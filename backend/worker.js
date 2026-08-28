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

import * as h3 from "h3-js";
import * as turf from "@turf/turf";
import { decode as decodePNG } from "fast-png";

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

// RECORD retention sweep: deletes unlocked, ended sessions (and their
// position_history) once a project's record_retention_days has elapsed.
// Day-granularity, so the shared 5-minute cron tick is more than fine —
// no dedicated trigger needed. locked=1 rows (including incident clips,
// locked by default) are excluded outright — that's what lets a flagged
// incident survive this sweep. Capped per tick so a project that just
// enabled retention on a long capture history can't try to delete a huge
// backlog in one statement.
async function cleanupOldRecordings(env) {
  const now = Date.now();
  const { results: expired } = await env.DB.prepare(
    `SELECT rs.id FROM record_session rs
     JOIN project p ON p.id = rs.project_id
     WHERE p.record_retention_days IS NOT NULL
       AND rs.locked = 0
       AND rs.ended_at IS NOT NULL
       AND rs.ended_at < (? - p.record_retention_days * 86400000)
     LIMIT 500`
  ).bind(now).all();
  const ids = (expired || []).map(r => r.id);
  if (!ids.length) return;
  const ph = ids.map(() => "?").join(",");
  await env.DB.prepare(`DELETE FROM position_history WHERE session_id IN (${ph})`).bind(...ids).run().catch(() => {});
  await env.DB.prepare(`DELETE FROM record_session WHERE id IN (${ph})`).bind(...ids).run().catch(() => {});
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
  await env.DB.prepare("DELETE FROM position_history WHERE project_id=?").bind(pid).run();
  await env.DB.prepare("DELETE FROM record_session WHERE project_id=?").bind(pid).run();
  await env.DB.prepare("DELETE FROM record_folder WHERE project_id=?").bind(pid).run();
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

// --- Asset library (3D models: glTF/GLB), Phase 0 of the AR/3D plan ---
// Structurally identical to the audio_folder/audio_clip tree above — same
// project/library scoping, same permanent-opaque-r2_key convention — with
// one addition: kind='url' rows (an externally-hosted glTF link) have no
// r2_key at all and skip R2 entirely. Auth is deliberately the *same*
// audio/publish scopes as the audio tree (assetScopeAuthOk delegates to
// audioScopeAuthOk unchanged) — 3D assets are just another kind of project
// media alongside audio, not a new permission tier. Split this out into its
// own scope later if that stops being true.
const assetScopeAuthOk = audioScopeAuthOk;
async function assetWouldCreateCycle(env, folderId, newParentId) {
  if (!newParentId) return false;
  if (newParentId === folderId) return true;
  let cur = newParentId, seen = new Set();
  while (cur) {
    if (cur === folderId) return true;
    if (seen.has(cur)) break;
    seen.add(cur);
    const row = await env.DB.prepare("SELECT parent_id FROM asset_folder WHERE id=?").bind(cur).first();
    cur = row ? row.parent_id : null;
  }
  return false;
}
async function collectAssetFolderSubtree(env, scope, scopeId, rootFolderId) {
  const ids = [rootFolderId];
  let frontier = [rootFolderId];
  while (frontier.length) {
    const ph = frontier.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT id FROM asset_folder WHERE scope=? AND scope_id=? AND parent_id IN (${ph})`
    ).bind(scope, scopeId, ...frontier).all();
    frontier = (results || []).map(r => r.id);
    ids.push(...frontier);
  }
  return ids;
}
async function rescopeAssetFolderSubtree(env, rootFolderId, srcScope, srcScopeId, targetScope, targetScopeId, targetParentId) {
  const folderIds = await collectAssetFolderSubtree(env, srcScope, srcScopeId, rootFolderId);
  const ph = folderIds.map(() => "?").join(",");
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE asset_folder SET scope=?, scope_id=?, updated_at=? WHERE id IN (${ph})`)
    .bind(targetScope, targetScopeId, now, ...folderIds).run();
  await env.DB.prepare("UPDATE asset_folder SET parent_id=? WHERE id=?").bind(targetParentId, rootFolderId).run();
  await env.DB.prepare(`UPDATE asset_object SET scope=?, scope_id=?, updated_at=? WHERE folder_id IN (${ph})`)
    .bind(targetScope, targetScopeId, now, ...folderIds).run();
}
// Duplicates one asset row. kind='upload' copies the underlying R2 object
// under a fresh stable key (same reasoning as copyClipRow — separate copies
// so trimming/deleting one never affects the other); kind='url' just copies
// the metadata row, since there's no R2 object to duplicate.
async function copyAssetRow(env, row, targetScope, targetScopeId, targetFolderId, overrideName) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  let r2Key = null;
  if (row.kind === "upload") {
    if (!env.MODELS) throw new Error("no models bucket bound");
    const obj = await env.MODELS.get(row.r2_key);
    if (!obj) throw new Error("source asset missing in R2: " + row.r2_key);
    const ext = (row.r2_key.match(/\.[^.\/]+$/) || [""])[0];
    r2Key = "model/" + crypto.randomUUID() + ext;
    await env.MODELS.put(r2Key, obj.body, { httpMetadata: obj.httpMetadata });
  }
  await env.DB.prepare(
    "INSERT INTO asset_object (id,scope,scope_id,folder_id,name,kind,r2_key,source_url,format,size_bytes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(id, targetScope, targetScopeId, targetFolderId, overrideName || row.name, row.kind, r2Key, row.kind === "url" ? row.source_url : null, row.format, row.size_bytes || null, now, now).run();
  return id;
}
async function copyAssetFolderSubtree(env, sourceFolderId, srcScope, srcScopeId, targetScope, targetScopeId, targetParentId) {
  const src = await env.DB.prepare("SELECT name FROM asset_folder WHERE id=? AND scope=? AND scope_id=?")
    .bind(sourceFolderId, srcScope, srcScopeId).first();
  if (!src) throw new Error("source folder not found");
  const newId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO asset_folder (id,scope,scope_id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(newId, targetScope, targetScopeId, targetParentId, src.name, now, now).run();
  const { results: objs } = await env.DB.prepare(
    "SELECT id,name,kind,r2_key,source_url,format,size_bytes FROM asset_object WHERE scope=? AND scope_id=? AND folder_id=?"
  ).bind(srcScope, srcScopeId, sourceFolderId).all();
  for (const o of (objs || [])) await copyAssetRow(env, o, targetScope, targetScopeId, newId);
  const { results: subfolders } = await env.DB.prepare(
    "SELECT id FROM asset_folder WHERE scope=? AND scope_id=? AND parent_id=?"
  ).bind(srcScope, srcScopeId, sourceFolderId).all();
  for (const sf of (subfolders || [])) await copyAssetFolderSubtree(env, sf.id, srcScope, srcScopeId, targetScope, targetScopeId, newId);
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

// --- Artistic Fog-of-War Tiles, Phase B: terrain classification helpers.
// Priority order matters -- first matching rule wins, tried area tags
// (natural/landuse/building) before linear tags (waterway/highway, which get
// buffered into polygons at parse time so classification is one consistent
// point-in-polygon test either way). ---
const TILE_REVEAL_MARGIN_M = 60; // ~one H3 k=1 ring beyond the corridor's own width
const TERRAIN_TAXONOMY = [
  { type: "water_lake",  test: t => t.natural === "water" || t.landuse === "reservoir" },
  { type: "wetland",     test: t => t.natural === "wetland" },
  { type: "urban_block", test: t => !!t.building },
  { type: "plaza",       test: t => t.highway === "pedestrian" || t.landuse === "plaza" || t.landuse === "square" },
  { type: "sand",        test: t => t.natural === "beach" || t.natural === "sand" },
  { type: "farmland",    test: t => t.landuse === "farmland" || t.landuse === "orchard" },
  { type: "forest",      test: t => t.natural === "wood" || t.landuse === "forest" },
  { type: "scrub",       test: t => t.natural === "scrub" },
  { type: "rock_face",   test: t => t.natural === "bare_rock" || t.natural === "cliff" },
  { type: "scree",       test: t => t.natural === "scree" || t.natural === "shingle" },
  { type: "snow",        test: t => t.natural === "glacier" },
  { type: "meadow",      test: t => t.natural === "grassland" || t.landuse === "meadow" },
];
const TERRAIN_LINE_TYPES = [
  { type: "water_river", halfWidthM: 8, test: t => t.waterway === "river" || t.waterway === "stream" },
  { type: "trail",       halfWidthM: 4, test: t => ["path", "footway", "track"].includes(t.highway) || !!t["piste:type"] },
];
// Only consulted when a cell has no OSM tag match at all -- a single
// per-project setting, not per-cell painting, so classification stays fully
// automatic while still having a sane default for OSM-sparse backcountry.
const BIOME_FALLBACK = { alpine: "meadow", forest: "forest", coastal: "sand", urban: "plaza", farmland: "farmland" };

function hashCellToVariant(h3Cell) {
  let h = 0;
  for (let i = 0; i < h3Cell.length; i++) h = (h * 31 + h3Cell.charCodeAt(i)) | 0;
  return Math.abs(h) % 3;
}

async function fetchOverpassFeatures(bboxSWNE) {
  const [south, west, north, east] = bboxSWNE;
  const bbox = `${south},${west},${north},${east}`;
  const q = `[out:json][timeout:25];(way["natural"](${bbox});way["landuse"](${bbox});way["building"](${bbox});way["waterway"](${bbox});way["highway"](${bbox}););out geom;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST", body: "data=" + encodeURIComponent(q),
    // Overpass rejects requests with no User-Agent (406) -- confirmed live,
    // this silently degraded every classify-terrain call to elevation+biome
    // fallback only, since the caller treats a thrown error as
    // offline/unreachable and moves on rather than surfacing it.
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "geofence-platform (github.com/gary-jolivet/geofence-platform)" }
  });
  if (!res.ok) throw new Error("overpass query failed: " + res.status);
  const j = await res.json();
  return j.elements || [];
}
function overpassElementToPolygon(el) {
  if (!el.geometry || el.geometry.length < 3) return null;
  const coords = el.geometry.filter(Boolean).map(p => [p.lon, p.lat]);
  if (coords.length < 3) return null;
  if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) coords.push(coords[0]);
  try { return turf.polygon([coords]); } catch (e) { return null; }
}
function overpassElementToLine(el) {
  if (!el.geometry || el.geometry.length < 2) return null;
  const coords = el.geometry.filter(Boolean).map(p => [p.lon, p.lat]);
  if (coords.length < 2) return null;
  try { return turf.lineString(coords); } catch (e) { return null; }
}
function classifyFromOsm(lon, lat, areaFeatures, lineFeatures) {
  const pt = turf.point([lon, lat]);
  for (const f of areaFeatures) { try { if (turf.booleanPointInPolygon(pt, f.poly)) return f.type; } catch (e) {} }
  for (const f of lineFeatures) { try { if (turf.booleanPointInPolygon(pt, f.poly)) return f.type; } catch (e) {} }
  return null;
}

// Terrarium DEM tiles (same source geofence-engine.html/fence-editor.html
// already load client-side for 3D terrain) fetched+decoded server-side for
// elevation/slope sampling — z12 balances tile-fetch count against
// precision for this secondary/fallback classification signal.
function tileForLngLat(lon, lat, z) {
  const n = Math.pow(2, z);
  const latRad = lat * Math.PI / 180;
  const xf = (lon + 180) / 360 * n;
  const yf = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  const x = Math.floor(xf), y = Math.floor(yf);
  return { z, x, y, px: Math.min(255, Math.max(0, Math.floor((xf - x) * 256))), py: Math.min(255, Math.max(0, Math.floor((yf - y) * 256))) };
}
async function sampleElevation(lon, lat, tileCache) {
  const t = tileForLngLat(lon, lat, 12);
  const key = `${t.z}/${t.x}/${t.y}`;
  let img = tileCache.get(key);
  if (img === undefined) {
    try {
      const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${t.z}/${t.x}/${t.y}.png`);
      img = res.ok ? decodePNG(new Uint8Array(await res.arrayBuffer())) : null;
    } catch (e) { img = null; }
    tileCache.set(key, img);
  }
  if (!img) return null;
  const idx = (t.py * img.width + t.px) * img.channels;
  return (img.data[idx] * 256 + img.data[idx + 1] + img.data[idx + 2] / 256) - 32768;
}
// Pure decision logic, factored out of classifyFromElevation() so it's
// testable without mocking the Terrarium DEM fetch (same "_internal" spirit
// as kalman-filter.js's f()/jacobianF() split) -- thresholds tuned against
// Kicking Horse alpine terrain (see CLAUDE.md's Artistic Fog-of-War Tiles
// section), not yet validated against other mountain ranges' real slope
// distributions.
function classifyElevationSlope(elevationM, slopeDeg) {
  if (slopeDeg > 35) return "rock_face";
  if (slopeDeg > 20 && elevationM > 2200) return "scree";
  if (elevationM > 2800) return "snow";
  return null;
}
async function classifyFromElevation(lon, lat, tileCache) {
  const center = await sampleElevation(lon, lat, tileCache);
  if (center == null) return { type: null, elevation: null, slope: null };
  const D = 0.0004; // ~40m offset at mid-latitudes, for a simple two-axis slope estimate
  const [east, north] = await Promise.all([sampleElevation(lon + D, lat, tileCache), sampleElevation(lon, lat + D, tileCache)]);
  let slopeDeg = 0;
  if (east != null && north != null) {
    const distM = 40, dzdx = (east - center) / distM, dzdy = (north - center) / distM;
    slopeDeg = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * 180 / Math.PI;
  }
  return { type: classifyElevationSlope(center, slopeDeg), elevation: center, slope: slopeDeg };
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
// Ridge Quest password reset — a short numeric code (typed back in, not a
// clicked link) is easier to use on a phone. crypto.getRandomValues, not
// Math.random(), for the same reason every other token in this file uses it.
function randomSixDigitCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1000000).padStart(6, "0");
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
// Ridge Quest player session — same token shape/expiry as createSession()
// above, deliberately a separate function/table (player_session, not
// user_session) since players and staff are different security domains.
async function createPlayerSession(env, playerId, ip) {
  const raw = randomHex(32);
  const hash = await sha256hex(raw);
  await env.DB.prepare(
    "INSERT INTO player_session (id, player_id, token_hash, expires_at, created_at, ip) VALUES (?,?,?,?,?,?)"
  ).bind(crypto.randomUUID(), playerId, hash, Date.now() + 30 * 24 * 3600 * 1000, new Date().toISOString(), ip || "").run();
  return raw;
}
// Resolves a bearer token to a logged-in player, or null. Deliberately not
// folded into auth() — see the "Ridge Quest: player auth" route block's own
// comment for why staff and player auth are kept as separate resolvers.
async function playerAuth(request, env) {
  const tok = bearer(request);
  if (!tok || !env.DB) return null;
  try {
    const hash = await sha256hex(tok);
    const row = await env.DB.prepare(
      "SELECT s.id AS sid, p.id AS pid, p.email, p.display_name, p.app_id FROM player_session s JOIN player_account p ON p.id=s.player_id WHERE s.token_hash=? AND s.expires_at>?"
    ).bind(hash, Date.now()).first();
    if (!row) return null;
    return { playerId: row.pid, email: row.email, displayName: row.display_name, appId: row.app_id };
  } catch (e) { return null; }
}
// Google Sign-In (Ridge Quest OAuth addendum). This Client ID is public by
// design (Google's own docs: it's meant to be embedded in frontend JS,
// never a secret) — unlike RESEND_API_KEY, it's a plain constant, not a
// wrangler secret.
const GOOGLE_OAUTH_CLIENT_ID = "228254697293-80gino7h5nfbbth1tlui3ndided7bjr8.apps.googleusercontent.com";
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}
// Verifies a Google Identity Services ID token entirely with native Web
// Crypto (no external JWT library — this repo has zero npm dependencies by
// design). Fetches Google's current public keys, checks the RS256
// signature, then exp/iss/aud. Returns the decoded payload (sub, email,
// email_verified, name, ...) or throws.
async function verifyGoogleIdToken(idToken, audience) {
  const parts = (idToken || "").split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [headerB64, payloadB64, sigB64] = parts;
  const header = b64urlToJson(headerB64);
  const payload = b64urlToJson(payloadB64);
  if (header.alg !== "RS256") throw new Error("unexpected alg");
  const jwksRes = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!jwksRes.ok) throw new Error("could not fetch Google signing keys");
  const jwks = await jwksRes.json();
  const jwk = (jwks.keys || []).find(k => k.kid === header.kid);
  if (!jwk) throw new Error("no matching Google signing key");
  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
  );
  const signedData = new TextEncoder().encode(headerB64 + "." + payloadB64);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(sigB64), signedData);
  if (!ok) throw new Error("bad signature");
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) throw new Error("token expired");
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") throw new Error("bad issuer");
  if (payload.aud !== audience) throw new Error("bad audience");
  return payload;
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

// --- Map Paint (POST /api/projects/:id/terrain-cells + the classifier's
// manual-cell guard) pure logic, factored out so tests/terrain-paint.test.js
// can exercise it without a live D1/Overpass, same pattern as the classifier
// helpers above. ---

// Drop hand-painted cells (source='manual') from the classifier's working
// set so a re-run only refreshes auto-classified ground. `candidateCells` is
// any iterable of h3 strings; `manualCells` a Set (or array) to protect.
function partitionManualCells(candidateCells, manualCells) {
  const manual = manualCells instanceof Set ? manualCells : new Set(manualCells || []);
  const toClassify = [];
  for (const c of candidateCells) if (!manual.has(c)) toClassify.push(c);
  return toClassify;
}

// Validate + normalise a terrain-cells POST body. Returns { paint, erase } or
// { error }. h3 strings guarded to 1..20 chars (same as reveal-cells),
// terrain_type to 1..40, variant_index coerced to an integer (default 0),
// and a hard 2000-cell-per-call cap (the client batches beyond that).
function normalizeTerrainPaint(body) {
  const okCell = c => typeof c === "string" && c.length > 0 && c.length <= 20;
  const paint = (Array.isArray(body && body.paint) ? body.paint : [])
    .filter(p => p && okCell(p.h3Cell) && typeof p.terrainType === "string" && p.terrainType.length > 0 && p.terrainType.length <= 40)
    .map(p => ({ h3Cell: p.h3Cell, terrainType: p.terrainType, variantIndex: Number.isInteger(p.variantIndex) ? p.variantIndex : 0 }));
  const erase = (Array.isArray(body && body.erase) ? body.erase : []).filter(okCell);
  if (!paint.length && !erase.length) return { error: "paint and/or erase (arrays) required" };
  if (paint.length + erase.length > 2000) return { error: "too many cells in one call (max 2000)" };
  return { paint, erase };
}

