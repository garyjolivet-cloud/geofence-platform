/* =====================================================================
   GEOFENCE PLATFORM — API Worker
   Ties the three tools together through D1:
     - the EDITOR  publishes a project's bundle  (PUT, admin)
     - the ENGINE + SIMULATOR load it by project (GET, public)
   Everything that is NOT /api/* is served from the static assets
   (geofence-engine.html, fence-editor.html, geofence-sim.html, ...).

   Bindings (set in wrangler.jsonc):
     env.DB             D1 database
     env.ASSETS         static assets
     env.AUDIO          R2 bucket for audio clips
     env.ADMIN_TOKEN    bearer secret for write endpoints  (wrangler secret)
     env.RESEMBLE_API_TOKEN  Resemble AI token for /api/chatterbox/generate  (wrangler secret)
     env.ORG_ID         organisation slug, e.g. "chase-life"  (var)
     env.ALLOWED_ORIGIN browser origin allowed on write endpoints, e.g.
                        "https://geofence-platform.gary-jolivet.workers.dev"
                        Omit (or set to *) to allow all origins.  (var)
   ===================================================================== */

// Public endpoints allow any browser origin.
const CORS_PUBLIC = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type"
};

// Write / admin endpoints are restricted to ALLOWED_ORIGIN (if set).
function adminCors(env) {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type"
  };
}

function json(obj, status = 200, cors = CORS_PUBLIC) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "content-type": "application/json", ...cors }
  });
}

async function cleanupLiveZones(env) {
  const expired = await env.DB.prepare(
    "SELECT id, zone_json FROM live_zone WHERE expires_at < ?"
  ).bind(Date.now()).all();
  for (const row of (expired.results || [])) {
    try {
      const z = JSON.parse(row.zone_json);
      if (z.audioUrl) {
        const key = z.audioUrl.replace('/api/audio/', '');
        await env.AUDIO.delete(key).catch(() => {});
      }
    } catch (e) {}
    await env.DB.prepare("DELETE FROM live_zone WHERE id=?").bind(row.id).run();
  }
  // Prune stale presence rows (walkers gone more than 60s ago)
  await env.DB.prepare("DELETE FROM presence WHERE updated_at < ?").bind(Date.now() - 60000).run().catch(() => {});
}

// Every table with a project_id/projectId column, kept in one place so the
// single-project DELETE and the app-cascade DELETE loop can't drift apart
// again — they used to only clean event/published_bundle, silently leaving
// orphaned rows in the other five tables every time a project was deleted.
async function deleteProjectRows(env, pid) {
  await env.DB.prepare("DELETE FROM event WHERE projectId=?").bind(pid).run();
  await env.DB.prepare("DELETE FROM published_bundle WHERE projectId=?").bind(pid).run();
  await env.DB.prepare("DELETE FROM live_zone WHERE project_id=?").bind(pid).run();
  await env.DB.prepare("DELETE FROM presence WHERE project_id=?").bind(pid).run();
  await env.DB.prepare("DELETE FROM project_link WHERE project_id=?").bind(pid).run();
  await env.DB.prepare("DELETE FROM project_guide WHERE project_id=?").bind(pid).run();
  await env.DB.prepare("DELETE FROM project_frontdesk WHERE project_id=?").bind(pid).run();
  // Audio tree clips can live under a "clip/<uuid>" key now (not just the
  // legacy "<pid>/..." prefix swept below), so their R2 objects have to be
  // deleted by looking up each row's actual r2_key before dropping the rows.
  if (env.AUDIO) {
    const { results: clipRows } = await env.DB.prepare(
      "SELECT r2_key FROM audio_clip WHERE scope='project' AND scope_id=?"
    ).bind(pid).all();
    for (const row of (clipRows || [])) await env.AUDIO.delete(row.r2_key).catch(() => {});
  }
  await env.DB.prepare("DELETE FROM audio_clip WHERE scope='project' AND scope_id=?").bind(pid).run();
  await env.DB.prepare("DELETE FROM studio_session WHERE scope='project' AND scope_id=?").bind(pid).run();
  await env.DB.prepare("DELETE FROM chatterbox_script WHERE scope='project' AND scope_id=?").bind(pid).run();
  await env.DB.prepare("DELETE FROM audio_folder WHERE scope='project' AND scope_id=?").bind(pid).run();
  await env.DB.prepare("DELETE FROM stop_folder WHERE project_id=?").bind(pid).run();
  await env.DB.prepare("DELETE FROM project WHERE id=?").bind(pid).run();
  // Any remaining un-migrated legacy R2 audio still sitting under "<pid>/..."
  if (env.AUDIO) {
    let cursor;
    do {
      const l = await env.AUDIO.list({ prefix: pid + "/", cursor });
      if (l.objects.length) await env.AUDIO.delete(l.objects.map(o => o.key));
      cursor = l.truncated ? l.cursor : undefined;
    } while (cursor);
  }
}

// Shared by every /api/audio-list branch — {key,size,url,uploaded} is the
// one shape the frontend's Audio Files panel expects regardless of scope.
function mapAudioObjs(objs) {
  return (objs || []).map(o => ({ key: o.key, size: o.size, url: "/api/audio/" + o.key, uploaded: o.uploaded || null }));
}
async function listAllAudio(env, prefix) {
  let objects = [], cursor;
  do {
    const l = await env.AUDIO.list({ prefix, cursor });
    objects = objects.concat(mapAudioObjs(l.objects));
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  return objects;
}

// --- Audio tree (D1-backed folders + clips, decoupled from R2 key layout) ---
// Auth for a (scope, scopeId) pair, shared by every audio-folder/audio-clip
// route below — mirrors the per-branch checks /api/audio-list already used,
// just re-checked against a row's scope/scope_id instead of parsing its key.
async function audioScopeAuthOk(env, A, scope, scopeId) {
  if (scope === "library") return libraryScopeOk(env, A, scopeId);
  if (scope === "project") {
    const appId = await projectAppId(env, scopeId);
    return scopeOk(A, "audio", appId) || scopeOk(A, "publish", appId);
  }
  return false;
}
// Walking paths are scoped directly to an app (workspace) id, not resolved
// from a project like audioScopeAuthOk — appId is already the direct key.
async function appScopeAuthOk(env, A, appId) {
  return scopeOk(A, "audio", appId) || scopeOk(A, "publish", appId);
}
// Would setting `folderId`'s parent to `newParentId` create a cycle? Walks
// newParentId's own parent chain looking for folderId.
async function wouldCreateCycle(env, folderId, newParentId) {
  if (!newParentId) return false;
  if (newParentId === folderId) return true;
  let cur = newParentId, seen = new Set();
  while (cur) {
    if (cur === folderId) return true;
    if (seen.has(cur)) break; // corrupt/looping data already — bail rather than spin
    seen.add(cur);
    const row = await env.DB.prepare("SELECT parent_id FROM audio_folder WHERE id=?").bind(cur).first();
    cur = row ? row.parent_id : null;
  }
  return false;
}
// Every folder id in folderId's subtree, folderId included — used to cascade
// a folder delete to every clip/folder underneath it in one pass.
async function collectFolderSubtree(env, scope, scopeId, rootFolderId) {
  const ids = [rootFolderId];
  let frontier = [rootFolderId];
  while (frontier.length) {
    const ph = frontier.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT id FROM audio_folder WHERE scope=? AND scope_id=? AND parent_id IN (${ph})`
    ).bind(scope, scopeId, ...frontier).all();
    frontier = (results || []).map(r => r.id);
    ids.push(...frontier);
  }
  return ids;
}
// Moves an entire folder subtree into a different scope in place — every
// descendant folder and clip keeps its id/r2_key, only their scope/scope_id
// columns change. Cheap (a couple of bulk UPDATEs), no R2 rewrite, and safe
// from cycles by construction: the target parent (if any) already belongs to
// the target scope, which is necessarily disjoint from rootFolderId's own
// subtree before this call.
async function rescopeFolderSubtree(env, rootFolderId, srcScope, srcScopeId, targetScope, targetScopeId, targetParentId) {
  const folderIds = await collectFolderSubtree(env, srcScope, srcScopeId, rootFolderId);
  const ph = folderIds.map(() => "?").join(",");
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE audio_folder SET scope=?, scope_id=?, updated_at=? WHERE id IN (${ph})`)
    .bind(targetScope, targetScopeId, now, ...folderIds).run();
  await env.DB.prepare("UPDATE audio_folder SET parent_id=? WHERE id=?").bind(targetParentId, rootFolderId).run();
  await env.DB.prepare(`UPDATE audio_clip SET scope=?, scope_id=?, updated_at=? WHERE folder_id IN (${ph})`)
    .bind(targetScope, targetScopeId, now, ...folderIds).run();
}
// Duplicates one clip's R2 object under a fresh stable key + a new D1 row.
async function copyClipRow(env, clipRow, targetScope, targetScopeId, targetFolderId, overrideName) {
  const obj = await env.AUDIO.get(clipRow.r2_key);
  if (!obj) throw new Error("source clip missing in R2: " + clipRow.r2_key);
  const ext = (clipRow.r2_key.match(/\.[^.\/]+$/) || [""])[0];
  const newKey = "clip/" + crypto.randomUUID() + ext;
  await env.AUDIO.put(newKey, obj.body, { httpMetadata: obj.httpMetadata });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO audio_clip (id,scope,scope_id,folder_id,name,r2_key,size_bytes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).bind(id, targetScope, targetScopeId, targetFolderId, overrideName || clipRow.name, newKey, obj.size || null, now, now).run();
  return id;
}
// Recursively duplicates a folder + everything under it (subfolders and
// clips) into a target location, possibly a different scope entirely.
async function copyFolderSubtree(env, sourceFolderId, srcScope, srcScopeId, targetScope, targetScopeId, targetParentId) {
  const src = await env.DB.prepare("SELECT name FROM audio_folder WHERE id=? AND scope=? AND scope_id=?")
    .bind(sourceFolderId, srcScope, srcScopeId).first();
  if (!src) throw new Error("source folder not found");
  const newId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO audio_folder (id,scope,scope_id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(newId, targetScope, targetScopeId, targetParentId, src.name, now, now).run();
  const { results: clips } = await env.DB.prepare(
    "SELECT id,name,r2_key FROM audio_clip WHERE scope=? AND scope_id=? AND folder_id=?"
  ).bind(srcScope, srcScopeId, sourceFolderId).all();
  for (const c of (clips || [])) await copyClipRow(env, c, targetScope, targetScopeId, newId);
  const { results: subfolders } = await env.DB.prepare(
    "SELECT id FROM audio_folder WHERE scope=? AND scope_id=? AND parent_id=?"
  ).bind(srcScope, srcScopeId, sourceFolderId).all();
  for (const sf of (subfolders || [])) await copyFolderSubtree(env, sf.id, srcScope, srcScopeId, targetScope, targetScopeId, newId);
  return newId;
}

async function scrapeWeather(env) {
  const resp = await fetch('https://kickinghorseresort.com/conditions/advanced-weather-data/', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GeofencePlatform/1.0)' },
    cf: { cacheEverything: false }
  });
  if (!resp.ok) throw new Error('KH fetch failed: ' + resp.status);
  const html = await resp.text();

  // Strip tags to plain text
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

  // Dogtooth section has both Dogtooth + WhiteWall columns merged per row
  const sec = text.match(/DOGTOOTH SNOW STUDY PLOT([\s\S]+?)(?:Descriptions|PARTNERS|WHITE WALL REMOTE)/i)?.[1] || '';
  // Data rows: start with month (1-2 digits) space day then 4-digit time
  const rows = sec.split('\n').filter(l => /^\s{0,10}\d{1,2}\s+\d{1,2}\s+\d{3,4}\s/.test(l));
  if (!rows.length) throw new Error('No Dogtooth data rows found');

  const latest = rows[rows.length - 1].trim().split(/\s+/);
  // cols: month day time dg_temp rh hn24 hst hs hour_precip precip_24hr gauge ww_time ww_temp ww_ws ww_wd ww_gust wind_run [month day]
  if (latest.length < 16) throw new Error('Row too short: ' + latest.join(','));

  // cols: month day time dg_temp rh hn24 hst hs hour_precip precip_24hr gauge ww_time ww_temp ww_ws ww_wd ww_gust wind_run [month day]
  const [month, day, time, , , hn24, hst, hs, hourPrecip, precip24hr, , , wwTemp, wwWs, wwWd, wwGust] = latest;
  const year = new Date().getUTCFullYear();
  const readingDate = `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`;

  await env.DB.prepare(`
    INSERT INTO weather_cache (fetched_at, reading_date, reading_time, ww_temp_c, ww_wind_spd_kph, ww_wind_dir_deg, ww_wind_gust_kph, hour_precip_mm, precip_24hr_mm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    new Date().toISOString(), readingDate, parseInt(time),
    parseFloat(wwTemp), parseFloat(wwWs), parseInt(wwWd), parseFloat(wwGust),
    parseFloat(hourPrecip), parseFloat(precip24hr)
  ).run();

  await env.DB.prepare(
    `DELETE FROM weather_cache WHERE id NOT IN (SELECT id FROM weather_cache ORDER BY id DESC LIMIT 48)`
  ).run();

  return {
    readingDate, readingTime: parseInt(time),
    wwTemp: parseFloat(wwTemp), wwWs: parseFloat(wwWs), wwWd: parseInt(wwWd), wwGust: parseFloat(wwGust),
    hourPrecip: parseFloat(hourPrecip), precip24hr: parseFloat(precip24hr),
    hn24: parseFloat(hn24), hst: parseFloat(hst), hs: parseFloat(hs)
  };
}

async function saveSnowSnapshot(env) {
  const data = await scrapeWeather(env);
  // snapshot_date is the local Mountain date (UTC-7 winter)
  const localDate = new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);
  await env.DB.prepare(`
    INSERT OR REPLACE INTO snow_history
      (snapshot_date, taken_at, ww_temp_c, ww_wind_spd_kph, ww_wind_dir_deg, ww_wind_gust_kph, hour_precip_mm, precip_24hr_mm, hn24_cm, hst_cm, hs_cm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    localDate, new Date().toISOString(),
    data.wwTemp, data.wwWs, data.wwWd, data.wwGust,
    data.hourPrecip, data.precip24hr,
    data.hn24, data.hst, data.hs
  ).run();

  // Keep only last 14 days
  await env.DB.prepare(
    `DELETE FROM snow_history WHERE snapshot_date < date('now', '-14 days')`
  ).run();

  return { snapshotDate: localDate, ...data };
}

function rawAdminToken(request, env) {
  const h = request.headers.get("authorization") || "";
  return !!env.ADMIN_TOKEN && h === "Bearer " + env.ADMIN_TOKEN;
}
// Accepts either the raw ADMIN_TOKEN secret (scripts/curl) or a logged-in
// admin session — auth() already treats role==="admin" as master, so this
// just closes the gap for endpoints that predate the session system.
async function authed(request, env) {
  if (rawAdminToken(request, env)) return true;
  const A = await auth(request, env);
  return !!(A && A.master);
}
function bearer(request) { const h = request.headers.get("authorization") || ""; return h.startsWith("Bearer ") ? h.slice(7) : ""; }
async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function auth(request, env) {
  const tok = bearer(request);
  if (!tok) return null;
  if (env.ADMIN_TOKEN && tok === env.ADMIN_TOKEN) return { master: true, appId: null, scopes: "*", keyId: "master" };
  try {
    const hash = await sha256hex(tok);
    const row = await env.DB.prepare("SELECT id,appId,scopes FROM api_key WHERE keyHash=? AND revokedAt IS NULL").bind(hash).first();
    if (row) {
      await env.DB.prepare("UPDATE api_key SET lastUsedAt=? WHERE id=?").bind(new Date().toISOString(), row.id).run().catch(() => {});
      return { master: false, appId: row.appId, scopes: row.scopes || "", keyId: row.id };
    }
    const sess = await env.DB.prepare(
      "SELECT s.id AS sid, u.id AS uid, u.role, u.org_id, u.email, u.name FROM user_session s JOIN user_account u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?"
    ).bind(hash, Date.now()).first();
    if (sess) return {
      master: sess.role === "admin",
      appId: sess.org_id,
      scopes: scopesForRole(sess.role),
      keyId: "user:" + sess.uid,
      userId: sess.uid,
      role: sess.role,
      name: sess.name,
      email: sess.email
    };
  } catch (e) { return null; }
  return null;
}
function scopeOk(A, scope, targetAppId) {
  if (!A) return false;
  if (A.master) return true;
  const scopes = (A.scopes || "").split(",").map(s => s.trim());
  const hasScope = scopes.includes("*") || scopes.includes(scope);
  const appOk = (A.appId == null) || (targetAppId == null) || (A.appId === targetAppId);
  return hasScope && appOk;
}
// Library audio is shared across every project belonging to one company,
// not across the whole bucket — the "org" here is the same client/orgId
// used everywhere else (project.orgId, app.orgId, user_account.org_id).
// A session caller's A.appId already *is* their org_id (see auth() above);
// an API-key caller's A.appId is a workspace id, so it needs one lookup to
// resolve which org that workspace belongs to.
async function libraryScopeOk(env, A, orgId) {
  if (!A) return false;
  if (A.master) return true;
  const scopes = (A.scopes || "").split(",").map(s => s.trim());
  const hasScope = scopes.includes("*") || scopes.includes("audio") || scopes.includes("publish");
  if (!hasScope) return false;
  if (A.appId == null) return true; // unscoped key — matches scopeOk's existing wide-open convention
  if (A.appId === orgId) return true;
  try {
    const row = await env.DB.prepare("SELECT orgId FROM app WHERE id=?").bind(A.appId).first();
    return !!(row && row.orgId === orgId);
  } catch (e) { return false; }
}
// Same shape as libraryScopeOk — code objects are org-scoped like the
// audio Library, gating who can list/author/entitle them. Kept distinct
// (not reusing libraryScopeOk directly) since the "audio" scope shouldn't
// imply code-object management, even though the org-match logic is
// identical; codeObjectScopeOk checks the "publish" scope instead.
async function codeObjectScopeOk(env, A, orgId) {
  if (!A) return false;
  if (A.master) return true;
  const scopes = (A.scopes || "").split(",").map(s => s.trim());
  if (!(scopes.includes("*") || scopes.includes("publish"))) return false;
  if (A.appId == null) return true;
  if (A.appId === orgId) return true;
  try {
    const row = await env.DB.prepare("SELECT orgId FROM app WHERE id=?").bind(A.appId).first();
    return !!(row && row.orgId === orgId);
  } catch (e) { return false; }
}
function scopesForRole(role) {
  if (role === "admin") return "*";
  if (role === "operator") return "analytics";
  if (role === "guide") return "publish,audio";
  return ""; // front_desk and anything else: no blanket scope — see explicit
             // role checks on /copy, /links, and /guides instead.
}
async function projectAppId(env, idOrSlug) {
  try {
    const r = await env.DB.prepare("SELECT appId FROM project WHERE id=? OR slug=? LIMIT 1").bind(idOrSlug, idOrSlug).first();
    return r ? r.appId : null;
  } catch (e) { return null; }
}
async function logAudit(env, request, A, action, target) {
  try {
    await env.DB.prepare("INSERT INTO audit_log (id,ts,keyId,action,target,ip) VALUES (?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), new Date().toISOString(), (A && A.keyId) || "?", action, target || "",
            request.headers.get("cf-connecting-ip") || "").run();
  } catch (e) {}
}
function randomHex(n = 32) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" }, key, 256
  );
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function createSession(env, userId, ip) {
  const raw = randomHex(32);
  const hash = await sha256hex(raw);
  await env.DB.prepare(
    "INSERT INTO user_session (id, user_id, token_hash, expires_at, created_at, ip) VALUES (?,?,?,?,?,?)"
  ).bind(crypto.randomUUID(), userId, hash, Date.now() + 30 * 24 * 3600 * 1000, new Date().toISOString(), ip || "").run();
  return raw;
}
function appUrl(env, path, request) {
  if (env.APP_URL) return env.APP_URL.replace(/\/+$/, "") + path;
  if (request) { try { return new URL(request.url).origin + path; } catch(e) {} }
  return path;
}
async function sendEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) return { stubbed: true };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.FROM_EMAIL || "noreply@example.com", to, subject, html })
  });
  if (!r.ok) throw new Error("Resend " + r.status + ": " + await r.text());
  return { sent: true };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: adminCors(env) });
    if (url.pathname.startsWith("/api/")) {
      try { return await api(request, env, url); }
      catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
    }
    const FRIENDLY = {
      "/privacy": "/privacy.html",
      "/editor": "/fence-editor.html",
      "/sim": "/geofence-sim.html",
      "/engine": "/geofence-engine.html",
      "/dashboard": "/dashboard.html",
      "/share": "/share.html",
      "/audio": "/audio-bench.html",
      "/library": "/library.html",
      "/studio": "/audio-studio.html",
      "/chatterbox": "/chatterbox-studio.html",
      "/field": "/field-recorder.html",
      "/pipeline": "/pipeline-editor.html",
      "/code-library": "/pipeline-editor.html", // retired standalone page — the library is now an inline sidebar on /pipeline
      "/login": "/login.html",
      "/invite": "/invite.html",
      "/walk": "/geofence-engine.html",
      "/clients": "/clients.html"
    };
    const clean = url.pathname.replace(/\/+$/, "");
    // Client-scoped login, e.g. /c/chase-life/login — same login.html, the
    // slug is read client-side from the URL path.
    const clientLogin = clean.match(/^\/c\/([^/]+)\/login$/);
    if (clientLogin && env.ASSETS) {
      const u = new URL(request.url);
      u.pathname = "/login.html";
      return env.ASSETS.fetch(new Request(u.toString(), request));
    }
    if (FRIENDLY[clean] && env.ASSETS) {
      const u = new URL(request.url);
      u.pathname = FRIENDLY[clean];
      return env.ASSETS.fetch(new Request(u.toString(), request));
    }
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  },

  async scheduled(event, env) {
    if (event.cron === "*/5 * * * *") {
      await cleanupLiveZones(env);
      return;
    }
    // At 15:00 UTC (8am MST): saveSnowSnapshot() already calls scrapeWeather()
    // internally — calling it again here would double-fetch the site and
    // double-insert into weather_cache for the same reading.
    if (event.cron === "0 15 * * *") {
      await saveSnowSnapshot(env);
    } else {
      // Every other hour: just update the real-time cache for Groq context
      await scrapeWeather(env);
    }
  }
};

