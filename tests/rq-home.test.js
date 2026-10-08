// Ridge Quest Home redesign (2026-10-06): the 3D today picture (frontend/rq-hero.js) on top,
// redrawn only when boarding the gondola; consolidated layout; Guard off Home; conditions page
// "Start tracking".
// Run: `node --test tests/rq-home.test.js` (or the full suite).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const H = require("../frontend/rq-hero.js");
const rq = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8").replace(/\r/g, "");

// A main lift (gondola, climbs 1068 m, drawn bottom->top) and a chair (climbs 350 m).
const gondola = { zoneId: "g", runType: "lift", climbM: 1068, descentM: 2, path: [[51.297, -116.955], [51.287, -117.03]] };
const chair = { zoneId: "c", runType: "lift", climbM: 350, descentM: 0, path: [[51.29, -117.06], [51.285, -117.07]] };
const cors = [gondola, chair, { zoneId: "x", runType: "chute", path: [[51.28, -117.05], [51.279, -117.051]] }];
const north = m => m / 111320;

test("boarding the main lift at its bottom station triggers; the top station and other lifts don't", () => {
  assert.strictEqual(H.mainLift(cors).lift, gondola, "the lift that climbs the most");
  assert.strictEqual(H.isMainLiftBoarding([51.297 + north(100), -116.955], cors), true, "100 m from the bottom station");
  assert.strictEqual(H.isMainLiftBoarding([51.287, -117.03], cors), false, "getting on at the top (to ride down) is not 'the bottom of the hill'");
  assert.strictEqual(H.isMainLiftBoarding([51.29, -117.06], cors), false, "another chair");
  const drawnDown = Object.assign({}, gondola, { climbM: 2, descentM: 1068, path: gondola.path.slice().reverse() });
  assert.strictEqual(H.isMainLiftBoarding([51.297, -116.955], [drawnDown]), true, "bottom found by elevation when drawn top->bottom");
  assert.strictEqual(H.isMainLiftBoarding([51.297, -116.955], []), false, "no lifts -> never");
});

test("a picture is fresh only for today and when not stale", () => {
  assert.strictEqual(H.isFreshFor({ img: "x", day: "2026-12-01" }, "2026-12-01"), true);
  assert.strictEqual(H.isFreshFor({ img: "x", day: "2026-11-30" }, "2026-12-01"), false, "yesterday's -> draw today's");
  assert.strictEqual(H.isFreshFor({ img: "x", day: "2026-12-01", stale: true }, "2026-12-01"), false, "asked for while locked");
  assert.strictEqual(H.isFreshFor(null, "2026-12-01"), false);
});

test("refresh: at most one gondola redraw per 10 minutes; a locked phone marks it stale", async () => {
  const store = {};
  global.localStorage = { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } };
  global.document = { hidden: true };
  H.state.lastAt = 0;
  const r1 = await H.refresh("p1", "gondola", async () => ({}), "2026-12-01");
  assert.strictEqual(r1, "stale");
  assert.ok(JSON.parse(store["rq.hero.v2.p1"]).stale, "remembered for the next Home open");
  const r2 = await H.refresh("p1", "gondola", async () => ({}), "2026-12-01");
  assert.strictEqual(r2, "skipped", "a second boarding within 10 min does nothing");
  delete global.document; delete global.localStorage;
});

test("Home: picture on top, Start tracking under it, strips, grid, account folded; no Guard button", () => {
  const home = rq.slice(rq.indexOf("function renderHome(){"), rq.indexOf("// The rider's own chute names (cached copy"));
  // (the Today strip went 2026-10-06 with the boot pack stats; points moved onto the picture)
  const order = ['id="heroBox"', 'id="btnTrack"', 'class="exploreGrid"', 'id="todayRuns"', 'details class="acct"'];
  let last = -1;
  order.forEach(k => { const i = home.indexOf(k); assert.ok(i > last, k + " in order"); last = i; });
  assert.ok(!/btnGuard/.test(home), "Guard switch is on My map only");
  assert.ok(/paintHero\(s\);/.test(home), "the picture is painted on every Home open");
  assert.ok(/<script src="\/rq-hero\.js"><\/script>/.test(rq));
});

test("the picture redraws when boarding the gondola (from the GPS handler), not on its own", () => {
  assert.ok(/RQHero\.isMainLiftBoarding\(\[fix\.lat, fix\.lon\], this\.corridors\)\) this\.onGondolaBoard\(\)/.test(rq));
  assert.ok(/Quest\.onGondolaBoard = \(\)=>\{ heroRefresh\(getSession\(\), "gondola"\); \};/.test(rq));
  const paint = rq.slice(rq.indexOf("function paintHero(s){"), rq.indexOf("Quest.onGondolaBoard = "));
  assert.ok(/if\(!RQHero\.isFreshFor\(cached, questDateBucketClient\(new Date\(\)\)\)\) heroRefresh/.test(paint), "Home only draws it when there is none for today");
});

