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

function degToCompass(deg) {
  const d = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return d[Math.round(deg / 22.5) % 16];
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

function buildChatPrompt(regionBot, clientBot, state, weather, snowHistory) {
  const persona = (regionBot && regionBot.persona) || "You are a knowledgeable and friendly guide at this location.";
  const knowledge = (regionBot && regionBot.knowledge) || "";
  let p = persona.trim();
  if (knowledge) p += "\n\nKNOWLEDGE ABOUT THIS LOCATION:\n" + knowledge.trim();
  if (clientBot && clientBot.knowledge) p += "\n\nCLIENT PROFILE (you know this person):\n" + clientBot.knowledge.trim();

  if (weather) {
    p += "\n\nCURRENT MOUNTAIN CONDITIONS (White Wall station, 2325m):";
    p += `\n  Temperature: ${weather.ww_temp_c}°C`;
    p += `\n  Wind: ${weather.ww_wind_spd_kph} km/h from the ${degToCompass(weather.ww_wind_dir_deg)}, gusting to ${weather.ww_wind_gust_kph} km/h`;
    p += weather.hour_precip_mm > 0
      ? `\n  Precipitation last hour: ${weather.hour_precip_mm} mm`
      : `\n  No precipitation in the last hour`;
    if (weather.precip_24hr_mm > 0) p += `\n  24-hour precipitation: ${weather.precip_24hr_mm} mm`;
    const t = String(weather.reading_time).padStart(4,'0');
    p += `\n  (Reading time: ${weather.reading_date} ${t.slice(0,2)}:${t.slice(2)})`;
  }

  if (snowHistory && snowHistory.length) {
    p += "\n\nSNOW HISTORY — last 14 days (8am daily snapshot):";
    for (const r of snowHistory) {
      const snow = r.hn24_cm > 0 ? ` | new snow: ${r.hn24_cm}cm` : '';
      const precip = r.precip_24hr_mm > 0 ? ` | precip: ${r.precip_24hr_mm}mm` : '';
      p += `\n  ${r.snapshot_date}: ${r.ww_temp_c}°C${snow}${precip}`;
    }
  }

  p += "\n\nCURRENT VISITOR SITUATION:\n";
  if (state) {
    if (state.zoneName)         p += `At: ${state.zoneName}.\n`;
    if (state.dwellSeconds > 5) p += `Time here: ${Math.round(state.dwellSeconds)}s.\n`;
    if (state.previousZones && state.previousZones.length)
      p += `Previously visited: ${state.previousZones.join(", ")}.\n`;
    if (state.distFromCenterM != null)
      p += `Distance from zone centre: ${state.distFromCenterM}m.\n`;
    if (state.speedKmh != null) {
      if (state.speedKmh > 15)     p += `Moving fast: ${state.speedKmh} km/h (skiing).\n`;
      else if (state.speedKmh > 2) p += `Moving slowly: ${state.speedKmh} km/h.\n`;
      else                          p += `Stationary.\n`;
    }
    if (state.headingDeg != null) {
      const _16 = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
      const card = _16[Math.round(state.headingDeg / 22.5) % 16];
      p += `Heading: ${card} (${state.headingDeg}°).\n`;
    }
    if (state.timeOfDay) p += `Local time: ${state.timeOfDay}.\n`;
    if (state.nearbyZones && state.nearbyZones.length)
      p += `Nearby: ${state.nearbyZones.map(z => `${z.name} (${Math.round(z.distanceM)}m ${z.direction})`).join(", ")}.\n`;
    if (state.visitorHistory && state.visitorHistory.length)
      p += `Visitor's zone history: ${state.visitorHistory.map(r => `${r.zoneName} (${r.dwellSeconds}s)`).join(" → ")}.\n`;
    if (state.trackers && state.trackers.length) {
      const _16c = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
      p += `Trackers currently in zones: ${state.trackers.map(t => {
        let s = `${t.trackerId} in "${t.zoneName}" for ${t.dwellSeconds}s`;
        if (t.speedKmh > 2) s += `, moving at ${t.speedKmh} km/h`;
        else if (t.speedKmh != null) s += `, stationary`;
        if (t.headingDeg != null) s += ` heading ${_16c[Math.round(t.headingDeg/22.5)%16]}`;
        return s;
      }).join("; ")}.\n`;
    }
    if (state.trackerHistories && Object.keys(state.trackerHistories).length) {
      for (const [tid, hist] of Object.entries(state.trackerHistories))
        p += `${tid} zone history: ${hist.map(r => `${r.zoneName} (${r.dwellSeconds}s)`).join(" → ")}.\n`;
    }
    if (state.peerHistories && Object.keys(state.peerHistories).length) {
      p += "\nPEER BOT HISTORIES (shared by other moving bots):\n";
      for (const [name, hist] of Object.entries(state.peerHistories))
        p += `${name}: ${hist.map(r => `${r.zoneName} (${r.dwellSeconds}s)`).join(" → ")}.\n`;
    }
  }
  // MARKET DATA: (coming soon — Yahoo Finance cron scrape cached in D1)
  // NEWS: (coming soon — Al Jazeera RSS scrape cached in D1)
  p += "\n\nRULES — follow these exactly:";
  p += "\n1. Facts only. Every fact you state MUST be explicitly written in your KNOWLEDGE section above. Do not infer, extrapolate, or invent details not written there. If you don't have the information, say \"I don't have details on that\" — never guess.";
  p += "\n2. No compass directions. Never say North, South, East, West, N, S, E, W, northeast, etc. Use landmarks, slope names, or relative terms (left, right, ahead) instead.";
  p += "\n3. Short. Keep responses under 3 sentences unless the visitor explicitly asks for more.";
  p += "\n4. Stay in persona as described above.";
  if (state && state.speedKmh > 15) p += "\n5. Visitor is moving fast (skiing) — 1 short sentence only.";
  return p;
}

function authed(request, env) {
  const h = request.headers.get("authorization") || "";
  return !!env.ADMIN_TOKEN && h === "Bearer " + env.ADMIN_TOKEN;
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
    if (!row) return null;
    env.DB.prepare("UPDATE api_key SET lastUsedAt=? WHERE id=?").bind(new Date().toISOString(), row.id).run().catch(() => {});
    return { master: false, appId: row.appId, scopes: row.scopes || "", keyId: row.id };
  } catch (e) { return null; }
}
function scopeOk(A, scope, targetAppId) {
  if (!A) return false;
  if (A.master) return true;
  const scopes = (A.scopes || "").split(",").map(s => s.trim());
  const hasScope = scopes.includes("*") || scopes.includes(scope);
  const appOk = (A.appId == null) || (targetAppId == null) || (A.appId === targetAppId);
  return hasScope && appOk;
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
      "/field": "/field-recorder.html",
      "/bots": "/bot-library.html"
    };
    const clean = url.pathname.replace(/\/+$/, "");
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

  // --- nuke all data (master only) — wipes every row, keeps schema ---
  if (path === "/api/nuke" && method === "DELETE") {
    if (!authed(request, env)) return json({ error: "master token required" }, 401, AC);
    const tables = ["event","consent","device","audit_log","published_bundle","api_key","project","app","bot"];
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
    if (!authed(request, env)) return json({ error: "master token required" }, 401, AC);
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
    if (!authed(request, env)) return json({ error: "master token required" }, 401, AC);
    const { results } = await env.DB.prepare(
      "SELECT id,appId,label,scopes,createdAt,lastUsedAt,revokedAt FROM api_key ORDER BY createdAt DESC"
    ).all();
    return json({ keys: results || [] }, 200, AC);
  }
  const mk = path.match(/^\/api\/keys\/([^/]+)$/);
  if (mk && method === "DELETE") {
    if (!authed(request, env)) return json({ error: "master token required" }, 401, AC);
    await env.DB.prepare("UPDATE api_key SET revokedAt=? WHERE id=?").bind(new Date().toISOString(), mk[1]).run();
    await logAudit(env, request, { keyId: "master" }, "key.revoke", mk[1]);
    return json({ ok: true, revoked: mk[1] }, 200, AC);
  }
  if (path === "/api/audit" && method === "GET") {
    if (!authed(request, env)) return json({ error: "master token required" }, 401, AC);
    const { results } = await env.DB.prepare(
      "SELECT ts,keyId,action,target,ip FROM audit_log ORDER BY ts DESC LIMIT 200"
    ).all();
    return json({ audit: results || [] }, 200, AC);
  }
  if (!env.DB) return json({ error: "D1 not bound — add the DB binding in wrangler.jsonc" }, 500);

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
    if (!authed(request, env)) return json({ error: "unauthorized" }, 401, AC);
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

  // --- delete an app (master only; ?cascade=true also deletes all its projects) ---
  const mda = path.match(/^\/api\/apps\/([^/]+)$/);
  if (mda && method === "DELETE") {
    if (!authed(request, env)) return json({ error: "master token required" }, 401, AC);
    const aid = decodeURIComponent(mda[1]);
    const cascade = url.searchParams.get("cascade") === "true";
    if (cascade) {
      const { results: projs } = await env.DB.prepare("SELECT id FROM project WHERE appId=?").bind(aid).all();
      for (const p of (projs || [])) {
        await env.DB.prepare("DELETE FROM event WHERE projectId=?").bind(p.id).run();
        await env.DB.prepare("DELETE FROM published_bundle WHERE projectId=?").bind(p.id).run();
        await env.DB.prepare("DELETE FROM project WHERE id=?").bind(p.id).run();
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

  // --- bots: org-scoped reusable bot library ---
  if (path === "/api/bots" && method === "GET") {
    const appId = url.searchParams.get("appId");
    const sql = appId
      ? "SELECT * FROM bot WHERE app_id=? ORDER BY name"
      : "SELECT * FROM bot ORDER BY name";
    const { results } = await env.DB.prepare(sql).bind(...(appId ? [appId] : [])).all();
    return json({ bots: results || [] });
  }

  if (path === "/api/bots" && method === "POST") {
    const A = await auth(request, env);
    if (!scopeOk(A, "publish", null)) return json({ error: "publish scope required" }, 401, AC);
    const b = await request.json().catch(() => ({}));
    if (!b.name) return json({ error: "name required" }, 400, AC);
    const id = b.id || "bot_" + crypto.randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const fnJson = b.functions ? JSON.stringify(b.functions) : null;
    await env.DB.prepare(
      "INSERT INTO bot (id,app_id,name,type,avatar,persona,knowledge,greeting,functions,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(id, b.appId || null, b.name, b.type || "region", b.avatar || "🤖",
           b.persona || null, b.knowledge || null, b.greeting || null, fnJson, now, now).run();
    return json({ ok: true, id }, 201, AC);
  }

  const mbot = path.match(/^\/api\/bots\/([^/]+)$/);
  if (mbot && method === "PUT") {
    const A = await auth(request, env);
    if (!scopeOk(A, "publish", null)) return json({ error: "publish scope required" }, 401, AC);
    const bid = decodeURIComponent(mbot[1]);
    const b = await request.json().catch(() => ({}));
    const now = new Date().toISOString();
    const fnJson = b.functions !== undefined ? (b.functions ? JSON.stringify(b.functions) : null) : undefined;
    await env.DB.prepare(
      "UPDATE bot SET name=COALESCE(?,name), type=COALESCE(?,type), avatar=COALESCE(?,avatar), persona=?, knowledge=?, greeting=?, functions=COALESCE(?,functions), app_id=COALESCE(?,app_id), updated_at=? WHERE id=?"
    ).bind(b.name || null, b.type || null, b.avatar || null,
           b.persona ?? null, b.knowledge ?? null, b.greeting ?? null,
           fnJson ?? null, b.appId || null, now, bid).run();
    return json({ ok: true }, 200, AC);
  }

  if (mbot && method === "DELETE") {
    if (!authed(request, env)) return json({ error: "master token required" }, 401, AC);
    const bid = decodeURIComponent(mbot[1]);
    await env.DB.prepare("DELETE FROM bot WHERE id=?").bind(bid).run();
    return json({ ok: true, deleted: bid }, 200, AC);
  }

  // --- move a project into an app (admin) ---
  const mvm = path.match(/^\/api\/projects\/([^/]+)\/app$/);
  if (mvm && method === "PUT") {
    if (!authed(request, env)) return json({ error: "unauthorized" }, 401, AC);
    const pid = decodeURIComponent(mvm[1]);
    const b = await request.json();
    await env.DB.prepare("UPDATE project SET appId=?, updatedAt=? WHERE id=?")
      .bind(b.appId || null, new Date().toISOString(), pid).run();
    return json({ ok: true, project: pid, appId: b.appId || null }, 200, AC);
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
    if (!authed(request, env)) return json({ error: "unauthorized" }, 401, AC);
    const b = await request.json();
    const id = b.id || b.slug;
    if (!id || !b.name) return json({ error: "need id and name" }, 400);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO project (id,orgId,appId,name,slug,mode,status,bundleVersion,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).bind(id, b.orgId || orgId, b.appId || null, b.name, b.slug || id, b.mode || "walking-tour", "draft", 1, now, now).run();
    return json({ ok: true, id }, 200, AC);
  }

  // --- delete a project (master only; cascades bundles + events) ---
  const mdp = path.match(/^\/api\/projects\/([^/]+)$/);
  if (mdp && method === "DELETE") {
    if (!authed(request, env)) return json({ error: "master token required" }, 401, AC);
    const pid = decodeURIComponent(mdp[1]);
    await env.DB.prepare("DELETE FROM event WHERE projectId=?").bind(pid).run();
    await env.DB.prepare("DELETE FROM published_bundle WHERE projectId=?").bind(pid).run();
    await env.DB.prepare("DELETE FROM project WHERE id=?").bind(pid).run();
    await logAudit(env, request, { keyId: "master" }, "project.delete", pid);
    return json({ ok: true, deleted: pid }, 200, AC);
  }

  // --- a project's bundle: GET latest (public) / PUT new version (scoped) ---
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
      bundle.bundleVersion = row.version;
      // Merge active live zones
      const liveRows = await env.DB.prepare(
        "SELECT zone_json FROM live_zone WHERE project_id=? AND expires_at > ?"
      ).bind(pid, Date.now()).all();
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
      const existingAppId = await projectAppId(env, pid);
      const targetApp = existingAppId || bundle.appId || null;
      const A = await auth(request, env);
      if (!scopeOk(A, "publish", targetApp)) return json({ error: "not authorized to publish to this app" }, 401, AC);
      const now = new Date().toISOString();
      // Resolve appId — auto-assign so project always surfaces on home screen
      let resolvedAppId = existingAppId || bundle.appId || null;
      if (!resolvedAppId) {
        const existingApp = await env.DB.prepare("SELECT id FROM app WHERE orgId=? LIMIT 1").bind(orgId).first();
        if (existingApp) {
          resolvedAppId = existingApp.id;
        } else {
          resolvedAppId = orgId;
          await env.DB.prepare(
            "INSERT OR IGNORE INTO app (id,orgId,name,slug,description,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)"
          ).bind(resolvedAppId, orgId, bundle.name || "Default Workspace", resolvedAppId, null, now, now).run();
        }
      }
      const proj = await env.DB.prepare("SELECT bundleVersion FROM project WHERE id=?").bind(pid).first();
      const ver = ((proj && proj.bundleVersion) || 0) + 1;
      // Only auto-create the project row if the editor explicitly opts in
      if (proj) {
        await env.DB.prepare("UPDATE project SET bundleVersion=?, updatedAt=?, status='live', appId=COALESCE(?,appId) WHERE id=?")
          .bind(ver, now, resolvedAppId, pid).run();
      } else if (bundle.createIfMissing) {
        await env.DB.prepare(
          "INSERT INTO project (id,orgId,appId,name,slug,mode,status,bundleVersion,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)"
        ).bind(pid, orgId, resolvedAppId, bundle.name || pid, bundle.project || pid, "walking-tour", "live", ver, now, now).run();
      } else {
        return json({ error: "project not found — create it from the main screen first" }, 404, AC);
      }
      await env.DB.prepare(
        "INSERT INTO published_bundle (projectId,version,json,publishedAt) VALUES (?,?,?,?)"
      ).bind(pid, ver, JSON.stringify(bundle), now).run();
      // upsert bots from bundle into D1 bot table for cross-project reuse
      if (Array.isArray(bundle.bots) && bundle.bots.length) {
        const appId = bundle.appId || null;
        for (const b of bundle.bots) {
          if (!b.id || !b.name) continue;
          await env.DB.prepare(
            "INSERT INTO bot (id,app_id,name,type,avatar,persona,knowledge,greeting,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, avatar=excluded.avatar, persona=excluded.persona, knowledge=excluded.knowledge, greeting=excluded.greeting, app_id=COALESCE(excluded.app_id,bot.app_id), updated_at=excluded.updated_at"
          ).bind(b.id, appId, b.name, b.type || "region", b.avatar || "🤖",
                 b.persona || null, b.knowledge || null, b.greeting || null, now, now).run().catch(() => {});
        }
      }
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
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "invalid JSON" }, 400, AC); }
    if (!body.zone || typeof body.zone !== "object") return json({ error: "zone object required" }, 400, AC);
    const ttlMs = Math.min(Math.max(body.ttlMs || 300000, 30000), 3600000); // 30s–60min
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const zoneId = body.zone.id || ("live_" + now.toString(36));
    const zone = { ...body.zone, id: zoneId, expiresAt };
    await env.DB.prepare(
      "INSERT INTO live_zone (id, project_id, zone_json, expires_at, created_at) VALUES (?,?,?,?,?)"
    ).bind(zoneId, pid, JSON.stringify(zone), expiresAt, now).run();
    return json({ ok: true, id: zoneId, expiresAt }, 200, AC);
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
    for (const e of evs.slice(0, 500)) {
      const pid = e.projectId || b.projectId;
      if (!e.id || !pid) continue;
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
    if (!scopeOk(A, "analytics", await projectAppId(env, pid))) return json({ error: "not authorized for this app's analytics" }, 401, AC);
    const lim = Math.min(parseInt(url.searchParams.get("limit") || "5000", 10) || 5000, 20000);
    const { results } = await env.DB.prepare(
      "SELECT id,type,ts,deviceId,data FROM event WHERE projectId=? ORDER BY ts DESC LIMIT ?"
    ).bind(pid, lim).all();
    return json({ project: pid, count: (results || []).length, events: results || [] }, 200, AC);
  }

  // --- list audio in R2 (scoped) ---
  if (path === "/api/audio-list" && method === "GET") {
    if (!env.AUDIO) return json({ error: "no audio bucket bound" }, 500);
    const pfx = url.searchParams.get("project");
    const A = await auth(request, env);
    const appId = pfx ? await projectAppId(env, pfx) : null;
    if (!scopeOk(A, "audio", appId) && !scopeOk(A, "publish", appId)) return json({ error: "unauthorized" }, 401, AC);
    const listed = await env.AUDIO.list(pfx ? { prefix: pfx + "/" } : {});
    return new Response(JSON.stringify({ objects: (listed.objects || []).map(o => ({ key: o.key, size: o.size, url: "/api/audio/" + o.key })) }), {
      status: 200, headers: { "content-type": "application/json", "cache-control": "no-store", ...AC }
    });
  }

  // --- audio assets in R2: upload (scoped) + serve (public) ---
  if (path.startsWith("/api/audio/")) {
    const key = decodeURIComponent(path.slice("/api/audio/".length)).trim();
    if (!key) return json({ error: "need an audio key" }, 400);
    if (!env.AUDIO) return json({ error: "no audio bucket bound (create R2 'geofence-audio' + binding)" }, 500);
    if (method === "PUT") {
      const A = await auth(request, env);
      const appId = await projectAppId(env, key.split("/")[0]);
      if (!scopeOk(A, "audio", appId) && !scopeOk(A, "publish", appId)) return json({ error: "not authorized to upload to this app" }, 401, AC);
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
      const appId = await projectAppId(env, key.split("/")[0]);
      if (!scopeOk(A, "audio", appId) && !scopeOk(A, "publish", appId)) return json({ error: "unauthorized" }, 401, AC);
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

  // --- TTS (Workers AI speecht5_tts → WAV) ---
  if (path === "/api/tts" && method === "POST") {
    if (!env.AI) return json({ error: "AI binding not configured" }, 503, CORS_PUBLIC);
    try {
      const { text } = await request.json();
      if (!text || typeof text !== "string") return json({ error: "text required" }, 400, CORS_PUBLIC);
      const result = await env.AI.run("@cf/microsoft/speecht5_tts", {
        prompt: text.slice(0, 600)
      });
      // result.audio is Float32Array of 16 kHz PCM samples
      const samples = result.audio;
      if (!samples || !samples.length) return json({ error: "no audio returned" }, 502, CORS_PUBLIC);
      // encode PCM → WAV
      const pcmBuf = new ArrayBuffer(samples.length * 2);
      const pcm = new DataView(pcmBuf);
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        pcm.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      }
      const wav = new ArrayBuffer(44 + pcmBuf.byteLength);
      const v = new DataView(wav);
      const w = (s, o) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      w('RIFF', 0); v.setUint32(4, 36 + pcmBuf.byteLength, true); w('WAVE', 8);
      w('fmt ', 12); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 16000, true); v.setUint32(28, 32000, true);
      v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      w('data', 36); v.setUint32(40, pcmBuf.byteLength, true);
      new Uint8Array(wav).set(new Uint8Array(pcmBuf), 44);
      return new Response(new Uint8Array(wav), {
        status: 200,
        headers: { "content-type": "audio/wav", ...CORS_PUBLIC }
      });
    } catch(e) {
      return json({ error: e.message }, 502, CORS_PUBLIC);
    }
  }

  // --- weather cache (read + manual trigger) ---
  if (path === "/api/weather") {
    if (method === "GET") {
      const row = await env.DB.prepare('SELECT * FROM weather_cache ORDER BY id DESC LIMIT 1').first();
      return json(row || { error: "no data yet" }, row ? 200 : 404, CORS_PUBLIC);
    }
    if (method === "POST" && authed(request, env)) {
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
    if (method === "POST" && authed(request, env)) {
      try {
        const result = await saveSnowSnapshot(env);
        return json({ ok: true, ...result }, 200, CORS_PUBLIC);
      } catch(e) {
        return json({ error: e.message }, 502, CORS_PUBLIC);
      }
    }
  }

  // --- chatbot (proxies Groq, streams SSE) ---
  if (path === "/api/chat" && method === "POST") {
    if (!env.GROQ_API_KEY) return json({ error: "GROQ_API_KEY not configured" }, 503, CORS_PUBLIC);
    let body;
    try { body = await request.json(); } catch(e) { return json({ error: "invalid JSON" }, 400, CORS_PUBLIC); }
    const { regionBot, clientBot, messages, geofenceState,
            persona, knowledge } = body; // persona/knowledge kept for backward compat
    if (!Array.isArray(messages) || !messages.length) return json({ error: "messages required" }, 400, CORS_PUBLIC);
    const rBot = regionBot || { persona, knowledge };
    const weather = env.DB ? await env.DB.prepare('SELECT * FROM weather_cache ORDER BY id DESC LIMIT 1').first().catch(()=>null) : null;
    const snowRows = env.DB ? await env.DB.prepare('SELECT snapshot_date, precip_24hr_mm, hn24_cm, ww_temp_c FROM snow_history ORDER BY snapshot_date DESC LIMIT 14').all().catch(()=>({results:[]})) : {results:[]};
    const sys = buildChatPrompt(rBot, clientBot, geofenceState, weather, snowRows.results || []);
    const gr = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.GROQ_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "system", content: sys }, ...messages.slice(-10)],
        stream: true,
        max_tokens: 300,
        temperature: 0.3
      })
    });
    if (!gr.ok) { const t = await gr.text(); return json({ error: "Groq " + gr.status, detail: t }, 502, CORS_PUBLIC); }
    return new Response(gr.body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "access-control-allow-origin": "*" } });
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
