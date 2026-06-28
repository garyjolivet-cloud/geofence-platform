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
function authed(request, env) {            // master-token check (sync; always works as fallback)
  const h = request.headers.get("authorization") || "";
  return !!env.ADMIN_TOKEN && h === "Bearer " + env.ADMIN_TOKEN;
}
function bearer(request){ const h = request.headers.get("authorization") || ""; return h.startsWith("Bearer ") ? h.slice(7) : ""; }
async function sha256hex(s){
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
// resolve the caller's auth context: master token (full) or a scoped, non-revoked key
async function auth(request, env){
  const tok = bearer(request);
  if(!tok) return null;
  if(env.ADMIN_TOKEN && tok === env.ADMIN_TOKEN) return { master:true, appId:null, scopes:"*", keyId:"master" };
  try{
    const hash = await sha256hex(tok);
    const row = await env.DB.prepare("SELECT id,appId,scopes FROM api_key WHERE keyHash=? AND revokedAt IS NULL").bind(hash).first();
    if(!row) return null;
    env.DB.prepare("UPDATE api_key SET lastUsedAt=? WHERE id=?").bind(new Date().toISOString(), row.id).run().catch(()=>{});
    return { master:false, appId:row.appId, scopes:row.scopes || "", keyId:row.id };
  }catch(e){ return null; }              // api_key table absent / db error → only master works (safety)
}
function scopeOk(A, scope, targetAppId){
  if(!A) return false;
  if(A.master) return true;
  const scopes = (A.scopes || "").split(",").map(s => s.trim());
  const hasScope = scopes.includes("*") || scopes.includes(scope);
  const appOk = (A.appId == null) || (targetAppId == null) || (A.appId === targetAppId);
  return hasScope && appOk;
}
async function projectAppId(env, idOrSlug){
  try{ const r = await env.DB.prepare("SELECT appId FROM project WHERE id=? OR slug=? LIMIT 1").bind(idOrSlug, idOrSlug).first();
    return r ? r.appId : null; }catch(e){ return null; }
}
async function logAudit(env, request, A, action, target){
  try{ await env.DB.prepare("INSERT INTO audit_log (id,ts,keyId,action,target,ip) VALUES (?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), new Date().toISOString(), (A && A.keyId) || "?", action, target || "",
          request.headers.get("cf-connecting-ip") || "").run();
  }catch(e){}
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

  // --- API keys: create / list / revoke (master only) ---
  if (path === "/api/keys" && method === "POST") {
    if (!authed(request, env)) return json({ error: "master token required" }, 401);
    const b = await request.json();
    const scopes = Array.isArray(b.scopes) ? b.scopes.join(",") : (b.scopes || "*");
    const secret = "gpk_" + crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO api_key (id,keyHash,appId,label,scopes,createdAt) VALUES (?,?,?,?,?,?)"
    ).bind(id, await sha256hex(secret), b.appId || null, b.label || "", scopes, now).run();
    await logAudit(env, request, { keyId: "master" }, "key.create", id);
    return json({ ok: true, id, key: secret, appId: b.appId || null, scopes, note: "Copy this key now — it is not shown again." });
  }
  if (path === "/api/keys" && method === "GET") {
    if (!authed(request, env)) return json({ error: "master token required" }, 401);
    const { results } = await env.DB.prepare(
      "SELECT id,appId,label,scopes,createdAt,lastUsedAt,revokedAt FROM api_key ORDER BY createdAt DESC"
    ).all();
    return json({ keys: results || [] });
  }
  const mk = path.match(/^\/api\/keys\/([^/]+)$/);
  if (mk && method === "DELETE") {
    if (!authed(request, env)) return json({ error: "master token required" }, 401);
    await env.DB.prepare("UPDATE api_key SET revokedAt=? WHERE id=?").bind(new Date().toISOString(), mk[1]).run();
    await logAudit(env, request, { keyId: "master" }, "key.revoke", mk[1]);
    return json({ ok: true, revoked: mk[1] });
  }
  if (path === "/api/audit" && method === "GET") {
    if (!authed(request, env)) return json({ error: "master token required" }, 401);
    const { results } = await env.DB.prepare(
      "SELECT ts,keyId,action,target,ip FROM audit_log ORDER BY ts DESC LIMIT 200"
    ).all();
    return json({ audit: results || [] });
  }
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
    const existing = await env.DB.prepare("SELECT id,name FROM app WHERE id=? OR slug=?").bind(id, slug).first();
    if (existing) return json({ ok: true, id: existing.id, slug, name: existing.name, existed: true });
    try {
      await env.DB.prepare(
        "INSERT INTO app (id,orgId,name,slug,description,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)"
      ).bind(id, b.orgId || "chase-life", name, slug, b.description || "", now, now).run();
    } catch (e) {
      return json({ error: "create failed: " + ((e && e.message) || e) }, 500);
    }
    await logAudit(env, request, { keyId: "master" }, "app.create", id);
    return json({ ok: true, id, slug, name, created: true });
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
      const bundle = await request.json();
      if (!bundle || !Array.isArray(bundle.zones))
        return json({ error: "body must be a bundle with a zones array" }, 400);
      const targetApp = (await projectAppId(env, pid)) || bundle.appId || null;
      const A = await auth(request, env);
      if (!scopeOk(A, "publish", targetApp)) return json({ error: "not authorized to publish to this app" }, 401);
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
        await env.DB.prepare(
          "INSERT INTO project (id,orgId,appId,name,slug,mode,status,bundleVersion,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)"
        ).bind(pid, "chase-life", bundle.appId || null, bundle.name || pid, bundle.project || pid, "walking-tour", "live", ver, now, now).run();
      }
      await logAudit(env, request, A, "publish", pid + " v" + ver);
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

  if (path === "/api/analytics" && method === "GET") {
    const pid = url.searchParams.get("project");
    if (!pid) return json({ error: "need project param" }, 400);
    const A = await auth(request, env);
    if (!scopeOk(A, "analytics", await projectAppId(env, pid))) return json({ error: "not authorized for this app's analytics" }, 401);
    const lim = Math.min(parseInt(url.searchParams.get("limit") || "5000", 10) || 5000, 20000);
    const { results } = await env.DB.prepare(
      "SELECT id,type,ts,deviceId,data FROM event WHERE projectId=? ORDER BY ts DESC LIMIT ?"
    ).bind(pid, lim).all();
    return json({ project: pid, count: (results || []).length, events: results || [] });
  }

  // --- list what audio is stored (scoped) ---
  if (path === "/api/audio-list" && method === "GET") {
    if (!env.AUDIO) return json({ error: "no audio bucket bound" }, 500);
    const pfx = url.searchParams.get("project");
    const A = await auth(request, env);
    if (!scopeOk(A, "audio", pfx ? await projectAppId(env, pfx) : null)) return json({ error: "unauthorized" }, 401);
    const listed = await env.AUDIO.list(pfx ? { prefix: pfx + "/" } : {});
    return json({ objects: (listed.objects || []).map(o => ({ key: o.key, size: o.size, url: "/api/audio/" + o.key })) });
  }

  // --- audio assets in R2: upload (scoped) + serve (public) ---
  if (path.startsWith("/api/audio/")) {
    const key = decodeURIComponent(path.slice("/api/audio/".length)).trim();
    if (!key) return json({ error: "need an audio key" }, 400);
    if (!env.AUDIO) return json({ error: "no audio bucket bound (create R2 'geofence-audio' + binding)" }, 500);
    if (method === "PUT") {
      const A = await auth(request, env);
      if (!scopeOk(A, "audio", await projectAppId(env, key.split("/")[0]))) return json({ error: "not authorized to upload to this app" }, 401);
      const ct = request.headers.get("content-type") || "application/octet-stream";
      await env.AUDIO.put(key, request.body, { httpMetadata: { contentType: ct } });
      await logAudit(env, request, A, "audio.put", key);
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
      const A = await auth(request, env);
      if (!scopeOk(A, "audio", await projectAppId(env, key.split("/")[0]))) return json({ error: "unauthorized" }, 401);
      await env.AUDIO.delete(key);
      await logAudit(env, request, A, "audio.delete", key);
      return json({ ok: true, deleted: key });
    }
  }

  // --- token check: lets tools verify the admin token before using it ---
  if (path === "/api/auth-check") {
    const A = await auth(request, env);
    return A
      ? json({ ok: true, master: A.master, appId: A.appId, scopes: A.scopes })
      : json({ ok: false, error: "unauthorized" }, 401);
  }

  return json({ error: "not found: " + method + " " + path }, 404);
}