test("conditions page: Start tracking replaces Continue (Back while tracking), with a look-around link", () => {
  const c = rq.slice(rq.indexOf("async function renderConditions(onContinue, onStart){"), rq.indexOf("function startTrackingFromConditions(){"));
  assert.ok(/'<button class="primary trackBtn" id="btnCont">Start tracking<\/button>/.test(c));
  assert.ok(/id="btnCont">Back<\/button>/.test(c) && /id="btnLookAround"/.test(c));
  assert.ok(/renderConditions\(renderHome, startTrackingFromConditions\);/.test(rq), "boot path");
  const s = rq.slice(rq.indexOf("function startTrackingFromConditions(){"));
  assert.ok(/renderHome\(\);[\s\S]{0,80}b\.click\(\)/.test(s.slice(0, 300)), "same tap starts tracking on Home");
});

test("Share my location is on the Friends screen, not Home; sending still runs from any screen", () => {
  const home = rq.slice(rq.indexOf("function renderHome(){"), rq.indexOf("// The rider's own chute names (cached copy"));
  assert.ok(!/btnShare/.test(home), "not on Home");
  const friends = rq.slice(rq.indexOf("async function renderFriends(){"));
  assert.ok(/id="btnShare"/.test(friends.slice(0, 1200)) && /bindShareButton\(document\.getElementById\("btnShare"\)\);/.test(friends.slice(0, 2500)));
  assert.ok(/api\("\/api\/share", \{method:"POST", body:JSON\.stringify\(\{on:turningOn\}\)\}\)/.test(rq.slice(rq.indexOf("function bindShareButton(btn){"))));
  assert.ok(/Quest\.onShare = \(p\)=>\{/.test(rq), "the location POST piggyback is still set up");
});

// 2026-10-06 follow-up: "The map is not the 3d map. It needed to look exactly like the my map."
test("the picture is drawn with My map's own pieces, and only once the runs are loaded", () => {
  const r = rq.slice(rq.indexOf("function renderMyMapPicture(w, h, today){"), rq.indexOf("// Today's chutes skied and boot packs climbed"));
  assert.ok(/features:runLineFeatures\(cors\)/.test(r), "same run features as My map (drawAllRuns uses runLineFeatures too)");
  assert.ok(/const feats = runLineFeatures\(cors\);/.test(rq.slice(rq.indexOf("function drawAllRuns(map){"))), "drawAllRuns shares it");
  assert.ok(/TileFog\.addCorridorLayers\(map,\{ source:"runLines", id:"runLines", guardByState:true \}\)/.test(r), "same corridor layers as My map");
  assert.ok(/Terrain3D\.setEnabled\(map, true, \{ sky:true \}\)/.test(r) && /const pitch=Quest\.threeDEnabled\?60:0;/.test(r), "3D, tilted like My map's 3D button");
  assert.ok(/RQHero\.mainLift\(cors\)/.test(r) && /cameraForBounds\(b,\{ padding:[^}]*, bearing \}\)/.test(r) && /pitch, bearing \}\);/.test(r),
    "looks up the main lift, framed on the upper mountain (chutes + lift tops)");
  assert.ok(/if\(c\.runType==="chute"\) \(c\.path\|\|\[\]\)\.forEach/.test(r) && /focus\.push\(\[t\[1\],t\[0\]\]\);/.test(r), "chutes and lift TOPS only");
  assert.ok(/Terrain3D\.applyWinter/.test(r) && /map\.addLayer\(HOME_TODAY_LAYER\)/.test(r) && /RidgeVisuals\.trackLayer/.test(r), "winter, today's gold glow, track");
  assert.ok(/const todayIds=new Set\(\[\.\.\.today\.skied, \.\.\.\(today\.bootPacks\|\|\[\]\)\]\);/.test(r), "today's chutes and boot packs both glow");
  assert.ok(/canvasContextAttributes:\{ preserveDrawingBuffer:true/.test(r) && /SocialCard\.isBlank/.test(r), "iPhone black-frame guard");
  const h = rq.slice(rq.indexOf("async function heroRefresh(s, reason){"));
  assert.ok(/if\(!\(Quest\.corridors\|\|\[\]\)\.length \|\| Quest\.corridorsProject !== RQ_PROJECT_ID\)\{ try\{ await Quest\.loadCorridors\(\); \}catch\(e\)\{\} \}/.test(h.slice(0, 900)), "waits for THIS map's runs (the drawn-mountain bug; another resort's runs)");
});

