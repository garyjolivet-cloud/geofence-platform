// A rider's own chute names (2026-10-03): saved on the account (migrations/0069,
// /api/players/:id/corridor-names), shown ONLY on that rider's screens and in the voice.
// User: "these names are never sent to leader board or social media. I can't have poor names
// under the name Kicking Horse." These tests pin both halves.
//
// Run: `node --test tests/rider-chute-names.test.js` (or the full suite).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "backend/worker.js"), "utf8").replace(/\r/g, "");
const rq = fs.readFileSync(path.join(root, "frontend/ridge-quest.html"), "utf8").replace(/\r/g, "");
const social = fs.readFileSync(path.join(root, "frontend/social-card.js"), "utf8");
const QN = require("../frontend/quest-narration.js");

// eslint-disable-next-line no-new-func
const clean = new Function(worker.match(/const CORRIDOR_NAME_MAX = \d+;/)[0] + "\n" +
  worker.slice(worker.indexOf("function cleanCorridorName(v) {"), worker.indexOf("\n}", worker.indexOf("function cleanCorridorName(v) {")) + 2) +
  "\nreturn cleanCorridorName;")();

test("names are cleaned: trimmed, no tags or control characters, 1-40 characters", () => {
  assert.strictEqual(clean("  Dad's   Favourite  "), "Dad's Favourite");
  assert.strictEqual(clean("<b>Big</b> one"), "bBig/b one");
  assert.strictEqual(clean("tab\there"), "tab here");
  assert.strictEqual(clean("   "), null);
  assert.strictEqual(clean("x".repeat(41)), null);
  assert.strictEqual(clean(42), null);
});

test("the table, the routes and the clean-ups exist", () => {
  const mig = fs.readFileSync(path.join(root, "migrations/0069_player_corridor_names.sql"), "utf8");
  assert.ok(/CREATE TABLE IF NOT EXISTS player_corridor_name/.test(mig) && /PRIMARY KEY \(player_id, zone_id\)/.test(mig));
  assert.ok(/corridor-names\(\?:\\\/\(\[\^\/\]\+\)\)\?\$/.test(worker), "GET/PUT/DELETE /api/players/:id/corridor-names[/:zoneId]");
  assert.ok(/P\.playerId !== decodeURIComponent\(mpcn\[1\]\)/.test(worker), "a rider can only touch their own names");
  assert.ok(worker.includes('env.DB.prepare("DELETE FROM player_corridor_name WHERE player_id=?").bind(P.playerId),'), "forget my data removes them");
  assert.ok(/"chute_line", "player_corridor_name"\]\) \{/.test(worker), "workspace delete removes them");
});

test("NEVER shared: runs sent to the server, chute lines, the leaderboard and the social image keep the resort's names", () => {
  assert.ok(/runName: corridor\.name, difficulty: corridor\.difficulty/.test(rq), "the run sent to the server carries the resort's name");
  assert.ok(/runName:corridor\.name, startedAt:run\.startedAt/.test(rq), "a saved chute line carries the resort's name");
  assert.ok(!/rqName|RQNames|corridor-names/.test(social), "the social media image never looks at a rider's names");
  const board = rq.slice(rq.indexOf("+'<span class=\"name\">'+esc(row.name)+(mine?' (you)':'')"));
  assert.ok(board.length > 0, "the leaderboard row prints the server's name untouched");
  assert.ok(!/\/api\/players\/[^"']*corridor-names[^"']*/.test(rq.slice(rq.indexOf("async function renderSocialExport"), rq.indexOf("async function renderYourChutes"))),
    "the social export screen doesn't load rider names");
});

test("shown on the rider's own screens and in the voice", () => {
  [
    "rqName(r.zone_id || r.zoneId, r.run_name || r.runName || \"Run\")",   // today's runs
    "esc(rqName(c.zoneId, c.name))",                                        // Your chutes
    "esc(rqName(l.zoneId, l.runName||name))",                               // saved chute lines
    "esc(rqName(r.zoneId, r.name))",                                        // boot packs / lift rides
    "el.textContent=rqName(c.zoneId, c.name);",                             // armed-run labels
    "rqName(zoneId, (feature.properties && feature.properties.name) || \"run\")" // press-and-hold toast
  ].forEach(s => assert.ok(rq.includes(s), "uses the rider's name: " + s));
  assert.ok(/line: myName \? "This is "\+myName : null/.test(rq), "the voice says the rider's name");
  const r = QN.step({}, { runType: "chute", widthM: 10, name: "Big Dumper", say: null, path: [[51.31, -117.05], [51.30, -117.05]] },
    [51.305, -117.05], { line: "This is Dad's Line", inRun: true, narrOk: true, onLift: false, now: 1, canSay: true, canPrefetch: false });
  assert.strictEqual(r.say, "This is Dad's Line", "the module speaks the override");
});

test("rename / back to the resort's name from the map popup, reset all on Your chutes", () => {
  assert.ok(rq.includes('<button class="rqRename" ') && rq.includes('<button class="rqRevert" '));
  assert.ok(/await RQNames\.set\(p\.id, v\)/.test(rq) && /await RQNames\.clear\(p\.id\)/.test(rq));
  assert.ok(/id="chResetNames"/.test(rq) && /await RQNames\.clear\(null\)/.test(rq));
  assert.ok(/RQNames\.load\(s\.player\.id\)\.finally\(\(\)=>refreshRuns\(s\.player\.id\)\)/.test(rq), "loaded from the account on Home");
});
