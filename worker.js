/* =====================================================================
   GEOFENCE PLATFORM — API Worker
   Ties the three tools together through D1:
     - the EDITOR  publishes a project's bundle  (PUT, admin)
     - the ENGINE + SIMULATOR load it by project (GET, public)
   Everything that is NOT /api/* is served from the static assets
   (geofence-engine.html, fence-editor.html, geofence-sim.html, ...).

   Bindings (set in wrangler.jsonc):
     env.DB           D1 database
     env.ASSETS       static assets
     env.ADMIN_TOKEN  bearer secret for write endpoints
   ===================================================================== */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  "access-control-allow-headers": "authorization,content-type"
};
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "content-type": "application/json", ...CORS }
  });
}
function authed(request, env) {
  const h = request.headers.get("authorization") || "";
  return !!env.ADMIN_TOKEN && h === "Bearer " + env.ADMIN_TOKEN;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (url.pathname.startsWith("/api/")) {
      try { return await api(request, env, url); }
      catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
    }
    // friendly URLs → the real static files (query string is preserved)
    const FRIENDLY = {
      "/editor": "/fence-editor.html",
      "/sim": "/geofence-sim.html",
      "/engine": "/geofence-engine.html",
      "/dashboard": "/dashboard.html",
      "/share": "/share.html",
      "/audio": "/tour-audio-sandbox.html"
    };
    const clean = url.pathname.replace(/\/+$/, "");
    if (FRIENDLY[clean] && env.ASSETS) {
      const u = new URL(request.url);
      u.pathname = FRIENDLY[clean];
      return env.ASSETS.fetch(new Request(u.toString(), request));
    }
    // everything else: static files (the home page + the three HTML tools)
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  }
};