// 2026-10-07: "when i change resort from kicking horse to jolivet walk the map remains the chutes of
// kicking horse" — the old resort's runs stayed in memory and Home's picture was drawn from them.
test("switching resort forgets the old runs, camera and picture", async () => {
  const pick = rq.slice(rq.indexOf("async function renderProjectPicker(appId, appName){"), rq.indexOf("/* ============================= AUTH VIEW"));
  assert.ok(/if\(RQ_PROJECT_ID !== btn\.dataset\.id\)\{ Quest\.forgetProject\(\); _splashEndCamera = null; \}\s*RQ_APP_ID = appId; RQ_PROJECT_ID = btn\.dataset\.id;/.test(pick), "before the new project id is set");
  const fp = rq.slice(rq.indexOf("  forgetProject(){"), rq.indexOf("  async loadCorridors(){"));
  assert.ok(/this\.corridors=\[\];/.test(fp) && /this\.ref=null;/.test(fp) && /this\.corridorsProject=null;/.test(fp) && /this\.skiedToday=new Set\(\);/.test(fp));
  const lc = rq.slice(rq.indexOf("  async loadCorridors(){"), rq.indexOf("const ref = bundle.ref || [0,0];"));
  assert.ok(/const forProject = RQ_PROJECT_ID;/.test(lc) && /if\(forProject !== RQ_PROJECT_ID\) return;/.test(lc) && /this\.corridorsProject = forProject;/.test(lc), "a late answer for another map is ignored");
  const paint = rq.slice(rq.indexOf("function paintHero(s){"), rq.indexOf("Quest.onGondolaBoard = "));
  assert.ok(/if\(cached && cached\.project !== RQ_PROJECT_ID\) cached=null;/.test(paint), "another resort's picture is never shown");
  // the picture is saved with its project
  const store = {};
  global.localStorage = { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } };
  global.document = { hidden: false };
  H.state.lastAt = 0;
  assert.strictEqual(await H.refresh("p9", "first", async () => ({ toDataURL: () => "data:x" }), "2026-12-01", "proj-a"), "done");
  assert.strictEqual(JSON.parse(store["rq.hero.v2.p9"]).project, "proj-a");
  delete global.document; delete global.localStorage;
});

