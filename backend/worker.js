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
  await env.DB.prepare("DELETE FROM project WHERE id=?").bind(pid).run();
  // R2 audio lives under "<pid>/..." — clean it up here too, or every project
  // delete leaves its recordings/uploads orphaned in the bucket forever.
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
      env.DB.prepare("UPDATE api_key SET lastUsedAt=? WHERE id=?").bind(new Date().toISOString(), row.id).run().catch(() => {});
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
      "/code-library": "/code-library.html",
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
    // Every hour: update real-time cache for Groq context
    await scrapeWeather(env);
    // At 15:00 UTC (8am MST): also save daily snow snapshot
    if (event.cron === "0 15 * * *") {
      await saveSnowSnapshot(env);
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
    env.DB.prepare("UPDATE user_account SET last_login_at=? WHERE id=?").bind(new Date().toISOString(), user.id).run().catch(() => {});
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
        await env.DB.prepare("DELETE FROM event WHERE projectId=?").bind(p.id).run();
        await env.DB.prepare("DELETE FROM published_bundle WHERE projectId=?").bind(p.id).run();
        await env.DB.prepare("DELETE FROM project WHERE id=?").bind(p.id).run();
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
      if (!prefix || prefix === "library" || liveIds.has(prefix)) continue;
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
    if (prefixes.some(p => !p || typeof p !== "string" || p === "library" || p.includes("/")))
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
      const { text } = await request.json();
      if (!text || typeof text !== "string") return json({ error: "text required" }, 400, CORS_PUBLIC);
      const result = await env.AI.run("@cf/deepgram/aura-1", {
        text: text.slice(0, 600)
      }, { returnRawResponse: true });
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
      ? await env.DB.prepare("SELECT id,org_id,name,description,icon,category,version,param_schema,feature_key FROM code_object WHERE org_id IS NULL OR org_id=? ORDER BY name").bind(orgId).all()
      : await env.DB.prepare(
          "SELECT co.id,co.org_id,co.name,co.description,co.icon,co.category,co.version,co.param_schema,co.feature_key FROM code_object co " +
          "JOIN org_entitlement oe ON oe.feature_key=co.feature_key AND oe.org_id=? " +
          "WHERE co.org_id IS NULL OR co.org_id=? ORDER BY co.name"
        ).bind(orgId, orgId).all();
    return json((rows.results || []).map(row => ({
      id: row.id, orgId: row.org_id, name: row.name, description: row.description, icon: row.icon,
      category: row.category, version: row.version, paramSchema: JSON.parse(row.param_schema), featureKey: row.feature_key
    })), 200, AC);
  }
  if (path === "/api/code-objects" && method === "POST") {
    const A = await auth(request, env);
    const b = await request.json().catch(() => ({}));
    const orgId = b.orgId;
    if (!orgId) return json({ error: "orgId required" }, 400, AC);
    if (!(await codeObjectScopeOk(env, A, orgId))) return json({ error: "forbidden" }, 403, AC);
    if (!b.name || !b.template || !Array.isArray(b.template.nodes)) return json({ error: "name and template required" }, 400, AC);
    const slug = b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "object";
    const id = b.id || (slug + "-" + Math.random().toString(36).slice(2, 8));
    const featureKey = b.featureKey || id;
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO code_object (id,org_id,built_in,name,description,icon,category,version,template,param_schema,feature_key,created_at,updated_at) " +
      "VALUES (?,?,0,?,?,?,?,1,?,?,?,?,?)"
    ).bind(id, orgId, b.name, b.description || "", b.icon || "🧩", b.category || "custom",
      JSON.stringify(b.template), JSON.stringify(b.paramSchema || []), featureKey, now, now).run();
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
