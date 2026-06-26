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
      "/engine": "/geofence-engine.html"
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
  if (path === "/api/projects" && method === "GET") {
    const { results } = await env.DB
      .prepare("SELECT id,name,slug,mode,status,bundleVersion,updatedAt FROM project ORDER BY updatedAt DESC")
      .all();
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
      "INSERT INTO project (id,orgId,name,slug,mode,status,bundleVersion,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)"
    ).bind(id, b.orgId || "chase-life", b.name, b.slug || id, b.mode || "walking-tour", "draft", 1, now, now).run();
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
        await env.DB.prepare("UPDATE project SET bundleVersion=?, updatedAt=?, status='live' WHERE id=?")
          .bind(ver, now, pid).run();
      } else {
        // first publish for a brand-new project id — create the project row too
        await env.DB.prepare(
          "INSERT INTO project (id,orgId,name,slug,mode,status,bundleVersion,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)"
        ).bind(pid, "chase-life", bundle.name || pid, bundle.project || pid, "walking-tour", "live", ver, now, now).run();
      }
      return json({ ok: true, version: ver });
    }
  }

  return json({ error: "not found: " + method + " " + path }, 404);
}