// 2026-10-06: "take the this season block with vertical chutes day streak and build a personal
// section into leader board. trying to simplify main screen."
test("This season (vertical, chutes, day streak) is on the Leaderboard, not Home", () => {
  const home = rq.slice(rq.indexOf("function renderHome(){"), rq.indexOf("// The rider's own chute names (cached copy"));
  assert.ok(!/vertSeason|chutesSeason|statsStreak/.test(home), "gone from Home");
  const lb = rq.slice(rq.indexOf("async function renderLeaderboard(mode){"), rq.indexOf("const listEl=document.getElementById(\"lbList\");"));
  // Runs sit beside Chutes, both n/total (2026-10-08, Gary: "runs need to show in the leader board like chutes").
  assert.ok(/id="lbYou"/.test(lb) && lb.includes('mini("vertSeason","Vertical")+mini("chutesSeason","Chutes","lbChutes")+mini("lbRunsSeason","Runs")+mini("liftSeasonN","Lifts","lbLifts")+mini("statsStreak","Streak")'));
  // Today (2026-10-06): "You — today" with today's vertical, chutes, runs, lifts and no streak
  assert.ok(/<h3>You — today<\/h3>/.test(lb) && lb.includes('mini("vertToday","Vertical")+mini("lbChutesToday","Chutes","lbChutes")+mini("lbRunsToday","Runs")+mini("liftTodayN","Lifts","lbLifts")'));
  assert.ok(/lbChutes"\)\.onclick=\(\)=>renderYourChutes\(mode\)/.test(rq) && /lbLifts"\)\.onclick=\(\)=>renderLifts\(mode\)/.test(rq), "opens on the same Today / Season");
  // Your chutes + Lift rides open from that box, not Home tiles, and come back to the Leaderboard
  assert.ok(!/btnChutes|btnLifts/.test(home), "no Home tiles");

  assert.ok(/chBack"\)\.onclick=\(\)=>renderLeaderboard\(\)/.test(rq) && /tlBack"\)\.onclick=\(\)=>renderLeaderboard\(\)/.test(rq));
  assert.ok(lb.indexOf('id="lbYou"') < lb.indexOf('id="lbList"'), "above the board");
  assert.ok(/refreshStats\(s\.player\.id\)/.test(lb), "filled on open");
  const rs = rq.slice(rq.indexOf("async function refreshStats(playerId){"), rq.indexOf("async function refreshClimbTiles("));
  assert.ok(rs.includes('if(!document.getElementById("chutesTodayNum") && !document.getElementById("lbChutesToday") && !streakEl) return;'), "fills the Leaderboard too");
  assert.ok(rs.includes('[["lbRunsToday","daily"],["lbRunsSeason","season"]]') && rs.includes('"/skiruns/"+span') && rs.includes('nOfTotal((j.runs||[]).length, "run")'), "Runs n/total from the runs-skied endpoint");
  assert.ok(rs.includes('el.textContent = nOfTotal((j.chutes||[]).length, "chute");') && rq.includes('el.textContent=nOfTotal(Quest.skiedToday.size, "chute");'), "Chutes n/total, today and season");
  // the pure formatter: different lines skied, of the map's lines of that type (no type = a run)
  const src = rq.slice(rq.indexOf("function nOfTotal(n, runType){"), rq.indexOf("function paintLbChutesToday(){"));
  // eslint-disable-next-line no-new-func
  const nOfTotal = new Function("Quest", src + "\nreturn nOfTotal;")({ corridors: [{ runType: "chute" }, { runType: "chute" }, { runType: "run" }, {}, { runType: "lift" }] });
  assert.deepStrictEqual([nOfTotal(1, "chute"), nOfTotal(2, "run"), nOfTotal(0, "run")], ["1/2", "2/2", "0/2"]);
  assert.strictEqual(new Function("Quest", src + "\nreturn nOfTotal;")({ corridors: [] })(3, "run"), "3", "no map loaded yet: just the count");
  // Test Mode's 🏆 box is the same row, same formats (Gary: "test and phone should be exact same")
  const fe = fs.readFileSync(path.join(__dirname, "../frontend/fence-editor.html"), "utf8");
  assert.ok(fe.includes('cell(Math.round(t.verticalM)+"m","Vertical")') && fe.includes('cell(t.chutes+"/"+t.chutesTotal,"Chutes")+cell(t.runsSkied+"/"+t.runsTotal,"Runs")+cell(t.liftRides,"Lifts")'), "Vertical Nm, then Chutes n/total · Runs n/total · Lifts");
  // phone layout: Vertical on its own line, the counts under it (five cells in one row overlapped at 390 px)
  assert.ok(rq.includes("#lbYou .stripRow .m:first-child{grid-column:1/-1}") && rq.includes('<div class="stripRow" style="--n:3">') && rq.includes('<div class="stripRow" style="--n:4">'));
  // the endpoint: ski descents that are not chutes, same aggregation and day/season buckets as the chute counts
  const wk = fs.readFileSync(path.join(__dirname, "../backend/worker.js"), "utf8");
  assert.ok(wk.includes("activity='ski' AND (run_type IS NULL OR run_type NOT IN ('chute','lift','hike'))") && /skiruns\\\/\(daily\|season\)\$/.test(wk), "GET /api/players/:id/skiruns/daily|season");
  assert.ok(/aggregateChuteCounts\(results \|\| \[\], daily \? questDateBucket : questSeasonId, key\)/.test(wk) && /P\.playerId !== decodeURIComponent\(mpsr\[1\]\)/.test(wk), "own rows only");
});

test("a failed render is never saved as the picture", async () => {
  const store = {};
  global.localStorage = { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } };
  global.document = { hidden: false };
  H.state.lastAt = 0;
  assert.strictEqual(await H.refresh("p2", "first", async () => null, "2026-12-01"), "failed");
  assert.strictEqual(store["rq.hero.v2.p2"], undefined, "nothing cached, so the next Home open tries again");
  delete global.document; delete global.localStorage;
});