// Artistic Fog-of-War Tiles classifier internals, exported for
// tests/terrain-classifier.test.js -- same "_internal exports for a
// standalone Node test file" pattern as frontend/kalman-filter.js's
// GPSFilter._internal, adapted to this file's real ESM export syntax.
export {
  TERRAIN_TAXONOMY, TERRAIN_LINE_TYPES, BIOME_FALLBACK,
  hashCellToVariant, classifyFromOsm, classifyElevationSlope,
  overpassElementToPolygon, overpassElementToLine,
  partitionManualCells, normalizeTerrainPaint
};

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
      "/studio": "/audio-studio.html",
      "/chatterbox": "/chatterbox-studio.html",
      "/field": "/field-recorder.html",
      "/pipeline": "/pipeline-editor.html",
      "/code-library": "/pipeline-editor.html", // retired standalone page — the library is now an inline sidebar on /pipeline
      "/objects": "/object-studio.html",
      "/record": "/record.html",
      "/gpx-editor": "/gpx-editor.html",
      "/paint": "/map-paint.html",
      "/login": "/login.html",
      "/invite": "/invite.html",
      "/walk": "/geofence-engine.html",
      "/clients": "/clients.html",
      "/quest": "/ridge-quest.html"
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
    // Unlike their manual-trigger routes (POST /api/weather, POST
    // /api/snow-history), which wrap the same calls in try/catch and
    // return a JSON error, this had none — an upstream page-layout change
    // (scrapeWeather already anticipates this: "No Dogtooth data rows
    // found", "Row too short") threw uncaught here, silently skipping that
    // hour's cache update or that day's 8am snow snapshot with no signal
    // anywhere in-app, only visible via Cloudflare's own exception logs.
    try {
      if (event.cron === "*/5 * * * *") {
        await cleanupLiveZones(env);
        await cleanupOldRecordings(env);
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
    } catch (e) {
      console.error("scheduled(" + event.cron + ") failed:", e.message);
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

  // --- Ridge Quest: player auth ---
  // Deliberately NOT reusing auth()/scopesForRole() — players are a wholly
  // different security domain from staff (no scopes, no master, no
  // publish/analytics access at all), and folding them into the same
  // resolver would risk a privilege-escalation bug down the line if the two
  // concepts ever got confused. Mirrors the staff hashPassword/createSession
  // pattern exactly (same PBKDF2 + session-token shape), just against
  // player_account/player_session instead of user_account/user_session.
  // email is unique per app_id (not globally, unlike staff accounts) — see
  // migrations/0036_ridge_quest_players.sql's own comment on why.
  if (path === "/api/players/signup" && method === "POST") {
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    const b = await request.json().catch(() => ({}));
    const email = (b.email || "").toLowerCase().trim();
    if (!email || !b.password || !b.appId) return json({ error: "email, password and appId required" }, 400, AC);
    if (b.password.length < 8) return json({ error: "password must be at least 8 characters" }, 400, AC);
    const existing = await env.DB.prepare("SELECT id FROM player_account WHERE app_id=? AND email=?").bind(b.appId, email).first().catch(() => null);
    if (existing) return json({ error: "an account with this email already exists" }, 409, AC);
    const id = crypto.randomUUID();
    const salt = randomHex(16);
    const hash = await hashPassword(b.password, salt);
    await env.DB.prepare(
      "INSERT INTO player_account (id,email,password_hash,salt,app_id,display_name,created_at) VALUES (?,?,?,?,?,?,?)"
    ).bind(id, email, hash, salt, b.appId, b.displayName || null, new Date().toISOString()).run();
    const token = await createPlayerSession(env, id, request.headers.get("cf-connecting-ip") || "");
    return json({ ok: true, token, player: { id, email, displayName: b.displayName || null, appId: b.appId } }, 200, AC);
  }
  if (path === "/api/players/login" && method === "POST") {
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    const b = await request.json().catch(() => ({}));
    const email = (b.email || "").toLowerCase().trim();
    if (!email || !b.password || !b.appId) return json({ error: "email, password and appId required" }, 400, AC);
    const player = await env.DB.prepare(
      "SELECT id,email,display_name,password_hash,salt FROM player_account WHERE app_id=? AND email=?"
    ).bind(b.appId, email).first().catch(() => null);
    if (!player) return json({ error: "invalid credentials" }, 401, AC);
    const computed = await hashPassword(b.password, player.salt);
    if (computed !== player.password_hash) return json({ error: "invalid credentials" }, 401, AC);
    const token = await createPlayerSession(env, player.id, request.headers.get("cf-connecting-ip") || "");
    await env.DB.prepare("UPDATE player_account SET last_login_at=? WHERE id=?").bind(new Date().toISOString(), player.id).run().catch(() => {});
    return json({ ok: true, token, player: { id: player.id, email: player.email, displayName: player.display_name, appId: b.appId } }, 200, AC);
  }
  if (path === "/api/players/logout" && method === "POST") {
    const tok = bearer(request);
    if (tok && env.DB) {
      const h = await sha256hex(tok).catch(() => null);
      if (h) env.DB.prepare("DELETE FROM player_session WHERE token_hash=?").bind(h).run().catch(() => {});
    }
    return json({ ok: true }, 200, AC);
  }
  if (path === "/api/players/me" && method === "GET") {
    const P = await playerAuth(request, env);
    if (!P) return json({ error: "not authenticated" }, 401, AC);
    // Ridge Quest R5 — fogEnabled needs to reach the game client, but this
    // is the ONLY player-facing call Ridge Quest already makes on every
    // boot, and GET /api/apps (where every other app-level flag lives) is
    // staff-token-gated — players have none. A one-column join here avoids
    // adding a whole new public app-lookup endpoint just for this one flag.
    // A missing/failed row reads as "on," matching the column's DEFAULT 1
    // (fail open, not closed, for a purely visual feature).
    const appRow = await env.DB.prepare("SELECT fog_enabled FROM app WHERE id=?").bind(P.appId).first().catch(() => null);
    return json({ id: P.playerId, email: P.email, displayName: P.displayName, appId: P.appId,
                  fogEnabled: !(appRow && appRow.fog_enabled === 0) }, 200, AC);
  }
  // --- Ridge Quest: Google Sign-In ---
  // Looks up by google_sub first; falls back to matching (app_id, email) to
  // auto-link an existing password account — safe because Google has
  // already verified the email (checked below), not just asserted by the
  // client. Creates a new google_sub-only account (no password) if neither
  // matches. Issues a session the same way /api/players/login does.
  if (path === "/api/players/oauth/google" && method === "POST") {
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    const b = await request.json().catch(() => ({}));
    if (!b.credential || !b.appId) return json({ error: "credential and appId required" }, 400, AC);
    let payload;
    try {
      payload = await verifyGoogleIdToken(b.credential, GOOGLE_OAUTH_CLIENT_ID);
    } catch (e) {
      return json({ error: "invalid Google credential: " + e.message }, 401, AC);
    }
    if (!payload.email_verified) return json({ error: "Google account email is not verified" }, 401, AC);
    const email = (payload.email || "").toLowerCase().trim();
    if (!email) return json({ error: "Google account has no email" }, 400, AC);
    let player = await env.DB.prepare(
      "SELECT id,email,display_name FROM player_account WHERE app_id=? AND google_sub=?"
    ).bind(b.appId, payload.sub).first().catch(() => null);
    if (!player) {
      const byEmail = await env.DB.prepare(
        "SELECT id,email,display_name FROM player_account WHERE app_id=? AND email=?"
      ).bind(b.appId, email).first().catch(() => null);
      if (byEmail) {
        await env.DB.prepare("UPDATE player_account SET google_sub=? WHERE id=?").bind(payload.sub, byEmail.id).run();
        player = byEmail;
      } else {
        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO player_account (id,email,google_sub,app_id,display_name,created_at) VALUES (?,?,?,?,?,?)"
        ).bind(id, email, payload.sub, b.appId, payload.name || null, new Date().toISOString()).run();
        player = { id, email, display_name: payload.name || null };
      }
    }
    const token = await createPlayerSession(env, player.id, request.headers.get("cf-connecting-ip") || "");
    await env.DB.prepare("UPDATE player_account SET last_login_at=? WHERE id=?").bind(new Date().toISOString(), player.id).run().catch(() => {});
    return json({ ok: true, token, player: { id: player.id, email: player.email, displayName: player.display_name, appId: b.appId } }, 200, AC);
  }
  // --- Ridge Quest: forgot / reset password (6-digit code, not a link —
  // easier to type back in on a phone mid-hill than tap through email) ---
  // reset_token stores the HASH of the code (never the raw code), same
  // never-store-raw-secrets convention as every session token in this file.
  // forgot-password always returns ok regardless of whether the email
  // exists, so this endpoint can't be used to enumerate accounts.
  if (path === "/api/players/forgot-password" && method === "POST") {
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    const b = await request.json().catch(() => ({}));
    const email = (b.email || "").toLowerCase().trim();
    if (!email || !b.appId) return json({ error: "email and appId required" }, 400, AC);
    const player = await env.DB.prepare("SELECT id FROM player_account WHERE app_id=? AND email=?").bind(b.appId, email).first().catch(() => null);
    if (player) {
      const code = randomSixDigitCode();
      const codeHash = await sha256hex(code);
      const resetExpires = Date.now() + 15 * 60 * 1000; // 15 minutes
      await env.DB.prepare("UPDATE player_account SET reset_token=?,reset_expires=? WHERE id=?").bind(codeHash, resetExpires, player.id).run();
      // Failure is logged, not surfaced to the caller — this endpoint must
      // not reveal whether an email exists or whether sending succeeded
      // (same reasoning as the unconditional {ok:true} below). console.error
      // shows up in `wrangler tail`, the only way to diagnose a bad
      // RESEND_API_KEY/FROM_EMAIL/unverified-domain failure in production
      // since nothing here can surface it to the player.
      await sendEmail(env, {
        to: email, subject: "Your Ridge Quest reset code",
        html: `<p>Your password reset code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p>This code expires in 15 minutes. If you didn't request this, you can ignore this email.</p>`
      }).catch(e => { console.error("sendEmail (reset code) failed:", e.message); });
    }
    return json({ ok: true }, 200, AC);
  }
  // Read-only check (doesn't consume the code) — lets the frontend show
  // immediate "wrong code" feedback before asking for a new password.
  // reset-password below re-validates the code itself, so this step being
  // skipped or bypassed client-side isn't a security boundary, just UX.
  if (path === "/api/players/verify-reset-code" && method === "POST") {
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    const b = await request.json().catch(() => ({}));
    const email = (b.email || "").toLowerCase().trim();
    if (!email || !b.appId || !b.code) return json({ error: "email, appId and code required" }, 400, AC);
    const codeHash = await sha256hex(String(b.code).trim());
    const player = await env.DB.prepare(
      "SELECT id FROM player_account WHERE app_id=? AND email=? AND reset_token=? AND reset_expires>?"
    ).bind(b.appId, email, codeHash, Date.now()).first().catch(() => null);
    return json({ ok: !!player }, 200, AC);
  }
  if (path === "/api/players/reset-password" && method === "POST") {
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    const b = await request.json().catch(() => ({}));
    const email = (b.email || "").toLowerCase().trim();
    if (!email || !b.appId || !b.code || !b.password) return json({ error: "email, appId, code and password required" }, 400, AC);
    if (b.password.length < 8) return json({ error: "password must be at least 8 characters" }, 400, AC);
    const codeHash = await sha256hex(String(b.code).trim());
    const player = await env.DB.prepare(
      "SELECT id FROM player_account WHERE app_id=? AND email=? AND reset_token=? AND reset_expires>?"
    ).bind(b.appId, email, codeHash, Date.now()).first().catch(() => null);
    if (!player) return json({ error: "invalid or expired code" }, 400, AC);
    const salt = randomHex(16);
    const hash = await hashPassword(b.password, salt);
    await env.DB.prepare("UPDATE player_account SET password_hash=?,salt=?,reset_token=NULL,reset_expires=NULL WHERE id=?").bind(hash, salt, player.id).run();
    // Invalidate every existing session on this account — a password reset
    // is often prompted by a compromised account, so any session an
    // attacker already holds should be logged out too, not just future ones.
    await env.DB.prepare("DELETE FROM player_session WHERE player_id=?").bind(player.id).run().catch(() => {});
    return json({ ok: true }, 200, AC);
  }

  // --- Ridge Quest: mandatory onboarding gate (data consent, liability
  // waiver, Skier Responsibility Code) ---
  // Reuses the `consent` table (already append-only + versioned, extended
  // in migrations/0036 with a playerId column) rather than a new table —
  // same shape as the existing device-consent routes just below, keyed by
  // playerId instead of deviceId. Versions are SERVER-side, not
  // client-supplied — bump the version string here when the resort updates
  // any of these documents' wording, and every returning player is
  // re-gated on next consent-status check until they accept the new
  // version. This route only records acceptance; it does not store or
  // serve the actual document text (that's static frontend content).
  const REQUIRED_CONSENT = { "data-privacy": "1", "liability-waiver": "1", "responsibility-code": "1" };
  const mc = path.match(/^\/api\/players\/([^/]+)\/consent$/);
  if (mc && method === "POST") {
    const P = await playerAuth(request, env);
    if (!P || P.playerId !== decodeURIComponent(mc[1])) return json({ error: "not authenticated" }, 401, AC);
    const b = await request.json().catch(() => ({}));
    if (!b.scope || !(b.scope in REQUIRED_CONSENT)) return json({ error: "unknown consent scope" }, 400, AC);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO consent (id,deviceId,playerId,scope,granted,version,grantedAt,revokedAt) VALUES (?,NULL,?,?,1,?,?,NULL)"
    ).bind(crypto.randomUUID(), P.playerId, b.scope, REQUIRED_CONSENT[b.scope], now).run();
    return json({ ok: true, scope: b.scope, version: REQUIRED_CONSENT[b.scope] }, 200, AC);
  }
  if (mc && method === "GET") {
    const P = await playerAuth(request, env);
    if (!P || P.playerId !== decodeURIComponent(mc[1])) return json({ error: "not authenticated" }, 401, AC);
    const { results } = await env.DB
      .prepare("SELECT scope,granted,version,grantedAt FROM consent WHERE playerId=? ORDER BY grantedAt ASC")
      .bind(P.playerId).all();
    const latest = {};
    (results || []).forEach(r => { latest[r.scope] = r; }); // later rows overwrite earlier ones — ASC order means last-write-wins
    const missing = Object.keys(REQUIRED_CONSENT).filter(scope => {
      const r = latest[scope];
      return !r || !r.granted || r.version !== REQUIRED_CONSENT[scope];
    });
    return json({ complete: missing.length === 0, missing, required: REQUIRED_CONSENT }, 200, AC);
  }

  // --- Ridge Quest: right to delete (real delete, not deactivation) ---
  // Mirrors POST /api/devices/:id/forget's exact pattern. NOTE for future
  // phases: R1-R3 add quest_session/quest_run/player_fog_cell/
  // player_day_stats — each of those tables MUST be added to this batch
  // when it's created, or a player's "delete my data" request will silently
  // leave their GPS-derived run history behind. Same class of trap as this
  // codebase's other "field added in N places, one got missed" incidents
  // (see CLAUDE.md's editorToSimBundle()/Code Object attach-detach notes) —
  // grep this function whenever a new player-scoped table is added.
  const mplf = path.match(/^\/api\/players\/([^/]+)\/forget$/);
  if (mplf && method === "POST") {
    const P = await playerAuth(request, env);
    if (!P || P.playerId !== decodeURIComponent(mplf[1])) return json({ error: "not authenticated" }, 401, AC);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM consent WHERE playerId=?").bind(P.playerId),
      env.DB.prepare("DELETE FROM player_session WHERE player_id=?").bind(P.playerId),
      env.DB.prepare("DELETE FROM quest_run WHERE player_id=?").bind(P.playerId),
      env.DB.prepare("DELETE FROM player_fog_cell WHERE player_id=?").bind(P.playerId),
      env.DB.prepare("DELETE FROM player_day_stats WHERE player_id=?").bind(P.playerId),
      // player_day_activity_stats (R6, 2026-08-20) — added per this
      // function's own header warning: a player_id FK to player_account
      // means skipping this actually BLOCKS the delete outright (caught
      // live, D1_ERROR: FOREIGN KEY constraint failed), not just leaves
      // orphaned data behind like the others technically could.
      env.DB.prepare("DELETE FROM player_day_activity_stats WHERE player_id=?").bind(P.playerId),
      env.DB.prepare("DELETE FROM player_account WHERE id=?").bind(P.playerId)
    ]);
    return json({ ok: true, forgotten: P.playerId }, 200, AC);
  }

  // --- Ridge Quest R2: H3 fog-of-war reveal ---
  // Client computes which H3 res-10 cells to grant (disk-reveal around each
  // confidence-gated GPS fix — see ridge-quest.html's Quest module) and the
  // server just persists it, upgrade-only, same trust model as quest_run
  // above. state=2 ("Visible", actually skied) is the only value R2 ever
  // sends; state=1 ("Fog", viewpoint-seen) is reserved for R4's
  // action.reveal_viewshed pipeline block, not built yet. Absence of a row
  // for a cell means Shroud (never seen).
  if (path === "/api/fog-cells" && method === "POST") {
    const P = await playerAuth(request, env);
    if (!P) return json({ error: "not authenticated" }, 401, AC);
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    const b = await request.json().catch(() => ({}));
    const cells = Array.isArray(b.cells) ? b.cells.filter(c => typeof c === "string" && c.length > 0 && c.length <= 20) : [];
    const state = b.state === 1 ? 1 : 2;
    if (!cells.length) return json({ error: "cells (non-empty array) required" }, 400, AC);
    if (cells.length > 500) return json({ error: "too many cells in one call (max 500)" }, 400, AC);
    const now = new Date().toISOString();
    await env.DB.batch(cells.map(cell =>
      env.DB.prepare(
        "INSERT INTO player_fog_cell (player_id,h3_cell,state,updated_at) VALUES (?,?,?,?) ON CONFLICT(player_id,h3_cell) DO UPDATE SET state=MAX(state,excluded.state), updated_at=excluded.updated_at"
      ).bind(P.playerId, cell, state, now)
    ));
    return json({ ok: true, count: cells.length }, 200, AC);
  }
  const mpfog = path.match(/^\/api\/players\/([^/]+)\/fog$/);
  if (mpfog && method === "GET") {
    const P = await playerAuth(request, env);
    if (!P || P.playerId !== decodeURIComponent(mpfog[1])) return json({ error: "not authenticated" }, 401, AC);
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    const { results } = await env.DB.prepare("SELECT h3_cell,state FROM player_fog_cell WHERE player_id=?").bind(P.playerId).all();
    return json({ cells: results || [] }, 200, AC);
  }

  // --- Ridge Quest R3-core: points/day-bucket/season helpers ---
  // D1/SQLite has no timezone database, so date(started_at) alone buckets
  // by UTC day — wrong for Golden BC (UTC-7/-6 depending on DST, which D1
  // can't model either). QUEST_DAY_BUCKET_OFFSET_H is a fixed, non-DST-aware
  // rule applied in JS before bucketing, named as a constant so the
  // simplification is visible rather than buried in a magic SQL literal.
  // Mirrored verbatim in tests/quest-stats.test.js — keep both in sync.
  const QUEST_DAY_BUCKET_OFFSET_H = -7;
  function questDateBucket(iso) {
    return new Date(new Date(iso).getTime() + QUEST_DAY_BUCKET_OFFSET_H * 3600000).toISOString().slice(0, 10);
  }
  // Ski season spans one calendar year-end; September is well before any
  // real season starts, so picking it as the rollover point never
  // misclassifies a real day.
  function questSeasonId(iso) {
    const d = new Date(new Date(iso).getTime() + QUEST_DAY_BUCKET_OFFSET_H * 3600000);
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    return m >= 9 ? (y + "-" + (y + 1)) : ((y - 1) + "-" + y);
  }
  // Per-vertical-metre weight by difficulty, MULTIPLIED by a second weight
  // for runType — both tuning knobs, not architecture decisions (start
  // simple, adjust after real play data, same spirit as this codebase's
  // other TUNING-object constants). runType is the corridor's AUTHORED
  // category (run/chute/bowl/ridge/hike/lift, set in Fence Editor),
  // distinct from `activity` (ski/lift/hike, DETECTED per-crossing by R1's
  // speed/direction classifier) — a run-type corridor skinned slowly still
  // gets its "run" runType weight even though that crossing's activity is
  // "hike". Only ski/hike activity earns points; a lift ride is transport,
  // not an accomplishment (zeroed via the activity check regardless of
  // runType). No separate "trees" category — tree runs are rated through
  // the existing difficulty scale like any other terrain, per explicit
  // product decision (2026-08-19).
  const QUEST_DIFFICULTY_POINTS_PER_VERT_M = { green: 1, blue: 1.5, black: 2, "double-black": 3 };
  const QUEST_RUNTYPE_POINTS_MULTIPLIER = { run: 1, chute: 1.4, bowl: 1.2, ridge: 1.3, hike: 1.1 };
  // Conditions bonus (fresh snow only, confirmed via AskUserQuestion,
  // 2026-08-19) — looked up SERVER-SIDE from snow_history by the run's own
  // date bucket, never client-supplied (a player could otherwise just claim
  // "it was a powder day" to farm points). snapshot_date is already a local
  // YYYY-MM-DD date from the same 8am MST daily snapshot cron (CLAUDE.md) —
  // matches questDateBucket's own local-day convention closely enough here.
  // Highest-threshold-first; hn24_cm==null (no snapshot yet, or the
  // scraper's own upstream source was down) is a bonus of 1, not a penalty —
  // same "no data = pass" convention altOk()/hazard raycasting already use.
  const QUEST_SNOW_BONUS_TIERS = [[30, 1.5], [15, 1.25], [5, 1.1]]; // [hn24_cm threshold, multiplier]
  function questSnowBonus(hn24Cm) {
    if (hn24Cm == null) return 1;
    for (const [threshold, mult] of QUEST_SNOW_BONUS_TIERS) if (hn24Cm >= threshold) return mult;
    return 1;
  }
  // R6 — bike/drive earn points from DISTANCE, not vertical (confirmed
  // product decision, 2026-08-20 — a road/bike trail doesn't have a "vertical
  // descended" the way a ski run does). Rates sized so a typical outing
  // lands near ski's own ~400-600pt range: a 2.5km blue MTB trail scores
  // 2500*0.18*1.4 ≈ 630; an 8km scenic drive scores 8000*0.06 ≈ 480. Drive's
  // rate is roughly a third of bike's — a drive covers far more ground per
  // minute of actual player engagement, so per-metre needs to be lower to
  // land in the same ballpark.
  // R12 (2026-08-20) — xcski (cross-country/Nordic skiing), a genuinely NEW
  // 5th activity distinct from downhill "ski", added alongside the
  // per-project activity-relevance filter (see quest_activities). Scored
  // like bike/drive (distance-based), NOT like ski/hike (vertical-based):
  // real Nordic terrain is flat/rolling, so "vertical descended" doesn't
  // mean anything for it. Rate sized to land near ski's ~400-600pt range
  // for a typical 8-12km outing (10km blue-rated loop: 10000*0.065*1.15
  // ≈ 748) — tunable, not measured, same as every other QUEST_TUNING/
  // scoring constant here.
  const QUEST_ACTIVITY_DISTANCE_POINTS_PER_M = { bike: 0.18, drive: 0.06, xcski: 0.065 };
  // Bike reuses ski's exact green/blue/black/double-black corridor field —
  // real MTB trail systems are rated on this identical scale — but with its
  // OWN multiplier values (ski's own table above stays locked/tuned as
  // confirmed 2026-08-19, not touched here). Drive corridors aren't
  // difficulty-rated in the real world (a road isn't "green/blue/black"),
  // so any difficulty present is ignored — multiplier fixed at 1 rather than
  // borrowed from bike/ski's scale, which wouldn't mean anything applied to
  // a road. Neither activity gets a runType-equivalent; runType stays ski
  // vocabulary (run/chute/bowl/ridge/hike/lift) and simply isn't applied —
  // an incidental runType/difficulty value on a bike/drive corridor is
  // harmless no-op metadata, same as it already is for lift corridors today.
  const QUEST_BIKE_DIFFICULTY_MULTIPLIER = { green: 1, blue: 1.4, black: 1.8, "double-black": 2.4 };
  // xcski DOES get its own difficulty multiplier, unlike drive — real Nordic
  // centres genuinely grade their trail network green/blue/black (novice/
  // intermediate/advanced classic-or-skate terrain), so an incidental
  // difficulty value here is real signal, not no-op metadata. Spread is
  // gentler than bike's — trail-to-trail difficulty variance at a Nordic
  // centre is grade/grooming, not the technical-hazard spread of MTB.
  const QUEST_XCSKI_DIFFICULTY_MULTIPLIER = { green: 1, blue: 1.15, black: 1.3 };
  const QUEST_LEADERBOARD_ACTIVITIES = ["ski", "hike", "bike", "drive", "xcski"];
  function questPoints(activity, difficulty, runType, verticalM, distanceM, snowBonus) {
    if (activity === "lift") return 0;
    if (activity === "ski" || activity === "hike") {
      if (verticalM == null) return 0;
      const w = (QUEST_DIFFICULTY_POINTS_PER_VERT_M[difficulty] || 1) * (QUEST_RUNTYPE_POINTS_MULTIPLIER[runType] || 1) * (snowBonus || 1);
      return Math.round(Math.abs(verticalM) * w);
    }
    if (activity === "bike" || activity === "drive" || activity === "xcski") {
      if (distanceM == null) return 0;
      const perM = QUEST_ACTIVITY_DISTANCE_POINTS_PER_M[activity] || 0;
      const diffMult = activity === "bike" ? (QUEST_BIKE_DIFFICULTY_MULTIPLIER[difficulty] || 1)
        : activity === "xcski" ? (QUEST_XCSKI_DIFFICULTY_MULTIPLIER[difficulty] || 1)
        : 1;
      return Math.round(Math.abs(distanceM) * perM * diffMult);
    }
    return 0;
  }

  // --- Ridge Quest R1: corridor-crossing runs ---
  // Classification (ski/lift/hike, direction, speed, vertical) happens
  // CLIENT-SIDE in ridge-quest.html's own self-contained corridor detector
  // and the server trusts it — same trust model this whole platform already
  // uses for zone behavior (CLAUDE.md's Pipeline System: "executed locally
  // on the visitor's device... no server round-trip to decide what fires"),
  // not a new concession. appId is taken from the authenticated player's own
  // account, never from the request body, so a player can't attribute a run
  // to a different app's leaderboard.
  if (path === "/api/quest-runs" && method === "POST") {
    const P = await playerAuth(request, env);
    if (!P) return json({ error: "not authenticated" }, 401, AC);
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    const b = await request.json().catch(() => ({}));
    if (!b.zoneId || !b.activity || !b.startedAt || !b.endedAt)
      return json({ error: "zoneId, activity, startedAt and endedAt are required" }, 400, AC);
    if (!["ski", "lift", "hike", "bike", "drive", "xcski"].includes(b.activity))
      return json({ error: "activity must be ski, lift, hike, bike, drive, or xcski" }, 400, AC);
    const id = crypto.randomUUID();
    const verticalM = b.verticalM != null ? b.verticalM : null;
    const distanceM = b.distanceM != null ? b.distanceM : null;
    // R3-core rollup, folded into the SAME batch as the quest_run insert —
    // a run and its day-stats update can never diverge (no separate write
    // path to fall out of sync). Incrementing (ON CONFLICT DO UPDATE
    // SET x=x+excluded.x), not overwriting, since a day can have many runs.
    const dateBucket = questDateBucket(b.startedAt);
    const seasonId = questSeasonId(b.startedAt);
    const snowRow = await env.DB.prepare("SELECT hn24_cm FROM snow_history WHERE snapshot_date=?").bind(dateBucket).first().catch(() => null);
    // R6 — the snow bonus is a ski/hike-only concept (fresh powder doesn't
    // change how far a road goes). Forced to 1 for bike/drive BEFORE it's
    // stored, not just inside the points formula — otherwise a powder-day
    // bike run would store a misleading nonzero snow_bonus on a run that
    // earned no bonus at all.
    const snowBonusRaw = questSnowBonus(snowRow ? snowRow.hn24_cm : null);
    const snowBonus = (b.activity === "ski" || b.activity === "hike") ? snowBonusRaw : 1;
    const points = questPoints(b.activity, b.difficulty, b.runType, verticalM, distanceM, snowBonus);
    const now = new Date().toISOString();
    const batch = [
      env.DB.prepare(
        `INSERT INTO quest_run
         (id,player_id,app_id,zone_id,run_name,difficulty,run_type,activity,started_at,ended_at,duration_s,vertical_m,distance_m,avg_speed_mps,max_speed_mps,created_at,points,snow_bonus)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        id, P.playerId, P.appId, b.zoneId, b.runName || null, b.difficulty || null, b.runType || null, b.activity,
        b.startedAt, b.endedAt, b.durationS || 0, verticalM,
        distanceM, b.avgSpeedMps != null ? b.avgSpeedMps : null,
        b.maxSpeedMps != null ? b.maxSpeedMps : null, now, points, snowBonus
      ),
      env.DB.prepare(
        `INSERT INTO player_day_stats (player_id,app_id,date,season_id,points,vertical_m,runs_count,lift_rides,hikes)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(player_id,date) DO UPDATE SET
           points=points+excluded.points, vertical_m=vertical_m+excluded.vertical_m,
           runs_count=runs_count+excluded.runs_count, lift_rides=lift_rides+excluded.lift_rides, hikes=hikes+excluded.hikes`
      ).bind(
        P.playerId, P.appId, dateBucket, seasonId, points, Math.abs(verticalM || 0),
        b.activity === "ski" ? 1 : 0, b.activity === "lift" ? 1 : 0, b.activity === "hike" ? 1 : 0
      )
    ];
    // R6 — the new per-activity rollup, only for activities that actually
    // earn a leaderboard spot (never 'lift'). Left completely separate from
    // the player_day_stats upsert above, which stays byte-for-byte
    // unchanged — bike/drive runs DO still add into its combined `points`
    // column (so the existing single leaderboard now genuinely reflects
    // every activity), but never touch its vertical_m/runs_count/
    // lift_rides/hikes, which stay ski/lift/hike-specific.
    if (b.activity !== "lift") {
      batch.push(env.DB.prepare(
        `INSERT INTO player_day_activity_stats (player_id,app_id,date,season_id,activity,points,vertical_m,distance_m,runs_count)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(player_id,date,activity) DO UPDATE SET
           points=points+excluded.points, vertical_m=vertical_m+excluded.vertical_m,
           distance_m=distance_m+excluded.distance_m, runs_count=runs_count+excluded.runs_count`
      ).bind(P.playerId, P.appId, dateBucket, seasonId, b.activity, points, Math.abs(verticalM || 0), Math.abs(distanceM || 0), 1));
    }
    await env.DB.batch(batch);
    return json({ ok: true, id, points, snowBonus }, 200, AC);
  }
  const mpr = path.match(/^\/api\/players\/([^/]+)\/runs$/);
  if (mpr && method === "GET") {
    const P = await playerAuth(request, env);
    if (!P || P.playerId !== decodeURIComponent(mpr[1])) return json({ error: "not authenticated" }, 401, AC);
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    const limit = Math.min(200, Math.max(1, +(url.searchParams.get("limit") || 50)));
    const { results } = await env.DB.prepare(
      "SELECT id,zone_id,run_name,difficulty,run_type,activity,started_at,ended_at,duration_s,vertical_m,distance_m,avg_speed_mps,max_speed_mps,points,snow_bonus FROM quest_run WHERE player_id=? ORDER BY started_at DESC LIMIT ?"
    ).bind(P.playerId, limit).all();
    return json({ runs: results || [] }, 200, AC);
  }

  // --- Ridge Quest R3-core: a player's own day-stats (streaks/today's
  // tiles are derived CLIENT-SIDE from these rows, not stored/computed
  // server-side — a season is at most ~200 rows per player, cheap to scan,
  // and this avoids a second incremental counter that could drift from
  // player_day_stats itself) ---
  const mps = path.match(/^\/api\/players\/([^/]+)\/stats$/);
  if (mps && method === "GET") {
    const P = await playerAuth(request, env);
    if (!P || P.playerId !== decodeURIComponent(mps[1])) return json({ error: "not authenticated" }, 401, AC);
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    const { results } = await env.DB.prepare(
      "SELECT date,season_id,points,vertical_m,runs_count,lift_rides,hikes FROM player_day_stats WHERE player_id=? ORDER BY date DESC LIMIT 200"
    ).bind(P.playerId).all();
    return json({ days: results || [] }, 200, AC);
  }

  // --- Ridge Quest R3-core: leaderboards ---
  // Scoped to the CALLER's own app_id (never client-supplied) — same
  // reasoning quest_run already uses, so one resort's leaderboard can never
  // leak into another's. NEVER returns email — the R0 data-privacy consent
  // screen explicitly told players only their display name and points may
  // be visible to others. A null display_name gets a generated fallback
  // ("Skier 4821"-style, from the player id) rather than falling back to
  // email or leaking a raw UUID.
  function leaderboardName(row) {
    return row.display_name || ("Skier " + row.player_id.replace(/-/g, "").slice(0, 4).toUpperCase());
  }
  if (path === "/api/leaderboard/daily" && method === "GET") {
    const P = await playerAuth(request, env);
    if (!P) return json({ error: "not authenticated" }, 401, AC);
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    const date = url.searchParams.get("date") || questDateBucket(new Date().toISOString());
    // R6 — optional per-activity filter, fully backward-compatible: absent
    // is today's exact combined query, byte-for-byte unchanged below.
    const activity = url.searchParams.get("activity");
    if (activity) {
      if (!QUEST_LEADERBOARD_ACTIVITIES.includes(activity)) return json({ error: "invalid activity" }, 400, AC);
      const { results } = await env.DB.prepare(
        `SELECT s.player_id, p.display_name, s.points, s.vertical_m, s.distance_m, s.runs_count
         FROM player_day_activity_stats s JOIN player_account p ON p.id = s.player_id
         WHERE s.app_id=? AND s.date=? AND s.activity=? ORDER BY s.points DESC LIMIT 100`
      ).bind(P.appId, date, activity).all();
      const board = (results || []).map(r => ({ playerId: r.player_id, name: leaderboardName(r), points: r.points, verticalM: r.vertical_m, distanceM: r.distance_m, runsCount: r.runs_count }));
      return json({ date, activity, board }, 200, AC);
    }
    const { results } = await env.DB.prepare(
      `SELECT s.player_id, p.display_name, s.points, s.vertical_m, s.runs_count
       FROM player_day_stats s JOIN player_account p ON p.id = s.player_id
       WHERE s.app_id=? AND s.date=? ORDER BY s.points DESC LIMIT 100`
    ).bind(P.appId, date).all();
    const board = (results || []).map(r => ({ playerId: r.player_id, name: leaderboardName(r), points: r.points, verticalM: r.vertical_m, runsCount: r.runs_count }));
    return json({ date, board }, 200, AC);
  }
  if (path === "/api/leaderboard/season" && method === "GET") {
    const P = await playerAuth(request, env);
    if (!P) return json({ error: "not authenticated" }, 401, AC);
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    const seasonId = url.searchParams.get("seasonId") || questSeasonId(new Date().toISOString());
    const activity = url.searchParams.get("activity");
    if (activity) {
      if (!QUEST_LEADERBOARD_ACTIVITIES.includes(activity)) return json({ error: "invalid activity" }, 400, AC);
      const { results } = await env.DB.prepare(
        `SELECT s.player_id, p.display_name, SUM(s.points) AS points, SUM(s.vertical_m) AS vertical_m, SUM(s.distance_m) AS distance_m, SUM(s.runs_count) AS runs_count
         FROM player_day_activity_stats s JOIN player_account p ON p.id = s.player_id
         WHERE s.app_id=? AND s.season_id=? AND s.activity=? GROUP BY s.player_id ORDER BY points DESC LIMIT 100`
      ).bind(P.appId, seasonId, activity).all();
      const board = (results || []).map(r => ({ playerId: r.player_id, name: leaderboardName(r), points: r.points, verticalM: r.vertical_m, distanceM: r.distance_m, runsCount: r.runs_count }));
      return json({ seasonId, activity, board }, 200, AC);
    }
    const { results } = await env.DB.prepare(
      `SELECT s.player_id, p.display_name, SUM(s.points) AS points, SUM(s.vertical_m) AS vertical_m, SUM(s.runs_count) AS runs_count
       FROM player_day_stats s JOIN player_account p ON p.id = s.player_id
       WHERE s.app_id=? AND s.season_id=? GROUP BY s.player_id ORDER BY points DESC LIMIT 100`
    ).bind(P.appId, seasonId).all();
    const board = (results || []).map(r => ({ playerId: r.player_id, name: leaderboardName(r), points: r.points, verticalM: r.vertical_m, runsCount: r.runs_count }));
    return json({ seasonId, board }, 200, AC);
  }
  // --- Ridge Quest R6: idempotent backfill of player_day_activity_stats
  // from historical quest_run rows (needed because activity stats didn't
  // exist before this phase — without this, a new "Ski" leaderboard filter
  // would look blank next to an already-populated combined board for the
  // exact same days). Safe to re-run any time: fully wipes and rebuilds
  // (it's a derived rollup, never a source of truth). Uses
  // questDateBucket/questSeasonId, not raw SQL date math, so it can never
  // drift from the exact bucketing rule every other read/write path uses.
  if (path === "/api/quest-backfill-activity-stats" && method === "POST") {
    if (!(await authed(request, env))) return json({ error: "master token required" }, 401, AC);
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    await env.DB.prepare("DELETE FROM player_day_activity_stats").run();
    const { results } = await env.DB.prepare(
      "SELECT player_id, app_id, activity, points, vertical_m, distance_m, started_at FROM quest_run WHERE activity != 'lift'"
    ).all();
    const agg = new Map(); // "playerId|date|activity" -> {playerId,appId,date,seasonId,activity,points,verticalM,distanceM,runsCount}
    for (const r of (results || [])) {
      const date = questDateBucket(r.started_at);
      const seasonId = questSeasonId(r.started_at);
      const key = r.player_id + "|" + date + "|" + r.activity;
      const row = agg.get(key) || { playerId: r.player_id, appId: r.app_id, date, seasonId, activity: r.activity, points: 0, verticalM: 0, distanceM: 0, runsCount: 0 };
      row.points += r.points || 0;
      row.verticalM += Math.abs(r.vertical_m || 0);
      row.distanceM += Math.abs(r.distance_m || 0);
      row.runsCount += 1;
      agg.set(key, row);
    }
    const rows = [...agg.values()];
    const batch = rows.map(row => env.DB.prepare(
      `INSERT INTO player_day_activity_stats (player_id,app_id,date,season_id,activity,points,vertical_m,distance_m,runs_count) VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(row.playerId, row.appId, row.date, row.seasonId, row.activity, row.points, row.verticalM, row.distanceM, row.runsCount));
    if (batch.length) await env.DB.batch(batch);
    return json({ ok: true, rows: rows.length }, 200, AC);
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
    }).catch(e => { console.error("sendEmail (invite) failed:", e.message); });
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
    // Non-master callers may only touch accounts in their own org — without
    // this, any operator/admin session could edit or hard-delete ANY
    // account platform-wide (including other companies' admins) just by
    // knowing/guessing a uid.
    if (!A.master) {
      const targetOrg = await env.DB.prepare("SELECT org_id FROM user_account WHERE id=?").bind(uid).first();
      if (!targetOrg || targetOrg.org_id !== A.appId) return json({ error: "unauthorized" }, 403, AC);
    }
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
    const user = await env.DB.prepare("SELECT id,email,name,org_id FROM user_account WHERE id=?").bind(uid).first().catch(() => null);
    if (!user) return json({ error: "user not found" }, 404, AC);
    // Same cross-org guard as PUT/DELETE above — reissuing an invite token
    // for an account outside the caller's own org would hand back a raw
    // token (in the response below) that can set that account's password
    // via the public /api/auth/set-password endpoint.
    if (!A.master && user.org_id !== A.appId) return json({ error: "unauthorized" }, 403, AC);
    const rawToken = randomHex(32);
    const tokenHash = await sha256hex(rawToken);
    await env.DB.prepare("UPDATE user_account SET invite_token=?,invite_expires=? WHERE id=?")
      .bind(tokenHash, Date.now() + 7 * 24 * 3600 * 1000, uid).run();
    const inviteUrl = appUrl(env, "/invite?token=" + rawToken, request);
    await sendEmail(env, {
      to: user.email, subject: "Your Chase Life invite link",
      html: `<p>Here is your updated invite link for Chase Life:</p><p><a href="${inviteUrl}">Set your password</a></p><p>This link expires in 7 days.</p>`
    }).catch(e => { console.error("sendEmail (resend invite) failed:", e.message); });
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
      // Cascade previously stopped at projects/staff, silently orphaning
      // every other org_id-scoped table. POST /api/clients only checks for
      // a CURRENTLY-existing id/slug, so a new company onboarded under a
      // reused slug would otherwise silently inherit the deleted client's
      // private Chatterbox voice palette, custom code objects, and paid
      // entitlement grants. code_object.org_id can be NULL (built-in
      // templates, shared across every org) — the org_id=? filter already
      // excludes those, same as every other org-scoped query in this file.
      await env.DB.prepare("DELETE FROM chatterbox_voice WHERE org_id=?").bind(cid).run();
      await env.DB.prepare("DELETE FROM code_object WHERE org_id=?").bind(cid).run();
      await env.DB.prepare("DELETE FROM code_object_folder WHERE org_id=?").bind(cid).run();
      await env.DB.prepare("DELETE FROM org_entitlement WHERE org_id=?").bind(cid).run();
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
    const sql = "SELECT a.id,a.orgId,a.name,a.slug,a.description,a.updatedAt,a.three_d_enabled AS threeDEnabled, " +
      "a.terrain_altitude_enabled AS terrainAltitudeEnabled, a.visitors_fly AS visitorsFly, " +
      "a.hazard_aware_enabled AS hazardAwareEnabled, a.fog_enabled AS fogEnabled, " +
      "a.quest_enabled AS questEnabled, a.tile_art_enabled AS tileArtEnabled, " +
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
    // threeDEnabled is the single tenant-level flag gating the whole AR/3D
    // upgrade (terrain on all 5 map surfaces + AR-object authoring in the
    // editor) — omit the field entirely to leave it unchanged.
    const threeD = b.threeDEnabled === undefined ? null : (b.threeDEnabled ? 1 : 0);
    // terrainAltitudeEnabled is deliberately its own flag, not folded into
    // threeDEnabled (item D, rescoped 2026-08-14): it controls whether the
    // production player defaults an altitude-gated stop's trigger to
    // terrain-DEM elevation instead of raw phone GPS altitude — a real
    // trigger-behavior change for a live tour, not just a visual one, so it
    // needs its own explicit opt-in even for a workspace that already has
    // 3D Mode on.
    const terrainAlt = b.terrainAltitudeEnabled === undefined ? null : (b.terrainAltitudeEnabled ? 1 : 0);
    // visitorsFly (item A, paraglider/drone stops, 2026-08-14) — a third,
    // separate flag: stops applyTerrainAltFallback() from clobbering a
    // flying visitor's real GPS altitude with ground elevation. Same
    // "own explicit opt-in" reasoning as terrainAltitudeEnabled above.
    const visitorsFly = b.visitorsFly === undefined ? null : (b.visitorsFly ? 1 : 0);
    // hazardAwareEnabled (Phase 5a, forward hazard raycasting, 2026-08-17) —
    // a fourth, separate flag gating the proactive "walking toward a
    // hazard" warning. Same "own explicit opt-in" reasoning as its three
    // siblings above.
    const hazardAware = b.hazardAwareEnabled === undefined ? null : (b.hazardAwareEnabled ? 1 : 0);
    // fogEnabled (Ridge Quest R5, 2026-08-20) — a fifth flag, gating ONLY
    // Ridge Quest's fog-of-war VISUAL layer (the shroud/colored-cell map
    // overlay). Unlike its four siblings above, this doesn't gate a new
    // capability nothing depended on — fog-of-war is already live, so its
    // column DEFAULT is 1 (see migrations/0043); omitting this field here
    // leaves it unchanged, same COALESCE convention as the others.
    const fogEnabled = b.fogEnabled === undefined ? null : (b.fogEnabled ? 1 : 0);
    // questEnabled (Ridge Quest R7, 2026-08-20) — a sixth flag, gating
    // whether this app appears at all in the new PUBLIC workspace picker
    // (GET /api/quest-workspaces). Separate from fogEnabled — an app can be
    // quest-enabled (publicly listed) with fog visuals off, or vice versa.
    const questEnabled = b.questEnabled === undefined ? null : (b.questEnabled ? 1 : 0);
    // tileArtEnabled (Artistic Fog-of-War Tiles Phase C) — a seventh flag,
    // gating the whole board-game-tile map feature. Unlike fogEnabled/
    // questEnabled, this is platform-wide (any project type), not tied to
    // Ridge Quest — DEFAULT 0 (see migrations/0052), an app must explicitly
    // opt in, same "own explicit opt-in" reasoning as threeDEnabled etc.
    const tileArtEnabled = b.tileArtEnabled === undefined ? null : (b.tileArtEnabled ? 1 : 0);
    await env.DB.prepare("UPDATE app SET name=?, description=COALESCE(?,description), three_d_enabled=COALESCE(?,three_d_enabled), terrain_altitude_enabled=COALESCE(?,terrain_altitude_enabled), visitors_fly=COALESCE(?,visitors_fly), hazard_aware_enabled=COALESCE(?,hazard_aware_enabled), fog_enabled=COALESCE(?,fog_enabled), quest_enabled=COALESCE(?,quest_enabled), tile_art_enabled=COALESCE(?,tile_art_enabled), updatedAt=? WHERE id=?")
      .bind(name, b.description ?? null, threeD, terrainAlt, visitorsFly, hazardAware, fogEnabled, questEnabled, tileArtEnabled, now, aid).run();
    await logAudit(env, request, { keyId: "master" }, "app.rename", aid);
    return json({ ok: true, id: aid, name, threeDEnabled: threeD, terrainAltitudeEnabled: terrainAlt, visitorsFly, hazardAwareEnabled: hazardAware, fogEnabled, questEnabled, tileArtEnabled }, 200, AC);
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
    const sql = "SELECT id,name,slug,mode,status,bundleVersion,zoneCount,updatedAt,appId,scheduled_date,scheduled_time,guide_id,is_template,tour_type,archived,visitor_name,record_retention_days,quest_public AS questPublic,quest_activities AS questActivities,terrain_biome AS terrainBiome,season FROM project" +
                where + " ORDER BY COALESCE(scheduled_date,'9999') DESC, updatedAt DESC";
    const stmt = binds.length ? env.DB.prepare(sql).bind(...binds) : env.DB.prepare(sql);
    const { results } = await stmt.all();
    return json({ projects: results || [] });
  }

  // --- Ridge Quest (R7): public workspace/project discovery for the
  // in-app picker. Deliberately SEPARATE routes from /api/apps and
  // /api/projects above — never touch their staff auth() gate — since
  // players have no staff token at all. Exposes ONLY id+name, nothing
  // else (no orgId, no flags, no counts): this is the one place on the
  // platform anonymous internet traffic can enumerate app/project names,
  // so the field list is deliberately minimal. Gated by the two-level
  // opt-in (app.quest_enabled AND project.quest_public) — see
  // migrations/0045 and 0046 for why this needs both, not just one.
  if (path === "/api/quest-workspaces" && method === "GET") {
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    const { results } = await env.DB.prepare(
      "SELECT id,name FROM app WHERE quest_enabled=1 ORDER BY name ASC"
    ).all();
    return json({ workspaces: results || [] }, 200, AC);
  }
  if (path === "/api/quest-projects" && method === "GET") {
    if (!env.DB) return json({ error: "D1 not bound" }, 500);
    const appId = url.searchParams.get("app");
    if (!appId) return json({ error: "app is required" }, 400, AC);
    // Empty result either way (app disabled, app nonexistent, or just no
    // public projects) — never reveal WHICH reason via status code, so an
    // anonymous caller can't use this to enumerate real-but-disabled app ids.
    const appRow = await env.DB.prepare("SELECT id FROM app WHERE id=? AND quest_enabled=1").bind(appId).first();
    if (!appRow) return json({ projects: [] }, 200, AC);
    const { results } = await env.DB.prepare(
      "SELECT id,name FROM project WHERE appId=? AND quest_public=1 AND (archived IS NULL OR archived=0) ORDER BY name ASC"
    ).bind(appId).all();
    return json({ projects: results || [] }, 200, AC);
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

  // --- RECORD retention setting (days before unlocked recordings auto-
  // delete). Separate from the PUT above on purpose: that one requires a
  // full booking-detail payload (name, etc.) and only edits tour scheduling
  // fields — retention is an operational/infra setting that must apply
  // immediately on its own, not bundled with booking edits. Surfaced from
  // #projSettingsPopover in fence-editor.html. ---
  if (mdp && method === "PATCH") {
    const pid = decodeURIComponent(mdp[1]);
    const A = await auth(request, env);
    const proj = await env.DB.prepare("SELECT appId FROM project WHERE id=?").bind(pid).first();
    if (!proj) return json({ error: "project not found" }, 404, AC);
    if (!scopeOk(A, "publish", proj.appId)) return json({ error: "unauthorized" }, 401, AC);
    const b = await request.json().catch(() => ({}));
    if (!("record_retention_days" in b) && !("questPublic" in b) && !("questActivities" in b) && !("terrainBiome" in b) && !("season" in b))
      return json({ error: "record_retention_days, questPublic, questActivities, terrainBiome, or season required" }, 400, AC);
    const now = new Date().toISOString();
    const resp = { ok: true, id: pid };
    if ("record_retention_days" in b) {
      const days = b.record_retention_days === null ? null : Number(b.record_retention_days);
      if (days !== null && (!Number.isFinite(days) || days < 0)) return json({ error: "invalid record_retention_days" }, 400, AC);
      await env.DB.prepare("UPDATE project SET record_retention_days=?, updatedAt=? WHERE id=?").bind(days, now, pid).run();
      await logAudit(env, request, A, "project.retention.update", pid + " -> " + days);
      resp.record_retention_days = days;
    }
    // Ridge Quest R7 (2026-08-20) — questPublic, the per-PROJECT half of the
    // two-level public-picker opt-in (quest_enabled lives on `app`, set via
    // PUT /api/apps/:id; this is its project-level sibling). A project only
    // shows up in GET /api/quest-projects when BOTH its app is
    // quest_enabled AND the project itself is quest_public.
    if ("questPublic" in b) {
      const questPublic = b.questPublic ? 1 : 0;
      await env.DB.prepare("UPDATE project SET quest_public=?, updatedAt=? WHERE id=?").bind(questPublic, now, pid).run();
      await logAudit(env, request, A, "project.questPublic.update", pid + " -> " + questPublic);
      resp.questPublic = !!questPublic;
    }
    // R12 (2026-08-20) — questActivities: the per-project "which activities
    // are relevant here" filter (Nordic centre offers Hike/XC-Ski, a bike
    // park offers Bike, etc). null clears it back to "show all activities"
    // (backward compat — this is what every project already has today).
    // Stored as a JSON array TEXT column; validated against the same
    // QUEST_LEADERBOARD_ACTIVITIES list the leaderboard's own ?activity=
    // filter already validates against, so an invalid value can never be
    // stored and later silently filter a player's activity picker to
    // nothing.
    if ("questActivities" in b) {
      let questActivities = null;
      if (b.questActivities !== null) {
        if (!Array.isArray(b.questActivities) || !b.questActivities.length || !b.questActivities.every(a => QUEST_LEADERBOARD_ACTIVITIES.includes(a)))
          return json({ error: "questActivities must be a non-empty array of ski/hike/bike/drive/xcski, or null for all" }, 400, AC);
        questActivities = JSON.stringify(b.questActivities);
      }
      await env.DB.prepare("UPDATE project SET quest_activities=?, updatedAt=? WHERE id=?").bind(questActivities, now, pid).run();
      await logAudit(env, request, A, "project.questActivities.update", pid + " -> " + (questActivities || "null(all)"));
      resp.questActivities = b.questActivities;
    }
    // Artistic Fog-of-War Tiles Phase C — terrainBiome, the single
    // per-project classification fallback (used only when a cell has no OSM
    // tag match and the elevation/slope heuristic is inconclusive; see
    // BIOME_FALLBACK). null clears it back to the generic default.
    if ("terrainBiome" in b) {
      const terrainBiome = b.terrainBiome === null ? null : String(b.terrainBiome);
      if (terrainBiome !== null && !(terrainBiome in BIOME_FALLBACK))
        return json({ error: "terrainBiome must be one of " + Object.keys(BIOME_FALLBACK).join("/") + ", or null" }, 400, AC);
      await env.DB.prepare("UPDATE project SET terrain_biome=?, updatedAt=? WHERE id=?").bind(terrainBiome, now, pid).run();
      await logAudit(env, request, A, "project.terrainBiome.update", pid + " -> " + (terrainBiome || "null"));
      resp.terrainBiome = terrainBiome;
    }
    // Artistic Fog-of-War Tiles — season, which of a season-aware tile's
    // two rows (see migrations/0054) the engine/sim/Test Mode actually load.
    // null means "no season set yet" -- GET /api/tile-assets with no
    // ?season= returns every row unfiltered, so an unset project just shows
    // both seasons' tiles mixed rather than erroring.
    if ("season" in b) {
      const season = b.season === null ? null : String(b.season);
      if (season !== null && season !== "summer" && season !== "winter")
        return json({ error: "season must be 'summer', 'winter', or null" }, 400, AC);
      await env.DB.prepare("UPDATE project SET season=?, updatedAt=? WHERE id=?").bind(season, now, pid).run();
      await logAudit(env, request, A, "project.season.update", pid + " -> " + (season || "null"));
      resp.season = season;
    }
    return json(resp, 200, AC);
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
      const ownerRow = await env.DB.prepare(
        "SELECT p.orgId AS orgId, p.quest_activities AS questActivities, p.terrain_biome AS terrainBiome, p.season AS season, a.tile_art_enabled AS tileArtEnabled " +
        "FROM project p LEFT JOIN app a ON a.id = p.appId WHERE p.id=?"
      ).bind(pid).first();
      if (ownerRow) bundle.orgId = ownerRow.orgId;
      // Artistic Fog-of-War Tiles — same live-owner-injection pattern as
      // orgId/questActivities: an app-level toggle + two project-level
      // settings, neither part of the published bundle JSON itself.
      bundle.tileArtEnabled = !!(ownerRow && ownerRow.tileArtEnabled);
      bundle.terrainBiome = (ownerRow && ownerRow.terrainBiome) || null;
      bundle.season = (ownerRow && ownerRow.season) || null;
      // R12 — the per-project activity-relevance filter isn't part of the
      // published bundle JSON (it's a project-row column, set via the
      // separate PATCH endpoint, not the Fence Editor's Publish button) —
      // injected here at read time, same live-owner-injection pattern as
      // orgId just above. null = every activity allowed (backward compat).
      try { bundle.questActivities = ownerRow && ownerRow.questActivities ? JSON.parse(ownerRow.questActivities) : null; }
      catch (e) { bundle.questActivities = null; }
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
      // Size guard: reject bundles over 1 MB. Measured on the raw byte
      // buffer, not the decoded string — String.length counts UTF-16 code
      // units, so multibyte content (accented text, CJK, emoji in stop
      // names/say text) could be up to ~3x its .length in real UTF-8 bytes,
      // letting a bundle well past the documented 1 MB cap slip through.
      const buf = await request.arrayBuffer();
      if (buf.byteLength > 1_000_000) return json({ error: "bundle too large (max 1 MB)" }, 413, AC);
      const body = new TextDecoder().decode(buf);
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
      // Guard against a real incident (2026-08-12): the editor's default
      // placeholder project name ("new tour") slugifies to a fixed id, so a
      // brand-new session in workspace A that collides with an older
      // unrelated project of the same id already owned by workspace B used
      // to silently update B's project in place — publish reported success,
      // but nothing ever appeared in A, with no error at all. bundle.appId
      // reflects which workspace THIS publish actually believes it belongs
      // to (set from the editor's own current ?app= context); if that
      // disagrees with the id's real existing owner, and this isn't an
      // explicit master-driven client move (movingClients), it's an
      // accidental id collision, not an intentional republish — refuse
      // rather than silently overwriting the wrong project.
      if (existingProj && bundle.appId && bundle.appId !== existingAppId && !movingClients) {
        const ownerApp = await env.DB.prepare("SELECT name FROM app WHERE id=?").bind(existingAppId).first();
        return json({
          error: "a project with this id already exists under a different workspace" +
            (ownerApp && ownerApp.name ? " (\"" + ownerApp.name + "\")" : "") +
            " — rename this project before publishing so it gets a different id"
        }, 409, AC);
      }
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
        // is_template COALESCE'd like every other optional field here — it
        // used to be set unconditionally, so any publisher that omits
        // isTemplate from the bundle JSON (a future/alternate publisher,
        // e.g. Field Recorder's own publish path mentioned above) would
        // silently flip an existing template project back to non-template
        // on its next publish.
        await env.DB.prepare("UPDATE project SET name=COALESCE(?,name), bundleVersion=?, zoneCount=?, updatedAt=?, status='live', appId=COALESCE(?,appId), guide_id=COALESCE(?,guide_id), orgId=COALESCE(?,orgId), is_template=COALESCE(?,is_template) WHERE id=?")
          .bind(bundle.name || null, ver, bundle.zones.length, now, resolvedAppId, bundle.guideId || null, orgOverride, bundle.isTemplate != null ? (bundle.isTemplate ? 1 : 0) : null, pid).run();
      } else {
        await env.DB.prepare(
          "INSERT INTO project (id,orgId,appId,name,slug,mode,status,bundleVersion,zoneCount,createdAt,updatedAt,guide_id,scheduled_date,is_template,tour_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
        ).bind(pid, finalOrgId, resolvedAppId, bundle.name || pid, bundle.project || pid, "walking-tour", "live", ver, bundle.zones.length, now, now, bundle.guideId||null, bundle.scheduledDate||null, bundle.isTemplate?1:0, bundle.tourType||null).run();
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

  // --- RECORD: GPS/motion session recording + playback (patrol sweeps,
  // freeride runs, trail-use recording for bike/nordic clubs, incident
  // clips). This is operational/liability data, not public like presence —
  // write needs publish/audio scope (same as a guide's field tools), read
  // additionally allows analytics scope (an operator reviewing without
  // publish rights). See migrations/0028_record_sessions.sql. ---
  async function recordWriteAuthOk(env, A, projectId) {
    const appId = await projectAppId(env, projectId);
    return scopeOk(A, "publish", appId) || scopeOk(A, "audio", appId);
  }
  async function recordReadAuthOk(env, A, projectId) {
    const appId = await projectAppId(env, projectId);
    return scopeOk(A, "analytics", appId) || scopeOk(A, "publish", appId) || scopeOk(A, "audio", appId);
  }

  const mrs = path.match(/^\/api\/projects\/([^/]+)\/record\/sessions$/);
  if (mrs) {
    const pid = decodeURIComponent(mrs[1]);
    if (method === "POST") {
      const A = await auth(request, env);
      if (!(await recordWriteAuthOk(env, A, pid))) return json({ error: "unauthorized" }, 401, AC);
      const b = await request.json().catch(() => ({}));
      if (b.folderId) {
        const folder = await env.DB.prepare("SELECT id FROM record_folder WHERE id=? AND project_id=?").bind(b.folderId, pid).first();
        if (!folder) return json({ error: "folder not found" }, 404, AC);
      }
      const id = crypto.randomUUID();
      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO record_session (id,project_id,folder_id,type,user_id,label,notes,started_at,ended_at,locked,source_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(id, pid, b.folderId || null, (b.type || "").trim(), A.userId || null, (b.label || "").trim(), (b.notes || "").trim(), now, null, 0, null, now, now).run();
      await logAudit(env, request, A, "record.session.start", id);
      return json({ id, startedAt: now }, 201, AC);
    }
    if (method === "GET") {
      const A = await auth(request, env);
      if (!(await recordReadAuthOk(env, A, pid))) return json({ error: "unauthorized" }, 401, AC);
      const folderId = url.searchParams.get("folderId");
      const from = url.searchParams.get("from"), to = url.searchParams.get("to");
      const conds = ["project_id=?"], binds = [pid];
      if (folderId === "root") conds.push("folder_id IS NULL");
      else if (folderId) { conds.push("folder_id=?"); binds.push(folderId); }
      if (from) { conds.push("started_at>=?"); binds.push(Number(from)); }
      if (to) { conds.push("started_at<=?"); binds.push(Number(to)); }
      const { results } = await env.DB.prepare(
        "SELECT id,folder_id AS folderId,type,label,notes,started_at AS startedAt,ended_at AS endedAt,locked,source_session_id AS sourceSessionId FROM record_session WHERE " +
        conds.join(" AND ") + " ORDER BY started_at DESC"
      ).bind(...binds).all();
      return json({ sessions: results || [] }, 200, AC);
    }
  }

  const mrsid = path.match(/^\/api\/projects\/([^/]+)\/record\/sessions\/([^/]+)$/);
  if (mrsid && method === "PATCH") {
    const pid = decodeURIComponent(mrsid[1]), sid = decodeURIComponent(mrsid[2]);
    const A = await auth(request, env);
    if (!(await recordWriteAuthOk(env, A, pid))) return json({ error: "unauthorized" }, 401, AC);
    const row = await env.DB.prepare("SELECT project_id AS projectId, ended_at AS endedAt FROM record_session WHERE id=?").bind(sid).first();
    if (!row || row.projectId !== pid) return json({ error: "session not found" }, 404, AC);
    const b = await request.json().catch(() => ({}));
    if (b.stop && row.endedAt != null) return json({ error: "session already stopped" }, 409, AC);
    if (b.folderId) {
      const folder = await env.DB.prepare("SELECT id FROM record_folder WHERE id=? AND project_id=?").bind(b.folderId, pid).first();
      if (!folder) return json({ error: "folder not found" }, 404, AC);
    }
    const sets = ["updated_at=?"], binds = [Date.now()];
    if (b.stop) { sets.push("ended_at=?"); binds.push(Date.now()); }
    if (b.label !== undefined) { sets.push("label=?"); binds.push(String(b.label).trim()); }
    if (b.notes !== undefined) { sets.push("notes=?"); binds.push(String(b.notes).trim()); }
    if (b.locked !== undefined) { sets.push("locked=?"); binds.push(b.locked ? 1 : 0); }
    if (b.folderId !== undefined) { sets.push("folder_id=?"); binds.push(b.folderId || null); }
    binds.push(sid);
    await env.DB.prepare(`UPDATE record_session SET ${sets.join(",")} WHERE id=?`).bind(...binds).run();
    await logAudit(env, request, A, "record.session.update", sid);
    return json({ ok: true, id: sid }, 200, AC);
  }

  const mrpos = path.match(/^\/api\/projects\/([^/]+)\/record\/sessions\/([^/]+)\/positions$/);
  if (mrpos && method === "POST") {
    const pid = decodeURIComponent(mrpos[1]), sid = decodeURIComponent(mrpos[2]);
    const A = await auth(request, env);
    if (!(await recordWriteAuthOk(env, A, pid))) return json({ error: "unauthorized" }, 401, AC);
    const row = await env.DB.prepare("SELECT project_id AS projectId, ended_at AS endedAt FROM record_session WHERE id=?").bind(sid).first();
    if (!row || row.projectId !== pid) return json({ error: "session not found" }, 404, AC);
    if (row.endedAt != null) return json({ error: "session already stopped" }, 409, AC);
    const b = await request.json().catch(() => ({}));
    const points = (Array.isArray(b.points) ? b.points : []).slice(0, 500).filter(p => p && p.lat != null && p.lon != null);
    if (!points.length) return json({ error: "need a non-empty points array" }, 400, AC);
    const stmts = points.map(p => env.DB.prepare(
      "INSERT INTO position_history (session_id,project_id,lat,lon,acc,heading,ts) VALUES (?,?,?,?,?,?,?)"
    ).bind(sid, pid, p.lat, p.lon, p.acc ?? null, p.heading ?? null, p.ts || Date.now()));
    await env.DB.batch(stmts);
    return json({ ok: true, accepted: stmts.length }, 200, AC);
  }

  // Cut a trimmed range out of a session and save it as its own permanent,
  // locked-by-default recording — a real copy of the point range, not a
  // saved pointer, so it survives even after retention purges the source
  // session (the motion-data equivalent of protecting a clip on a DVR).
  const mrclip = path.match(/^\/api\/projects\/([^/]+)\/record\/sessions\/([^/]+)\/clip$/);
  if (mrclip && method === "POST") {
    const pid = decodeURIComponent(mrclip[1]), sid = decodeURIComponent(mrclip[2]);
    const A = await auth(request, env);
    if (!(await recordWriteAuthOk(env, A, pid))) return json({ error: "unauthorized" }, 401, AC);
    const src = await env.DB.prepare("SELECT project_id AS projectId, folder_id AS folderId, type, label FROM record_session WHERE id=?").bind(sid).first();
    if (!src || src.projectId !== pid) return json({ error: "source session not found" }, 404, AC);
    const b = await request.json().catch(() => ({}));
    const from = Number(b.from), to = Number(b.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return json({ error: "need a valid from/to range" }, 400, AC);
    let folderId = b.folderId !== undefined ? (b.folderId || null) : src.folderId;
    if (folderId) {
      const folder = await env.DB.prepare("SELECT id FROM record_folder WHERE id=? AND project_id=?").bind(folderId, pid).first();
      if (!folder) return json({ error: "folder not found" }, 404, AC);
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const label = (b.label || "").trim() || (src.label ? src.label + " (clip)" : "Incident clip");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO record_session (id,project_id,folder_id,type,user_id,label,notes,started_at,ended_at,locked,source_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(id, pid, folderId, src.type || "", A.userId || null, label, (b.notes || "").trim(), from, to, b.locked === 0 ? 0 : 1, sid, now, now),
      env.DB.prepare(
        "INSERT INTO position_history (session_id,project_id,lat,lon,acc,heading,ts) SELECT ?,project_id,lat,lon,acc,heading,ts FROM position_history WHERE session_id=? AND ts BETWEEN ? AND ?"
      ).bind(id, sid, from, to)
    ]);
    await logAudit(env, request, A, "record.session.clip", id + " (from " + sid + ")");
    return json({ id }, 201, AC);
  }

  const mrposread = path.match(/^\/api\/projects\/([^/]+)\/record\/positions$/);
  if (mrposread && method === "GET") {
    const pid = decodeURIComponent(mrposread[1]);
    const A = await auth(request, env);
    if (!(await recordReadAuthOk(env, A, pid))) return json({ error: "unauthorized" }, 401, AC);
    const sessionId = url.searchParams.get("session");
    const from = url.searchParams.get("from"), to = url.searchParams.get("to");
    let results;
    if (sessionId) {
      const sess = await env.DB.prepare("SELECT id FROM record_session WHERE id=? AND project_id=?").bind(sessionId, pid).first();
      if (!sess) return json({ error: "session not found" }, 404, AC);
      ({ results } = await env.DB.prepare(
        "SELECT session_id AS sessionId,lat,lon,acc,heading,ts FROM position_history WHERE session_id=? ORDER BY ts LIMIT 50000"
      ).bind(sessionId).all());
    } else {
      if (!from || !to) return json({ error: "need session, or from and to" }, 400, AC);
      ({ results } = await env.DB.prepare(
        "SELECT session_id AS sessionId,lat,lon,acc,heading,ts FROM position_history WHERE project_id=? AND ts BETWEEN ? AND ? ORDER BY session_id, ts LIMIT 50000"
      ).bind(pid, Number(from), Number(to)).all());
    }
    return json({ points: results || [] }, 200, AC);
  }

  // Density heatmap for the "danger zone" view — grid-bucketed count of
  // position_history rows, a dwell-time proxy (see record.html). Not a
  // separate recording mode: it's computed on demand from whatever's
  // already been captured.
  const mrheat = path.match(/^\/api\/projects\/([^/]+)\/record\/heatmap$/);
  if (mrheat && method === "GET") {
    const pid = decodeURIComponent(mrheat[1]);
    const A = await auth(request, env);
    if (!(await recordReadAuthOk(env, A, pid))) return json({ error: "unauthorized" }, 401, AC);
    const gridM = Math.max(3, Math.min(200, Number(url.searchParams.get("gridM")) || 15));
    const step = gridM / 111320; // rough metres->degrees; fine at the scale this tool operates over
    const from = url.searchParams.get("from"), to = url.searchParams.get("to");
    const conds = ["project_id=?"], binds = [pid];
    if (from) { conds.push("ts>=?"); binds.push(Number(from)); }
    if (to) { conds.push("ts<=?"); binds.push(Number(to)); }
    const { results } = await env.DB.prepare(
      `SELECT ROUND(lat/?)*? AS lat, ROUND(lon/?)*? AS lon, COUNT(*) AS count FROM position_history WHERE ${conds.join(" AND ")} GROUP BY 1,2`
    ).bind(step, step, step, step, ...binds).all();
    return json({ gridM, cells: results || [] }, 200, AC);
  }

  // --- RECORD schedule: a per-project planning calendar for staff
  // recording windows (multiple dates per project). This is a reference
  // calendar only, not an auto-trigger — a record_session only ever gets
  // created because a device is physically running field-recorder.html
  // with an operator pressing Start/Stop; nothing here changes that. See
  // migrations/0029_record_schedule.sql. ---
  const mrsched = path.match(/^\/api\/projects\/([^/]+)\/record\/schedule$/);
  if (mrsched) {
    const pid = decodeURIComponent(mrsched[1]);
    if (method === "POST") {
      const A = await auth(request, env);
      if (!(await recordWriteAuthOk(env, A, pid))) return json({ error: "unauthorized" }, 401, AC);
      const b = await request.json().catch(() => ({}));
      const startsAt = Number(b.startsAt), endsAt = Number(b.endsAt);
      if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
        return json({ error: "need a valid startsAt/endsAt range" }, 400, AC);
      }
      const id = crypto.randomUUID();
      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO record_schedule (id,project_id,starts_at,ends_at,label,created_at,updated_at) VALUES (?,?,?,?,?,?,?)"
      ).bind(id, pid, startsAt, endsAt, (b.label || "").trim(), now, now).run();
      await logAudit(env, request, A, "record.schedule.create", id);
      return json({ id }, 201, AC);
    }
    if (method === "GET") {
      const A = await auth(request, env);
      if (!(await recordReadAuthOk(env, A, pid))) return json({ error: "unauthorized" }, 401, AC);
      const from = url.searchParams.get("from"), to = url.searchParams.get("to");
      const conds = ["project_id=?"], binds = [pid];
      // overlap test, not a strict-containment one -- a window that only
      // partially overlaps the requested range should still show up on a
      // month view that includes its start or end day.
      if (from) { conds.push("ends_at>=?"); binds.push(Number(from)); }
      if (to) { conds.push("starts_at<=?"); binds.push(Number(to)); }
      const { results } = await env.DB.prepare(
        "SELECT id,starts_at AS startsAt,ends_at AS endsAt,label FROM record_schedule WHERE " + conds.join(" AND ") + " ORDER BY starts_at"
      ).bind(...binds).all();
      return json({ windows: results || [] }, 200, AC);
    }
  }

  const mrschedid = path.match(/^\/api\/projects\/([^/]+)\/record\/schedule\/([^/]+)$/);
  if (mrschedid && (method === "PATCH" || method === "DELETE")) {
    const pid = decodeURIComponent(mrschedid[1]), sid = decodeURIComponent(mrschedid[2]);
    const A = await auth(request, env);
    if (!(await recordWriteAuthOk(env, A, pid))) return json({ error: "unauthorized" }, 401, AC);
    const row = await env.DB.prepare("SELECT project_id AS projectId FROM record_schedule WHERE id=?").bind(sid).first();
    if (!row || row.projectId !== pid) return json({ error: "schedule window not found" }, 404, AC);
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM record_schedule WHERE id=?").bind(sid).run();
      await logAudit(env, request, A, "record.schedule.delete", sid);
      return json({ ok: true, deleted: sid }, 200, AC);
    }
    const b = await request.json().catch(() => ({}));
    const sets = ["updated_at=?"], binds = [Date.now()];
    if (b.startsAt !== undefined) { sets.push("starts_at=?"); binds.push(Number(b.startsAt)); }
    if (b.endsAt !== undefined) { sets.push("ends_at=?"); binds.push(Number(b.endsAt)); }
    if (b.label !== undefined) { sets.push("label=?"); binds.push(String(b.label).trim()); }
    binds.push(sid);
    await env.DB.prepare(`UPDATE record_schedule SET ${sets.join(",")} WHERE id=?`).bind(...binds).run();
    await logAudit(env, request, A, "record.schedule.update", sid);
    return json({ ok: true, id: sid }, 200, AC);
  }

  // --- RECORD tripline crossing counts: replay a session's recorded track
  // through the same crossing test the live engine uses (Geo.lineCross /
  // Geo.toXY in geofence-engine.html, ~line 328-365) against a chosen
  // tripline zone pulled from the project's published bundle. A read-only
  // replay over already-captured data, same "computed on demand" approach
  // as the heatmap above — not a new capture mode. The math below is a
  // verbatim mirror of the live engine's; a fix to the live crossing logic
  // should be checked against this copy too (same caution as the EKF
  // three-call-site mirror documented in CLAUDE.md). ---
  function mPerDegLonRec(lat) { return 111320 * Math.cos(lat * Math.PI / 180); }
  function toXYRec(p, ref) { return { x: (p[1] - ref[1]) * mPerDegLonRec(ref[0]), y: (p[0] - ref[0]) * 111320 }; }
  function ccwRec(p, q, r) { return (r.y - p.y) * (q.x - p.x) - (q.y - p.y) * (r.x - p.x); }
  function lineCrossRec(prev, cur, from, to, ref) {
    const A = toXYRec(prev, ref), B = toXYRec(cur, ref), C = toXYRec(from, ref), D = toXYRec(to, ref);
    const d1 = ccwRec(C, D, A), d2 = ccwRec(C, D, B), d3 = ccwRec(A, B, C), d4 = ccwRec(A, B, D);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  }
  const TRIPLINE_COOLDOWN_MS = 4000; // matches Geofencer's live cooldown, so a lingering track near the line isn't double-counted

  const mrtrip = path.match(/^\/api\/projects\/([^/]+)\/record\/tripline-counts$/);
  if (mrtrip && method === "GET") {
    const pid = decodeURIComponent(mrtrip[1]);
    const A = await auth(request, env);
    if (!(await recordReadAuthOk(env, A, pid))) return json({ error: "unauthorized" }, 401, AC);
    const zoneId = url.searchParams.get("zoneId");
    if (!zoneId) return json({ error: "zoneId required" }, 400, AC);
    const bundleRow = await env.DB.prepare("SELECT json FROM published_bundle WHERE projectId=? ORDER BY version DESC LIMIT 1").bind(pid).first();
    if (!bundleRow) return json({ error: "project has no published bundle" }, 404, AC);
    let bundle;
    try { bundle = JSON.parse(bundleRow.json); } catch (e) { return json({ error: "bundle is corrupt" }, 500, AC); }
    const zone = (bundle.zones || []).find(z => z.id === zoneId);
    const targetLayer = zone && (zone.layers || []).find(l => l.kind === "target" && l.geometry && l.geometry.type === "tripline");
    if (!targetLayer) return json({ error: "zone not found or is not a tripline zone" }, 404, AC);
    const ref = bundle.ref || targetLayer.geometry.from;

    const from = url.searchParams.get("from"), to = url.searchParams.get("to");
    const conds = ["project_id=?"], binds = [pid];
    if (from) { conds.push("ts>=?"); binds.push(Number(from)); }
    if (to) { conds.push("ts<=?"); binds.push(Number(to)); }
    const { results } = await env.DB.prepare(
      `SELECT session_id AS sessionId, lat, lon, ts FROM position_history WHERE ${conds.join(" AND ")} ORDER BY session_id, ts`
    ).bind(...binds).all();

    const bySession = {};
    let totalCount = 0;
    const prevBySession = {}, cooldownUntilBySession = {};
    for (const p of (results || [])) {
      const prev = prevBySession[p.sessionId];
      if (prev && !(cooldownUntilBySession[p.sessionId] > p.ts) &&
          lineCrossRec([prev.lat, prev.lon], [p.lat, p.lon], targetLayer.geometry.from, targetLayer.geometry.to, ref)) {
        bySession[p.sessionId] = (bySession[p.sessionId] || 0) + 1;
        totalCount++;
        cooldownUntilBySession[p.sessionId] = p.ts + TRIPLINE_COOLDOWN_MS;
      }
      prevBySession[p.sessionId] = p;
    }
    return json({ zoneId, count: totalCount, bySession }, 200, AC);
  }

  // --- RECORD folders: organize sessions into a tree, same shape/behavior
  // as stop_folder/walking_path_folder — always project-scoped, and (unlike
  // audio_folder) deleting a folder moves its sessions up to the parent
  // instead of destroying them, since a recorded session is expensive or
  // impossible to redo and often kept for liability. ---
  async function collectRecordFolderSubtreeIds(env, rootId) {
    const ids = [rootId]; let frontier = [rootId];
    while (frontier.length) {
      const ph = frontier.map(() => "?").join(",");
      const { results } = await env.DB.prepare(`SELECT id FROM record_folder WHERE parent_id IN (${ph})`).bind(...frontier).all();
      frontier = (results || []).map(r => r.id);
      ids.push(...frontier);
    }
    return ids;
  }

  if (path === "/api/record-folder" && method === "GET") {
    const A = await auth(request, env);
    const projectId = url.searchParams.get("projectId");
    if (!projectId) return json({ error: "projectId required" }, 400, AC);
    if (!(await recordWriteAuthOk(env, A, projectId)) && !(await recordReadAuthOk(env, A, projectId))) return json({ error: "unauthorized" }, 401, AC);
    const { results } = await env.DB.prepare(
      "SELECT id,parent_id AS parentId,name FROM record_folder WHERE project_id=? ORDER BY name"
    ).bind(projectId).all();
    return json({ folders: results || [] }, 200, AC);
  }

  if (path === "/api/record-folder" && method === "POST") {
    const A = await auth(request, env);
    const b = await request.json().catch(() => ({}));
    const projectId = (b.projectId || "").trim(), name = (b.name || "").trim();
    const parentId = b.parentId || null;
    if (!projectId || !name) return json({ error: "projectId and name required" }, 400, AC);
    if (name.includes("/")) return json({ error: "folder name can't contain /" }, 400, AC);
    if (!(await recordWriteAuthOk(env, A, projectId))) return json({ error: "unauthorized" }, 401, AC);
    if (parentId) {
      const parent = await env.DB.prepare("SELECT id FROM record_folder WHERE id=? AND project_id=?").bind(parentId, projectId).first();
      if (!parent) return json({ error: "parent folder not found" }, 404, AC);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO record_folder (id,project_id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .bind(id, projectId, parentId, name, now, now).run();
    await logAudit(env, request, A, "recordfolder.create", projectId + "/" + name);
    return json({ id, projectId, parentId, name }, 201, AC);
  }

  const mRecordFolder = path.match(/^\/api\/record-folder\/([^/]+)$/);
  if (mRecordFolder && (method === "PATCH" || method === "DELETE")) {
    const folderId = decodeURIComponent(mRecordFolder[1]);
    const A = await auth(request, env);
    const row = await env.DB.prepare("SELECT project_id AS projectId,parent_id AS parentId,name FROM record_folder WHERE id=?").bind(folderId).first();
    if (!row) return json({ error: "folder not found" }, 404, AC);
    if (!(await recordWriteAuthOk(env, A, row.projectId))) return json({ error: "unauthorized" }, 401, AC);

    if (method === "DELETE") {
      const folderIds = await collectRecordFolderSubtreeIds(env, folderId);
      const fph = folderIds.map(() => "?").join(",");
      const { meta } = await env.DB.prepare(
        `UPDATE record_session SET folder_id=?, updated_at=? WHERE project_id=? AND folder_id IN (${fph})`
      ).bind(row.parentId, Date.now(), row.projectId, ...folderIds).run();
      await env.DB.prepare(`DELETE FROM record_folder WHERE id IN (${fph})`).bind(...folderIds).run();
      await logAudit(env, request, A, "recordfolder.delete", folderId + " (" + (meta.changes || 0) + " sessions moved up)");
      return json({ ok: true, deletedFolders: folderIds.length, movedSessions: meta.changes || 0 }, 200, AC);
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
        const parent = await env.DB.prepare("SELECT id FROM record_folder WHERE id=? AND project_id=?").bind(newParentId, row.projectId).first();
        if (!parent) return json({ error: "parent folder not found" }, 404, AC);
        const subtreeIds = await collectRecordFolderSubtreeIds(env, folderId);
        if (subtreeIds.includes(newParentId)) return json({ error: "can't move a folder into its own subtree" }, 400, AC);
      }
      parentId = newParentId;
    }
    await env.DB.prepare("UPDATE record_folder SET name=?, parent_id=?, updated_at=? WHERE id=?")
      .bind(name, parentId, new Date().toISOString(), folderId).run();
    await logAudit(env, request, A, "recordfolder.update", folderId);
    return json({ id: folderId, name, parentId }, 200, AC);
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
    // Size guard: reject payloads over 500 KB — measured on raw bytes, not
    // the decoded string's UTF-16 .length, same reasoning as the bundle
    // guard above.
    const buf = await request.arrayBuffer();
    if (buf.byteLength > 500_000) return json({ error: "payload too large (max 500 KB)" }, 413);
    const body = new TextDecoder().decode(buf);
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

  // --- Asset tree: 3D model library (glTF/GLB), same shape as /api/audio/tree ---
  if (path === "/api/assets/tree" && method === "GET") {
    const A = await auth(request, env);
    const pid = url.searchParams.get("project");
    const scopeParam = url.searchParams.get("scope");

    if (pid) {
      const proj = await env.DB.prepare("SELECT appId,orgId FROM project WHERE id=? OR slug=? LIMIT 1").bind(pid, pid).first();
      const appId = proj ? proj.appId : null;
      if (!scopeOk(A, "audio", appId) && !scopeOk(A, "publish", appId)) return json({ error: "unauthorized" }, 401, AC);
      const [pf, po] = await Promise.all([
        env.DB.prepare("SELECT id,parent_id AS parentId,name FROM asset_folder WHERE scope='project' AND scope_id=? ORDER BY name").bind(pid).all(),
        env.DB.prepare("SELECT id,folder_id AS folderId,name,kind,r2_key AS r2Key,source_url AS sourceUrl,format,size_bytes AS sizeBytes,created_at AS createdAt FROM asset_object WHERE scope='project' AND scope_id=? ORDER BY name").bind(pid).all()
      ]);
      const orgId = url.searchParams.get("org") || (proj && proj.orgId) || null;
      let library = null;
      if (orgId && (await libraryScopeOk(env, A, orgId))) {
        const [lf, lo] = await Promise.all([
          env.DB.prepare("SELECT id,parent_id AS parentId,name FROM asset_folder WHERE scope='library' AND scope_id=? ORDER BY name").bind(orgId).all(),
          env.DB.prepare("SELECT id,folder_id AS folderId,name,kind,r2_key AS r2Key,source_url AS sourceUrl,format,size_bytes AS sizeBytes,created_at AS createdAt FROM asset_object WHERE scope='library' AND scope_id=? ORDER BY name").bind(orgId).all()
        ]);
        library = {
          scope: "library", scopeId: orgId, folders: lf.results || [],
          objects: (lo.results || []).map(o => ({ ...o, url: o.kind === "url" ? o.sourceUrl : "/api/models/" + o.r2Key }))
        };
      }
      return json({
        project: {
          scope: "project", scopeId: pid, folders: pf.results || [],
          objects: (po.results || []).map(o => ({ ...o, url: o.kind === "url" ? o.sourceUrl : "/api/models/" + o.r2Key }))
        },
        library
      }, 200, AC);
    }

    if (scopeParam === "library") {
      const libOrgId = url.searchParams.get("org");
      if (!libOrgId) return json({ error: "?scope=library needs &org=<clientId>" }, 400, AC);
      if (!(await libraryScopeOk(env, A, libOrgId))) return json({ error: "unauthorized" }, 401, AC);
      const [lf, lo] = await Promise.all([
        env.DB.prepare("SELECT id,parent_id AS parentId,name FROM asset_folder WHERE scope='library' AND scope_id=? ORDER BY name").bind(libOrgId).all(),
        env.DB.prepare("SELECT id,folder_id AS folderId,name,kind,r2_key AS r2Key,source_url AS sourceUrl,format,size_bytes AS sizeBytes,created_at AS createdAt FROM asset_object WHERE scope='library' AND scope_id=? ORDER BY name").bind(libOrgId).all()
      ]);
      return json({
        library: {
          scope: "library", scopeId: libOrgId, folders: lf.results || [],
          objects: (lo.results || []).map(o => ({ ...o, url: o.kind === "url" ? o.sourceUrl : "/api/models/" + o.r2Key }))
        }
      }, 200, AC);
    }

    return json({ error: "specify ?project=<id> or ?scope=library&org=<clientId>" }, 400, AC);
  }

  if (path === "/api/asset-folder" && method === "POST") {
    const A = await auth(request, env);
    const b = await request.json().catch(() => ({}));
    const scope = b.scope, scopeId = (b.scopeId || "").trim(), name = (b.name || "").trim();
    const parentId = b.parentId || null;
    if (!["project", "library"].includes(scope)) return json({ error: "scope must be 'project' or 'library'" }, 400, AC);
    if (!scopeId || !name) return json({ error: "scopeId and name required" }, 400, AC);
    if (name.includes("/")) return json({ error: "folder name can't contain /" }, 400, AC);
    if (!(await assetScopeAuthOk(env, A, scope, scopeId))) return json({ error: "unauthorized" }, 401, AC);
    if (parentId) {
      const parent = await env.DB.prepare("SELECT id FROM asset_folder WHERE id=? AND scope=? AND scope_id=?").bind(parentId, scope, scopeId).first();
      if (!parent) return json({ error: "parent folder not found in this scope" }, 404, AC);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO asset_folder (id,scope,scope_id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .bind(id, scope, scopeId, parentId, name, now, now).run();
    await logAudit(env, request, A, "asset.folder.create", scope + "/" + scopeId + "/" + name);
    return json({ id, scope, scopeId, parentId, name }, 201, AC);
  }

  const mAssetFolderCopy = path.match(/^\/api\/asset-folder\/([^/]+)\/copy$/);
  if (mAssetFolderCopy && method === "POST") {
    const folderId = decodeURIComponent(mAssetFolderCopy[1]);
    const A = await auth(request, env);
    const src = await env.DB.prepare("SELECT scope,scope_id AS scopeId FROM asset_folder WHERE id=?").bind(folderId).first();
    if (!src) return json({ error: "folder not found" }, 404, AC);
    if (!(await assetScopeAuthOk(env, A, src.scope, src.scopeId))) return json({ error: "unauthorized" }, 401, AC);
    const b = await request.json().catch(() => ({}));
    const targetScope = b.targetScope || src.scope;
    const targetScopeId = b.targetScopeId || src.scopeId;
    const targetParentId = b.targetParentId || null;
    if (!["project", "library"].includes(targetScope)) return json({ error: "invalid targetScope" }, 400, AC);
    if (!(await assetScopeAuthOk(env, A, targetScope, targetScopeId))) return json({ error: "unauthorized on target" }, 401, AC);
    if (targetParentId) {
      const parent = await env.DB.prepare("SELECT id FROM asset_folder WHERE id=? AND scope=? AND scope_id=?").bind(targetParentId, targetScope, targetScopeId).first();
      if (!parent) return json({ error: "target parent folder not found" }, 404, AC);
    }
    try {
      const newId = await copyAssetFolderSubtree(env, folderId, src.scope, src.scopeId, targetScope, targetScopeId, targetParentId);
      await logAudit(env, request, A, "asset.folder.copy", folderId + " -> " + newId);
      return json({ id: newId }, 201, AC);
    } catch (e) {
      return json({ error: "copy failed: " + e.message }, 500, AC);
    }
  }

  const mAssetFolder = path.match(/^\/api\/asset-folder\/([^/]+)$/);
  if (mAssetFolder && (method === "PATCH" || method === "DELETE")) {
    const folderId = decodeURIComponent(mAssetFolder[1]);
    const A = await auth(request, env);
    const row = await env.DB.prepare("SELECT scope,scope_id AS scopeId,parent_id AS parentId,name FROM asset_folder WHERE id=?").bind(folderId).first();
    if (!row) return json({ error: "folder not found" }, 404, AC);
    if (!(await assetScopeAuthOk(env, A, row.scope, row.scopeId))) return json({ error: "unauthorized" }, 401, AC);

    if (method === "DELETE") {
      const folderIds = await collectAssetFolderSubtree(env, row.scope, row.scopeId, folderId);
      const fph = folderIds.map(() => "?").join(",");
      const { results: objs } = await env.DB.prepare(
        `SELECT id,kind,r2_key FROM asset_object WHERE scope=? AND scope_id=? AND folder_id IN (${fph})`
      ).bind(row.scope, row.scopeId, ...folderIds).all();
      for (const o of (objs || [])) if (o.kind === "upload" && env.MODELS) await env.MODELS.delete(o.r2_key).catch(() => {});
      if ((objs || []).length) {
        const oph = objs.map(() => "?").join(",");
        await env.DB.prepare(`DELETE FROM asset_object WHERE id IN (${oph})`).bind(...objs.map(o => o.id)).run();
      }
      await env.DB.prepare(`DELETE FROM asset_folder WHERE id IN (${fph})`).bind(...folderIds).run();
      await logAudit(env, request, A, "asset.folder.delete", folderId + " (" + (objs || []).length + " objects)");
      return json({ ok: true, deletedFolders: folderIds.length, deletedObjects: (objs || []).length }, 200, AC);
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
      if (!(await assetScopeAuthOk(env, A, targetScope, targetScopeId))) return json({ error: "unauthorized on target" }, 401, AC);
      const newParentId = b.parentId !== undefined ? (b.parentId || null) : null;
      if (newParentId) {
        const parent = await env.DB.prepare("SELECT id FROM asset_folder WHERE id=? AND scope=? AND scope_id=?").bind(newParentId, targetScope, targetScopeId).first();
        if (!parent) return json({ error: "target parent folder not found" }, 404, AC);
      }
      await rescopeAssetFolderSubtree(env, folderId, row.scope, row.scopeId, targetScope, targetScopeId, newParentId);
      if (name !== row.name) await env.DB.prepare("UPDATE asset_folder SET name=?, updated_at=? WHERE id=?").bind(name, new Date().toISOString(), folderId).run();
      await logAudit(env, request, A, "asset.folder.move", folderId + " " + row.scope + "/" + row.scopeId + " -> " + targetScope + "/" + targetScopeId);
      return json({ id: folderId, name, parentId: newParentId, scope: targetScope, scopeId: targetScopeId }, 200, AC);
    }

    let parentId = row.parentId;
    if (b.parentId !== undefined) {
      const newParentId = b.parentId || null;
      if (newParentId) {
        const parent = await env.DB.prepare("SELECT id FROM asset_folder WHERE id=? AND scope=? AND scope_id=?").bind(newParentId, row.scope, row.scopeId).first();
        if (!parent) return json({ error: "parent folder not found in this scope" }, 404, AC);
        if (await assetWouldCreateCycle(env, folderId, newParentId)) return json({ error: "can't move a folder into its own subtree" }, 400, AC);
      }
      parentId = newParentId;
    }
    await env.DB.prepare("UPDATE asset_folder SET name=?, parent_id=?, updated_at=? WHERE id=?")
      .bind(name, parentId, new Date().toISOString(), folderId).run();
    await logAudit(env, request, A, "asset.folder.update", folderId);
    return json({ id: folderId, name, parentId, scope: row.scope, scopeId: row.scopeId }, 200, AC);
  }

  // POST /api/asset-object: two shapes under one endpoint. Default is a
  // binary GLB/glTF upload (mirrors /api/audio-clip's PUT-style body read).
  // ?kind=url takes a JSON body referencing an externally-hosted model
  // instead — no R2 write at all, r2_key stays NULL.
  if (path === "/api/asset-object" && method === "POST" && url.searchParams.get("kind") === "url") {
    const A = await auth(request, env);
    const b = await request.json().catch(() => ({}));
    const scope = b.scope, scopeId = (b.scopeId || "").trim(), name = (b.name || "").trim();
    const folderId = b.folderId || null;
    const sourceUrl = (b.sourceUrl || "").trim();
    const format = b.format === "gltf" ? "gltf" : "glb";
    if (!["project", "library"].includes(scope)) return json({ error: "scope must be 'project' or 'library'" }, 400, AC);
    if (!scopeId || !name || !sourceUrl) return json({ error: "scopeId, name, and sourceUrl required" }, 400, AC);
    if (name.includes("/")) return json({ error: "asset name can't contain /" }, 400, AC);
    try { new URL(sourceUrl); } catch (e) { return json({ error: "sourceUrl must be a valid URL" }, 400, AC); }
    if (!(await assetScopeAuthOk(env, A, scope, scopeId))) return json({ error: "unauthorized" }, 401, AC);
    if (folderId) {
      const folder = await env.DB.prepare("SELECT id FROM asset_folder WHERE id=? AND scope=? AND scope_id=?").bind(folderId, scope, scopeId).first();
      if (!folder) return json({ error: "folder not found in this scope" }, 404, AC);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO asset_object (id,scope,scope_id,folder_id,name,kind,r2_key,source_url,format,size_bytes,created_at,updated_at) VALUES (?,?,?,?,?,'url',NULL,?,?,NULL,?,?)"
    ).bind(id, scope, scopeId, folderId, name, sourceUrl, format, now, now).run();
    await logAudit(env, request, A, "asset.object.create.url", scope + "/" + scopeId + "/" + name);
    return json({ id, name, folderId, kind: "url", url: sourceUrl }, 201, AC);
  }

  if (path === "/api/asset-object" && method === "POST") {
    if (!env.MODELS) return json({ error: "no models bucket bound" }, 500);
    const A = await auth(request, env);
    const scope = url.searchParams.get("scope");
    const scopeId = (url.searchParams.get("scopeId") || "").trim();
    const folderId = url.searchParams.get("folderId") || null;
    const name = (url.searchParams.get("name") || "").trim();
    if (!["project", "library"].includes(scope)) return json({ error: "scope must be 'project' or 'library'" }, 400, AC);
    if (!scopeId || !name) return json({ error: "scopeId and name required" }, 400, AC);
    if (name.includes("/")) return json({ error: "asset name can't contain /" }, 400, AC);
    if (!(await assetScopeAuthOk(env, A, scope, scopeId))) return json({ error: "unauthorized" }, 401, AC);
    if (folderId) {
      const folder = await env.DB.prepare("SELECT id FROM asset_folder WHERE id=? AND scope=? AND scope_id=?").bind(folderId, scope, scopeId).first();
      if (!folder) return json({ error: "folder not found in this scope" }, 404, AC);
    }
    const ext = (name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
    const format = ext === ".gltf" ? "gltf" : ext === ".zip" ? "obj-zip" : "glb";
    const r2Key = "model/" + crypto.randomUUID() + (ext || ".glb");
    const ct = request.headers.get("content-type") ||
      (format === "gltf" ? "model/gltf+json" : format === "obj-zip" ? "application/zip" : "model/gltf-binary");
    const buf = await request.arrayBuffer();
    await env.MODELS.put(r2Key, buf, { httpMetadata: { contentType: ct } });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO asset_object (id,scope,scope_id,folder_id,name,kind,r2_key,source_url,format,size_bytes,created_at,updated_at) VALUES (?,?,?,?,?,'upload',?,NULL,?,?,?,?)"
    ).bind(id, scope, scopeId, folderId, name, r2Key, format, buf.byteLength, now, now).run();
    await logAudit(env, request, A, "asset.object.create", scope + "/" + scopeId + "/" + name);
    return json({ id, name, folderId, kind: "upload", r2Key, url: "/api/models/" + r2Key }, 201, AC);
  }

  const mAssetCopy = path.match(/^\/api\/asset-object\/([^/]+)\/copy$/);
  if (mAssetCopy && method === "POST") {
    const assetId = decodeURIComponent(mAssetCopy[1]);
    const A = await auth(request, env);
    const row = await env.DB.prepare(
      "SELECT scope,scope_id AS scopeId,folder_id AS folderId,name,kind,r2_key,source_url,format,size_bytes FROM asset_object WHERE id=?"
    ).bind(assetId).first();
    if (!row) return json({ error: "asset not found" }, 404, AC);
    if (!(await assetScopeAuthOk(env, A, row.scope, row.scopeId))) return json({ error: "unauthorized" }, 401, AC);
    const b = await request.json().catch(() => ({}));
    const targetScope = b.targetScope || row.scope;
    const targetScopeId = b.targetScopeId || row.scopeId;
    const targetFolderId = b.targetFolderId !== undefined ? (b.targetFolderId || null) : row.folderId;
    if (!["project", "library"].includes(targetScope)) return json({ error: "invalid targetScope" }, 400, AC);
    if (!(await assetScopeAuthOk(env, A, targetScope, targetScopeId))) return json({ error: "unauthorized on target" }, 401, AC);
    if (targetFolderId) {
      const folder = await env.DB.prepare("SELECT id FROM asset_folder WHERE id=? AND scope=? AND scope_id=?").bind(targetFolderId, targetScope, targetScopeId).first();
      if (!folder) return json({ error: "target folder not found" }, 404, AC);
    }
    try {
      const newId = await copyAssetRow(env, row, targetScope, targetScopeId, targetFolderId, b.name);
      await logAudit(env, request, A, "asset.object.copy", assetId + " -> " + newId);
      return json({ id: newId }, 201, AC);
    } catch (e) {
      return json({ error: "copy failed: " + e.message }, 500, AC);
    }
  }

  const mAsset = path.match(/^\/api\/asset-object\/([^/]+)$/);
  if (mAsset && (method === "PATCH" || method === "DELETE")) {
    const assetId = decodeURIComponent(mAsset[1]);
    const A = await auth(request, env);
    const row = await env.DB.prepare(
      "SELECT scope,scope_id AS scopeId,folder_id AS folderId,name,kind,r2_key FROM asset_object WHERE id=?"
    ).bind(assetId).first();
    if (!row) return json({ error: "asset not found" }, 404, AC);
    if (!(await assetScopeAuthOk(env, A, row.scope, row.scopeId))) return json({ error: "unauthorized" }, 401, AC);

    if (method === "DELETE") {
      if (row.kind === "upload" && env.MODELS) await env.MODELS.delete(row.r2_key).catch(() => {});
      await env.DB.prepare("DELETE FROM asset_object WHERE id=?").bind(assetId).run();
      await logAudit(env, request, A, "asset.object.delete", assetId);
      return json({ ok: true, deleted: assetId }, 200, AC);
    }

    const b = await request.json().catch(() => ({}));
    let name = row.name, folderId = row.folderId, scope = row.scope, scopeId = row.scopeId;
    if (b.scope !== undefined || b.scopeId !== undefined) {
      scope = b.scope || row.scope;
      scopeId = b.scopeId || row.scopeId;
      if (!["project", "library"].includes(scope)) return json({ error: "invalid scope" }, 400, AC);
      if (!(await assetScopeAuthOk(env, A, scope, scopeId))) return json({ error: "unauthorized on target scope" }, 401, AC);
      folderId = null;
    }
    if (b.name !== undefined) {
      if (!b.name.trim() || b.name.includes("/")) return json({ error: "invalid name" }, 400, AC);
      name = b.name.trim();
    }
    if (b.folderId !== undefined) folderId = b.folderId || null;
    if (folderId) {
      const folder = await env.DB.prepare("SELECT id FROM asset_folder WHERE id=? AND scope=? AND scope_id=?").bind(folderId, scope, scopeId).first();
      if (!folder) return json({ error: "folder not found in target scope" }, 404, AC);
    }
    await env.DB.prepare("UPDATE asset_object SET name=?, folder_id=?, scope=?, scope_id=?, updated_at=? WHERE id=?")
      .bind(name, folderId, scope, scopeId, new Date().toISOString(), assetId).run();
    await logAudit(env, request, A, "asset.object.update", assetId);
    return json({ id: assetId, name, folderId, scope, scopeId }, 200, AC);
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
    // widthM is the former Corridor library's one real distinguishing field
    // (0049 merge) — NULL means a plain path (snap-guide use), a real number
    // means it's used as a buffered corridor trigger-zone import instead.
    const widthM = b.widthM != null ? b.widthM : null;
    await env.DB.prepare(
      "INSERT INTO walking_path (id,app_id,folder_id,name,points_json,width_m,distance_m,elev_gain_m,elev_loss_m,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(id, appId, folderId, name, JSON.stringify(b.points), widthM, b.distanceM || 0, b.elevGainM || 0, b.elevLossM || 0, now, now).run();
    await logAudit(env, request, A, "walkingpath.create", appId + "/" + name);
    return json({ id, name, folderId, widthM }, 201, AC);
  }

  if (path === "/api/walking-path" && method === "GET") {
    const A = await auth(request, env);
    const appId = (url.searchParams.get("appId") || "").trim();
    if (!appId) return json({ error: "appId required" }, 400, AC);
    if (!(await appScopeAuthOk(env, A, appId))) return json({ error: "unauthorized" }, 401, AC);
    const { results } = await env.DB.prepare(
      "SELECT id,folder_id AS folderId,name,width_m AS widthM,distance_m AS distanceM,elev_gain_m AS elevGainM,elev_loss_m AS elevLossM,updated_at AS updatedAt FROM walking_path WHERE app_id=? ORDER BY name"
    ).bind(appId).all();
    return json({ paths: results || [] }, 200, AC);
  }

  const mWalkingPath = path.match(/^\/api\/walking-path\/([^/]+)$/);
  if (mWalkingPath && (method === "GET" || method === "PATCH" || method === "DELETE")) {
    const pathId = decodeURIComponent(mWalkingPath[1]);
    const row = await env.DB.prepare(
      "SELECT app_id AS appId,folder_id AS folderId,name,points_json AS pointsJson,width_m AS widthM,distance_m AS distanceM,elev_gain_m AS elevGainM,elev_loss_m AS elevLossM FROM walking_path WHERE id=?"
    ).bind(pathId).first();
    if (!row) return json({ error: "walking path not found" }, 404, AC);

    if (method === "GET") {
      // Public — the live engine (no visitor session) needs to fetch this
      // for a published, path-driven project.
      let points;
      try { points = JSON.parse(row.pointsJson); } catch (e) { return json({ error: "stored path is corrupt" }, 500, AC); }
      return json({ id: pathId, name: row.name, appId: row.appId, folderId: row.folderId, widthM: row.widthM, distanceM: row.distanceM, elevGainM: row.elevGainM, elevLossM: row.elevLossM, points }, 200, AC);
    }

    const A = await auth(request, env);
    if (!(await appScopeAuthOk(env, A, row.appId))) return json({ error: "unauthorized" }, 401, AC);

    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM walking_path WHERE id=?").bind(pathId).run();
      await logAudit(env, request, A, "walkingpath.delete", pathId);
      return json({ ok: true, deleted: pathId }, 200, AC);
    }

    const b = await request.json().catch(() => ({}));
    let name = row.name, folderId = row.folderId, widthM = row.widthM;
    let pointsJson = row.pointsJson, distanceM = row.distanceM, elevGainM = row.elevGainM, elevLossM = row.elevLossM;
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
    // widthM is a real, separate on/off edit — b.widthM===null clears it back
    // to a plain path, a number sets/changes it, undefined leaves it alone
    // (the pre-existing rename/move call sites never send this key at all).
    if (b.widthM !== undefined) widthM = b.widthM;
    // GPX Editor in-place save — points/distanceM/elevGainM/elevLossM are all
    // optional so the pre-existing rename/move call sites (which only ever
    // send {name} or {folderId}) keep working unchanged.
    if (b.points !== undefined) {
      if (!Array.isArray(b.points) || b.points.length < 2) return json({ error: "points (array of [lon,lat]) required" }, 400, AC);
      pointsJson = JSON.stringify(b.points);
      if (b.distanceM != null) distanceM = b.distanceM;
      if (b.elevGainM != null) elevGainM = b.elevGainM;
      if (b.elevLossM != null) elevLossM = b.elevLossM;
    }
    await env.DB.prepare("UPDATE walking_path SET name=?, folder_id=?, points_json=?, width_m=?, distance_m=?, elev_gain_m=?, elev_loss_m=?, updated_at=? WHERE id=?")
      .bind(name, folderId, pointsJson, widthM, distanceM, elevGainM, elevLossM, new Date().toISOString(), pathId).run();
    await logAudit(env, request, A, "walkingpath.update", pathId);
    return json({ id: pathId, name, folderId, widthM }, 200, AC);
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

  // --- Corridors retired as a separate table/API (migration 0049) — a
  // corridor was always just "a path with a width" (0048's own comment
  // already called it "an exact structural mirror of walking_path"), so it
  // merged into walking_path's own width_m column instead of staying a
  // parallel table+endpoint family. See /api/walking-path above.

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

  // --- serve a 3D model (glTF/GLB) from R2, public streaming read only —
  // uploads/deletes go through /api/asset-object above, same split as
  // /api/audio/:key vs /api/audio-clip. ---
  if (path.startsWith("/api/models/") && method === "GET") {
    const key = decodeURIComponent(path.slice("/api/models/".length)).trim();
    if (!key) return json({ error: "need a model key" }, 400);
    if (!env.MODELS) return json({ error: "no models bucket bound (create R2 'geofence-models' + binding)" }, 500);
    let obj = null;
    try { obj = await env.MODELS.get(key); }
    catch (e) { return new Response("invalid key", { status: 404, headers: CORS_PUBLIC }); }
    if (!obj) return new Response("not found", { status: 404, headers: CORS_PUBLIC });
    const h = new Headers(CORS_PUBLIC);
    h.set("content-type", (obj.httpMetadata && obj.httpMetadata.contentType) || "model/gltf-binary");
    h.set("cache-control", "public, max-age=31536000, immutable"); // r2_key is a permanent opaque id — safe to cache hard, same reasoning as audio clip URLs
    if (obj.httpEtag) h.set("etag", obj.httpEtag);
    return new Response(obj.body, { headers: h });
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
      // fails to load and this Workers AI tier is used instead.
      const AURA_SPEAKER = {
        af_bella: "asteria", af_nicole: "luna", af_sarah: "athena", af_sky: "stella",
        am_adam: "orion", am_michael: "zeus",
        bf_emma: "hera", bf_isabella: "perseus", bm_george: "arcas", bm_lewis: "helios"
      };
      const ttsInput = { text: text.slice(0, 600) };
      // Every voice picker in this app labels no-selection as "default
      // (Bella)" — confirmed live (2026-08-07): when Kokoro fails to load
      // client-side and this endpoint serves instead, an unmapped/missing
      // voice used to fall through to Aura's own unrelated default speaker
      // (angus, a British male voice), silently breaking that promise.
      // Explicitly pin the no-voice case to Bella's Aura equivalent so
      // "default" means the same thing regardless of which TTS tier serves it.
      ttsInput.speaker = (voice && AURA_SPEAKER[voice]) || AURA_SPEAKER.af_bella;
      const result = await env.AI.run("@cf/deepgram/aura-1", ttsInput, { returnRawResponse: true });
      return new Response(result.body, {
        status: 200,
        headers: { "content-type": "audio/mpeg", ...CORS_PUBLIC }
      });
    } catch(e) {
      return json({ error: e.message }, 502, CORS_PUBLIC);
    }
  }

  // --- Object Studio: text-to-image texture generation for Blender-composed
  // objects. Staff-only local tool (see blender-bridge/) — no new auth model,
  // same public-Workers-AI-proxy pattern as /api/tts above. The Blender-side
  // agent (blender-bridge/mcp-server.js's blender_generate_and_apply_texture
  // tool) calls this, saves the PNG locally, then UV-wraps it onto the
  // in-progress object.
  if (path === "/api/texture-gen" && method === "POST") {
    if (!env.AI) return json({ error: "AI binding not configured" }, 503, CORS_PUBLIC);
    try {
      const { prompt } = await request.json();
      if (!prompt || typeof prompt !== "string") return json({ error: "prompt required" }, 400, CORS_PUBLIC);
      const result = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", { prompt: prompt.slice(0, 800) });
      // flux-1-schnell's docs describe { image: <base64 PNG> }, but confirmed
      // live (2026-08-25) it sometimes actually returns JPEG bytes under that
      // same base64 "image" field -- hardcoding content-type:image/png
      // mislabeled those responses. Sniff the real format from the decoded
      // magic bytes instead of trusting the model's documented shape.
      if (result && typeof result.image === "string") {
        const bytes = Uint8Array.from(atob(result.image), c => c.charCodeAt(0));
        const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
        const ct = isPng ? "image/png" : "image/jpeg";
        return new Response(bytes, { status: 200, headers: { "content-type": ct, ...CORS_PUBLIC } });
      }
      // Fallback for any texture model that instead streams raw image bytes.
      if (result && result.body) {
        return new Response(result.body, { status: 200, headers: { "content-type": "image/png", ...CORS_PUBLIC } });
      }
      return json({ error: "unexpected texture-gen response shape" }, 502, CORS_PUBLIC);
    } catch (e) {
      return json({ error: e.message }, 502, CORS_PUBLIC);
    }
  }

  // --- Artistic Fog-of-War Tiles, Phase A: tile_asset is the shared,
  // platform-global library of curated board-game-style tile art. Master-
  // only (curation is a deliberate hand-picked step after generating via
  // /api/texture-gen above, not a per-org/per-scope upload surface like
  // audio clips or 3D models) -- mirrors /api/asset-object's binary-upload
  // shape (query-string metadata + raw body bytes), storing into the TILES
  // bucket instead of MODELS. ---
  if (path === "/api/tile-asset" && method === "POST") {
    if (!(await authed(request, env))) return json({ error: "admin access required" }, 403, AC);
    if (!env.TILES) return json({ error: "no tiles bucket bound (create R2 'geofence-tiles' + binding)" }, 500, AC);
    const terrainType = (url.searchParams.get("terrainType") || "").trim();
    const variantIndex = parseInt(url.searchParams.get("variantIndex") || "0", 10) || 0;
    const style = (url.searchParams.get("style") || "").trim();
    // Season is orthogonal to terrainType (see migrations/0054) -- 'summer'/
    // 'winter', or omitted/null for a season-neutral tile (rock_face,
    // scree, urban_block, plaza, landmarks, fog all look the same
    // year-round).
    const seasonRaw = url.searchParams.get("season");
    const season = seasonRaw === "summer" || seasonRaw === "winter" ? seasonRaw : null;
    if (!terrainType) return json({ error: "terrainType required" }, 400, AC);
    const buf = await request.arrayBuffer();
    if (!buf.byteLength) return json({ error: "empty upload" }, 400, AC);
    // Sniff actual format from magic bytes rather than trusting the
    // uploader's Content-Type header -- /api/texture-gen's own output isn't
    // reliably PNG (see its own comment), and every tile in this library
    // was produced by that route. R2 key keeps a .png extension regardless
    // (a permanent opaque id, same convention as audio/model keys elsewhere
    // in this codebase -- the extension is cosmetic, real format lives in
    // the stored httpMetadata.contentType the GET route actually serves).
    const bytes = new Uint8Array(buf);
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const uploadCt = isPng ? "image/png" : "image/jpeg";
    const r2Key = "tile/" + crypto.randomUUID() + ".png";
    await env.TILES.put(r2Key, buf, { httpMetadata: { contentType: uploadCt } });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO tile_asset (id,terrain_type,variant_index,r2_key,style,season,created_at) VALUES (?,?,?,?,?,?,?)"
    ).bind(id, terrainType, variantIndex, r2Key, style, season, now).run();
    await logAudit(env, request, { keyId: "master" }, "tile.asset.create", terrainType + "#" + variantIndex + (season ? "/" + season : ""));
    return json({ id, terrainType, variantIndex, season, r2Key, url: "/api/tiles/" + r2Key }, 201, AC);
  }

  // --- serve a tile PNG from R2, public streaming read only -- uploads go
  // through /api/tile-asset above, same split as /api/models/:key vs
  // /api/asset-object. ---
  if (path.startsWith("/api/tiles/") && method === "GET") {
    const key = decodeURIComponent(path.slice("/api/tiles/".length)).trim();
    if (!key) return json({ error: "need a tile key" }, 400);
    if (!env.TILES) return json({ error: "no tiles bucket bound (create R2 'geofence-tiles' + binding)" }, 500);
    let obj = null;
    try { obj = await env.TILES.get(key); }
    catch (e) { return new Response("invalid key", { status: 404, headers: CORS_PUBLIC }); }
    if (!obj) return new Response("not found", { status: 404, headers: CORS_PUBLIC });
    const h = new Headers(CORS_PUBLIC);
    h.set("content-type", (obj.httpMetadata && obj.httpMetadata.contentType) || "image/png");
    h.set("cache-control", "public, max-age=31536000, immutable"); // r2_key is a permanent opaque id, same reasoning as audio/model URLs
    if (obj.httpEtag) h.set("etag", obj.httpEtag);
    return new Response(obj.body, { headers: h });
  }

  // --- list the shared tile library, so the Fence Editor / engine can
  // preload every image they might need to render. Public: this is just
  // art, not customer data. ---
  if (path === "/api/tile-assets" && method === "GET") {
    if (!env.DB) return json({ error: "D1 not bound" }, 500, CORS_PUBLIC);
    const terrainType = url.searchParams.get("terrainType");
    // ?season= narrows to that season's tiles PLUS every season-neutral one
    // (season IS NULL) -- a caller with no season set at all (project.season
    // unset) omits this and gets everything, same "no filter = show all"
    // convention as terrainType.
    const season = url.searchParams.get("season");
    const conditions = [], binds = [];
    if (terrainType) { conditions.push("terrain_type=?"); binds.push(terrainType); }
    if (season === "summer" || season === "winter") { conditions.push("(season IS NULL OR season=?)"); binds.push(season); }
    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const sql = "SELECT id,terrain_type AS terrainType,variant_index AS variantIndex,r2_key AS r2Key,style,season,created_at AS createdAt FROM tile_asset" +
      where + " ORDER BY terrain_type,variant_index";
    const stmt = binds.length ? env.DB.prepare(sql).bind(...binds) : env.DB.prepare(sql);
    const { results } = await stmt.all();
    return json({ tiles: (results || []).map(t => ({ ...t, url: "/api/tiles/" + t.r2Key })) }, 200, CORS_PUBLIC);
  }

  // --- Artistic Fog-of-War Tiles, Phase B: OSM + elevation terrain
  // classifier. Reads corridor geometry straight from the request body
  // (the Fence Editor's live in-memory zones, same "snapshot what's on
  // screen" approach Test Mode's editorToSimBundle() already uses) rather
  // than the published bundle, so "Generate Terrain" works before a
  // project's first Publish. One Overpass query per call for the whole
  // project's combined corridor bbox (never per-cell -- Overpass fair-use
  // policy), Terrarium DEM tiles fetched+decoded on demand and cached per
  // call to avoid re-fetching the same tile for neighboring cells. ---
  const mClassify = path.match(/^\/api\/projects\/([^/]+)\/classify-terrain$/);
  if (mClassify && method === "POST") {
    const pid = decodeURIComponent(mClassify[1]);
    const A = await auth(request, env);
    const proj = await env.DB.prepare("SELECT id,orgId,terrain_biome AS terrainBiome FROM project WHERE id=?").bind(pid).first();
    if (!proj) return json({ error: "project not found" }, 404, AC);
    if (!(await codeObjectScopeOk(env, A, proj.orgId))) return json({ error: "unauthorized" }, 401, AC);
    const b = await request.json().catch(() => ({}));
    const corridors = Array.isArray(b.corridors) ? b.corridors : [];
    const polygons = Array.isArray(b.polygons) ? b.polygons : [];
    if (!corridors.length && !polygons.length) return json({ error: "corridors and/or polygons required: corridors [{coords:[[lon,lat],...], widthM}], polygons [[[lon,lat],...]]" }, 400, AC);

    const cellSet = new Set();
    const bufferFeatures = [];
    for (const c of corridors) {
      if (!Array.isArray(c.coords) || c.coords.length < 2) continue;
      const widthM = (typeof c.widthM === "number" && c.widthM > 0) ? c.widthM : 8;
      let line;
      try { line = turf.lineString(c.coords); } catch (e) { continue; }
      const halfWidthKm = (widthM / 2 + TILE_REVEAL_MARGIN_M) / 1000;
      let buf;
      try { buf = turf.buffer(line, halfWidthKm, { units: "kilometers" }); } catch (e) { continue; }
      if (!buf) continue;
      bufferFeatures.push(buf);
      try {
        h3.polygonToCells(buf.geometry.coordinates, 10, true).forEach(cell => cellSet.add(cell));
      } catch (e) {}
    }
    // Map Paint feeds a drawn polygon region straight in -- the ring already
    // IS the area to classify (no corridor buffering), but everything past
    // this point (shared-bbox Overpass query, per-cell OSM/DEM/biome
    // classification, chunked upsert) is identical to the corridor branch.
    for (const ring of polygons) {
      if (!Array.isArray(ring) || ring.length < 3) continue;
      const closed = (ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ? ring : ring.concat([ring[0]]);
      let poly;
      try { poly = turf.polygon([closed]); } catch (e) { continue; }
      bufferFeatures.push(poly);
      try {
        h3.polygonToCells(poly.geometry.coordinates, 10, true).forEach(cell => cellSet.add(cell));
      } catch (e) {}
    }
    if (!cellSet.size) return json({ error: "no valid corridor or polygon geometry" }, 400, AC);
    // Guard the per-cell OSM/DEM loop (and Overpass load) against an
    // accidentally huge drawn region -- res-10 is ~66 m/hex, so 20k cells is
    // already ~300 km2.
    if (cellSet.size > 20000) return json({ error: "region too large (" + cellSet.size + " cells) — draw a smaller area or split it into parts" }, 400, AC);

    // Hand-painted cells (Map Paint, source='manual') are never re-classified
    // or wiped -- drop them from the working set before any OSM/DEM work, and
    // the DELETE below excludes them too, so a re-run only refreshes
    // auto-classified ground.
    let manualCells = new Set();
    try {
      const mc = await env.DB.prepare("SELECT h3_cell FROM terrain_cell WHERE project_id=? AND source='manual'").bind(pid).all();
      manualCells = new Set((mc.results || []).map(r => r.h3_cell));
    } catch (e) {}
    const toClassify = partitionManualCells(cellSet, manualCells);
    if (!toClassify.length) return json({ ok: true, cellCount: 0, summary: {}, note: "every cell in the region is hand-painted" }, 200, AC);

    let elements = [];
    try {
      const [west, south, east, north] = turf.bbox(turf.featureCollection(bufferFeatures));
      elements = await fetchOverpassFeatures([south, west, north, east]);
    } catch (e) { /* offline/unreachable Overpass -- fall through to elevation + biome fallback only */ }

    const areaFeatures = [], lineFeatures = [];
    for (const el of elements) {
      if (el.type !== "way" || !el.tags) continue;
      const rule = TERRAIN_TAXONOMY.find(r => r.test(el.tags));
      if (rule) {
        const poly = overpassElementToPolygon(el);
        if (poly) areaFeatures.push({ type: rule.type, poly });
        continue;
      }
      const lineRule = TERRAIN_LINE_TYPES.find(r => r.test(el.tags));
      if (lineRule) {
        const ln = overpassElementToLine(el);
        if (ln) {
          try {
            const lbuf = turf.buffer(ln, lineRule.halfWidthM / 1000, { units: "kilometers" });
            if (lbuf) lineFeatures.push({ type: lineRule.type, poly: lbuf });
          } catch (e) {}
        }
      }
    }

    const biomeDefault = BIOME_FALLBACK[proj.terrainBiome] || "meadow";
    const tileCache = new Map();
    const now = new Date().toISOString();
    const rows = [];
    for (const cell of toClassify) {
      const [lat, lon] = h3.cellToLatLng(cell);
      let terrainType = classifyFromOsm(lon, lat, areaFeatures, lineFeatures);
      let source = terrainType ? "osm" : null;
      let elevation = null, slope = null;
      if (!terrainType) {
        const el = await classifyFromElevation(lon, lat, tileCache);
        elevation = el.elevation; slope = el.slope;
        if (el.type) { terrainType = el.type; source = "elevation"; }
      }
      if (!terrainType) { terrainType = biomeDefault; source = "biome-fallback"; }
      rows.push({ cell, terrainType, variantIndex: hashCellToVariant(cell), elevation, slope, source });
    }

    // Full replace, not additive-only -- confirmed live (2026-08-25): a
    // corridor deleted in the editor (or shrunk/moved) left its previously-
    // classified cells behind forever, since this route only ever
    // inserted/updated cells for the corridors in THIS request, never
    // pruned rows for corridors no longer present. Wiping the project's
    // prior classification before inserting the fresh set makes a re-run
    // genuinely reflect the current corridor set, matching the "safe to
    // re-run after corridor edits" promise -- not just duplicate-safe.
    await env.DB.prepare("DELETE FROM terrain_cell WHERE project_id=? AND source<>'manual'").bind(pid).run();
    const CHUNK = 50;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const stmts = rows.slice(i, i + CHUNK).map(r => env.DB.prepare(
        "INSERT INTO terrain_cell (project_id,h3_cell,terrain_type,variant_index,elevation_m,slope_deg,source,classified_at) VALUES (?,?,?,?,?,?,?,?) " +
        "ON CONFLICT(project_id,h3_cell) DO UPDATE SET terrain_type=excluded.terrain_type,variant_index=excluded.variant_index,elevation_m=excluded.elevation_m,slope_deg=excluded.slope_deg,source=excluded.source,classified_at=excluded.classified_at"
      ).bind(pid, r.cell, r.terrainType, r.variantIndex, r.elevation, r.slope, r.source, now));
      await env.DB.batch(stmts);
    }

    await logAudit(env, request, A, "terrain.classify", pid + " (" + rows.length + " cells)");
    const summary = {};
    rows.forEach(r => summary[r.terrainType] = (summary[r.terrainType] || 0) + 1);
    return json({ ok: true, cellCount: rows.length, summary }, 200, AC);
  }

  // --- read a project's classified cells, for the engine's tile renderer.
  // Public: this is just terrain classification, not customer data. ---
  const mTerrainCells = path.match(/^\/api\/projects\/([^/]+)\/terrain-cells$/);
  if (mTerrainCells && method === "GET") {
    const pid = decodeURIComponent(mTerrainCells[1]);
    const { results } = await env.DB.prepare(
      "SELECT h3_cell AS h3Cell,terrain_type AS terrainType,variant_index AS variantIndex,source FROM terrain_cell WHERE project_id=?"
    ).bind(pid).all();
    return json({ cells: results || [] }, 200, CORS_PUBLIC);
  }

  // --- Map Paint: hand-painted terrain cells. Writes terrain_cell rows with
  // source='manual', which the classifier above never overwrites or deletes
  // (see its manualCells guard + "source<>'manual'" DELETE). Same auth as
  // classify-terrain (scoped `publish` via codeObjectScopeOk), same
  // cell-string guard as reveal-cells, same 50-row env.DB.batch chunking as
  // the classifier's upsert. Body: { paint:[{h3Cell,terrainType,variantIndex}],
  // erase:[h3Cell,...] }. ---
  if (mTerrainCells && method === "POST") {
    if (!env.DB) return json({ error: "D1 not bound" }, 500, AC);
    const pid = decodeURIComponent(mTerrainCells[1]);
    const A = await auth(request, env);
    const proj = await env.DB.prepare("SELECT id,orgId FROM project WHERE id=?").bind(pid).first();
    if (!proj) return json({ error: "project not found" }, 404, AC);
    if (!(await codeObjectScopeOk(env, A, proj.orgId))) return json({ error: "unauthorized" }, 401, AC);
    const b = await request.json().catch(() => ({}));
    const { paint, erase, error } = normalizeTerrainPaint(b);
    if (error) return json({ error }, 400, AC);
    const now = new Date().toISOString();
    const CHUNK = 50;
    for (let i = 0; i < paint.length; i += CHUNK) {
      await env.DB.batch(paint.slice(i, i + CHUNK).map(p => env.DB.prepare(
        "INSERT INTO terrain_cell (project_id,h3_cell,terrain_type,variant_index,elevation_m,slope_deg,source,classified_at) VALUES (?,?,?,?,NULL,NULL,'manual',?) " +
        "ON CONFLICT(project_id,h3_cell) DO UPDATE SET terrain_type=excluded.terrain_type,variant_index=excluded.variant_index,elevation_m=NULL,slope_deg=NULL,source='manual',classified_at=excluded.classified_at"
      ).bind(pid, p.h3Cell, p.terrainType, p.variantIndex, now)));
    }
    for (let i = 0; i < erase.length; i += CHUNK) {
      const chunk = erase.slice(i, i + CHUNK);
      await env.DB.prepare(
        "DELETE FROM terrain_cell WHERE project_id=? AND h3_cell IN (" + chunk.map(() => "?").join(",") + ")"
      ).bind(pid, ...chunk).run();
    }
    await logAudit(env, request, A, "terrain.paint", pid + " (+" + paint.length + " / -" + erase.length + ")");
    return json({ ok: true, painted: paint.length, erased: erase.length }, 200, AC);
  }

  // --- Artistic Fog-of-War Tiles, Phase D: reveal state, generalizing Ridge
  // Quest's /api/fog-cells + /api/players/:id/fog off player_account onto
  // the platform's generic device table -- same deviceId-in-body pattern
  // POST /api/events already uses (anonymous, no bearer auth, device row
  // assumed pre-registered via POST /api/devices), not Ridge Quest's
  // login-gated playerAuth. ---
  const mRevealCells = path.match(/^\/api\/projects\/([^/]+)\/reveal-cells$/);
  if (mRevealCells && method === "POST") {
    if (!env.DB) return json({ error: "D1 not bound" }, 500, CORS_PUBLIC);
    const pid = decodeURIComponent(mRevealCells[1]);
    const b = await request.json().catch(() => ({}));
    if (!b.deviceId) return json({ error: "deviceId required" }, 400, CORS_PUBLIC);
    const cells = Array.isArray(b.cells) ? b.cells.filter(c => typeof c === "string" && c.length > 0 && c.length <= 20) : [];
    const state = b.state === 1 ? 1 : 2;
    if (!cells.length) return json({ error: "cells (non-empty array) required" }, 400, CORS_PUBLIC);
    if (cells.length > 500) return json({ error: "too many cells in one call (max 500)" }, 400, CORS_PUBLIC);
    const now = new Date().toISOString();
    await env.DB.batch(cells.map(cell =>
      env.DB.prepare(
        "INSERT INTO tile_fog_cell (device_id,project_id,h3_cell,state,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(device_id,project_id,h3_cell) DO UPDATE SET state=MAX(state,excluded.state),updated_at=excluded.updated_at"
      ).bind(b.deviceId, pid, cell, state, now)
    ));
    return json({ ok: true, count: cells.length }, 200, CORS_PUBLIC);
  }
  const mProjectFog = path.match(/^\/api\/projects\/([^/]+)\/fog$/);
  if (mProjectFog && method === "GET") {
    if (!env.DB) return json({ error: "D1 not bound" }, 500, CORS_PUBLIC);
    const pid = decodeURIComponent(mProjectFog[1]);
    const deviceId = url.searchParams.get("device");
    if (!deviceId) return json({ error: "?device= required" }, 400, CORS_PUBLIC);
    const { results } = await env.DB.prepare(
      "SELECT h3_cell,state FROM tile_fog_cell WHERE device_id=? AND project_id=?"
    ).bind(deviceId, pid).all();
    return json({ cells: results || [] }, 200, CORS_PUBLIC);
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