async function api(request, env, url) {
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;
  const orgId = env.ORG_ID || "chase-life";
  const AC = adminCors(env);

  if (path === "/api/health") return json({ ok: true, db: !!env.DB, ts: Date.now() });

  // --- auth: seed first admin (master token required; errors if admin already exists) ---
  if (path === "/api/auth/seed-admin" && method === "POST") {
    // Raw token only — no admin session can exist yet at bootstrap time.
    if (!rawAdminToken(request, env)) return json({ error: "master token required" }, 401, AC);
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    const b = await request.json().catch(() => ({}));
    if (!b.email || !b.password) return json({ error: "email and password required" }, 400, AC);
    const existing = await env.DB.prepare("SELECT id FROM user_account WHERE role='admin' LIMIT 1").first().catch(() => null);
    if (existing) return json({ error: "admin already exists" }, 409, AC);
    const id = crypto.randomUUID();
    const salt = randomHex(16);
    const hash = await hashPassword(b.password, salt);
    const orgId2 = env.ORG_ID || "chase-life";
    await env.DB.prepare(
      "INSERT INTO user_account (id,email,password_hash,salt,org_id,role,name,created_at) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(id, b.email.toLowerCase().trim(), hash, salt, orgId2, "admin", b.name || b.email, new Date().toISOString()).run();
    return json({ ok: true, id }, 200, AC);
  }

  // --- auth: login ---
  if (path === "/api/auth/login" && method === "POST") {
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    const b = await request.json().catch(() => ({}));
    const email = (b.email || "").toLowerCase().trim();
    if (!email || !b.password) return json({ error: "email and password required" }, 400, AC);
    const user = await env.DB.prepare(
      "SELECT id,email,name,role,org_id,password_hash,salt FROM user_account WHERE email=? AND role!='inactive'"
    ).bind(email).first().catch(() => null);
    if (!user || !user.password_hash) return json({ error: "invalid credentials" }, 401, AC);
    const computed = await hashPassword(b.password, user.salt);
    if (computed !== user.password_hash) return json({ error: "invalid credentials" }, 401, AC);
    // If the login page was client-scoped (/c/<slug>/login), the account
    // must actually belong to that client — a correct password elsewhere
    // isn't enough.
    if (b.client && user.org_id !== b.client) {
      return json({ error: "this account isn't part of this client" }, 403, AC);
    }
    const token = await createSession(env, user.id, request.headers.get("cf-connecting-ip") || "");
    await env.DB.prepare("UPDATE user_account SET last_login_at=? WHERE id=?").bind(new Date().toISOString(), user.id).run().catch(() => {});
    return json({ ok: true, token, user: { id: user.id, email: user.email, name: user.name, role: user.role } }, 200, AC);
  }

  // --- auth: logout ---
  if (path === "/api/auth/logout" && method === "POST") {
    const tok = bearer(request);
    if (tok && env.DB) {
      const h = await sha256hex(tok).catch(() => null);
      if (h) env.DB.prepare("DELETE FROM user_session WHERE token_hash=?").bind(h).run().catch(() => {});
    }
    return json({ ok: true }, 200, AC);
  }

  // --- auth: me ---
  if (path === "/api/auth/me" && method === "GET") {
    const A = await auth(request, env);
    if (!A || !A.userId) return json({ error: "not authenticated" }, 401, AC);
    const client = A.appId
      ? await env.DB.prepare("SELECT name FROM client WHERE id=?").bind(A.appId).first()
      : null;
    return json({ id: A.userId, email: A.email, name: A.name, role: A.role, orgId: A.appId, orgName: client ? client.name : A.appId }, 200, AC);
  }

  // --- auth: accept invite + set password ---
  if (path === "/api/auth/set-password" && method === "POST") {
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    const b = await request.json().catch(() => ({}));
    if (!b.token || !b.password) return json({ error: "token and password required" }, 400, AC);
    const tokenHash = await sha256hex(b.token);
    const user = await env.DB.prepare(
      "SELECT id,email,name,role FROM user_account WHERE invite_token=? AND invite_expires>?"
    ).bind(tokenHash, Date.now()).first().catch(() => null);
    if (!user) return json({ error: "invalid or expired invite link" }, 400, AC);
    const salt = randomHex(16);
    const hash = await hashPassword(b.password, salt);
    await env.DB.prepare(
      "UPDATE user_account SET password_hash=?,salt=?,name=COALESCE(?,name),invite_token=NULL,invite_expires=NULL,last_login_at=? WHERE id=?"
    ).bind(hash, salt, b.name || null, new Date().toISOString(), user.id).run();
    const token = await createSession(env, user.id, request.headers.get("cf-connecting-ip") || "");
    return json({ ok: true, token, user: { id: user.id, email: user.email, name: b.name || user.name, role: user.role } }, 200, AC);
  }

  // --- users: list ---
  if (path === "/api/users" && method === "GET") {
    const A = await auth(request, env);
    if (!A) return json({ error: "authentication required" }, 401, AC);
    // front_desk gets a narrow carve-out: read-only guide-name lookups only
    // (e.g. Walk Links / Calendar tabs need to show a guide's name, not their
    // raw id) — never a full staff roster.
    const frontDeskGuideLookup = A.role === "front_desk" && url.searchParams.get("role") === "guide";
    if (!A.master && A.role !== "operator" && A.role !== "admin" && !frontDeskGuideLookup)
      return json({ error: "operator access required" }, 403, AC);
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    // Master/admin sees every client's staff by default (matches /api/apps) —
    // callers that want one client's staff (dashboard's own Team tab) must
    // explicitly pass ?org=, rather than the backend silently guessing which
    // client an admin session "belongs to" (that broke the cross-client
    // developer homepage, which intentionally has no single home client).
    const orgFilter = A.master ? (url.searchParams.get("org") || null) : A.appId;
    const roleFilter = url.searchParams.get("role");
    const conditions = [], binds = [];
    if (orgFilter) { conditions.push("org_id=?"); binds.push(orgFilter); }
    if (roleFilter) { conditions.push("role=?"); binds.push(roleFilter); }
    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const sql = "SELECT id,email,name,role,org_id,created_at,last_login_at FROM user_account" + where + " ORDER BY name ASC";
    const { results } = await (binds.length ? env.DB.prepare(sql).bind(...binds) : env.DB.prepare(sql)).all();
    return json({ users: results || [] }, 200, AC);
  }

  // --- users: create + invite ---
  if (path === "/api/users" && method === "POST") {
    const A = await auth(request, env);
    if (!A) return json({ error: "authentication required" }, 401, AC);
    if (!A.master && A.role !== "operator" && A.role !== "admin") return json({ error: "operator access required" }, 403, AC);
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    const b = await request.json().catch(() => ({}));
    const email = (b.email || "").toLowerCase().trim();
    if (!email) return json({ error: "email required" }, 400, AC);
    const existing = await env.DB.prepare("SELECT id FROM user_account WHERE email=?").bind(email).first().catch(() => null);
    if (existing) return json({ error: "email already in use" }, 409, AC);
    const id = crypto.randomUUID();
    const rawToken = randomHex(32);
    const tokenHash = await sha256hex(rawToken);
    const inviteExpires = Date.now() + 7 * 24 * 3600 * 1000;
    // Master falls back to its own home client (A.appId) before the global
    // default — otherwise inviting while previewing another client silently
    // created the account under chase-life instead of the client being viewed.
    const orgId2 = A.master ? (b.orgId || A.appId || (env.ORG_ID || "chase-life")) : (A.appId || (env.ORG_ID || "chase-life"));
    // Operators may only create guide/front_desk accounts — never operator/admin.
    let inviteRole = b.role || "guide";
    if (!A.master && A.role === "operator" && inviteRole !== "guide" && inviteRole !== "front_desk") {
      inviteRole = "guide";
    }
    await env.DB.prepare(
      "INSERT INTO user_account (id,email,name,org_id,role,invite_token,invite_expires,created_at) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(id, email, b.name || "", orgId2, inviteRole, tokenHash, inviteExpires, new Date().toISOString()).run();
    const inviteUrl = appUrl(env, "/invite?token=" + rawToken, request);
    await sendEmail(env, {
      to: email, subject: "You've been invited to Chase Life",
      html: `<p>You've been added to the Chase Life guide platform.</p><p><a href="${inviteUrl}">Set your password and get started</a></p><p>This link expires in 7 days.</p>`
    }).catch(() => {});
    await logAudit(env, request, A, "user.create", id);
    return json({ ok: true, id, inviteUrl }, 200, AC);
  }

  // --- users: update / deactivate / resend invite (matched by id) ---
  const muser = path.match(/^\/api\/users\/([^/]+)$/);
  if (muser) {
    const A = await auth(request, env);
    if (!A) return json({ error: "authentication required" }, 401, AC);
    if (!A.master && A.role !== "operator" && A.role !== "admin") return json({ error: "operator access required" }, 403, AC);
    const uid = decodeURIComponent(muser[1]);
    if (method === "PUT") {
      const b = await request.json().catch(() => ({}));
      let newRole = b.role || null;
      // Operators may only set guide/front_desk — never promote to operator/admin.
      if (newRole && !A.master && A.role === "operator" && newRole !== "guide" && newRole !== "front_desk") {
        newRole = null;
      }
      await env.DB.prepare("UPDATE user_account SET name=COALESCE(?,name), role=COALESCE(?,role) WHERE id=?")
        .bind(b.name || null, newRole, uid).run();
      return json({ ok: true }, 200, AC);
    }
    if (method === "DELETE") {
      // Hard delete, not a soft-deactivate: strip every project assignment
      // first (project_guide/front_desk tables, plus the guide_id on any
      // scheduled booking), then kill sessions, then remove the account row
      // itself so the login lookup (which matches on email) finds nothing.
      await env.DB.prepare("DELETE FROM project_guide WHERE guide_id=?").bind(uid).run();
      await env.DB.prepare("DELETE FROM project_frontdesk WHERE frontdesk_id=?").bind(uid).run();
      await env.DB.prepare("UPDATE project SET guide_id=NULL WHERE guide_id=?").bind(uid).run();
      await env.DB.prepare("DELETE FROM user_session WHERE user_id=?").bind(uid).run().catch(() => {});
      await env.DB.prepare("DELETE FROM user_account WHERE id=?").bind(uid).run();
      return json({ ok: true }, 200, AC);
    }
  }

  // --- users: resend invite ---
  const museri = path.match(/^\/api\/users\/([^/]+)\/invite$/);
  if (museri && method === "POST") {
    const A = await auth(request, env);
    if (!A) return json({ error: "authentication required" }, 401, AC);
    if (!A.master && A.role !== "operator" && A.role !== "admin") return json({ error: "operator access required" }, 403, AC);
    const uid = decodeURIComponent(museri[1]);
    const user = await env.DB.prepare("SELECT id,email,name FROM user_account WHERE id=?").bind(uid).first().catch(() => null);
    if (!user) return json({ error: "user not found" }, 404, AC);
    const rawToken = randomHex(32);
    const tokenHash = await sha256hex(rawToken);
    await env.DB.prepare("UPDATE user_account SET invite_token=?,invite_expires=? WHERE id=?")
      .bind(tokenHash, Date.now() + 7 * 24 * 3600 * 1000, uid).run();
    const inviteUrl = appUrl(env, "/invite?token=" + rawToken, request);
    await sendEmail(env, {
      to: user.email, subject: "Your Chase Life invite link",
      html: `<p>Here is your updated invite link for Chase Life:</p><p><a href="${inviteUrl}">Set your password</a></p><p>This link expires in 7 days.</p>`
    }).catch(() => {});
    return json({ ok: true, inviteUrl }, 200, AC);
  }

  // --- nuke all data (master only) — wipes every row, keeps schema ---
  if (path === "/api/nuke" && method === "DELETE") {
    if (!(await authed(request, env))) return json({ error: "master token required" }, 401, AC);
    const tables = ["event","consent","device","audit_log","published_bundle","api_key","project","app"];
    const wiped = [], skipped = [];
    for (const t of tables) {
      try { await env.DB.prepare(`DELETE FROM ${t}`).run(); wiped.push(t); }
      catch(e) { skipped.push(t); }
    }
    // Also wipe all R2 audio objects
    let r2Deleted = 0;
    if (env.AUDIO) {
      try {
        let cursor;
        do {
          const listed = await env.AUDIO.list({ cursor, limit: 1000 });
          for (const obj of listed.objects) {
            await env.AUDIO.delete(obj.key);
            r2Deleted++;
          }
          cursor = listed.truncated ? listed.cursor : undefined;
        } while (cursor);
      } catch(e) {}
    }
    return json({ ok: true, wiped, skipped, r2Deleted }, 200, AC);
  }

  // --- API keys: create / list / revoke (master only) ---
  if (path === "/api/keys" && method === "POST") {
    if (!(await authed(request, env))) return json({ error: "master token required" }, 401, AC);
    const b = await request.json();
    const scopes = Array.isArray(b.scopes) ? b.scopes.join(",") : (b.scopes || "*");
    const secret = "gpk_" + crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO api_key (id,keyHash,appId,label,scopes,createdAt) VALUES (?,?,?,?,?,?)"
    ).bind(id, await sha256hex(secret), b.appId || null, b.label || "", scopes, now).run();
    await logAudit(env, request, { keyId: "master" }, "key.create", id);
    return json({ ok: true, id, key: secret, appId: b.appId || null, scopes, note: "Copy this key now — it is not shown again." }, 200, AC);
  }
  if (path === "/api/keys" && method === "GET") {
    if (!(await authed(request, env))) return json({ error: "master token required" }, 401, AC);
    const { results } = await env.DB.prepare(
      "SELECT id,appId,label,scopes,createdAt,lastUsedAt,revokedAt FROM api_key ORDER BY createdAt DESC"
    ).all();
    return json({ keys: results || [] }, 200, AC);
  }
  const mk = path.match(/^\/api\/keys\/([^/]+)$/);
  if (mk && method === "DELETE") {
    if (!(await authed(request, env))) return json({ error: "master token required" }, 401, AC);
    await env.DB.prepare("UPDATE api_key SET revokedAt=? WHERE id=?").bind(new Date().toISOString(), mk[1]).run();
    await logAudit(env, request, { keyId: "master" }, "key.revoke", mk[1]);
    return json({ ok: true, revoked: mk[1] }, 200, AC);
  }
  if (path === "/api/audit" && method === "GET") {
    if (!(await authed(request, env))) return json({ error: "master token required" }, 401, AC);
    const { results } = await env.DB.prepare(
      "SELECT ts,keyId,action,target,ip FROM audit_log ORDER BY ts DESC LIMIT 200"
    ).all();
    return json({ audit: results || [] }, 200, AC);
  }
  if (!env.DB) return json({ error: "D1 not bound — add the DB binding in wrangler.jsonc" }, 500);

  // --- clients: public name lookup by slug, used by the client-scoped login page ---
  const mcl = path.match(/^\/api\/clients\/([^/]+)$/);
  if (mcl && method === "GET") {
    const slug = decodeURIComponent(mcl[1]);
    const client = await env.DB.prepare("SELECT id,name FROM client WHERE slug=?").bind(slug).first();
    if (!client) return json({ error: "client not found" }, 404, AC);
    return json({ id: client.id, name: client.name }, 200, AC);
  }

  // --- clients: admin-only list + create (the sandbox's client picker) ---
  if (path === "/api/clients" && method === "GET") {
    const A = await auth(request, env);
    if (!A || !A.master) return json({ error: "admin access required" }, 403, AC);
    const { results } = await env.DB.prepare(
      "SELECT c.id,c.name,c.slug,c.created_at, " +
      "(SELECT COUNT(*) FROM project p WHERE p.orgId=c.id) AS projectCount, " +
      "(SELECT COUNT(*) FROM user_account u WHERE u.org_id=c.id AND u.role!='inactive') AS userCount " +
      "FROM client c ORDER BY c.created_at DESC"
    ).all();
    return json({ clients: results || [] }, 200, AC);
  }
  if (path === "/api/clients" && method === "POST") {
    const A = await auth(request, env);
    if (!A || !A.master) return json({ error: "admin access required" }, 403, AC);
    const b = await request.json().catch(() => ({}));
    const name = (b.name || "").trim();
    if (!name) return json({ error: "need a name" }, 400, AC);
    const slug = (b.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
    const id = b.id || slug;
    const existing = await env.DB.prepare("SELECT id FROM client WHERE id=? OR slug=?").bind(id, slug).first();
    if (existing) return json({ error: "a client with that id or slug already exists" }, 409, AC);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO client (id,name,slug,created_at) VALUES (?,?,?,?)"
    ).bind(id, name, slug, now).run();
    // Matching default workspace — id intentionally equals the client id, the
    // same convention the single-tenant fallback already relied on (see
    // resolvedAppId = orgId in the bundle-publish auto-create path below).
    await env.DB.prepare(
      "INSERT OR IGNORE INTO app (id,orgId,name,slug,description,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)"
    ).bind(id, id, name, slug, "", now, now).run();
    await logAudit(env, request, A, "client.create", id);
    return json({ ok: true, id, slug }, 200, AC);
  }
  // --- delete a client (master only; ?cascade=true also wipes its projects/staff) ---
  // Deliberately never touches the `app` table: a project's orgId (client) and
  // its appId (workspace) can drift apart (a project can be reassigned to a
  // different client without its workspace following), so deleting workspaces
  // here risked sweeping up a workspace that still legitimately belongs to,
  // or is shared with, a different client. Workspace deletion stays its own
  // separate, explicit action (DELETE /api/apps/:id) with its own safety check.
  const mdc = path.match(/^\/api\/clients\/([^/]+)$/);
  if (mdc && method === "DELETE") {
    const A = await auth(request, env);
    if (!A || !A.master) return json({ error: "admin access required" }, 403, AC);
    const cid = decodeURIComponent(mdc[1]);
    const cascade = url.searchParams.get("cascade") === "true";
    if (!cascade) {
      const proj = await env.DB.prepare("SELECT id FROM project WHERE orgId=? LIMIT 1").bind(cid).first();
      const usr = await env.DB.prepare("SELECT id FROM user_account WHERE org_id=? LIMIT 1").bind(cid).first();
      if (proj || usr) return json({ error: "remove or reassign this client's projects/staff first, or use cascade=true" }, 409, AC);
    } else {
      const { results: projs } = await env.DB.prepare("SELECT id FROM project WHERE orgId=?").bind(cid).all();
      for (const p of (projs || [])) {
        await deleteProjectRows(env, p.id);
      }
      await env.DB.prepare("DELETE FROM user_session WHERE user_id IN (SELECT id FROM user_account WHERE org_id=?)").bind(cid).run();
      await env.DB.prepare("DELETE FROM user_account WHERE org_id=?").bind(cid).run();
    }
    await env.DB.prepare("DELETE FROM client WHERE id=?").bind(cid).run();
    await logAudit(env, request, A, "client.delete", cid);
    return json({ ok: true, deleted: cid }, 200, AC);
  }

  // --- apps (workspaces): list with project counts ---
  if (path === "/api/apps" && method === "GET") {
    const A = await auth(request, env);
    // Unscoped before multi-client support existed — now requires a session,
    // and non-master callers only ever see their own client's workspace(s).
    // Master sees everything unless an explicit ?org= is given (matches
    // /api/projects and /api/users), so the homepage's client picker can
    // actually filter the workspace list.
    if (!A) return json({ apps: [] }, 200, AC);
    const scopedOrg = A.master ? (url.searchParams.get("org") || null) : A.appId;
    const sql = "SELECT a.id,a.orgId,a.name,a.slug,a.description,a.updatedAt, " +
      "(SELECT COUNT(*) FROM project p WHERE p.appId=a.id) AS projectCount " +
      "FROM app a" + (scopedOrg ? " WHERE a.orgId=?" : "") + " ORDER BY a.updatedAt DESC";
    const stmt = scopedOrg ? env.DB.prepare(sql).bind(scopedOrg) : env.DB.prepare(sql);
    const { results } = await stmt.all();
    return json({ apps: results || [] }, 200, AC);
  }

  // --- create an app (admin) ---
  if (path === "/api/apps" && method === "POST") {
    if (!(await authed(request, env))) return json({ error: "unauthorized" }, 401, AC);
    const b = await request.json();
    const name = (b.name || "").trim();
    if (!name) return json({ error: "need a name" }, 400);
    const slug = (b.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
    const id = b.id || slug;
    const now = new Date().toISOString();
    const existing = await env.DB.prepare("SELECT id,name FROM app WHERE id=? OR slug=?").bind(id, slug).first();
    if (existing) return json({ ok: true, id: existing.id, slug, name: existing.name, existed: true }, 200, AC);
    try {
      await env.DB.prepare(
        "INSERT INTO app (id,orgId,name,slug,description,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)"
      ).bind(id, b.orgId || orgId, name, slug, b.description || "", now, now).run();
    } catch (e) {
      return json({ error: "create failed: " + ((e && e.message) || e) }, 500);
    }
    await logAudit(env, request, { keyId: "master" }, "app.create", id);
    return json({ ok: true, id, slug, name, created: true }, 200, AC);
  }

  // --- rename an app (master only) ---
  const mda = path.match(/^\/api\/apps\/([^/]+)$/);
  if (mda && method === "PUT") {
    if (!(await authed(request, env))) return json({ error: "master token required" }, 401, AC);
    const aid = decodeURIComponent(mda[1]);
    const b = await request.json();
    const name = (b.name || "").trim();
    if (!name) return json({ error: "name required" }, 400, AC);
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE app SET name=?, description=COALESCE(?,description), updatedAt=? WHERE id=?")
      .bind(name, b.description ?? null, now, aid).run();
    await logAudit(env, request, { keyId: "master" }, "app.rename", aid);
    return json({ ok: true, id: aid, name }, 200, AC);
  }

  // --- delete an app (master only; ?cascade=true also deletes all its projects) ---
  if (mda && method === "DELETE") {
    if (!(await authed(request, env))) return json({ error: "master token required" }, 401, AC);
    const aid = decodeURIComponent(mda[1]);
    const cascade = url.searchParams.get("cascade") === "true";
    if (cascade) {
      const { results: projs } = await env.DB.prepare("SELECT id FROM project WHERE appId=?").bind(aid).all();
      for (const p of (projs || [])) {
        await deleteProjectRows(env, p.id);
      }
    } else {
      const chk = await env.DB.prepare("SELECT id FROM project WHERE appId=? LIMIT 1").bind(aid).first();
      if (chk) return json({ error: "remove or reassign this app's projects first, or use cascade=true" }, 409, AC);
    }
    await env.DB.prepare("DELETE FROM api_key WHERE appId=?").bind(aid).run();
    await env.DB.prepare("DELETE FROM walking_path WHERE app_id=?").bind(aid).run();
    await env.DB.prepare("DELETE FROM walking_path_folder WHERE app_id=?").bind(aid).run();
    await env.DB.prepare("DELETE FROM app WHERE id=?").bind(aid).run();
    await logAudit(env, request, { keyId: "master" }, "app.delete", aid);
    return json({ ok: true, deleted: aid }, 200, AC);
  }

  // --- merge one workspace's projects into another (master only) ---
  // Non-destructive: the source app row itself is left behind, empty, so
  // there's nothing to roll back if this fails partway — same reasoning as
  // /api/projects/combine. v1 restricts this to two apps under the same
  // client (orgId never changes on any moved row), to avoid reopening the
  // orgId/appId drift bug class this codebase has hit before.
  const mmg = path.match(/^\/api\/apps\/([^/]+)\/merge$/);
  if (mmg && method === "POST") {
    if (!(await authed(request, env))) return json({ error: "master token required" }, 401, AC);
    const targetId = decodeURIComponent(mmg[1]);
    const b = await request.json().catch(() => ({}));
    const sourceAppId = b.sourceAppId;
    if (!sourceAppId) return json({ error: "sourceAppId required" }, 400, AC);
    if (sourceAppId === targetId) return json({ error: "source and target must be different workspaces" }, 400, AC);
    const target = await env.DB.prepare("SELECT id,orgId FROM app WHERE id=?").bind(targetId).first();
    const source = await env.DB.prepare("SELECT id,orgId FROM app WHERE id=?").bind(sourceAppId).first();
    if (!target || !source) return json({ error: "workspace not found" }, 404, AC);
    if (target.orgId !== source.orgId) return json({ error: "both workspaces must belong to the same client" }, 400, AC);
    const now = new Date().toISOString();
    const projMove = await env.DB.prepare("UPDATE project SET appId=?, updatedAt=? WHERE appId=?")
      .bind(targetId, now, sourceAppId).run();
    await logAudit(env, request, { keyId: "master" }, "app.merge", targetId);
    return json({
      ok: true,
      movedProjects: projMove.meta?.changes || 0
    }, 200, AC);
  }

  // --- move a project into an app (admin) ---
  const mvm = path.match(/^\/api\/projects\/([^/]+)\/app$/);
  if (mvm && method === "PUT") {
    if (!(await authed(request, env))) return json({ error: "unauthorized" }, 401, AC);
    const pid = decodeURIComponent(mvm[1]);
    const b = await request.json();
    await env.DB.prepare("UPDATE project SET appId=?, updatedAt=? WHERE id=?")
      .bind(b.appId || null, new Date().toISOString(), pid).run();
    return json({ ok: true, project: pid, appId: b.appId || null }, 200, AC);
  }

  // --- move a project to a different client (developer/admin only) ---
  const mvo = path.match(/^\/api\/projects\/([^/]+)\/org$/);
  if (mvo && method === "PUT") {
    if (!(await authed(request, env))) return json({ error: "unauthorized" }, 401, AC);
    const pid = decodeURIComponent(mvo[1]);
    const b = await request.json();
    if (!b.orgId) return json({ error: "need orgId" }, 400, AC);
    await env.DB.prepare("UPDATE project SET orgId=?, updatedAt=? WHERE id=?")
      .bind(b.orgId, new Date().toISOString(), pid).run();
    return json({ ok: true, project: pid, orgId: b.orgId }, 200, AC);
  }

  if (path === "/api/projects" && method === "GET") {
    const A = await auth(request, env);
    // Unscoped before multi-client support existed — non-master callers are
    // now pinned to their own client's rows regardless of other filters.
    if (!A) return json({ projects: [] }, 200, AC);
    const conditions = [], binds = [];
    const appFilter = url.searchParams.get("app");
    const dateFilter = url.searchParams.get("date");
    const dateFromFilter = url.searchParams.get("dateFrom");
    const dateToFilter = url.searchParams.get("dateTo");
    const guideFilter = url.searchParams.get("guide");
    const templateFilter = url.searchParams.get("template");
    const archivedFilter = url.searchParams.get("archived");
    // orgFilter scopes by client — distinct from appFilter (workspace). Master
    // sees every client's projects by default (matches /api/apps) — callers
    // that want one client's projects (dashboard's own tabs) must explicitly
    // pass ?org=, rather than the backend silently guessing which client an
    // admin session "belongs to" (that broke the cross-client developer
    // homepage, which intentionally has no single home client).
    const orgFilter = A.master ? (url.searchParams.get("org") || null) : A.appId;
    if (orgFilter) { conditions.push("orgId=?"); binds.push(orgFilter); }
    if (!A.master && A.role === "front_desk") {
      conditions.push("id IN (SELECT project_id FROM project_frontdesk WHERE frontdesk_id=?)");
      binds.push(A.userId);
    }
    if (appFilter) { conditions.push("appId=?"); binds.push(appFilter); }
    if (dateFilter) { conditions.push("scheduled_date=?"); binds.push(dateFilter); }
    if (dateFromFilter) { conditions.push("scheduled_date>=?"); binds.push(dateFromFilter); }
    if (dateToFilter) { conditions.push("scheduled_date<=?"); binds.push(dateToFilter); }
    if (guideFilter) { conditions.push("(guide_id=? OR id IN (SELECT project_id FROM project_guide WHERE guide_id=?))"); binds.push(guideFilter, guideFilter); }
    if (templateFilter !== null) { conditions.push("is_template=?"); binds.push(Number(templateFilter)); }
    if (archivedFilter === null) { conditions.push("(archived IS NULL OR archived=0)"); }
    else if (archivedFilter === "1") { conditions.push("archived=1"); }
    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const sql = "SELECT id,name,slug,mode,status,bundleVersion,updatedAt,appId,scheduled_date,scheduled_time,guide_id,is_template,tour_type,archived,visitor_name FROM project" +
                where + " ORDER BY COALESCE(scheduled_date,'9999') DESC, updatedAt DESC";
    const stmt = binds.length ? env.DB.prepare(sql).bind(...binds) : env.DB.prepare(sql);
    const { results } = await stmt.all();
    return json({ projects: results || [] });
  }

  // --- create a project (admin) ---
  if (path === "/api/projects" && method === "POST") {
    if (!(await authed(request, env))) return json({ error: "unauthorized" }, 401, AC);
    const b = await request.json();
    const id = b.id || b.slug;
    if (!id || !b.name) return json({ error: "need id and name" }, 400);
    // "library" is a reserved R2 key prefix for the shared audio library —
    // a project with this id/slug would collide with it (see /api/audio-list).
    if (id === "library" || b.slug === "library") return json({ error: "\"library\" is a reserved id — pick a different id/slug" }, 400);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO project (id,orgId,appId,name,slug,mode,status,bundleVersion,createdAt,updatedAt,scheduled_date,guide_id,is_template,tour_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(id, b.orgId || orgId, b.appId || null, b.name, b.slug || id, b.mode || "walking-tour", "draft", 1, now, now,
           b.scheduledDate || null, b.guideId || null, b.isTemplate ? 1 : 0, b.tourType || null).run();
    return json({ ok: true, id }, 200, AC);
  }

  // --- delete a project (master only; cascades every project-scoped table) ---
  const mdp = path.match(/^\/api\/projects\/([^/]+)$/);
  if (mdp && method === "DELETE") {
    if (!(await authed(request, env))) return json({ error: "master token required" }, 401, AC);
    const pid = decodeURIComponent(mdp[1]);
    await deleteProjectRows(env, pid);
    await logAudit(env, request, { keyId: "master" }, "project.delete", pid);
    return json({ ok: true, deleted: pid }, 200, AC);
  }

  // --- edit a scheduled tour's booking details (name/time/guide/visitor);
  // does not touch scheduled_date — a booking's date is set by which
  // calendar day it was created under, not editable here; operator/front_desk/master ---
  if (mdp && method === "PUT") {
    const A = await auth(request, env);
    if (!A || !(A.master || A.role === "operator" || A.role === "front_desk"))
      return json({ error: "operator or front_desk access required" }, 403, AC);
    const pid = decodeURIComponent(mdp[1]);
    const proj = await env.DB.prepare("SELECT orgId FROM project WHERE id=?").bind(pid).first();
    if (!proj) return json({ error: "project not found" }, 404, AC);
    if (!A.master && proj.orgId !== A.appId) return json({ error: "project belongs to a different client" }, 403, AC);
    if (!A.master && A.role === "front_desk") {
      const assigned = await env.DB.prepare(
        "SELECT 1 FROM project_frontdesk WHERE project_id=? AND frontdesk_id=?"
      ).bind(pid, A.userId).first();
      if (!assigned) return json({ error: "not assigned to this project" }, 403, AC);
    }
    const b = await request.json().catch(() => ({}));
    if (!b.name) return json({ error: "name required" }, 400, AC);
    await env.DB.prepare(
      "UPDATE project SET name=?, scheduled_time=?, guide_id=?, visitor_name=?, updatedAt=? WHERE id=?"
    ).bind(b.name, b.scheduledTime || null, b.guideId || null, b.visitorName || null, new Date().toISOString(), pid).run();
    await logAudit(env, request, A, "project.update", pid);
    return json({ ok: true, id: pid }, 200, AC);
  }

  // --- archive/cancel a scheduled tour (soft/reversible for the project itself,
  // but also hard-revokes its walk links; operator/front_desk/master) ---
  const arp = path.match(/^\/api\/projects\/([^/]+)\/archive$/);
  if (arp && method === "PUT") {
    const A = await auth(request, env);
    if (!A || !(A.master || A.role === "operator" || A.role === "front_desk"))
      return json({ error: "operator or front_desk access required" }, 403, AC);
    const pid = decodeURIComponent(arp[1]);
    const proj = await env.DB.prepare("SELECT orgId FROM project WHERE id=?").bind(pid).first();
    if (!proj) return json({ error: "project not found" }, 404, AC);
    if (!A.master && proj.orgId !== A.appId) return json({ error: "project belongs to a different client" }, 403, AC);
    if (!A.master && A.role === "front_desk") {
      const assigned = await env.DB.prepare(
        "SELECT 1 FROM project_frontdesk WHERE project_id=? AND frontdesk_id=?"
      ).bind(pid, A.userId).first();
      if (!assigned) return json({ error: "not assigned to this project" }, 403, AC);
    }
    const b = await request.json().catch(() => ({}));
    const val = b.archived === 0 ? 0 : 1;
    await env.DB.prepare("UPDATE project SET archived=?, updatedAt=? WHERE id=?")
      .bind(val, new Date().toISOString(), pid).run();
    let linksRevoked = 0;
    if (val) {
      // Cancelling a booking also revokes any walk links already generated for
      // it — otherwise a visitor holding an old link could still open a tour
      // that's been called off. Links have no soft-revoke column (see the
      // DELETE /api/links/:token handler), so this is a hard delete; restoring
      // the booking later does not bring the links back — staff would
      // generate a fresh one via the Links tab if still needed.
      const delResult = await env.DB.prepare("DELETE FROM project_link WHERE project_id=?").bind(pid).run();
      linksRevoked = delResult.meta?.changes || 0;
    }
    await logAudit(env, request, A, val ? "project.archive" : "project.unarchive", pid);
    return json({ ok: true, id: pid, archived: val, linksRevoked }, 200, AC);
  }

  // --- copy a project from template ---
  const mcp = path.match(/^\/api\/projects\/([^/]+)\/copy$/);
  if (mcp && method === "POST") {
    const A = await auth(request, env);
    if (!A || !(A.master || A.role === "operator" || A.role === "front_desk"))
      return json({ error: "operator or front_desk access required" }, 403, AC);
    const srcId = decodeURIComponent(mcp[1]);
    const b = await request.json().catch(() => ({}));
    if (!b.name) return json({ error: "name required" }, 400, AC);
    const src = await env.DB.prepare("SELECT id,orgId,appId,mode,tour_type FROM project WHERE id=?").bind(srcId).first();
    if (!src) return json({ error: "source project not found" }, 404, AC);
    if (!A.master && src.orgId !== A.appId) return json({ error: "template belongs to a different client" }, 403, AC);
    const srcBundle = await env.DB.prepare(
      "SELECT json FROM published_bundle WHERE projectId=? ORDER BY version DESC LIMIT 1"
    ).bind(srcId).first();
    const newId = "proj_" + Date.now().toString(36) + "_" + randomHex(4);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO project (id,orgId,appId,name,slug,mode,status,bundleVersion,createdAt,updatedAt,scheduled_date,scheduled_time,guide_id,is_template,tour_type,visitor_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(newId, src.orgId || orgId, src.appId, b.name, newId, src.mode || "walking-tour", "draft", 0, now, now,
           b.scheduledDate || null, b.scheduledTime || null, b.guideId || null, 0, b.tourType || src.tour_type || null, b.visitorName || null).run();
    if (srcBundle) {
      let bundleJson = srcBundle.json;
      try { const p = JSON.parse(bundleJson); p.name = b.name; bundleJson = JSON.stringify(p); } catch(e) {}
      await env.DB.prepare(
        "INSERT INTO published_bundle (projectId,version,json,publishedAt) VALUES (?,?,?,?)"
      ).bind(newId, 1, bundleJson, now).run();
      await env.DB.prepare("UPDATE project SET bundleVersion=1, status='live' WHERE id=?").bind(newId).run();
    }
    await logAudit(env, request, A, "project.copy", newId);
    return json({ ok: true, id: newId }, 200, AC);
  }

  // --- combine 2+ unassigned projects into one new project (admin only) ---
  // Non-destructive: sources are only read, never written to. Zone ids are
  // re-prefixed per source project before concatenating, since fence-editor
  // derives a zone id from its slugified name with no project scoping —
  // two sources each having a "Stop 1" zone would otherwise collide and
  // corrupt geofence-engine's id-keyed live-patch/guidance lookups.
  if (path === "/api/projects/combine" && method === "POST") {
    if (!(await authed(request, env))) return json({ error: "unauthorized" }, 401, AC);
    const b = await request.json().catch(() => ({}));
    const name = (b.name || "").trim();
    const sourceIds = Array.isArray(b.sourceIds) ? [...new Set(b.sourceIds)] : [];
    if (!name) return json({ error: "name required" }, 400, AC);
    if (sourceIds.length < 2) return json({ error: "need at least 2 source projects" }, 400, AC);
    const sources = [];
    for (const sid of sourceIds) {
      const src = await env.DB.prepare("SELECT id,orgId,appId,mode,tour_type FROM project WHERE id=?").bind(sid).first();
      if (!src) return json({ error: "source project not found: " + sid }, 404, AC);
      sources.push(src);
    }
    // v1 restriction: same workspace only.
    const appId = sources[0].appId;
    if (sources.some(s => s.appId !== appId)) {
      return json({ error: "all source projects must be in the same workspace" }, 400, AC);
    }
    const orgId = sources[0].orgId;
    let mergedZones = [];
    for (const src of sources) {
      const row = await env.DB.prepare(
        "SELECT json FROM published_bundle WHERE projectId=? ORDER BY version DESC LIMIT 1"
      ).bind(src.id).first();
      if (!row) continue;
      let bundle;
      try { bundle = JSON.parse(row.json); } catch (e) { continue; }
      const zones = Array.isArray(bundle.zones) ? bundle.zones : [];
      for (const z of zones) {
        mergedZones.push({ ...z, id: src.id + "__" + z.id });
      }
    }
    if (!mergedZones.length) return json({ error: "no published zones found in the selected projects" }, 400, AC);
    // ref = centroid of every combined zone's center, mirrors fence-editor's
    // own client-side centroid calc in exportBundle(), just run server-side
    // over the merged set.
    let sumLat = 0, sumLon = 0, n = 0;
    for (const z of mergedZones) {
      const c = z.center || (z.shape && z.shape.coords && z.shape.coords[0]);
      if (Array.isArray(c) && c.length === 2) { sumLat += c[0]; sumLon += c[1]; n++; }
    }
    const ref = n ? [sumLat / n, sumLon / n] : [0, 0];
    const firstSrcBundleRow = await env.DB.prepare(
      "SELECT json FROM published_bundle WHERE projectId=? ORDER BY version DESC LIMIT 1"
    ).bind(sources[0].id).first();
    let scalars = {};
    try {
      const fb = firstSrcBundleRow ? JSON.parse(firstSrcBundleRow.json) : {};
      scalars = {
        spatialRangeM: fb.spatialRangeM, spatialClearM: fb.spatialClearM,
        spatialTuning: fb.spatialTuning, liveTtlMs: fb.liveTtlMs
      };
    } catch (e) {}
    const newId = "proj_" + Date.now().toString(36) + "_" + randomHex(4);
    const now = new Date().toISOString();
    const isTemplate = b.isTemplate === false ? 0 : 1;
    await env.DB.prepare(
      "INSERT INTO project (id,orgId,appId,name,slug,mode,status,bundleVersion,createdAt,updatedAt,is_template,tour_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(newId, orgId, appId, name, newId, sources[0].mode || "walking-tour", "live", 1, now, now, isTemplate, sources[0].tour_type || null).run();
    const mergedBundle = {
      project: newId, name, ref, ...scalars,
      appId, orgId, isTemplate: !!isTemplate,
      zones: mergedZones
    };
    await env.DB.prepare(
      "INSERT INTO published_bundle (projectId,version,json,publishedAt) VALUES (?,?,?,?)"
    ).bind(newId, 1, JSON.stringify(mergedBundle), now).run();
    await logAudit(env, request, { keyId: "master" }, "project.combine", newId);
    return json({ ok: true, id: newId }, 200, AC);
  }

  // --- guide walk links lookup (public) — returns all active links for a guide on a project ---
  if (path === "/api/guide-links" && method === "GET") {
    const pid = url.searchParams.get("project");
    const guideId = url.searchParams.get("guide");
    if (!pid || !guideId) return json({ links: [] }, 200, AC);
    const { results } = await env.DB.prepare(
      "SELECT token, label FROM project_link WHERE project_id=? AND guide_id=? AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at ASC"
    ).bind(pid, guideId, Date.now()).all();
    const links = (results || []).map(r => ({
      label: r.label || "Visitor",
      url: appUrl(env, "/engine?t=" + r.token, request)
    }));
    return json({ links }, 200, AC);
  }

  // --- walk links: create / list (per project) ---
  const mlnk = path.match(/^\/api\/projects\/([^/]+)\/links$/);
  if (mlnk) {
    const pid = decodeURIComponent(mlnk[1]);
    if (method === "POST") {
      const A = await auth(request, env);
      if (!A || !(A.master || A.role === "operator" || A.role === "front_desk"))
        return json({ error: "operator or front_desk access required" }, 403, AC);
      if (!A.master) {
        const proj = await env.DB.prepare("SELECT orgId FROM project WHERE id=?").bind(pid).first();
        if (!proj || proj.orgId !== A.appId) return json({ error: "project belongs to a different client" }, 403, AC);
      }
      const b = await request.json().catch(() => ({}));
      const token = randomHex(24);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const expiresAt = b.expiresInHours ? Date.now() + b.expiresInHours * 3600000 : null;
      await env.DB.prepare(
        "INSERT INTO project_link (id,project_id,token,expires_at,label,created_at,guide_id) VALUES (?,?,?,?,?,?,?)"
      ).bind(id, pid, token, expiresAt, b.label || null, now, b.guideId || null).run();
      const url = appUrl(env, "/engine?t=" + token, request);
      return json({ ok: true, id, token, url, expiresAt }, 200, AC);
    }
    if (method === "GET") {
      const A = await auth(request, env);
      if (!A) return json({ error: "authentication required" }, 401, AC);
      const { results } = await env.DB.prepare(
        "SELECT id,token,label,expires_at,created_at FROM project_link WHERE project_id=? ORDER BY created_at DESC"
      ).bind(pid).all();
      return json({ links: results || [] }, 200, AC);
    }
  }

  // --- walk links: resolve (public) / revoke (auth) ---
  const mltok = path.match(/^\/api\/links\/([^/]+)$/);
  if (mltok) {
    const token = decodeURIComponent(mltok[1]);
    if (method === "GET") {
      const row = await env.DB.prepare(
        "SELECT project_id, expires_at, guide_id FROM project_link WHERE token=?"
      ).bind(token).first();
      if (!row) return json({ error: "link not found" }, 404, AC);
      if (row.expires_at && row.expires_at < Date.now()) return json({ error: "link expired", expired: true }, 410, AC);
      return json({ projectId: row.project_id, guideId: row.guide_id || null, valid: true }, 200, AC);
    }
    if (method === "DELETE") {
      const A = await auth(request, env);
      if (!A) return json({ error: "authentication required" }, 401, AC);
      await env.DB.prepare("DELETE FROM project_link WHERE token=?").bind(token).run();
      return json({ ok: true }, 200, AC);
    }
  }

  // --- get project IDs assigned to a guide (public — only returns IDs) ---
  const mga = path.match(/^\/api\/projects\/([^/]+)\/assigned$/);
  if (mga && method === "GET") {
    const guideId = decodeURIComponent(mga[1]);
    const { results } = await env.DB.prepare(
      "SELECT project_id FROM project_guide WHERE guide_id=?"
    ).bind(guideId).all();
    return json((results || []).map(r => r.project_id), 200, AC);
  }

  // --- project guide assignments (M:M) ---
  const mpg = path.match(/^\/api\/projects\/([^/]+)\/guides(?:\/([^/]+))?$/);
  if (mpg) {
    const pid = decodeURIComponent(mpg[1]);
    const gid = mpg[2] ? decodeURIComponent(mpg[2]) : null;
    const A = await auth(request, env);
    if (!A || !(A.master || A.role === "operator" || A.role === "front_desk"))
      return json({ error: "admin, operator, or front_desk required" }, 401, AC);
    if (!A.master) {
      const proj = await env.DB.prepare("SELECT orgId FROM project WHERE id=?").bind(pid).first();
      if (!proj || proj.orgId !== A.appId) return json({ error: "project belongs to a different client" }, 403, AC);
    }
    if (method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT u.id,u.name,u.email,u.role,pg.assigned_at FROM project_guide pg JOIN user_account u ON u.id=pg.guide_id WHERE pg.project_id=? ORDER BY pg.assigned_at"
      ).bind(pid).all();
      return json({ guides: results || [] }, 200, AC);
    }
    if (method === "POST") {
      const b = await request.json();
      if (!b.guideId) return json({ error: "need guideId" }, 400);
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT OR IGNORE INTO project_guide (project_id,guide_id,assigned_at) VALUES (?,?,?)"
      ).bind(pid, b.guideId, now).run();
      return json({ ok: true }, 200, AC);
    }
    if (method === "DELETE" && gid) {
      await env.DB.prepare("DELETE FROM project_guide WHERE project_id=? AND guide_id=?").bind(pid, gid).run();
      return json({ ok: true }, 200, AC);
    }
  }

  // --- get project IDs assigned to a front_desk user (public — only returns IDs) ---
  const mfa = path.match(/^\/api\/frontdesk\/([^/]+)\/assigned$/);
  if (mfa && method === "GET") {
    const fdId = decodeURIComponent(mfa[1]);
    const { results } = await env.DB.prepare(
      "SELECT project_id FROM project_frontdesk WHERE frontdesk_id=?"
    ).bind(fdId).all();
    return json((results || []).map(r => r.project_id), 200, AC);
  }

  // --- project front_desk assignments (M:M) — operator/admin only; front_desk cannot self-assign ---
  const mpf = path.match(/^\/api\/projects\/([^/]+)\/frontdesk(?:\/([^/]+))?$/);
  if (mpf) {
    const pid = decodeURIComponent(mpf[1]);
    const fdId = mpf[2] ? decodeURIComponent(mpf[2]) : null;
    const A = await auth(request, env);
    if (!A || !(A.master || A.role === "operator"))
      return json({ error: "admin or operator required" }, 401, AC);
    if (!A.master) {
      const proj = await env.DB.prepare("SELECT orgId FROM project WHERE id=?").bind(pid).first();
      if (!proj || proj.orgId !== A.appId) return json({ error: "project belongs to a different client" }, 403, AC);
    }
    if (method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT u.id,u.name,u.email,u.role,pf.assigned_at FROM project_frontdesk pf JOIN user_account u ON u.id=pf.frontdesk_id WHERE pf.project_id=? ORDER BY pf.assigned_at"
      ).bind(pid).all();
      return json({ frontdesk: results || [] }, 200, AC);
    }
    if (method === "POST") {
      const b = await request.json();
      if (!b.frontdeskId) return json({ error: "need frontdeskId" }, 400);
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT OR IGNORE INTO project_frontdesk (project_id,frontdesk_id,assigned_at) VALUES (?,?,?)"
      ).bind(pid, b.frontdeskId, now).run();
      return json({ ok: true }, 200, AC);
    }
    if (method === "DELETE" && fdId) {
      await env.DB.prepare("DELETE FROM project_frontdesk WHERE project_id=? AND frontdesk_id=?").bind(pid, fdId).run();
      return json({ ok: true }, 200, AC);
    }
  }

  // --- a project's bundle: GET latest (public) / PUT new version (scoped) ---
  const mb = path.match(/^\/api\/projects\/([^/]+)\/bundle$/);
  if (mb) {
    const pid = decodeURIComponent(mb[1]);
    if (pid === "library") return json({ error: "\"library\" is a reserved id" }, 400);

    if (method === "GET") {
      const row = await env.DB
        .prepare("SELECT json,version FROM published_bundle WHERE projectId=? ORDER BY version DESC LIMIT 1")
        .bind(pid).first();
      if (!row) return json({ error: "no published bundle for '" + pid + "'" }, 404);
      let bundle;
      try { bundle = JSON.parse(row.json); }
      catch (e) { return json({ error: "stored bundle is corrupt" }, 500); }
      bundle.bundleVersion = row.version;
      // Reflect the live owner — a project may have moved clients since this
      // bundle was published, and the stored JSON would otherwise be stale.
      const ownerRow = await env.DB.prepare("SELECT orgId FROM project WHERE id=?").bind(pid).first();
      if (ownerRow) bundle.orgId = ownerRow.orgId;
      // Merge active live zones — filtered by guide when visitor arrived via a guide's walk link
      const liveGuide = url.searchParams.get("guide");
      const liveRows = liveGuide
        ? await env.DB.prepare("SELECT zone_json FROM live_zone WHERE project_id=? AND expires_at>? AND guide_id=?").bind(pid, Date.now(), liveGuide).all()
        : await env.DB.prepare("SELECT zone_json FROM live_zone WHERE project_id=? AND expires_at>?").bind(pid, Date.now()).all();
      if (liveRows.results.length) {
        bundle.zones = [...(bundle.zones || []), ...liveRows.results.map(r => JSON.parse(r.zone_json))];
      }
      bundle.liveZoneCount = liveRows.results.length;
      return new Response(JSON.stringify(bundle), {
        headers: { "content-type": "application/json", "cache-control": "no-store", ...AC }
      });
    }

    if (method === "PUT") {
      // Size guard: reject bundles over 1 MB
      const body = await request.text();
      if (body.length > 1_000_000) return json({ error: "bundle too large (max 1 MB)" }, 413, AC);
      let bundle;
      try { bundle = JSON.parse(body); }
      catch (e) { return json({ error: "invalid JSON" }, 400); }
      if (!bundle || !Array.isArray(bundle.zones))
        return json({ error: "body must be a bundle with a zones array" }, 400);
      const existingProj = await env.DB.prepare("SELECT orgId, appId FROM project WHERE id=?").bind(pid).first();
      const existingAppId = existingProj ? existingProj.appId : null;
      const targetApp = existingAppId || bundle.appId || null;
      const A = await auth(request, env);
      if (!scopeOk(A, "publish", targetApp)) return json({ error: "not authorized to publish to this app" }, 401, AC);
      if (A && A.role === "guide") return json({ error: "guides cannot publish persistent stops — use live mode" }, 403, AC);
      const now = new Date().toISOString();
      // Only master/admin may steer which client a new project lands under;
      // everyone else falls back to the default org, matching prior behavior.
      const chosenOrgId = (A && A.master && bundle.orgId) ? bundle.orgId : orgId;
      // For an already-published project, only touch orgId if master explicitly
      // picked one — otherwise republishing must never silently move a project.
      const orgOverride = (A && A.master && bundle.orgId) ? bundle.orgId : null;
      // If master is actually moving this project to a different client, its
      // workspace must follow — otherwise the project stays pinned to a
      // workspace under the OLD client (the orgId/appId drift that caused an
      // earlier data-loss incident when a client got deleted). Ignoring the
      // stale existingAppId here forces the block below to resolve/auto-create
      // a workspace under the new client instead, unless bundle.appId was
      // explicitly given.
      const movingClients = orgOverride && existingProj && existingProj.orgId !== orgOverride;
      // Resolve appId — auto-assign so project always surfaces on home screen
      let resolvedAppId = (movingClients ? null : existingAppId) || bundle.appId || null;
      if (!resolvedAppId) {
        const existingApp = await env.DB.prepare("SELECT id FROM app WHERE orgId=? LIMIT 1").bind(chosenOrgId).first();
        if (existingApp) {
          resolvedAppId = existingApp.id;
        } else {
          resolvedAppId = chosenOrgId;
          await env.DB.prepare(
            "INSERT OR IGNORE INTO app (id,orgId,name,slug,description,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)"
          ).bind(resolvedAppId, chosenOrgId, bundle.name || "Default Workspace", resolvedAppId, "", now, now).run();
        }
      }
      const proj = await env.DB.prepare("SELECT bundleVersion FROM project WHERE id=?").bind(pid).first();
      const ver = ((proj && proj.bundleVersion) || 0) + 1;
      if (!proj && !bundle.createIfMissing) {
        return json({ error: "project not found — create it from the main screen first" }, 404, AC);
      }
      // Determine the TRUE effective org this publish lands under — an
      // existing project keeps its own org unless master explicitly moves it
      // (orgOverride); a new project inherits its resolved workspace's real
      // owner. Deliberately NOT just chosenOrgId: for a non-master caller
      // chosenOrgId is always the server's default org (see comment above),
      // which would let the entitlement check below be silently bypassed by
      // any scoped key publishing a new project without an explicit orgId.
      let finalOrgId = chosenOrgId;
      if (proj) {
        finalOrgId = orgOverride || (existingProj && existingProj.orgId) || chosenOrgId;
      } else if (!orgOverride && resolvedAppId) {
        const ownerApp = await env.DB.prepare("SELECT orgId FROM app WHERE id=?").bind(resolvedAppId).first();
        if (ownerApp && ownerApp.orgId) finalOrgId = ownerApp.orgId;
      }
      // Reject a publish that references a code object this org isn't
      // entitled to. This — not the palette's list filter, which only
      // controls what an admin SEES — is the real enforcement boundary for
      // the upsell: covers every authoring surface that ends up PUTting a
      // bundle here (Fence Editor today, Field Recorder in a later phase)
      // from one place instead of needing to be re-checked per surface.
      if (!(A && A.master)) {
        const objectIds = new Set();
        (bundle.zones || []).forEach(z => (z.codeObjects || []).forEach(co => { if (co && co.objectId) objectIds.add(co.objectId); }));
        if (objectIds.size) {
          const entitledRows = await env.DB.prepare("SELECT feature_key FROM org_entitlement WHERE org_id=?").bind(finalOrgId).all();
          const entitledKeys = new Set((entitledRows.results || []).map(r => r.feature_key));
          const objRows = await env.DB.prepare(
            "SELECT id,feature_key FROM code_object WHERE id IN (" + [...objectIds].map(() => "?").join(",") + ")"
          ).bind(...objectIds).all();
          const featureKeyById = {};
          (objRows.results || []).forEach(r => { featureKeyById[r.id] = r.feature_key; });
          for (const oid of objectIds) {
            const fk = featureKeyById[oid];
            if (!fk || !entitledKeys.has(fk)) return json({ error: "not entitled to code object: " + oid }, 403, AC);
          }
        }
      }
      // Only auto-create the project row if the editor explicitly opts in
      if (proj) {
        await env.DB.prepare("UPDATE project SET name=COALESCE(?,name), bundleVersion=?, updatedAt=?, status='live', appId=COALESCE(?,appId), guide_id=COALESCE(?,guide_id), orgId=COALESCE(?,orgId), is_template=? WHERE id=?")
          .bind(bundle.name || null, ver, now, resolvedAppId, bundle.guideId || null, orgOverride, bundle.isTemplate ? 1 : 0, pid).run();
      } else {
        await env.DB.prepare(
          "INSERT INTO project (id,orgId,appId,name,slug,mode,status,bundleVersion,createdAt,updatedAt,guide_id,scheduled_date,is_template,tour_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
        ).bind(pid, finalOrgId, resolvedAppId, bundle.name || pid, bundle.project || pid, "walking-tour", "live", ver, now, now, bundle.guideId||null, bundle.scheduledDate||null, bundle.isTemplate?1:0, bundle.tourType||null).run();
      }
      await env.DB.prepare(
        "INSERT INTO published_bundle (projectId,version,json,publishedAt) VALUES (?,?,?,?)"
      ).bind(pid, ver, JSON.stringify(bundle), now).run();
      await logAudit(env, request, A, "publish", pid + " v" + ver);
      return json({ ok: true, version: ver }, 200, AC);
    }
  }

  // --- live zone: append a single ephemeral zone (scoped publish) ---
  const mz = path.match(/^\/api\/projects\/([^/]+)\/zones$/);
  if (mz && method === "POST") {
    const pid = decodeURIComponent(mz[1]);
    const appId = await projectAppId(env, pid);
    const A = await auth(request, env);
    if (!scopeOk(A, "publish", appId)) return json({ error: "not authorized" }, 401, AC);
    if (A && A.role === "guide") {
      const assigned = await env.DB.prepare(
        "SELECT 1 FROM project_guide WHERE project_id=? AND guide_id=? UNION SELECT 1 FROM project WHERE id=? AND guide_id=?"
      ).bind(pid, A.userId, pid, A.userId).first().catch(() => null);
      if (!assigned) return json({ error: "not assigned to this project" }, 403, AC);
    }
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "invalid JSON" }, 400, AC); }
    if (!body.zone || typeof body.zone !== "object") return json({ error: "zone object required" }, 400, AC);
    const isGuide = A && A.role === "guide";
    const ttlMs = isGuide ? 300000 : Math.min(Math.max(body.ttlMs || 300000, 30000), 3600000);
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const zoneId = body.zone.id || ("live_" + now.toString(36));
    const zone = { ...body.zone, id: zoneId, expiresAt };
    const guideId = isGuide ? A.userId : (A ? A.userId : null);
    await env.DB.prepare(
      "INSERT INTO live_zone (id, project_id, zone_json, expires_at, created_at, guide_id) VALUES (?,?,?,?,?,?)"
    ).bind(zoneId, pid, JSON.stringify(zone), expiresAt, now, guideId).run();
    return json({ ok: true, id: zoneId, expiresAt }, 200, AC);
  }

  // --- walker presence: ping (public POST) + fetch (public GET) ---
  const mp = path.match(/^\/api\/projects\/([^/]+)\/presence$/);
  if (mp) {
    const pid = decodeURIComponent(mp[1]);
    if (method === "POST") {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "invalid JSON" }, 400); }
      const { deviceId, lat, lon, label } = body;
      if (!deviceId || lat == null || lon == null) return json({ error: "deviceId, lat, lon required" }, 400);
      try {
        await env.DB.prepare(
          "INSERT INTO presence (device_id,project_id,lat,lon,label,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(device_id,project_id) DO UPDATE SET lat=excluded.lat,lon=excluded.lon,label=excluded.label,updated_at=excluded.updated_at"
        ).bind(deviceId, pid, lat, lon, label || null, Date.now()).run();
      } catch (e) { return json({ error: "presence unavailable" }, 503); }
      return json({ ok: true });
    }
    if (method === "GET") {
      let rows;
      try {
        rows = await env.DB.prepare(
          "SELECT device_id,lat,lon,label,updated_at FROM presence WHERE project_id=? AND updated_at > ?"
        ).bind(pid, Date.now() - 30000).all();
      } catch (e) { return json({ walkers: [] }); }
      return json({ walkers: rows.results || [] });
    }
  }

  // --- device register (public) ---
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

  // --- analytics ingest: idempotent batch, gated by consent ---
  if (path === "/api/events" && method === "POST") {
    // Size guard: reject payloads over 500 KB
    const body = await request.text();
    if (body.length > 500_000) return json({ error: "payload too large (max 500 KB)" }, 413);
    let b;
    try { b = JSON.parse(body); }
    catch (e) { return json({ error: "invalid JSON" }, 400); }
    if (!b.deviceId) return json({ error: "need deviceId" }, 400);
    const evs = Array.isArray(b.events) ? b.events : [];
    if (!evs.length) return json({ ok: true, accepted: 0 });
    const c = await env.DB.prepare(
      "SELECT granted FROM consent WHERE deviceId=? AND scope='store-history' ORDER BY grantedAt DESC LIMIT 1"
    ).bind(b.deviceId).first();
    if (!c || !c.granted) return json({ error: "no analytics consent on record" }, 403);
    const stmts = [];
    const linkToken = b.linkToken || null;
    for (const e of evs.slice(0, 500)) {
      const pid = e.projectId || b.projectId;
      if (!e.id || !pid) continue;
      stmts.push(env.DB.prepare(
        "INSERT OR IGNORE INTO event (id,projectId,userId,deviceId,type,ts,data,link_token) VALUES (?,?,?,?,?,?,?,?)"
      ).bind(e.id, pid, null, b.deviceId, e.type || "event", e.ts || Date.now(),
             typeof e.data === "string" ? e.data : JSON.stringify(e.data || {}), linkToken));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, accepted: stmts.length });
  }

  if (path === "/api/analytics" && method === "GET") {
    const pid = url.searchParams.get("project");
    if (!pid) return json({ error: "need project param" }, 400);
    const A = await auth(request, env);
    if (!scopeOk(A, "analytics", await projectAppId(env, pid))) return json({ error: "not authorized for this app's analytics" }, 401, AC);
    const lim = Math.min(parseInt(url.searchParams.get("limit") || "5000", 10) || 5000, 20000);
    const linkToken = url.searchParams.get("linkToken");
    const aConds = ["projectId=?"], aBinds = [pid];
    if (linkToken) { aConds.push("link_token=?"); aBinds.push(linkToken); }
    const { results } = await env.DB.prepare(
      "SELECT id,type,ts,deviceId,data,link_token FROM event WHERE " + aConds.join(" AND ") + " ORDER BY ts DESC LIMIT ?"
    ).bind(...aBinds, lim).all();
    return json({ project: pid, count: (results || []).length, events: results || [] }, 200, AC);
  }

  // --- list audio in R2 (scoped) ---
  // Three explicit modes — a bare call with no recognized param used to leak
  // the entire bucket (scopeOk's appOk check is vacuously true when
  // targetAppId is null), so every mode below now resolves a real appId or
  // requires master, on purpose.
  if (path === "/api/audio-list" && method === "GET") {
    if (!env.AUDIO) return json({ error: "no audio bucket bound" }, 500);
    const A = await auth(request, env);
    const pid = url.searchParams.get("project");
    const scope = url.searchParams.get("scope");

    if (pid) {
      const appId = await projectAppId(env, pid);
      if (!scopeOk(A, "audio", appId) && !scopeOk(A, "publish", appId)) return json({ error: "unauthorized" }, 401, AC);
      const objects = await listAllAudio(env, pid + "/");
      const { results: lz } = await env.DB.prepare(
        "SELECT zone_json, expires_at FROM live_zone WHERE project_id=? AND expires_at IS NOT NULL"
      ).bind(pid).all();
      const expiryByUrl = {};
      for (const row of (lz || [])) {
        try { const z = JSON.parse(row.zone_json); if (z.audioUrl) expiryByUrl[z.audioUrl] = row.expires_at; } catch (e) {}
      }
      return json({ scope: "project", project: pid, objects: objects.map(o => ({ ...o, expiresAt: expiryByUrl[o.url] || null })) }, 200, AC);
    }

    if (scope === "library") {
      // Library is shared across every project belonging to ONE company —
      // scoped by org (client id), not the whole bucket.
      const orgId = url.searchParams.get("org");
      if (!orgId) return json({ error: "?scope=library needs &org=<clientId>" }, 400);
      if (!(await libraryScopeOk(env, A, orgId))) return json({ error: "unauthorized" }, 401, AC);
      const folder = url.searchParams.get("folder") || "";
      if (folder.includes("/")) return json({ error: "library folders are flat — no nested paths" }, 400);
      const prefix = "library/" + orgId + "/" + (folder ? folder + "/" : "");
      let objects = [], folders = [], cursor;
      do {
        const l = await env.AUDIO.list({ prefix, delimiter: "/", cursor });
        objects = objects.concat(mapAudioObjs(l.objects));
        folders = folders.concat((l.delimitedPrefixes || []).map(p => p.slice(prefix.length, -1)));
        cursor = l.truncated ? l.cursor : undefined;
      } while (cursor);
      return json({ scope: "library", org: orgId, folder: folder || null, folders, objects }, 200, AC);
    }

    if (scope === "all") {
      if (!(await authed(request, env))) return json({ error: "master token required for the full bucket view" }, 401, AC);
      let objects = [], cursor;
      do {
        const l = await env.AUDIO.list({ cursor });
        objects = objects.concat(mapAudioObjs(l.objects));
        cursor = l.truncated ? l.cursor : undefined;
      } while (cursor);
      return json({ scope: "all", objects }, 200, AC);
    }

    return json({ error: "specify ?project=<id>, ?scope=library&org=<clientId>, or ?scope=all" }, 400, AC);
  }

  // --- delete an entire library folder (everything under it), org-scoped ---
  if (path === "/api/audio/folder" && method === "DELETE") {
    if (!env.AUDIO) return json({ error: "no audio bucket bound" }, 500);
    const A = await auth(request, env);
    const orgId = url.searchParams.get("org"), folder = url.searchParams.get("folder");
    if (!orgId || !folder) return json({ error: "need org and folder" }, 400);
    if (folder.includes("/")) return json({ error: "library folders are flat — no nested paths" }, 400);
    if (!(await libraryScopeOk(env, A, orgId))) return json({ error: "unauthorized" }, 401, AC);
    const prefix = "library/" + orgId + "/" + folder + "/";
    let deleted = 0, cursor;
    do {
      const l = await env.AUDIO.list({ prefix, cursor });
      if (l.objects.length) { await env.AUDIO.delete(l.objects.map(o => o.key)); deleted += l.objects.length; }
      cursor = l.truncated ? l.cursor : undefined;
    } while (cursor);
    await logAudit(env, request, A, "audio.folder.delete", prefix + " (" + deleted + " files)");
    return json({ ok: true, deleted, prefix }, 200, AC);
  }

  // --- move/rename a library file (any folder incl. root, same org), or rename a
  // project-owned file in place (same project only — it still can't change owners) ---
  if (path === "/api/audio/move" && method === "POST") {
    if (!env.AUDIO) return json({ error: "no audio bucket bound" }, 500);
    const A = await auth(request, env);
    const b = await request.json().catch(() => ({}));
    const from = (b.from || "").trim(), to = (b.to || "").trim();
    if (!from || !to) return json({ error: "need from and to" }, 400);
    if (from === to) return json({ error: "from and to are the same" }, 400);
    const fromParts = from.split("/"), toParts = to.split("/");
    const isLibrary = fromParts[0] === "library";
    if (isLibrary !== (toParts[0] === "library")) return json({ error: "can't move a file between the library and a project" }, 400);
    if (isLibrary) {
      if (fromParts[1] !== toParts[1]) return json({ error: "can't move a file to a different company's library" }, 400);
      if (toParts.length > 4) return json({ error: "library folders are flat — no nested paths" }, 400); // library/<org>/<folder?>/<file>
      if (!(await libraryScopeOk(env, A, fromParts[1]))) return json({ error: "unauthorized" }, 401, AC);
    } else {
      if (fromParts[0] !== toParts[0]) return json({ error: "project-owned clips can be renamed but not moved to a different project" }, 400);
      if (fromParts.length !== 2 || toParts.length !== 2) return json({ error: "project-owned clips are flat — no folders" }, 400);
      const appId = await projectAppId(env, fromParts[0]);
      if (!scopeOk(A, "audio", appId) && !scopeOk(A, "publish", appId)) return json({ error: "unauthorized" }, 401, AC);
    }
    // Check the source exists BEFORE checking for a destination conflict —
    // otherwise a stale/already-moved source still 409s ("replace it?"),
    // the user confirms, and only then does the real 404 surface.
    if (!(await env.AUDIO.head(from))) return json({ error: "source not found: " + from }, 404);
    const existing = await env.AUDIO.head(to);
    if (existing && !b.overwrite) return json({ error: "a file already exists at " + to }, 409);
    const obj = await env.AUDIO.get(from);
    if (!obj) return json({ error: "source not found: " + from }, 404);
    await env.AUDIO.put(to, obj.body, { httpMetadata: obj.httpMetadata });
    await env.AUDIO.delete(from);
    await logAudit(env, request, A, "audio.move", from + " -> " + to);
    return json({ ok: true, from, to, url: "/api/audio/" + to }, 200, AC);
  }

  // --- orphaned project audio: R2 objects under a project-id prefix whose
  // project no longer exists in D1. Library keys are never candidates —
  // they're excluded by construction (prefix check), not by allowlist. ---
  if (path === "/api/audio-orphans" && method === "GET") {
    if (!env.AUDIO) return json({ error: "no audio bucket bound" }, 500);
    if (!(await authed(request, env))) return json({ error: "master token required" }, 401, AC);
    const { results: projRows } = await env.DB.prepare("SELECT id FROM project").all();
    const liveIds = new Set((projRows || []).map(r => r.id));
    let objects = [], cursor;
    do {
      const l = await env.AUDIO.list({ cursor });
      objects = objects.concat(l.objects.map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded })));
      cursor = l.truncated ? l.cursor : undefined;
    } while (cursor);
    const groups = {};
    for (const o of objects) {
      const prefix = o.key.split("/")[0];
      // "clip" is the new stable-key prefix used by the audio tree (see
      // below) — never a real project id, so it must never be flagged as
      // an orphan group or a stray DELETE could wipe every tree-managed clip.
      if (!prefix || prefix === "library" || prefix === "clip" || liveIds.has(prefix)) continue;
      if (!groups[prefix]) groups[prefix] = { prefix, files: [], totalSize: 0, oldest: null, newest: null };
      const g = groups[prefix];
      g.files.push(o.key);
      g.totalSize += o.size;
      const t = new Date(o.uploaded).getTime();
      if (g.oldest === null || t < g.oldest) g.oldest = t;
      if (g.newest === null || t > g.newest) g.newest = t;
    }
    const SAFETY_MS = 24 * 60 * 60 * 1000; // don't flag anything touched in the last 24h as delete-safe
    const now = Date.now();
    const orphans = Object.values(groups).map(g => ({
      prefix: g.prefix, fileCount: g.files.length, totalSize: g.totalSize,
      oldestUploaded: g.oldest ? new Date(g.oldest).toISOString() : null,
      newestUploaded: g.newest ? new Date(g.newest).toISOString() : null,
      safeToDelete: g.newest !== null && (now - g.newest) > SAFETY_MS
    }));
    return json({ orphanPrefixes: orphans.length, orphans }, 200, AC);
  }

  // --- delete confirmed-orphaned project audio, by prefix (see GET above) ---
  if (path === "/api/audio-orphans" && method === "DELETE") {
    if (!env.AUDIO) return json({ error: "no audio bucket bound" }, 500);
    if (!(await authed(request, env))) return json({ error: "master token required" }, 401, AC);
    const b = await request.json().catch(() => ({}));
    const prefixes = Array.isArray(b.prefixes) ? b.prefixes : [];
    if (!prefixes.length) return json({ error: "need a non-empty prefixes array" }, 400);
    if (prefixes.some(p => !p || typeof p !== "string" || p === "library" || p === "clip" || p.includes("/")))
      return json({ error: "invalid prefix in list" }, 400);
    const { results: projRows } = await env.DB.prepare("SELECT id FROM project").all();
    const liveIds = new Set((projRows || []).map(r => r.id));
    const results = [];
    for (const prefix of prefixes) {
      if (liveIds.has(prefix)) { results.push({ prefix, skipped: "now a live project id" }); continue; }
      let deleted = 0, cursor;
      do {
        const l = await env.AUDIO.list({ prefix: prefix + "/", cursor });
        if (l.objects.length) { await env.AUDIO.delete(l.objects.map(o => o.key)); deleted += l.objects.length; }
        cursor = l.truncated ? l.cursor : undefined;
      } while (cursor);
      await logAudit(env, request, { keyId: "master" }, "audio.orphan.delete", prefix + " (" + deleted + " files)");
      results.push({ prefix, deleted });
    }
    return json({ ok: true, results }, 200, AC);
  }

  // --- audio tree: real nested folders for project clips + org Library,
  // backed by audio_folder/audio_clip (D1). R2 keys are permanent/opaque —
  // rename/move/copy below are metadata-only ops, never R2 key rewrites.
  // Deprecated during rollout, kept working alongside these: /api/audio-list,
  // /api/audio/move, DELETE /api/audio/folder (single flat level only). ---
  if (path === "/api/audio/tree" && method === "GET") {
    if (!env.AUDIO) return json({ error: "no audio bucket bound" }, 500);
    const A = await auth(request, env);
    const pid = url.searchParams.get("project");
    const scopeParam = url.searchParams.get("scope");

    if (pid) {
      // Mirrors the old /api/audio-list's permissive behavior: a project
      // that hasn't been published yet has no D1 row at all, but its
      // Fence-Editor-recorded clips are still real (Record/Upload work
      // pre-publish) — don't 404 just because the row doesn't exist yet.
      const proj = await env.DB.prepare("SELECT appId,orgId FROM project WHERE id=? OR slug=? LIMIT 1").bind(pid, pid).first();
      const appId = proj ? proj.appId : null;
      if (!scopeOk(A, "audio", appId) && !scopeOk(A, "publish", appId)) return json({ error: "unauthorized" }, 401, AC);
      const [pf, pc, ps, pscr] = await Promise.all([
        env.DB.prepare("SELECT id,parent_id AS parentId,name FROM audio_folder WHERE scope='project' AND scope_id=? ORDER BY name").bind(pid).all(),
        env.DB.prepare("SELECT id,folder_id AS folderId,name,r2_key AS r2Key,size_bytes AS sizeBytes,created_at AS createdAt FROM audio_clip WHERE scope='project' AND scope_id=? ORDER BY name").bind(pid).all(),
        // Timeline JSON is left out of the tree listing on purpose — it can
        // get large and the tree doesn't need it, only opening a session does.
        env.DB.prepare("SELECT id,folder_id AS folderId,name,updated_at AS updatedAt FROM studio_session WHERE scope='project' AND scope_id=? ORDER BY name").bind(pid).all(),
        // Same reasoning as sessions — script_json is left out, only opening a script needs it.
        env.DB.prepare("SELECT id,folder_id AS folderId,name,updated_at AS updatedAt FROM chatterbox_script WHERE scope='project' AND scope_id=? ORDER BY name").bind(pid).all()
      ]);
      // ?org= lets a caller pick the Library explicitly (Fence Editor's own
      // Customer dropdown, for a project that has no orgId yet) — falls back
      // to the project row's own orgId (Audio Studio's case) when omitted.
      const orgId = url.searchParams.get("org") || (proj && proj.orgId) || null;
      let library = null;
      if (orgId && (await libraryScopeOk(env, A, orgId))) {
        const [lf, lc] = await Promise.all([
          env.DB.prepare("SELECT id,parent_id AS parentId,name FROM audio_folder WHERE scope='library' AND scope_id=? ORDER BY name").bind(orgId).all(),
          env.DB.prepare("SELECT id,folder_id AS folderId,name,r2_key AS r2Key,size_bytes AS sizeBytes,created_at AS createdAt FROM audio_clip WHERE scope='library' AND scope_id=? ORDER BY name").bind(orgId).all()
        ]);
        library = {
          scope: "library", scopeId: orgId, folders: lf.results || [],
          clips: (lc.results || []).map(c => ({ ...c, url: "/api/audio/" + c.r2Key }))
        };
      }
      // Field Recorder's "live-stop" mode (temporary clips auto-deleted after
      // a TTL) annotates matching clips with expiresAt, same as the old
      // /api/audio-list — the Fence Editor's palette shows a countdown badge.
      const { results: lz } = await env.DB.prepare(
        "SELECT zone_json, expires_at FROM live_zone WHERE project_id=? AND expires_at IS NOT NULL"
      ).bind(pid).all();
      const expiryByUrl = {};
      for (const row of (lz || [])) {
        try { const z = JSON.parse(row.zone_json); if (z.audioUrl) expiryByUrl[z.audioUrl] = row.expires_at; } catch (e) {}
      }
      return json({
        project: {
          scope: "project", scopeId: pid, folders: pf.results || [],
          clips: (pc.results || []).map(c => { const clipUrl = "/api/audio/" + c.r2Key; return { ...c, url: clipUrl, expiresAt: expiryByUrl[clipUrl] || null }; }),
          sessions: ps.results || [],
          scripts: pscr.results || []
        },
        library
      }, 200, AC);
    }

    if (scopeParam === "library") {
      const libOrgId = url.searchParams.get("org");
      if (!libOrgId) return json({ error: "?scope=library needs &org=<clientId>" }, 400, AC);
      if (!(await libraryScopeOk(env, A, libOrgId))) return json({ error: "unauthorized" }, 401, AC);
      const [lf, lc] = await Promise.all([
        env.DB.prepare("SELECT id,parent_id AS parentId,name FROM audio_folder WHERE scope='library' AND scope_id=? ORDER BY name").bind(libOrgId).all(),
        env.DB.prepare("SELECT id,folder_id AS folderId,name,r2_key AS r2Key,size_bytes AS sizeBytes,created_at AS createdAt FROM audio_clip WHERE scope='library' AND scope_id=? ORDER BY name").bind(libOrgId).all()
      ]);
      return json({
        library: {
          scope: "library", scopeId: libOrgId, folders: lf.results || [],
          clips: (lc.results || []).map(c => ({ ...c, url: "/api/audio/" + c.r2Key }))
        }
      }, 200, AC);
    }

    return json({ error: "specify ?project=<id> or ?scope=library&org=<clientId>" }, 400, AC);
  }

  if (path === "/api/audio-folder" && method === "POST") {
    const A = await auth(request, env);
    const b = await request.json().catch(() => ({}));
    const scope = b.scope, scopeId = (b.scopeId || "").trim(), name = (b.name || "").trim();
    const parentId = b.parentId || null;
    if (!["project", "library"].includes(scope)) return json({ error: "scope must be 'project' or 'library'" }, 400, AC);
    if (!scopeId || !name) return json({ error: "scopeId and name required" }, 400, AC);
    if (name.includes("/")) return json({ error: "folder name can't contain /" }, 400, AC);
    if (!(await audioScopeAuthOk(env, A, scope, scopeId))) return json({ error: "unauthorized" }, 401, AC);
    if (parentId) {
      const parent = await env.DB.prepare("SELECT id FROM audio_folder WHERE id=? AND scope=? AND scope_id=?").bind(parentId, scope, scopeId).first();
      if (!parent) return json({ error: "parent folder not found in this scope" }, 404, AC);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO audio_folder (id,scope,scope_id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .bind(id, scope, scopeId, parentId, name, now, now).run();
    await logAudit(env, request, A, "audio.folder.create", scope + "/" + scopeId + "/" + name);
    return json({ id, scope, scopeId, parentId, name }, 201, AC);
  }

  const mFolderCopy = path.match(/^\/api\/audio-folder\/([^/]+)\/copy$/);
  if (mFolderCopy && method === "POST") {
    const folderId = decodeURIComponent(mFolderCopy[1]);
    const A = await auth(request, env);
    const src = await env.DB.prepare("SELECT scope,scope_id AS scopeId FROM audio_folder WHERE id=?").bind(folderId).first();
    if (!src) return json({ error: "folder not found" }, 404, AC);
    if (!(await audioScopeAuthOk(env, A, src.scope, src.scopeId))) return json({ error: "unauthorized" }, 401, AC);
    const b = await request.json().catch(() => ({}));
    const targetScope = b.targetScope || src.scope;
    const targetScopeId = b.targetScopeId || src.scopeId;
    const targetParentId = b.targetParentId || null;
    if (!["project", "library"].includes(targetScope)) return json({ error: "invalid targetScope" }, 400, AC);
    if (!(await audioScopeAuthOk(env, A, targetScope, targetScopeId))) return json({ error: "unauthorized on target" }, 401, AC);
    if (targetParentId) {
      const parent = await env.DB.prepare("SELECT id FROM audio_folder WHERE id=? AND scope=? AND scope_id=?").bind(targetParentId, targetScope, targetScopeId).first();
      if (!parent) return json({ error: "target parent folder not found" }, 404, AC);
    }
    try {
      const newId = await copyFolderSubtree(env, folderId, src.scope, src.scopeId, targetScope, targetScopeId, targetParentId);
      await logAudit(env, request, A, "audio.folder.copy", folderId + " -> " + newId);
      return json({ id: newId }, 201, AC);
    } catch (e) {
      return json({ error: "copy failed: " + e.message }, 500, AC);
    }
  }

  const mFolder = path.match(/^\/api\/audio-folder\/([^/]+)$/);
  if (mFolder && (method === "PATCH" || method === "DELETE")) {
    const folderId = decodeURIComponent(mFolder[1]);
    const A = await auth(request, env);
    const row = await env.DB.prepare("SELECT scope,scope_id AS scopeId,parent_id AS parentId,name FROM audio_folder WHERE id=?").bind(folderId).first();
    if (!row) return json({ error: "folder not found" }, 404, AC);
    if (!(await audioScopeAuthOk(env, A, row.scope, row.scopeId))) return json({ error: "unauthorized" }, 401, AC);

    if (method === "DELETE") {
      const folderIds = await collectFolderSubtree(env, row.scope, row.scopeId, folderId);
      const fph = folderIds.map(() => "?").join(",");
      const { results: clips } = await env.DB.prepare(
        `SELECT id,r2_key FROM audio_clip WHERE scope=? AND scope_id=? AND folder_id IN (${fph})`
      ).bind(row.scope, row.scopeId, ...folderIds).all();
      for (const c of (clips || [])) await env.AUDIO.delete(c.r2_key).catch(() => {});
      if ((clips || []).length) {
        const cph = clips.map(() => "?").join(",");
        await env.DB.prepare(`DELETE FROM audio_clip WHERE id IN (${cph})`).bind(...clips.map(c => c.id)).run();
      }
      await env.DB.prepare(`DELETE FROM studio_session WHERE scope=? AND scope_id=? AND folder_id IN (${fph})`)
        .bind(row.scope, row.scopeId, ...folderIds).run();
      await env.DB.prepare(`DELETE FROM chatterbox_script WHERE scope=? AND scope_id=? AND folder_id IN (${fph})`)
        .bind(row.scope, row.scopeId, ...folderIds).run();
      await env.DB.prepare(`DELETE FROM audio_folder WHERE id IN (${fph})`).bind(...folderIds).run();
      await logAudit(env, request, A, "audio.folder.delete", folderId + " (" + (clips || []).length + " clips)");
      return json({ ok: true, deletedFolders: folderIds.length, deletedClips: (clips || []).length }, 200, AC);
    }

    const b = await request.json().catch(() => ({}));
    let name = row.name;
    if (b.name !== undefined) {
      if (!b.name.trim() || b.name.includes("/")) return json({ error: "invalid name" }, 400, AC);
      name = b.name.trim();
    }

    const targetScope = b.targetScope || row.scope;
    const targetScopeId = b.targetScopeId || row.scopeId;
    const crossScope = targetScope !== row.scope || targetScopeId !== row.scopeId;

    if (crossScope) {
      if (!["project", "library"].includes(targetScope)) return json({ error: "invalid targetScope" }, 400, AC);
      if (!(await audioScopeAuthOk(env, A, targetScope, targetScopeId))) return json({ error: "unauthorized on target" }, 401, AC);
      const newParentId = b.parentId !== undefined ? (b.parentId || null) : null;
      if (newParentId) {
        const parent = await env.DB.prepare("SELECT id FROM audio_folder WHERE id=? AND scope=? AND scope_id=?").bind(newParentId, targetScope, targetScopeId).first();
        if (!parent) return json({ error: "target parent folder not found" }, 404, AC);
      }
      await rescopeFolderSubtree(env, folderId, row.scope, row.scopeId, targetScope, targetScopeId, newParentId);
      if (name !== row.name) await env.DB.prepare("UPDATE audio_folder SET name=?, updated_at=? WHERE id=?").bind(name, new Date().toISOString(), folderId).run();
      await logAudit(env, request, A, "audio.folder.move", folderId + " " + row.scope + "/" + row.scopeId + " -> " + targetScope + "/" + targetScopeId);
      return json({ id: folderId, name, parentId: newParentId, scope: targetScope, scopeId: targetScopeId }, 200, AC);
    }

    let parentId = row.parentId;
    if (b.parentId !== undefined) {
      const newParentId = b.parentId || null;
      if (newParentId) {
        const parent = await env.DB.prepare("SELECT id FROM audio_folder WHERE id=? AND scope=? AND scope_id=?").bind(newParentId, row.scope, row.scopeId).first();
        if (!parent) return json({ error: "parent folder not found in this scope" }, 404, AC);
        if (await wouldCreateCycle(env, folderId, newParentId)) return json({ error: "can't move a folder into its own subtree" }, 400, AC);
      }
      parentId = newParentId;
    }
    await env.DB.prepare("UPDATE audio_folder SET name=?, parent_id=?, updated_at=? WHERE id=?")
      .bind(name, parentId, new Date().toISOString(), folderId).run();
    await logAudit(env, request, A, "audio.folder.update", folderId);
    return json({ id: folderId, name, parentId, scope: row.scope, scopeId: row.scopeId }, 200, AC);
  }

  if (path === "/api/audio-clip" && method === "POST") {
    if (!env.AUDIO) return json({ error: "no audio bucket bound" }, 500);
    const A = await auth(request, env);
    const scope = url.searchParams.get("scope");
    const scopeId = (url.searchParams.get("scopeId") || "").trim();
    const folderId = url.searchParams.get("folderId") || null;
    const name = (url.searchParams.get("name") || "").trim();
    if (!["project", "library"].includes(scope)) return json({ error: "scope must be 'project' or 'library'" }, 400, AC);
    if (!scopeId || !name) return json({ error: "scopeId and name required" }, 400, AC);
    if (name.includes("/")) return json({ error: "clip name can't contain /" }, 400, AC);
    if (!(await audioScopeAuthOk(env, A, scope, scopeId))) return json({ error: "unauthorized" }, 401, AC);
    if (folderId) {
      const folder = await env.DB.prepare("SELECT id FROM audio_folder WHERE id=? AND scope=? AND scope_id=?").bind(folderId, scope, scopeId).first();
      if (!folder) return json({ error: "folder not found in this scope" }, 404, AC);
    }
    const ext = (name.match(/\.[^.]+$/) || [""])[0];
    const r2Key = "clip/" + crypto.randomUUID() + ext;
    const ct = request.headers.get("content-type") || "application/octet-stream";
    const buf = await request.arrayBuffer();
    await env.AUDIO.put(r2Key, buf, { httpMetadata: { contentType: ct } });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO audio_clip (id,scope,scope_id,folder_id,name,r2_key,size_bytes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
    ).bind(id, scope, scopeId, folderId, name, r2Key, buf.byteLength, now, now).run();
    await logAudit(env, request, A, "audio.clip.create", scope + "/" + scopeId + "/" + name);
    return json({ id, name, folderId, r2Key, url: "/api/audio/" + r2Key }, 201, AC);
  }

  const mClipCopy = path.match(/^\/api\/audio-clip\/([^/]+)\/copy$/);
  if (mClipCopy && method === "POST") {
    if (!env.AUDIO) return json({ error: "no audio bucket bound" }, 500);
    const clipId = decodeURIComponent(mClipCopy[1]);
    const A = await auth(request, env);
    const row = await env.DB.prepare(
      "SELECT scope,scope_id AS scopeId,folder_id AS folderId,name,r2_key AS r2Key FROM audio_clip WHERE id=?"
    ).bind(clipId).first();
    if (!row) return json({ error: "clip not found" }, 404, AC);
    if (!(await audioScopeAuthOk(env, A, row.scope, row.scopeId))) return json({ error: "unauthorized" }, 401, AC);
    const b = await request.json().catch(() => ({}));
    const targetScope = b.targetScope || row.scope;
    const targetScopeId = b.targetScopeId || row.scopeId;
    const targetFolderId = b.targetFolderId !== undefined ? (b.targetFolderId || null) : row.folderId;
    if (!["project", "library"].includes(targetScope)) return json({ error: "invalid targetScope" }, 400, AC);
    if (!(await audioScopeAuthOk(env, A, targetScope, targetScopeId))) return json({ error: "unauthorized on target" }, 401, AC);
    if (targetFolderId) {
      const folder = await env.DB.prepare("SELECT id FROM audio_folder WHERE id=? AND scope=? AND scope_id=?").bind(targetFolderId, targetScope, targetScopeId).first();
      if (!folder) return json({ error: "target folder not found" }, 404, AC);
    }
    try {
      const newId = await copyClipRow(env, { name: row.name, r2_key: row.r2Key }, targetScope, targetScopeId, targetFolderId, b.name);
      await logAudit(env, request, A, "audio.clip.copy", clipId + " -> " + newId);
      return json({ id: newId }, 201, AC);
    } catch (e) {
      return json({ error: "copy failed: " + e.message }, 500, AC);
    }
  }

  const mClip = path.match(/^\/api\/audio-clip\/([^/]+)$/);
  if (mClip && (method === "PATCH" || method === "DELETE")) {
    if (!env.AUDIO) return json({ error: "no audio bucket bound" }, 500);
    const clipId = decodeURIComponent(mClip[1]);
    const A = await auth(request, env);
    const row = await env.DB.prepare(
      "SELECT scope,scope_id AS scopeId,folder_id AS folderId,name,r2_key AS r2Key FROM audio_clip WHERE id=?"
    ).bind(clipId).first();
    if (!row) return json({ error: "clip not found" }, 404, AC);
    if (!(await audioScopeAuthOk(env, A, row.scope, row.scopeId))) return json({ error: "unauthorized" }, 401, AC);

    if (method === "DELETE") {
      await env.AUDIO.delete(row.r2Key).catch(() => {});
      await env.DB.prepare("DELETE FROM audio_clip WHERE id=?").bind(clipId).run();
      await logAudit(env, request, A, "audio.clip.delete", clipId);
      return json({ ok: true, deleted: clipId }, 200, AC);
    }

    const b = await request.json().catch(() => ({}));
    let name = row.name, folderId = row.folderId, scope = row.scope, scopeId = row.scopeId;
    if (b.scope !== undefined || b.scopeId !== undefined) {
      scope = b.scope || row.scope;
      scopeId = b.scopeId || row.scopeId;
      if (!["project", "library"].includes(scope)) return json({ error: "invalid scope" }, 400, AC);
      if (!(await audioScopeAuthOk(env, A, scope, scopeId))) return json({ error: "unauthorized on target scope" }, 401, AC);
      folderId = null; // scope changed — target folder (if any) must be re-specified below
    }
    if (b.name !== undefined) {
      if (!b.name.trim() || b.name.includes("/")) return json({ error: "invalid name" }, 400, AC);
      name = b.name.trim();
    }
    if (b.folderId !== undefined) folderId = b.folderId || null;
    if (folderId) {
      const folder = await env.DB.prepare("SELECT id FROM audio_folder WHERE id=? AND scope=? AND scope_id=?").bind(folderId, scope, scopeId).first();
      if (!folder) return json({ error: "folder not found in target scope" }, 404, AC);
    }
    await env.DB.prepare("UPDATE audio_clip SET name=?, folder_id=?, scope=?, scope_id=?, updated_at=? WHERE id=?")
      .bind(name, folderId, scope, scopeId, new Date().toISOString(), clipId).run();
    await logAudit(env, request, A, "audio.clip.update", clipId);
    return json({ id: clipId, name, folderId, scope, scopeId }, 200, AC);
  }

  // --- Studio sessions: saved timeline arrangements (which clips, trim
  // points, fades, gain, spatial filter — never raw audio), organized in the
  // same audio_folder tree as clips so an Act/Scene structure is just
  // regular folders with a session saved inside each scene. Always
  // scope='project' — there's no such thing as a Library session. ---
  if (path === "/api/studio-session" && method === "POST") {
    const A = await auth(request, env);
    const b = await request.json().catch(() => ({}));
    const scopeId = (b.scopeId || "").trim(), name = (b.name || "").trim();
    const folderId = b.folderId || null;
    if (!scopeId || !name) return json({ error: "scopeId and name required" }, 400, AC);
    if (!b.timeline || typeof b.timeline !== "object") return json({ error: "timeline required" }, 400, AC);
    if (!(await audioScopeAuthOk(env, A, "project", scopeId))) return json({ error: "unauthorized" }, 401, AC);
    if (folderId) {
      const folder = await env.DB.prepare("SELECT id FROM audio_folder WHERE id=? AND scope='project' AND scope_id=?").bind(folderId, scopeId).first();
      if (!folder) return json({ error: "folder not found in this project" }, 404, AC);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO studio_session (id,scope,scope_id,folder_id,name,timeline_json,created_at,updated_at) VALUES (?,'project',?,?,?,?,?,?)"
    ).bind(id, scopeId, folderId, name, JSON.stringify(b.timeline), now, now).run();
    await logAudit(env, request, A, "studio.session.create", scopeId + "/" + name);
    return json({ id, name, folderId }, 201, AC);
  }

  const mSessionCopy = path.match(/^\/api\/studio-session\/([^/]+)\/copy$/);
  if (mSessionCopy && method === "POST") {
    const sessionId = decodeURIComponent(mSessionCopy[1]);
    const A = await auth(request, env);
    const row = await env.DB.prepare("SELECT scope_id AS scopeId,folder_id AS folderId,name,timeline_json AS timelineJson FROM studio_session WHERE id=?").bind(sessionId).first();
    if (!row) return json({ error: "session not found" }, 404, AC);
    if (!(await audioScopeAuthOk(env, A, "project", row.scopeId))) return json({ error: "unauthorized" }, 401, AC);
    const b = await request.json().catch(() => ({}));
    const targetFolderId = b.targetFolderId !== undefined ? (b.targetFolderId || null) : row.folderId;
    if (targetFolderId) {
      const folder = await env.DB.prepare("SELECT id FROM audio_folder WHERE id=? AND scope='project' AND scope_id=?").bind(targetFolderId, row.scopeId).first();
      if (!folder) return json({ error: "target folder not found" }, 404, AC);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO studio_session (id,scope,scope_id,folder_id,name,timeline_json,created_at,updated_at) VALUES (?,'project',?,?,?,?,?,?)"
    ).bind(id, row.scopeId, targetFolderId, b.name || row.name, row.timelineJson, now, now).run();
    await logAudit(env, request, A, "studio.session.copy", sessionId + " -> " + id);
    return json({ id }, 201, AC);
  }

  const mSession = path.match(/^\/api\/studio-session\/([^/]+)$/);
  if (mSession && (method === "GET" || method === "PATCH" || method === "DELETE")) {
    const sessionId = decodeURIComponent(mSession[1]);
    const A = await auth(request, env);
    const row = await env.DB.prepare(
      "SELECT scope_id AS scopeId,folder_id AS folderId,name,timeline_json AS timelineJson FROM studio_session WHERE id=?"
    ).bind(sessionId).first();
    if (!row) return json({ error: "session not found" }, 404, AC);
    if (!(await audioScopeAuthOk(env, A, "project", row.scopeId))) return json({ error: "unauthorized" }, 401, AC);

    if (method === "GET") {
      let timeline;
      try { timeline = JSON.parse(row.timelineJson); } catch (e) { return json({ error: "stored session is corrupt" }, 500, AC); }
      return json({ id: sessionId, name: row.name, folderId: row.folderId, scopeId: row.scopeId, timeline }, 200, AC);
    }

    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM studio_session WHERE id=?").bind(sessionId).run();
      await logAudit(env, request, A, "studio.session.delete", sessionId);
      return json({ ok: true, deleted: sessionId }, 200, AC);
    }

    const b = await request.json().catch(() => ({}));
    let name = row.name, folderId = row.folderId, timelineJson = row.timelineJson;
    if (b.name !== undefined) {
      if (!b.name.trim()) return json({ error: "invalid name" }, 400, AC);
      name = b.name.trim();
    }
    if (b.folderId !== undefined) {
      const newFolderId = b.folderId || null;
      if (newFolderId) {
        const folder = await env.DB.prepare("SELECT id FROM audio_folder WHERE id=? AND scope='project' AND scope_id=?").bind(newFolderId, row.scopeId).first();
        if (!folder) return json({ error: "folder not found in this project" }, 404, AC);
      }
      folderId = newFolderId;
    }
    if (b.timeline !== undefined) {
      if (typeof b.timeline !== "object") return json({ error: "invalid timeline" }, 400, AC);
      timelineJson = JSON.stringify(b.timeline);
    }
    await env.DB.prepare("UPDATE studio_session SET name=?, folder_id=?, timeline_json=?, updated_at=? WHERE id=?")
      .bind(name, folderId, timelineJson, new Date().toISOString(), sessionId).run();
    await logAudit(env, request, A, "studio.session.update", sessionId);
    return json({ id: sessionId, name, folderId }, 200, AC);
  }

  // --- Chatterbox scripts: saved script text + per-line voice tagging +
  // generated-audio-URL state, organized in the same audio_folder tree the
  // rendered clips themselves save into — a straight parallel of Studio
  // Sessions above (script_json in place of timeline_json), so a play's
  // Act/Scene structure holds the script that generated each scene's lines
  // right alongside the clips it produced. Always scope='project'. ---
  if (path === "/api/chatterbox-script" && method === "POST") {
    const A = await auth(request, env);
    const b = await request.json().catch(() => ({}));
    const scopeId = (b.scopeId || "").trim(), name = (b.name || "").trim();
    const folderId = b.folderId || null;
    if (!scopeId || !name) return json({ error: "scopeId and name required" }, 400, AC);
    if (!b.script || typeof b.script !== "object") return json({ error: "script required" }, 400, AC);
    if (!(await audioScopeAuthOk(env, A, "project", scopeId))) return json({ error: "unauthorized" }, 401, AC);
    if (folderId) {
      const folder = await env.DB.prepare("SELECT id FROM audio_folder WHERE id=? AND scope='project' AND scope_id=?").bind(folderId, scopeId).first();
      if (!folder) return json({ error: "folder not found in this project" }, 404, AC);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO chatterbox_script (id,scope,scope_id,folder_id,name,script_json,created_at,updated_at) VALUES (?,'project',?,?,?,?,?,?)"
    ).bind(id, scopeId, folderId, name, JSON.stringify(b.script), now, now).run();
    await logAudit(env, request, A, "chatterbox.script.create", scopeId + "/" + name);
    return json({ id, name, folderId }, 201, AC);
  }

  const mScriptCopy = path.match(/^\/api\/chatterbox-script\/([^/]+)\/copy$/);
  if (mScriptCopy && method === "POST") {
    const scriptId = decodeURIComponent(mScriptCopy[1]);
    const A = await auth(request, env);
    const row = await env.DB.prepare("SELECT scope_id AS scopeId,folder_id AS folderId,name,script_json AS scriptJson FROM chatterbox_script WHERE id=?").bind(scriptId).first();
    if (!row) return json({ error: "script not found" }, 404, AC);
    if (!(await audioScopeAuthOk(env, A, "project", row.scopeId))) return json({ error: "unauthorized" }, 401, AC);
    const b = await request.json().catch(() => ({}));
    const targetFolderId = b.targetFolderId !== undefined ? (b.targetFolderId || null) : row.folderId;
    if (targetFolderId) {
      const folder = await env.DB.prepare("SELECT id FROM audio_folder WHERE id=? AND scope='project' AND scope_id=?").bind(targetFolderId, row.scopeId).first();
      if (!folder) return json({ error: "target folder not found" }, 404, AC);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO chatterbox_script (id,scope,scope_id,folder_id,name,script_json,created_at,updated_at) VALUES (?,'project',?,?,?,?,?,?)"
    ).bind(id, row.scopeId, targetFolderId, b.name || row.name, row.scriptJson, now, now).run();
    await logAudit(env, request, A, "chatterbox.script.copy", scriptId + " -> " + id);
    return json({ id }, 201, AC);
  }

  const mScript = path.match(/^\/api\/chatterbox-script\/([^/]+)$/);
  if (mScript && (method === "GET" || method === "PATCH" || method === "DELETE")) {
    const scriptId = decodeURIComponent(mScript[1]);
    const A = await auth(request, env);
    const row = await env.DB.prepare(
      "SELECT scope_id AS scopeId,folder_id AS folderId,name,script_json AS scriptJson FROM chatterbox_script WHERE id=?"
    ).bind(scriptId).first();
    if (!row) return json({ error: "script not found" }, 404, AC);
    if (!(await audioScopeAuthOk(env, A, "project", row.scopeId))) return json({ error: "unauthorized" }, 401, AC);

    if (method === "GET") {
      let script;
      try { script = JSON.parse(row.scriptJson); } catch (e) { return json({ error: "stored script is corrupt" }, 500, AC); }
      return json({ id: scriptId, name: row.name, folderId: row.folderId, scopeId: row.scopeId, script }, 200, AC);
    }

    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM chatterbox_script WHERE id=?").bind(scriptId).run();
      await logAudit(env, request, A, "chatterbox.script.delete", scriptId);
      return json({ ok: true, deleted: scriptId }, 200, AC);
    }

    const b = await request.json().catch(() => ({}));
    let name = row.name, folderId = row.folderId, scriptJson = row.scriptJson;
    if (b.name !== undefined) {
      if (!b.name.trim()) return json({ error: "invalid name" }, 400, AC);
      name = b.name.trim();
    }
    if (b.folderId !== undefined) {
      const newFolderId = b.folderId || null;
      if (newFolderId) {
        const folder = await env.DB.prepare("SELECT id FROM audio_folder WHERE id=? AND scope='project' AND scope_id=?").bind(newFolderId, row.scopeId).first();
        if (!folder) return json({ error: "folder not found in this project" }, 404, AC);
      }
      folderId = newFolderId;
    }
    if (b.script !== undefined) {
      if (typeof b.script !== "object") return json({ error: "invalid script" }, 400, AC);
      scriptJson = JSON.stringify(b.script);
    }
    await env.DB.prepare("UPDATE chatterbox_script SET name=?, folder_id=?, script_json=?, updated_at=? WHERE id=?")
      .bind(name, folderId, scriptJson, new Date().toISOString(), scriptId).run();
    await logAudit(env, request, A, "chatterbox.script.update", scriptId);
    return json({ id: scriptId, name, folderId }, 200, AC);
  }

  // --- Walking paths: a recorded, filtered GPS trail (Field Recorder), saved
  // at the app (workspace) level so one path is reusable across every
  // project in that workspace — not project-scoped like every other tree in
  // this app. Flat list, no folders (confirmed with the user). The list
  // endpoint omits points_json (same "leave the heavy payload out of the
  // list" convention as studio_session/chatterbox_script); GET by id is
  // public/no-auth since the anonymous visitor-facing engine needs to fetch
  // a published project's path with no session token, same as the bundle
  // read itself. ---
  if (path === "/api/walking-path" && method === "POST") {
    const A = await auth(request, env);
    const b = await request.json().catch(() => ({}));
    const appId = (b.appId || "").trim(), name = (b.name || "").trim();
    const folderId = b.folderId || null;
    if (!appId || !name) return json({ error: "appId and name required" }, 400, AC);
    if (!Array.isArray(b.points) || b.points.length < 2) return json({ error: "points (array of [lon,lat]) required" }, 400, AC);
    if (!(await appScopeAuthOk(env, A, appId))) return json({ error: "unauthorized" }, 401, AC);
    if (folderId) {
      const folder = await env.DB.prepare("SELECT id FROM walking_path_folder WHERE id=? AND app_id=?").bind(folderId, appId).first();
      if (!folder) return json({ error: "folder not found" }, 404, AC);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO walking_path (id,app_id,folder_id,name,points_json,distance_m,elev_gain_m,elev_loss_m,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).bind(id, appId, folderId, name, JSON.stringify(b.points), b.distanceM || 0, b.elevGainM || 0, b.elevLossM || 0, now, now).run();
    await logAudit(env, request, A, "walkingpath.create", appId + "/" + name);
    return json({ id, name, folderId }, 201, AC);
  }

  if (path === "/api/walking-path" && method === "GET") {
    const A = await auth(request, env);
    const appId = (url.searchParams.get("appId") || "").trim();
    if (!appId) return json({ error: "appId required" }, 400, AC);
    if (!(await appScopeAuthOk(env, A, appId))) return json({ error: "unauthorized" }, 401, AC);
    const { results } = await env.DB.prepare(
      "SELECT id,folder_id AS folderId,name,distance_m AS distanceM,elev_gain_m AS elevGainM,elev_loss_m AS elevLossM,updated_at AS updatedAt FROM walking_path WHERE app_id=? ORDER BY name"
    ).bind(appId).all();
    return json({ paths: results || [] }, 200, AC);
  }

  const mWalkingPath = path.match(/^\/api\/walking-path\/([^/]+)$/);
  if (mWalkingPath && (method === "GET" || method === "PATCH" || method === "DELETE")) {
    const pathId = decodeURIComponent(mWalkingPath[1]);
    const row = await env.DB.prepare(
      "SELECT app_id AS appId,folder_id AS folderId,name,points_json AS pointsJson,distance_m AS distanceM,elev_gain_m AS elevGainM,elev_loss_m AS elevLossM FROM walking_path WHERE id=?"
    ).bind(pathId).first();
    if (!row) return json({ error: "walking path not found" }, 404, AC);

    if (method === "GET") {
      // Public — the live engine (no visitor session) needs to fetch this
      // for a published, path-driven project.
      let points;
      try { points = JSON.parse(row.pointsJson); } catch (e) { return json({ error: "stored path is corrupt" }, 500, AC); }
      return json({ id: pathId, name: row.name, appId: row.appId, folderId: row.folderId, distanceM: row.distanceM, elevGainM: row.elevGainM, elevLossM: row.elevLossM, points }, 200, AC);
    }

    const A = await auth(request, env);
    if (!(await appScopeAuthOk(env, A, row.appId))) return json({ error: "unauthorized" }, 401, AC);

    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM walking_path WHERE id=?").bind(pathId).run();
      await logAudit(env, request, A, "walkingpath.delete", pathId);
      return json({ ok: true, deleted: pathId }, 200, AC);
    }

    const b = await request.json().catch(() => ({}));
    let name = row.name, folderId = row.folderId;
    if (b.name !== undefined) {
      if (!b.name.trim()) return json({ error: "invalid name" }, 400, AC);
      name = b.name.trim();
    }
    if (b.folderId !== undefined) {
      const newFolderId = b.folderId || null;
      if (newFolderId) {
        const folder = await env.DB.prepare("SELECT id FROM walking_path_folder WHERE id=? AND app_id=?").bind(newFolderId, row.appId).first();
        if (!folder) return json({ error: "folder not found" }, 404, AC);
      }
      folderId = newFolderId;
    }
    await env.DB.prepare("UPDATE walking_path SET name=?, folder_id=?, updated_at=? WHERE id=?")
      .bind(name, folderId, new Date().toISOString(), pathId).run();
    await logAudit(env, request, A, "walkingpath.update", pathId);
    return json({ id: pathId, name, folderId }, 200, AC);
  }

  // --- Walking path folders: same tree shape as stop_folder, but app-scoped
  // to match walking_path itself (see above). Deleting a folder cascades to
  // every path inside its subtree, same convention as audio_folder deletes
  // cascading to clips — move paths out first if they should survive. ---
  async function collectWalkingPathFolderSubtreeIds(env, rootId) {
    const ids = [rootId]; let frontier = [rootId];
    while (frontier.length) {
      const ph = frontier.map(() => "?").join(",");
      const { results } = await env.DB.prepare(`SELECT id FROM walking_path_folder WHERE parent_id IN (${ph})`).bind(...frontier).all();
      frontier = (results || []).map(r => r.id);
      ids.push(...frontier);
    }
    return ids;
  }

  if (path === "/api/walking-path-folder" && method === "GET") {
    const A = await auth(request, env);
    const appId = (url.searchParams.get("appId") || "").trim();
    if (!appId) return json({ error: "appId required" }, 400, AC);
    if (!(await appScopeAuthOk(env, A, appId))) return json({ error: "unauthorized" }, 401, AC);
    const { results } = await env.DB.prepare(
      "SELECT id,parent_id AS parentId,name FROM walking_path_folder WHERE app_id=? ORDER BY name"
    ).bind(appId).all();
    return json({ folders: results || [] }, 200, AC);
  }

  if (path === "/api/walking-path-folder" && method === "POST") {
    const A = await auth(request, env);
    const b = await request.json().catch(() => ({}));
    const appId = (b.appId || "").trim(), name = (b.name || "").trim();
    const parentId = b.parentId || null;
    if (!appId || !name) return json({ error: "appId and name required" }, 400, AC);
    if (name.includes("/")) return json({ error: "folder name can't contain /" }, 400, AC);
    if (!(await appScopeAuthOk(env, A, appId))) return json({ error: "unauthorized" }, 401, AC);
    if (parentId) {
      const parent = await env.DB.prepare("SELECT id FROM walking_path_folder WHERE id=? AND app_id=?").bind(parentId, appId).first();
      if (!parent) return json({ error: "parent folder not found" }, 404, AC);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO walking_path_folder (id,app_id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .bind(id, appId, parentId, name, now, now).run();
    await logAudit(env, request, A, "walkingpathfolder.create", appId + "/" + name);
    return json({ id, appId, parentId, name }, 201, AC);
  }

  const mWalkingPathFolder = path.match(/^\/api\/walking-path-folder\/([^/]+)$/);
  if (mWalkingPathFolder && (method === "PATCH" || method === "DELETE")) {
    const folderId = decodeURIComponent(mWalkingPathFolder[1]);
    const A = await auth(request, env);
    const row = await env.DB.prepare("SELECT app_id AS appId,parent_id AS parentId,name FROM walking_path_folder WHERE id=?").bind(folderId).first();
    if (!row) return json({ error: "folder not found" }, 404, AC);
    if (!(await appScopeAuthOk(env, A, row.appId))) return json({ error: "unauthorized" }, 401, AC);

    if (method === "DELETE") {
      // Unlike audio_folder (cascade-deletes clips), a walking path is a
      // physically-recorded field walk — expensive to redo, not just
      // re-uploadable. Move any paths in the deleted subtree up to this
      // folder's own parent instead of destroying them, same as
      // stop_folder does for zones on folder delete.
      const folderIds = await collectWalkingPathFolderSubtreeIds(env, folderId);
      const fph = folderIds.map(() => "?").join(",");
      const { meta } = await env.DB.prepare(
        `UPDATE walking_path SET folder_id=?, updated_at=? WHERE app_id=? AND folder_id IN (${fph})`
      ).bind(row.parentId, new Date().toISOString(), row.appId, ...folderIds).run();
      await env.DB.prepare(`DELETE FROM walking_path_folder WHERE id IN (${fph})`).bind(...folderIds).run();
      await logAudit(env, request, A, "walkingpathfolder.delete", folderId + " (" + (meta.changes || 0) + " paths moved up)");
      return json({ ok: true, deletedFolders: folderIds.length, movedPaths: meta.changes || 0 }, 200, AC);
    }

    const b = await request.json().catch(() => ({}));
    let name = row.name, parentId = row.parentId;
    if (b.name !== undefined) {
      if (!b.name.trim() || b.name.includes("/")) return json({ error: "invalid name" }, 400, AC);
      name = b.name.trim();
    }
    if (b.parentId !== undefined) {
      const newParentId = b.parentId || null;
      if (newParentId) {
        const parent = await env.DB.prepare("SELECT id FROM walking_path_folder WHERE id=? AND app_id=?").bind(newParentId, row.appId).first();
        if (!parent) return json({ error: "parent folder not found" }, 404, AC);
        const subtreeIds = await collectWalkingPathFolderSubtreeIds(env, folderId);
        if (subtreeIds.includes(newParentId)) return json({ error: "can't move a folder into its own subtree" }, 400, AC);
      }
      parentId = newParentId;
    }
    await env.DB.prepare("UPDATE walking_path_folder SET name=?, parent_id=?, updated_at=? WHERE id=?")
      .bind(name, parentId, new Date().toISOString(), folderId).run();
    await logAudit(env, request, A, "walkingpathfolder.update", folderId);
    return json({ id: folderId, name, parentId }, 200, AC);
  }

  // --- Stop folders: organize a project's map stops (zones) into a tree
  // when there are hundreds of them. Deliberately its own table, independent
  // of audio_folder — confirmed with the user that sharing the audio tree
  // wasn't useful in practice. Always project-scoped (no library equivalent).
  // Stops themselves aren't rows here — a zone's folderId lives inside the
  // published_bundle JSON like every other zone field; only the folder
  // *structure* is server-side. ---
  async function stopFolderAuthOk(env, A, projectId) {
    const appId = await projectAppId(env, projectId);
    return scopeOk(A, "audio", appId) || scopeOk(A, "publish", appId);
  }
  async function collectStopFolderSubtreeIds(env, rootId) {
    const ids = [rootId]; let frontier = [rootId];
    while (frontier.length) {
      const ph = frontier.map(() => "?").join(",");
      const { results } = await env.DB.prepare(`SELECT id FROM stop_folder WHERE parent_id IN (${ph})`).bind(...frontier).all();
      frontier = (results || []).map(r => r.id);
      ids.push(...frontier);
    }
    return ids;
  }

  if (path === "/api/stop-folder" && method === "GET") {
    const A = await auth(request, env);
    const projectId = url.searchParams.get("projectId");
    if (!projectId) return json({ error: "projectId required" }, 400, AC);
    if (!(await stopFolderAuthOk(env, A, projectId))) return json({ error: "unauthorized" }, 401, AC);
    const { results } = await env.DB.prepare(
      "SELECT id,parent_id AS parentId,name FROM stop_folder WHERE project_id=? ORDER BY name"
    ).bind(projectId).all();
    return json({ folders: results || [] }, 200, AC);
  }

  if (path === "/api/stop-folder" && method === "POST") {
    const A = await auth(request, env);
    const b = await request.json().catch(() => ({}));
    const projectId = (b.projectId || "").trim(), name = (b.name || "").trim();
    const parentId = b.parentId || null;
    if (!projectId || !name) return json({ error: "projectId and name required" }, 400, AC);
    if (name.includes("/")) return json({ error: "folder name can't contain /" }, 400, AC);
    if (!(await stopFolderAuthOk(env, A, projectId))) return json({ error: "unauthorized" }, 401, AC);
    if (parentId) {
      const parent = await env.DB.prepare("SELECT id FROM stop_folder WHERE id=? AND project_id=?").bind(parentId, projectId).first();
      if (!parent) return json({ error: "parent folder not found" }, 404, AC);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO stop_folder (id,project_id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .bind(id, projectId, parentId, name, now, now).run();
    await logAudit(env, request, A, "stopfolder.create", projectId + "/" + name);
    return json({ id, projectId, parentId, name }, 201, AC);
  }

  const mStopFolder = path.match(/^\/api\/stop-folder\/([^/]+)$/);
  if (mStopFolder && (method === "PATCH" || method === "DELETE")) {
    const folderId = decodeURIComponent(mStopFolder[1]);
    const A = await auth(request, env);
    const row = await env.DB.prepare("SELECT project_id AS projectId,parent_id AS parentId,name FROM stop_folder WHERE id=?").bind(folderId).first();
    if (!row) return json({ error: "folder not found" }, 404, AC);
    if (!(await stopFolderAuthOk(env, A, row.projectId))) return json({ error: "unauthorized" }, 401, AC);

    if (method === "DELETE") {
      const folderIds = await collectStopFolderSubtreeIds(env, folderId);
      const fph = folderIds.map(() => "?").join(",");
      await env.DB.prepare(`DELETE FROM stop_folder WHERE id IN (${fph})`).bind(...folderIds).run();
      await logAudit(env, request, A, "stopfolder.delete", folderId);
      return json({ ok: true, deletedFolders: folderIds.length }, 200, AC);
    }

    const b = await request.json().catch(() => ({}));
    let name = row.name, parentId = row.parentId;
    if (b.name !== undefined) {
      if (!b.name.trim() || b.name.includes("/")) return json({ error: "invalid name" }, 400, AC);
      name = b.name.trim();
    }
    if (b.parentId !== undefined) {
      const newParentId = b.parentId || null;
      if (newParentId) {
        const parent = await env.DB.prepare("SELECT id FROM stop_folder WHERE id=? AND project_id=?").bind(newParentId, row.projectId).first();
        if (!parent) return json({ error: "parent folder not found" }, 404, AC);
        const subtreeIds = await collectStopFolderSubtreeIds(env, folderId);
        if (subtreeIds.includes(newParentId)) return json({ error: "can't move a folder into its own subtree" }, 400, AC);
      }
      parentId = newParentId;
    }
    await env.DB.prepare("UPDATE stop_folder SET name=?, parent_id=?, updated_at=? WHERE id=?")
      .bind(name, parentId, new Date().toISOString(), folderId).run();
    await logAudit(env, request, A, "stopfolder.update", folderId);
    return json({ id: folderId, name, parentId }, 200, AC);
  }

  // --- one-off, idempotent backfill: record every existing R2 audio object's
  // current key as-is into audio_clip/audio_folder (no bytes are rewritten,
  // no key ever changes) so old clips show up in the new tree endpoints
  // above. Safe to re-run — skips any r2_key already present. ---
  if (path === "/api/audio/migrate-legacy" && method === "POST") {
    if (!env.AUDIO) return json({ error: "no audio bucket bound" }, 500);
    if (!(await authed(request, env))) return json({ error: "master token required" }, 401, AC);
    const now = new Date().toISOString();
    const stats = { projects: 0, projectClips: 0, orgs: 0, libraryFolders: 0, libraryClips: 0, skipped: 0 };

    const { results: projRows } = await env.DB.prepare("SELECT id FROM project").all();
    for (const p of (projRows || [])) {
      let cursor;
      do {
        const l = await env.AUDIO.list({ prefix: p.id + "/", cursor });
        for (const o of l.objects) {
          const existing = await env.DB.prepare("SELECT id FROM audio_clip WHERE r2_key=?").bind(o.key).first();
          if (existing) { stats.skipped++; continue; }
          await env.DB.prepare(
            "INSERT INTO audio_clip (id,scope,scope_id,folder_id,name,r2_key,size_bytes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
          ).bind(crypto.randomUUID(), "project", p.id, null, o.key.split("/").pop(), o.key, o.size || null, now, now).run();
          stats.projectClips++;
        }
        cursor = l.truncated ? l.cursor : undefined;
      } while (cursor);
      stats.projects++;
    }

    const { results: clientRows } = await env.DB.prepare("SELECT id FROM client").all();
    for (const cl of (clientRows || [])) {
      const libOrgId = cl.id;
      const rootPrefix = "library/" + libOrgId + "/";
      const rootList = await env.AUDIO.list({ prefix: rootPrefix, delimiter: "/" });
      for (const o of rootList.objects) {
        const existing = await env.DB.prepare("SELECT id FROM audio_clip WHERE r2_key=?").bind(o.key).first();
        if (existing) { stats.skipped++; continue; }
        await env.DB.prepare(
          "INSERT INTO audio_clip (id,scope,scope_id,folder_id,name,r2_key,size_bytes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
        ).bind(crypto.randomUUID(), "library", libOrgId, null, o.key.split("/").pop(), o.key, o.size || null, now, now).run();
        stats.libraryClips++;
      }
      const folderNames = (rootList.delimitedPrefixes || []).map(p => p.slice(rootPrefix.length, -1));
      for (const folderName of folderNames) {
        let folderRow = await env.DB.prepare(
          "SELECT id FROM audio_folder WHERE scope='library' AND scope_id=? AND parent_id IS NULL AND name=?"
        ).bind(libOrgId, folderName).first();
        let folderId;
        if (folderRow) { folderId = folderRow.id; }
        else {
          folderId = crypto.randomUUID();
          await env.DB.prepare("INSERT INTO audio_folder (id,scope,scope_id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
            .bind(folderId, "library", libOrgId, null, folderName, now, now).run();
          stats.libraryFolders++;
        }
        let cursor;
        const prefix = rootPrefix + folderName + "/";
        do {
          const l = await env.AUDIO.list({ prefix, cursor });
          for (const o of l.objects) {
            const existing = await env.DB.prepare("SELECT id FROM audio_clip WHERE r2_key=?").bind(o.key).first();
            if (existing) { stats.skipped++; continue; }
            await env.DB.prepare(
              "INSERT INTO audio_clip (id,scope,scope_id,folder_id,name,r2_key,size_bytes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
            ).bind(crypto.randomUUID(), "library", libOrgId, folderId, o.key.split("/").pop(), o.key, o.size || null, now, now).run();
            stats.libraryClips++;
          }
          cursor = l.truncated ? l.cursor : undefined;
        } while (cursor);
      }
      stats.orgs++;
    }

    await logAudit(env, request, { keyId: "master" }, "audio.migrate-legacy", JSON.stringify(stats));
    return json({ ok: true, ...stats }, 200, AC);
  }

  // --- audio assets in R2: upload (scoped) + serve (public) ---
  if (path.startsWith("/api/audio/")) {
    const key = decodeURIComponent(path.slice("/api/audio/".length)).trim();
    if (!key) return json({ error: "need an audio key" }, 400);
    if (!env.AUDIO) return json({ error: "no audio bucket bound (create R2 'geofence-audio' + binding)" }, 500);
    const keyParts = key.split("/");
    const isLibrary = keyParts[0] === "library";
    if (method === "PUT") {
      const A = await auth(request, env);
      if (isLibrary) {
        const orgId = keyParts[1];
        if (!orgId) return json({ error: "library keys need an org: library/<clientId>/<file>" }, 400);
        if (!(await libraryScopeOk(env, A, orgId))) return json({ error: "not authorized to upload to this company's library" }, 401, AC);
        if (keyParts.length > 4) return json({ error: "library folders are flat — no nested paths" }, 400);
      } else {
        const appId = await projectAppId(env, keyParts[0]);
        if (!scopeOk(A, "audio", appId) && !scopeOk(A, "publish", appId))
          return json({ error: "not authorized to upload to this app" }, 401, AC);
      }
      const ct = request.headers.get("content-type") || "application/octet-stream";
      await env.AUDIO.put(key, request.body, { httpMetadata: { contentType: ct } });
      await logAudit(env, request, A, "audio.put", key);
      return json({ ok: true, key, url: "/api/audio/" + key }, 200, AC);
    }
    if (method === "GET") {
      let obj = null;
      try { obj = await env.AUDIO.get(key); }
      catch (e) { return new Response("invalid key", { status: 404, headers: CORS_PUBLIC }); }
      if (!obj) return new Response("not found", { status: 404, headers: CORS_PUBLIC });
      const h = new Headers(CORS_PUBLIC);
      h.set("content-type", (obj.httpMetadata && obj.httpMetadata.contentType) || "audio/mpeg");
      h.set("cache-control", "no-cache");
      if (obj.httpEtag) h.set("etag", obj.httpEtag);
      return new Response(obj.body, { headers: h });
    }
    if (method === "DELETE") {
      const A = await auth(request, env);
      if (isLibrary) {
        const orgId = keyParts[1];
        if (!orgId || !(await libraryScopeOk(env, A, orgId))) return json({ error: "unauthorized" }, 401, AC);
      } else {
        const appId = await projectAppId(env, keyParts[0]);
        if (!scopeOk(A, "audio", appId) && !scopeOk(A, "publish", appId)) return json({ error: "unauthorized" }, 401, AC);
      }
      await env.AUDIO.delete(key);
      await logAudit(env, request, A, "audio.delete", key);
      return json({ ok: true, deleted: key }, 200, AC);
    }
  }

  // --- whisper STT transcription ---
  if (path === "/api/transcribe" && method === "POST") {
    if (!env.AI) return json({ error: "AI binding not configured" }, 503, CORS_PUBLIC);
    try {
      const buf = await request.arrayBuffer();
      if (!buf.byteLength) return json({ error: "empty audio" }, 400, CORS_PUBLIC);
      const result = await env.AI.run("@cf/openai/whisper", {
        audio: [...new Uint8Array(buf)]
      });
      return json({ text: (result.text || "").trim() }, 200, CORS_PUBLIC);
    } catch(e) {
      return json({ error: e.message }, 502, CORS_PUBLIC);
    }
  }

  // --- TTS (Workers AI aura-1 → MP3 stream) ---
  // @cf/microsoft/speecht5_tts was removed from the Workers AI catalog
  // (confirmed via `wrangler ai models` — no longer listed, calls 502
  // "no such model"). Replaced with @cf/deepgram/aura-1, which returns
  // MP3 audio directly as a ReadableStream via returnRawResponse — no PCM
  // decoding/WAV encoding needed. Client-side decodeAudioData() is
  // format-agnostic (auto-detects MP3 vs WAV from the bytes), so no
  // frontend changes are required for this swap.
  if (path === "/api/tts" && method === "POST") {
    if (!env.AI) return json({ error: "AI binding not configured" }, 503, CORS_PUBLIC);
    try {
      const { text, voice } = await request.json();
      if (!text || typeof text !== "string") return json({ error: "text required" }, 400, CORS_PUBLIC);
      // Aura-1 has its own speaker roster, unrelated to Kokoro's af_bella-style
      // ids — map the same curated voice picker the editor/engine expose so
      // selection still does something when Kokoro (client-side neural TTS)
      // fails to load and this Workers AI tier is used instead. Unmapped/
      // missing voice falls through to Aura's own default (angus).
      const AURA_SPEAKER = {
        af_bella: "asteria", af_nicole: "luna", af_sarah: "athena", af_sky: "stella",
        am_adam: "orion", am_michael: "zeus",
        bf_emma: "hera", bf_isabella: "perseus", bm_george: "arcas", bm_lewis: "helios"
      };
      const ttsInput = { text: text.slice(0, 600) };
      if (voice && AURA_SPEAKER[voice]) ttsInput.speaker = AURA_SPEAKER[voice];
      const result = await env.AI.run("@cf/deepgram/aura-1", ttsInput, { returnRawResponse: true });
      return new Response(result.body, {
        status: 200,
        headers: { "content-type": "audio/mpeg", ...CORS_PUBLIC }
      });
    } catch(e) {
      return json({ error: e.message }, 502, CORS_PUBLIC);
    }
  }

  // --- Chatterbox Studio: org-scoped voice palette + Resemble AI proxy.
  // Moved here from a local FastAPI service tunneled off one laptop — that
  // service used to also run a local ONNX voice-cloning model, which is why
  // it existed outside the Worker at all; once that was removed for being
  // unusable on the laptop's hardware (RAM), every voice became Resemble-
  // hosted only, and there was no remaining reason this needed to live
  // outside the Worker. Scoped by org (client id) exactly like the Library,
  // since voices are meant to be reusable across every project belonging to
  // one company — reuses libraryScopeOk() rather than inventing a new scope.
  if (path === "/api/chatterbox/voices" && method === "GET") {
    const A = await auth(request, env);
    const orgId = url.searchParams.get("org");
    if (!orgId) return json({ error: "?org=<clientId> required" }, 400, AC);
    if (!(await libraryScopeOk(env, A, orgId))) return json({ error: "unauthorized" }, 401, AC);
    const { results } = await env.DB.prepare(
      "SELECT id,name,resemble_voice_uuid AS resembleVoiceUuid FROM chatterbox_voice WHERE org_id=? ORDER BY name"
    ).bind(orgId).all();
    return json(results || [], 200, AC);
  }

  if (path === "/api/chatterbox/voices" && method === "POST") {
    const A = await auth(request, env);
    const b = await request.json().catch(() => ({}));
    if (!b.org || !b.name || !b.resembleVoiceUuid) return json({ error: "org, name, and resembleVoiceUuid required" }, 400, AC);
    if (!(await libraryScopeOk(env, A, b.org))) return json({ error: "unauthorized" }, 401, AC);
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO chatterbox_voice (id,org_id,name,resemble_voice_uuid,created_at,updated_at) VALUES (?,?,?,?,?,?)"
    ).bind(id, b.org, b.name, b.resembleVoiceUuid, now, now).run();
    return json({ id, name: b.name }, 201, AC);
  }

  const mcv = path.match(/^\/api\/chatterbox\/voices\/([^/]+)$/);
  if (mcv && (method === "PATCH" || method === "DELETE")) {
    const voiceId = decodeURIComponent(mcv[1]);
    const A = await auth(request, env);
    const row = await env.DB.prepare("SELECT org_id FROM chatterbox_voice WHERE id=?").bind(voiceId).first();
    if (!row) return json({ error: "voice not found" }, 404, AC);
    if (!(await libraryScopeOk(env, A, row.org_id))) return json({ error: "unauthorized" }, 401, AC);
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM chatterbox_voice WHERE id=?").bind(voiceId).run();
      return json({ deleted: voiceId }, 200, AC);
    }
    const b = await request.json().catch(() => ({}));
    if (!b.name) return json({ error: "name required" }, 400, AC);
    await env.DB.prepare("UPDATE chatterbox_voice SET name=?, updated_at=? WHERE id=?")
      .bind(b.name, new Date().toISOString(), voiceId).run();
    return json({ id: voiceId, name: b.name }, 200, AC);
  }

  if (path === "/api/chatterbox/generate" && method === "POST") {
    if (!env.RESEMBLE_API_TOKEN) return json({ error: "RESEMBLE_API_TOKEN not configured" }, 503, AC);
    const A = await auth(request, env);
    const b = await request.json().catch(() => ({}));
    if (!b.voiceId || !b.text) return json({ error: "voiceId and text required" }, 400, AC);
    const voice = await env.DB.prepare("SELECT org_id,resemble_voice_uuid FROM chatterbox_voice WHERE id=?").bind(b.voiceId).first();
    if (!voice) return json({ error: "voice not found" }, 404, AC);
    if (!(await libraryScopeOk(env, A, voice.org_id))) return json({ error: "unauthorized" }, 401, AC);
    try {
      const r = await fetch("https://f.cluster.resemble.ai/synthesize", {
        method: "POST",
        headers: { "Authorization": "Bearer " + env.RESEMBLE_API_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ voice_uuid: voice.resemble_voice_uuid, data: b.text, output_format: "wav", use_hd: false })
      });
      const result = await r.json().catch(() => null);
      if (!result || !result.success) {
        return json({ error: "Resemble synthesis failed: " + ((result && (result.message || JSON.stringify(result))) || ("HTTP " + r.status)) }, 502, AC);
      }
      // Resemble already returns a ready-to-play WAV — just base64-decode it,
      // no re-encoding needed (unlike the old local-ONNX path, which produced
      // raw PCM float32 that had to be WAV-encoded before it could be served).
      const bin = atob(result.audio_content);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Response(bytes, { status: 200, headers: { "content-type": "audio/wav", ...AC } });
    } catch (e) {
      return json({ error: e.message }, 502, AC);
    }
  }

  // --- weather cache (read + manual trigger) ---
  if (path === "/api/weather") {
    if (method === "GET") {
      const row = await env.DB.prepare('SELECT * FROM weather_cache ORDER BY id DESC LIMIT 1').first();
      return json(row || { error: "no data yet" }, row ? 200 : 404, CORS_PUBLIC);
    }
    if (method === "POST" && (await authed(request, env))) {
      try {
        const result = await scrapeWeather(env);
        return json({ ok: true, ...result }, 200, CORS_PUBLIC);
      } catch(e) {
        return json({ error: e.message }, 502, CORS_PUBLIC);
      }
    }
  }

  // --- 14-day snow history ---
  if (path === "/api/snow-history") {
    if (method === "GET") {
      const rows = await env.DB.prepare(
        `SELECT snapshot_date, ww_temp_c, ww_wind_spd_kph, ww_wind_dir_deg, ww_wind_gust_kph, hour_precip_mm, precip_24hr_mm, hn24_cm, hst_cm, hs_cm
         FROM snow_history ORDER BY snapshot_date DESC LIMIT 14`
      ).all();
      return json(rows.results || [], 200, CORS_PUBLIC);
    }
    if (method === "POST" && (await authed(request, env))) {
      try {
        const result = await saveSnowSnapshot(env);
        return json({ ok: true, ...result }, 200, CORS_PUBLIC);
      } catch(e) {
        return json({ error: e.message }, 502, CORS_PUBLIC);
      }
    }
  }

  // --- Code Object folders: same tree shape as walking_path_folder, but
  // org-scoped to match code_object itself (see codeObjectScopeOk above).
  // Deleting a folder moves objects in its subtree up to the parent instead
  // of destroying them — a hand-authored object is as expensive to redo as
  // a recorded walk, same reasoning walking_path_folder's delete uses.
  async function collectCodeObjectFolderSubtreeIds(env, rootId) {
    const ids = [rootId]; let frontier = [rootId];
    while (frontier.length) {
      const ph = frontier.map(() => "?").join(",");
      const { results } = await env.DB.prepare(`SELECT id FROM code_object_folder WHERE parent_id IN (${ph})`).bind(...frontier).all();
      frontier = (results || []).map(r => r.id);
      ids.push(...frontier);
    }
    return ids;
  }

  if (path === "/api/code-object-folder" && method === "GET") {
    const A = await auth(request, env);
    const orgId = (url.searchParams.get("org") || "").trim();
    if (!orgId) return json({ error: "org required" }, 400, AC);
    if (!(await codeObjectScopeOk(env, A, orgId))) return json({ error: "forbidden" }, 403, AC);
    const { results } = await env.DB.prepare(
      "SELECT id,parent_id AS parentId,name FROM code_object_folder WHERE org_id=? ORDER BY name"
    ).bind(orgId).all();
    return json({ folders: results || [] }, 200, AC);
  }

  if (path === "/api/code-object-folder" && method === "POST") {
    const A = await auth(request, env);
    const b = await request.json().catch(() => ({}));
    const orgId = (b.orgId || "").trim(), name = (b.name || "").trim();
    const parentId = b.parentId || null;
    if (!orgId || !name) return json({ error: "orgId and name required" }, 400, AC);
    if (name.includes("/")) return json({ error: "folder name can't contain /" }, 400, AC);
    if (!(await codeObjectScopeOk(env, A, orgId))) return json({ error: "forbidden" }, 403, AC);
    if (parentId) {
      const parent = await env.DB.prepare("SELECT id FROM code_object_folder WHERE id=? AND org_id=?").bind(parentId, orgId).first();
      if (!parent) return json({ error: "parent folder not found" }, 404, AC);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO code_object_folder (id,org_id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .bind(id, orgId, parentId, name, now, now).run();
    await logAudit(env, request, A, "codeobjectfolder.create", orgId + "/" + name);
    return json({ id, orgId, parentId, name }, 201, AC);
  }

  const mCodeObjectFolder = path.match(/^\/api\/code-object-folder\/([^/]+)$/);
  if (mCodeObjectFolder && (method === "PATCH" || method === "DELETE")) {
    const folderId = decodeURIComponent(mCodeObjectFolder[1]);
    const A = await auth(request, env);
    const row = await env.DB.prepare("SELECT org_id AS orgId,parent_id AS parentId,name FROM code_object_folder WHERE id=?").bind(folderId).first();
    if (!row) return json({ error: "folder not found" }, 404, AC);
    if (!(await codeObjectScopeOk(env, A, row.orgId))) return json({ error: "forbidden" }, 403, AC);

    if (method === "DELETE") {
      const folderIds = await collectCodeObjectFolderSubtreeIds(env, folderId);
      const fph = folderIds.map(() => "?").join(",");
      const { meta } = await env.DB.prepare(
        `UPDATE code_object SET folder_id=?, updated_at=? WHERE org_id=? AND folder_id IN (${fph})`
      ).bind(row.parentId, new Date().toISOString(), row.orgId, ...folderIds).run();
      await env.DB.prepare(`DELETE FROM code_object_folder WHERE id IN (${fph})`).bind(...folderIds).run();
      await logAudit(env, request, A, "codeobjectfolder.delete", folderId + " (" + (meta.changes || 0) + " objects moved up)");
      return json({ ok: true, deletedFolders: folderIds.length, movedObjects: meta.changes || 0 }, 200, AC);
    }

    const b = await request.json().catch(() => ({}));
    let name = row.name, parentId = row.parentId;
    if (b.name !== undefined) {
      if (!b.name.trim() || b.name.includes("/")) return json({ error: "invalid name" }, 400, AC);
      name = b.name.trim();
    }
    if (b.parentId !== undefined) {
      const newParentId = b.parentId || null;
      if (newParentId) {
        const parent = await env.DB.prepare("SELECT id FROM code_object_folder WHERE id=? AND org_id=?").bind(newParentId, row.orgId).first();
        if (!parent) return json({ error: "parent folder not found" }, 404, AC);
        const subtreeIds = await collectCodeObjectFolderSubtreeIds(env, folderId);
        if (subtreeIds.includes(newParentId)) return json({ error: "can't move a folder into its own subtree" }, 400, AC);
      }
      parentId = newParentId;
    }
    await env.DB.prepare("UPDATE code_object_folder SET name=?, parent_id=?, updated_at=? WHERE id=?")
      .bind(name, parentId, new Date().toISOString(), folderId).run();
    await logAudit(env, request, A, "codeobjectfolder.update", folderId);
    return json({ id: folderId, name, parentId }, 200, AC);
  }

  // --- code objects ---
  // GET /:id stays public/unauthenticated on purpose: it's fetched by
  // pipeline-runtime.js from an anonymous visitor's browser during a live
  // walk to resolve zone.codeObjects at GPS-tick time (see resolveCodeObjects
  // in pipeline-runtime.js) — gating it would break execution for real
  // visitors. Entitlement is enforced where it actually matters: what an
  // admin can see/attach (the list below) and what a bundle is allowed to
  // publish (PUT /api/projects/:id/bundle's codeObjects validation).
  if (path === "/api/code-objects" && method === "GET") {
    const orgId = url.searchParams.get("org");
    if (!orgId) return json({ error: "org required" }, 400, AC);
    const A = await auth(request, env);
    if (!(await codeObjectScopeOk(env, A, orgId))) return json({ error: "forbidden" }, 403, AC);
    // Even a platform master, viewing this org's library, only sees THIS
    // org's custom objects (workspace isolation) plus entitlement-gated
    // built-ins — master's bypass is of the entitlement check, not of org
    // scoping, so it still sees every built-in regardless of grants.
    const rows = A.master
      ? await env.DB.prepare("SELECT id,org_id,name,description,icon,category,version,param_schema,feature_key,folder_id AS folderId FROM code_object WHERE org_id IS NULL OR org_id=? ORDER BY name").bind(orgId).all()
      : await env.DB.prepare(
          // LEFT JOIN (not INNER) + the 'hazard-zone' OR-exemption below: Hazard
          // was previously a free, always-on checkbox with no entitlement concept
          // at all — gating it behind org_entitlement like every other built-in
          // would silently break it for every org that hasn't been granted it.
          "SELECT co.id,co.org_id,co.name,co.description,co.icon,co.category,co.version,co.param_schema,co.feature_key,co.folder_id AS folderId FROM code_object co " +
          "LEFT JOIN org_entitlement oe ON oe.feature_key=co.feature_key AND oe.org_id=? " +
          "WHERE (co.org_id IS NULL OR co.org_id=?) AND (oe.org_id IS NOT NULL OR co.id='hazard-zone') ORDER BY co.name"
        ).bind(orgId, orgId).all();
    return json((rows.results || []).map(row => ({
      id: row.id, orgId: row.org_id, name: row.name, description: row.description, icon: row.icon,
      category: row.category, version: row.version, paramSchema: JSON.parse(row.param_schema), featureKey: row.feature_key,
      folderId: row.folderId
    })), 200, AC);
  }
  if (path === "/api/code-objects" && method === "POST") {
    const A = await auth(request, env);
    const b = await request.json().catch(() => ({}));
    const orgId = b.orgId;
    if (!orgId) return json({ error: "orgId required" }, 400, AC);
    if (!(await codeObjectScopeOk(env, A, orgId))) return json({ error: "forbidden" }, 403, AC);
    if (!b.name || !b.template || !Array.isArray(b.template.nodes)) return json({ error: "name and template required" }, 400, AC);
    let folderId = b.folderId || null;
    if (folderId) {
      const folder = await env.DB.prepare("SELECT id FROM code_object_folder WHERE id=? AND org_id=?").bind(folderId, orgId).first();
      if (!folder) return json({ error: "folder not found" }, 404, AC);
    }
    const slug = b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "object";
    // id/featureKey are always server-generated, never taken from the client:
    // feature_key is the exact key self-entitled to this org two lines below,
    // so trusting a client-supplied featureKey let any org with "publish"
    // scope self-grant an EXISTING feature_key (e.g. a real built-in's) just
    // by naming their own dummy object with a matching string — bypassing
    // the master-only /api/entitlements gate entirely. id is likewise never
    // client-controlled so it can't be pointed at an existing row.
    const id = slug + "-" + Math.random().toString(36).slice(2, 8);
    const featureKey = id;
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO code_object (id,org_id,built_in,name,description,icon,category,version,template,param_schema,feature_key,folder_id,created_at,updated_at) " +
      "VALUES (?,?,0,?,?,?,?,1,?,?,?,?,?,?)"
    ).bind(id, orgId, b.name, b.description || "", b.icon || "🧩", b.category || "custom",
      JSON.stringify(b.template), JSON.stringify(b.paramSchema || []), featureKey, folderId, now, now).run();
    // Self-entitled: the org that authors a custom object can use it immediately,
    // no separate master grant step needed (grants are for built-ins / cross-org).
    await env.DB.prepare(
      "INSERT OR IGNORE INTO org_entitlement (org_id,feature_key,granted_at,granted_by) VALUES (?,?,?,?)"
    ).bind(orgId, featureKey, now, A.keyId || "self").run();
    return json({ id, featureKey }, 200, AC);
  }
  if (path.startsWith("/api/code-objects/") && method === "GET") {
    const id = decodeURIComponent(path.slice("/api/code-objects/".length));
    const row = await env.DB.prepare("SELECT * FROM code_object WHERE id=?").bind(id).first();
    if (!row) return json({ error: "not found" }, 404, CORS_PUBLIC);
    return json({
      id: row.id, name: row.name, description: row.description, icon: row.icon,
      category: row.category, version: row.version,
      template: JSON.parse(row.template), paramSchema: JSON.parse(row.param_schema)
    }, 200, CORS_PUBLIC);
  }
  if (path.startsWith("/api/code-objects/") && (method === "PATCH" || method === "DELETE")) {
    const id = decodeURIComponent(path.slice("/api/code-objects/".length));
    const row = await env.DB.prepare("SELECT * FROM code_object WHERE id=?").bind(id).first();
    if (!row) return json({ error: "not found" }, 404, AC);
    const A = await auth(request, env);
    // Built-ins (org_id NULL) are shared across every entitled org — only a
    // platform master may edit/delete the shared definition. Custom objects
    // are editable by the org that owns them.
    const ok = row.org_id == null ? !!(A && A.master) : await codeObjectScopeOk(env, A, row.org_id);
    if (!ok) return json({ error: "forbidden" }, 403, AC);
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM code_object WHERE id=?").bind(id).run();
      return json({ ok: true }, 200, AC);
    }
    const b = await request.json().catch(() => ({}));
    const fields = [], vals = [];
    if (b.name != null) { fields.push("name=?"); vals.push(b.name); }
    if (b.description != null) { fields.push("description=?"); vals.push(b.description); }
    if (b.icon != null) { fields.push("icon=?"); vals.push(b.icon); }
    if (b.category != null) { fields.push("category=?"); vals.push(b.category); }
    if (b.template != null) { fields.push("template=?"); vals.push(JSON.stringify(b.template)); fields.push("version=version+1"); }
    if (b.paramSchema != null) { fields.push("param_schema=?"); vals.push(JSON.stringify(b.paramSchema)); }
    if (b.folderId !== undefined) {
      const newFolderId = b.folderId || null;
      if (newFolderId) {
        const orgForFolder = row.org_id == null ? null : row.org_id;
        const folder = orgForFolder
          ? await env.DB.prepare("SELECT id FROM code_object_folder WHERE id=? AND org_id=?").bind(newFolderId, orgForFolder).first()
          : null; // built-ins (org_id NULL) have no org to scope a folder check against — moving a built-in into a folder isn't supported
        if (!folder) return json({ error: "folder not found" }, 404, AC);
      }
      fields.push("folder_id=?"); vals.push(newFolderId);
    }
    if (!fields.length) return json({ error: "nothing to update" }, 400, AC);
    fields.push("updated_at=?"); vals.push(new Date().toISOString());
    vals.push(id);
    await env.DB.prepare("UPDATE code_object SET " + fields.join(",") + " WHERE id=?").bind(...vals).run();
    const updated = await env.DB.prepare("SELECT version FROM code_object WHERE id=?").bind(id).first();
    return json({ ok: true, version: updated.version }, 200, AC);
  }

  // --- entitlements (the upsell lever — master-only) ---
  if (path === "/api/entitlements" && method === "GET") {
    const A = await auth(request, env);
    if (!A || !A.master) return json({ error: "admin access required" }, 403, AC);
    const orgId = url.searchParams.get("org");
    if (!orgId) return json({ error: "org required" }, 400, AC);
    const rows = await env.DB.prepare("SELECT feature_key,granted_at,granted_by FROM org_entitlement WHERE org_id=?").bind(orgId).all();
    return json(rows.results || [], 200, AC);
  }
  if (path === "/api/entitlements" && method === "POST") {
    const A = await auth(request, env);
    if (!A || !A.master) return json({ error: "admin access required" }, 403, AC);
    const b = await request.json().catch(() => ({}));
    if (!b.orgId || !b.featureKey) return json({ error: "orgId and featureKey required" }, 400, AC);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO org_entitlement (org_id,feature_key,granted_at,granted_by) VALUES (?,?,?,?)"
    ).bind(b.orgId, b.featureKey, new Date().toISOString(), A.keyId || "master").run();
    return json({ ok: true }, 200, AC);
  }
  if (path === "/api/entitlements" && method === "DELETE") {
    const A = await auth(request, env);
    if (!A || !A.master) return json({ error: "admin access required" }, 403, AC);
    const b = await request.json().catch(() => ({}));
    if (!b.orgId || !b.featureKey) return json({ error: "orgId and featureKey required" }, 400, AC);
    await env.DB.prepare("DELETE FROM org_entitlement WHERE org_id=? AND feature_key=?").bind(b.orgId, b.featureKey).run();
    return json({ ok: true }, 200, AC);
  }

  // --- token check ---
  if (path === "/api/auth-check") {
    const A = await auth(request, env);
    return A
      ? json({ ok: true, master: A.master, appId: A.appId, scopes: A.scopes }, 200, AC)
      : json({ ok: false, error: "unauthorized" }, 401, AC);
  }

  return json({ error: "not found: " + method + " " + path }, 404);
}