// 2026-10-06: "for todays runs on home screen create a scroll window so account information will
// never be pushed off bottom of screen. make it max size yet keep account info button at bottom"
test("today's runs scroll in their own box sized to the screen; Account stays at the bottom", () => {
  assert.ok(/#todayRuns, \[data-fitlist\]\{overflow-y:auto;/.test(rq), "the list scrolls on its own");
  const f = rq.slice(rq.indexOf("function sizeRunList(){"), rq.indexOf("function renderHome(){"));
  assert.ok(/window\.innerHeight - top - acctH - 12/.test(f) && /list\.style\.maxHeight = Math\.max\(RUNLIST_MIN_PX, avail\)/.test(f), "fills the space down to Account");
  assert.ok(/const RUNLIST_MIN_PX = 140;/.test(f), "function-local: renderHome may run before a top-level const is initialised");
  assert.ok(/details\.acct\{[^}]*\n?\s*position:sticky;bottom:0;/.test(rq), "Account pinned to the bottom even on a short phone");
  const home = rq.slice(rq.indexOf("function renderHome(){"), rq.indexOf("// The rider's own chute names (cached copy"));
  assert.ok(/sizeRunList\(\);/.test(home) && /new ResizeObserver\(\(\)=>sizeRunList\(\)\)/.test(home), "sized on render and when anything above changes");
  assert.ok(/addEventListener\("resize", \(\)=>\{ sizeRunList\(\); sizeScreenList\(\); \}\)/.test(rq), "and on resize");
});

// 2026-10-06: "redraw after each chute is complete. also replace points on home screen with runs.
// the home screen should only show todays vertical, chutes, runs, lift rides."
test("Home shows only Vertical, Chutes, Runs, Lift rides (no points)", () => {
  const home = rq.slice(rq.indexOf("function renderHome(){"), rq.indexOf("// The rider's own chute names (cached copy"));
  assert.ok(/<div class="heroStats">'\s*\+hs\("vertToday","Vertical","ice"\)\+hs\("chutesTodayNum","Chutes","gold"\)\+hs\("runsTodayN","Runs"\)\+hs\("liftTodayN","Lift rides"\)\s*\+'<\/div>'/.test(home));
  assert.ok(!/ptsToday|Points/.test(home), "no points on Home");
  const rr = rq.slice(rq.indexOf("async function refreshRuns(playerId){"), rq.indexOf("async function refreshStats("));
  assert.ok(/todays\.filter\(r=>r\.activity==="ski" && r\.run_type!=="chute"\)\.length/.test(rr), "runs = today's ski runs that aren't chutes");
});

test("the picture redraws after each chute (and a chute finished mid-render isn't lost)", async () => {
  assert.ok(/if\(skiedChute && this\.onChuteComplete\) this\.onChuteComplete\(\);/.test(rq), "fired from _celebrate for a skied chute only");
  assert.ok(/Quest\.onChuteComplete = \(\)=>\{ heroRefresh\(getSession\(\), "chute"\); \};/.test(rq));
  const store = {};
  global.localStorage = { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } };
  global.document = { hidden: false };
  H.state.lastAt = 0;
  let renders = 0, release;
  const canvas = { toDataURL: () => "data:image/jpeg;base64,x" };
  const slow = () => { renders++; return new Promise(r => { release = () => r(canvas); }); };
  const first = H.refresh("p3", "chute", slow, "2026-12-01");
  assert.strictEqual(await H.refresh("p3", "chute", async () => { renders++; return canvas; }, "2026-12-01"), "busy");
  release(); assert.strictEqual(await first, "done");
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(renders, 2, "the second chute's redraw ran after the first finished");
  assert.strictEqual(JSON.parse(store["rq.hero.v2.p3"]).reason, "chute");
  assert.strictEqual(await H.refresh("p3", "chute", async () => canvas, "2026-12-01"), "done", "chutes are not rate-limited");
  delete global.document; delete global.localStorage;
});

// 2026-10-06: "on the leader board remove all and ski. the today and season button should be enough.
// make a scrolling window like on home screen so chutes and runs dont push the back button off"
test("Leaderboard: Today / Season only; the board, Your chutes and Lift rides scroll with Back pinned", () => {
  const lb = rq.slice(rq.indexOf("async function renderLeaderboard(mode){"), rq.indexOf("/* ============================ YOUR CHUTES"));
  assert.ok(!/data-act|QUEST_ACTIVITIES/.test(lb) && /const j = await api\(base\);/.test(lb), "no All / Ski buttons, combined board only");
  assert.ok(/id="lbDailyBtn"/.test(lb) && /id="lbSeasonBtn"/.test(lb));
  ["lbList", "chList", "tlList"].forEach(id => assert.ok(new RegExp('id="' + id + '" data-fitlist').test(rq), id + " is a scroll box"));
  ["lbBack", "chBack", "tlBack"].forEach(id => assert.ok(new RegExp('class="ghost stickyBack" id="' + id + '"').test(rq), id + " pinned"));
  assert.ok(/button\.ghost\.stickyBack\{position:sticky;bottom:0;/.test(rq));
  assert.ok((rq.match(/\n  sizeScreenList\(\);/g) || []).length >= 3, "sized when each screen draws");
  const f = rq.slice(rq.indexOf("function sizeScreenList(){"), rq.indexOf("function renderHome(){"));
  assert.ok(/card\.bottom - r\.bottom/.test(f) && /window\.innerHeight - top - after - 12/.test(f), "fills down to what follows it");
});