async function api(request, env, url) {
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  if (path === "/api/health") return json({ ok: true, db: !!env.DB, ts: Date.now() });
  if (!env.DB) return json({ error: "D1 not bound — add the DB binding in wrangler.jsonc" }, 500);

  // --- list projects (public; used by the tool pickers) ---
  // --- apps (workspaces): list with project counts ---
  if (path === "/api/apps" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT a.id,a.name,a.slug,a.description,a.updatedAt, " +
      "(SELECT COUNT(*) FROM project p WHERE p.appId=a.id) AS projectCount " +
      "FROM app a ORDER BY a.updatedAt DESC"
    ).all();
    return json({ apps: results || [] });
  }

  // --- create an app (admin) ---
  if (path === "/api/apps" && method === "POST") {
    if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
    const b = await request.json();
    const name = (b.name || "").trim();
    if (!name) return json({ error: "need a name" }, 400);
    const slug = (b.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
    const id = b.id || slug;
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO app (id,orgId,name,slug,description,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)"
    ).bind(id, b.orgId || "chase-life", name, slug, b.description || "", now, now).run();
    return json({ ok: true, id, slug, name });
  }

  // --- move a project into an app (admin) ---
  const mvm = path.match(/^\/api\/projects\/([^/]+)\/app$/);
  if (mvm && method === "PUT") {
    if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
    const pid = decodeURIComponent(mvm[1]);
    const b = await request.json();
    await env.DB.prepare("UPDATE project SET appId=?, updatedAt=? WHERE id=?")
      .bind(b.appId || null, new Date().toISOString(), pid).run();
    return json({ ok: true, project: pid, appId: b.appId || null });
  }

  if (path === "/api/projects" && method === "GET") {
    const appFilter = url.searchParams.get("app");
    const sql = "SELECT id,name,slug,mode,status,bundleVersion,updatedAt,appId FROM project" +
                (appFilter ? " WHERE appId=?" : "") + " ORDER BY updatedAt DESC";
    const stmt = appFilter ? env.DB.prepare(sql).bind(appFilter) : env.DB.prepare(sql);
    const { results } = await stmt.all();
    return json({ projects: results || [] });
  }

  // --- create a project (admin) ---
  if (path === "/api/projects" && method === "POST") {
    if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
    const b = await request.json();
    const id = b.id || b.slug;
    if (!id || !b.name) return json({ error: "need id and name" }, 400);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO project (id,orgId,appId,name,slug,mode,status,bundleVersion,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).bind(id, b.orgId || "chase-life", b.appId || null, b.name, b.slug || id, b.mode || "walking-tour", "draft", 1, now, now).run();
    return json({ ok: true, id });
  }

  // --- a project's bundle: GET latest (public) / PUT new version (admin) ---
  const mb = path.match(/^\/api\/projects\/([^/]+)\/bundle$/);
  if (mb) {
    const pid = decodeURIComponent(mb[1]);

    if (method === "GET") {
      const row = await env.DB
        .prepare("SELECT json,version FROM published_bundle WHERE projectId=? ORDER BY version DESC LIMIT 1")
        .bind(pid).first();
      if (!row) return json({ error: "no published bundle for '" + pid + "'" }, 404);
      let bundle;
      try { bundle = JSON.parse(row.json); }
      catch (e) { return json({ error: "stored bundle is corrupt" }, 500); }
      bundle.bundleVersion = row.version;       // engine/sim can check staleness
      return json(bundle);
    }

    if (method === "PUT") {
      if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
      const bundle = await request.json();
      if (!bundle || !Array.isArray(bundle.zones))
        return json({ error: "body must be a bundle with a zones array" }, 400);
      const now = new Date().toISOString();
      const proj = await env.DB.prepare("SELECT bundleVersion FROM project WHERE id=?").bind(pid).first();
      const ver = ((proj && proj.bundleVersion) || 0) + 1;
      await env.DB.prepare(
        "INSERT INTO published_bundle (projectId,version,json,publishedAt) VALUES (?,?,?,?)"
      ).bind(pid, ver, JSON.stringify(bundle), now).run();
      if (proj) {
        await env.DB.prepare("UPDATE project SET bundleVersion=?, updatedAt=?, status='live', appId=COALESCE(?,appId) WHERE id=?")
          .bind(ver, now, bundle.appId || null, pid).run();
      } else {
        // first publish for a brand-new project id — create the project row too
        await env.DB.prepare(
          "INSERT INTO project (id,orgId,appId,name,slug,mode,status,bundleVersion,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)"
        ).bind(pid, "chase-life", bundle.appId || null, bundle.name || pid, bundle.project || pid, "walking-tour", "live", ver, now, now).run();
      }
      return json({ ok: true, version: ver });
    }
  }

  // --- device register (public; the device records itself, anonymously) ---
  if (path === "/api/devices" && method === "POST") {
    const b = await request.json();
    if (!b.id) return json({ error: "need device id" }, 400);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO device (id,platform,lastSeen,createdAt) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET lastSeen=?"
    ).bind(b.id, b.platform || "web", now, now, now).run();
    return json({ ok: true, id: b.id });
  }

  // --- right to delete: purge everything tied to a device ---
  const mf = path.match(/^\/api\/devices\/([^/]+)\/forget$/);
  if (mf && method === "POST") {
    const id = decodeURIComponent(mf[1]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM event WHERE deviceId=?").bind(id),
      env.DB.prepare("DELETE FROM consent WHERE deviceId=?").bind(id),
      env.DB.prepare("DELETE FROM device WHERE id=?").bind(id)
    ]);
    return json({ ok: true, forgotten: id });
  }

  // --- consent: record (append-only) and read latest state per scope ---
  if (path === "/api/consent" && method === "POST") {
    const b = await request.json();
    if (!b.deviceId || !b.scopes) return json({ error: "need deviceId and scopes" }, 400);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO device (id,platform,lastSeen,createdAt) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET lastSeen=?"
    ).bind(b.deviceId, b.platform || "web", now, now, now).run();
    const ver = b.version || "1";
    const stmts = [];
    for (const scope of Object.keys(b.scopes)) {
      const granted = b.scopes[scope] ? 1 : 0;
      stmts.push(env.DB.prepare(
        "INSERT INTO consent (id,deviceId,scope,granted,version,retentionDays,grantedAt,revokedAt) VALUES (?,?,?,?,?,?,?,?)"
      ).bind(crypto.randomUUID(), b.deviceId, scope, granted, ver,
             b.retentionDays || null, now, granted ? null : now));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, recorded: stmts.length });
  }
  if (path === "/api/consent" && method === "GET") {
    const dev = url.searchParams.get("device");
    if (!dev) return json({ error: "need device param" }, 400);
    const { results } = await env.DB
      .prepare("SELECT scope,granted,version,grantedAt FROM consent WHERE deviceId=? ORDER BY grantedAt ASC")
      .bind(dev).all();
    const state = {};
    (results || []).forEach(r => { state[r.scope] = { granted: !!r.granted, version: r.version, at: r.grantedAt }; });
    return json({ deviceId: dev, consent: state });
  }

  // --- analytics ingest: idempotent batch, gated by recorded consent ---
  if (path === "/api/events" && method === "POST") {
    const b = await request.json();
    if (!b.deviceId) return json({ error: "need deviceId" }, 400);
    const evs = Array.isArray(b.events) ? b.events : [];
    if (!evs.length) return json({ ok: true, accepted: 0 });
    // defense in depth: only accept if this device has store-history consent on record
    const c = await env.DB.prepare(
      "SELECT granted FROM consent WHERE deviceId=? AND scope='store-history' ORDER BY grantedAt DESC LIMIT 1"
    ).bind(b.deviceId).first();
    if (!c || !c.granted) return json({ error: "no analytics consent on record" }, 403);
    const stmts = [];
    for (const e of evs.slice(0, 500)) {
      const pid = e.projectId || b.projectId;
      if (!e.id || !pid) continue;                       // event needs an id + project
      stmts.push(env.DB.prepare(
        "INSERT OR IGNORE INTO event (id,projectId,userId,deviceId,type,ts,data) VALUES (?,?,?,?,?,?,?)"
      ).bind(e.id, pid, null, b.deviceId, e.type || "event", e.ts || Date.now(),
             typeof e.data === "string" ? e.data : JSON.stringify(e.data || {})));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, accepted: stmts.length });
  }

  // --- analytics read (admin-gated): raw events for the dashboard to aggregate ---
  if (path === "/api/analytics" && method === "GET") {
    if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
    const pid = url.searchParams.get("project");
    if (!pid) return json({ error: "need project param" }, 400);
    const lim = Math.min(parseInt(url.searchParams.get("limit") || "5000", 10) || 5000, 20000);
    const { results } = await env.DB.prepare(
      "SELECT id,type,ts,deviceId,data FROM event WHERE projectId=? ORDER BY ts DESC LIMIT ?"
    ).bind(pid, lim).all();
    return json({ project: pid, count: (results || []).length, events: results || [] });
  }

  // --- list what audio is stored (admin) ---
  if (path === "/api/audio-list" && method === "GET") {
    if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
    if (!env.AUDIO) return json({ error: "no audio bucket bound" }, 500);
    const pfx = url.searchParams.get("project");
    const listed = await env.AUDIO.list(pfx ? { prefix: pfx + "/" } : {});
    return json({ objects: (listed.objects || []).map(o => ({ key: o.key, size: o.size, url: "/api/audio/" + o.key })) });
  }

  // --- audio assets in R2: upload (admin) + serve (public) ---
  if (path.startsWith("/api/audio/")) {
    const key = decodeURIComponent(path.slice("/api/audio/".length)).trim();
    if (!key) return json({ error: "need an audio key" }, 400);
    if (!env.AUDIO) return json({ error: "no audio bucket bound (create R2 'geofence-audio' + binding)" }, 500);
    if (method === "PUT") {
      if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
      const ct = request.headers.get("content-type") || "application/octet-stream";
      await env.AUDIO.put(key, request.body, { httpMetadata: { contentType: ct } });
      return json({ ok: true, key, url: "/api/audio/" + key });
    }
    if (method === "GET") {
      let obj = null;
      try { obj = await env.AUDIO.get(key); }
      catch (e) { return new Response("invalid key", { status: 404, headers: CORS }); }
      if (!obj) return new Response("not found", { status: 404, headers: CORS });
      const h = new Headers(CORS);
      h.set("content-type", (obj.httpMetadata && obj.httpMetadata.contentType) || "audio/mpeg");
      h.set("cache-control", "public, max-age=31536000");
      if (obj.httpEtag) h.set("etag", obj.httpEtag);
      return new Response(obj.body, { headers: h });
    }
    if (method === "DELETE") {
      if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
      await env.AUDIO.delete(key);
      return json({ ok: true, deleted: key });
    }
  }

  // --- token check: lets tools verify the admin token before using it ---
  if (path === "/api/auth-check") {
    return authed(request, env)
      ? json({ ok: true })
      : json({ ok: false, error: "unauthorized" }, 401);
  }

  return json({ error: "not found: " + method + " " + path }, 404);
}
