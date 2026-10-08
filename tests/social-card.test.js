// Ridge Quest "Social media export" (frontend/social-card.js, 2026-09-30): the test day, the card
// layouts (against a recording fake 2D canvas), the JPEG/EXIF metadata, and the page wiring.
//
// Run: `node --test tests/social-card.test.js`
"use strict";
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const src = fs.readFileSync(path.join(__dirname, "../frontend/social-card.js"), "utf8");
const sandbox = {};
// eslint-disable-next-line no-new-func
new Function("window", "globalThis", src)(sandbox, sandbox);
const SC = sandbox.SocialCard;

// A small Kicking Horse-like project: lifts drawn bottom-to-top (as in the real library).
const L = (lat, lon) => [lat, lon];
const cors = [
  { zoneId: "gondola", name: "Golden Eagle Express Gondi", runType: "lift", path: [L(51.297, -117.048), L(51.275, -117.078)], descentM: 0, climbM: 1068 },
  { zoneId: "stairway", name: "Stairway Chair", runType: "lift", path: [L(51.276, -117.074), L(51.283, -117.090)], descentM: 3, climbM: 357 },
  { zoneId: "t1", name: "T1 Hike", runType: "hike", path: [L(51.275, -117.078), L(51.274, -117.080)], descentM: 0, climbM: 95 },
  { zoneId: "guts", name: "Guts Hike", runType: "hike", path: [L(51.283, -117.090), L(51.284, -117.091)], descentM: 0, climbM: 73 },
  { zoneId: "midle", name: "Midle Ridge Hike", runType: "hike", path: [L(51.280, -117.085), L(51.281, -117.087)], descentM: 2, climbM: 61 },
  { zoneId: "bear", name: "Bear Chute", runType: "chute", difficulty: "double-black", path: [L(51.276, -117.079), L(51.279, -117.076)], descentM: 200, climbM: 0 },
  { zoneId: "gift", name: "Gift Horse", runType: "chute", difficulty: "double-black", path: [L(51.283, -117.089), L(51.281, -117.087)], descentM: 166, climbM: 0 },
  { zoneId: "pine", name: "Pine Tree", runType: "chute", difficulty: "black", path: [L(51.273, -117.074), L(51.274, -117.075)], descentM: 65, climbM: 0 },
  { zoneId: "cloud9", name: "Cloud 9", runType: "run", difficulty: "blue", path: [L(51.276, -117.090), L(51.280, -117.080)], descentM: 300, climbM: 0 },
  { zoneId: "easy", name: "Its a 10", runType: "run", difficulty: "green", path: [L(51.278, -117.080), L(51.290, -117.060)], descentM: 600, climbM: 0 }
];
const ids = new Set(cors.map(c => c.zoneId));

test("the test day is 10 gondola + 10 Stairway rides and 3 boot packs, from real corridors", () => {
  const d = SC.testDay(cors);
  assert.deepStrictEqual(d.lifts.map(l => [l.name, l.count]), [["Golden Eagle Express Gondola", 10], ["Stairway Chair", 10]]);
  assert.strictEqual(d.liftRides, 20);
  assert.strictEqual(d.bootPacks.count, 3);
  assert.deepStrictEqual(d.bootPacks.routes.map(r => [r.name, r.verticalM]), [["T1 Hike", 95], ["Guts Hike", 73], ["Midle Ridge Hike", 61]]);
  assert.strictEqual(d.verticalM, 10 * 1068 + 10 * 357 + 229, "total vertical = lifts + boot packs = 14,479 m");
  // 20 descents (one after every lift ride); Runs counts only the ones that are not chutes (2026-10-08).
  assert.strictEqual(d.runs + d.chutes.reduce((s, c) => s + c.count, 0), 20, "one descent after every lift ride");
  assert.ok(d.chutes.every(c => ids.has(c.zoneId)), "chutes are real corridors");
  assert.ok(d.chutes.length >= 1 && d.points > 0 && d.weather && d.season);
  assert.ok(d.geo.track.length === 23 && d.geo.lifts.length === 2 && d.geo.bootPacks.length === 3, "geometry for the map");
  assert.deepStrictEqual(SC.testDay(cors), SC.testDay(cors), "deterministic for a given seed");
  const s = SC.testSeason(cors);
  assert.strictEqual(s.kind, "season");
  assert.ok(s.days === 38 && s.verticalM > d.verticalM && s.liftRides > d.liftRides);
});

// A fake 2D canvas that records every text draw.
function fakeCtx(w, h) {
  const texts = [];
  let font = "10px x";
  const grad = { addColorStop() {} };
  const ctx = new Proxy({
    get font() { return font; }, set font(v) { font = v; },
    measureText(t) { const px = +((font.match(/(\d+)px/) || [0, 10])[1]); return { width: String(t).length * px * 0.5 }; },
    fillText(t, x, y) { texts.push({ t: String(t), x, y, font, align: ctx.textAlign }); },
    createLinearGradient() { return grad; }, createRadialGradient() { return grad; }
  }, {
    get(target, k) { if (k in target) return target[k]; return target[k] = typeof k === "string" && /^[a-z]/.test(k) && !/Style|Width|Align|Baseline|shadow/.test(k) ? () => {} : undefined; },
    set(target, k, v) { target[k] = v; return true; }
  });
  return { ctx, texts, w, h };
}
function drawn(data, format) {
  const F = SC.FORMATS[format], f = fakeCtx(F.w, F.h);
  SC.draw(f.ctx, data, format, null);
  return f;
}

for (const format of ["story", "wide"]) {
  test("the " + format + " Today card shows the day's data, inside the frame, never speed or turns", () => {
    const d = SC.testDay(cors, { date: new Date("2026-02-14T18:00:00Z") });
    const f = drawn(d, format);
    const all = f.texts.map(x => x.t).join(" | ");
    for (const want of ["14,479", "VERTICAL TODAY", "KICKING HORSE", "lifts + boot packs", "Golden Eagle Express Gondola ×10", "Stairway Chair ×10",
      "RUNS", "CHUTES", "LIFT RIDES", "POINTS", "Ridge Quest", "LIVE TO SKI. SKI TO LIVE.", "24 cm fresh", "-8°C"]) {
      assert.ok(all.includes(want), "shows " + want + " -- got: " + all);
    }
    // 2026-10-06: boot packs only feed the vertical — no boot pack numbers on the image
    assert.ok(!/BOOT PACKS ·|boot packs ·|\bclimbed\b/i.test(all), "no boot pack stats: " + all);
    assert.ok(/SATURDAY, FEBRUARY 14|FEBRUARY 14/.test(all), "the date");
    if (format === "story") assert.ok(all.includes("Season so far"), "season line on the day story");
    assert.ok(!/speed|m\/s|km\/h|\bturns?\b/i.test(all), "never speed or turn counts: " + all);
    f.texts.forEach(x => {
      const px = +((x.font.match(/(\d+)px/) || [0, 10])[1]);
      const width = x.t.length * px * 0.5;
      const left = x.align === "right" ? x.x - width : x.align === "center" ? x.x - width / 2 : x.x;
      assert.ok(left >= -1 && left + width <= f.w + 1 && x.y > 0 && x.y <= f.h, "inside the frame: " + JSON.stringify(x));
    });
  });
  test("the " + format + " Season card shows the season", () => {
    const f = drawn(SC.testSeason(cors), format);
    const all = f.texts.map(x => x.t).join(" | ");
    for (const want of ["MY SEASON", "VERTICAL THIS SEASON", "DAYS ON THE HILL", "LIFT RIDES", "Ridge Quest"]) assert.ok(all.includes(want), "shows " + want);
    assert.ok(!/speed|m\/s|km\/h|\bturns?\b/i.test(all));
  });
}

test("difficulty marks are drawn on the chutes chip and list", () => {
  const d = SC.testDay(cors), F = SC.FORMATS.story, f = fakeCtx(F.w, F.h);
  let paths = 0; f.ctx.moveTo = () => { paths++; };
  SC.draw(f.ctx, d, "story", null);
  assert.ok(paths > 10, "diamond shapes drawn");
});

// 2026-10-01: WhatsApp didn't take the PNG; the export is now a JPEG photo with EXIF metadata.
test("JPEG + EXIF: stats, artist, date, software and GPS are written and read back", () => {
  // a tiny JFIF-style JPEG: SOI, APP0 (JFIF), then a stand-in for the rest, EOI
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const jpg = new Uint8Array([0xff, 0xd8, ...app0, 0xff, 0xdb, 0x00, 0x03, 0x00, 0xff, 0xd9]);
  const meta = SC.meta(SC.testDay(cors));
  const out = SC.jpegWithExif(jpg, meta);
  assert.deepStrictEqual(Array.from(out.subarray(0, 20)), Array.from(jpg.subarray(0, 20)), "SOI + JFIF kept first");
  assert.deepStrictEqual(Array.from(out.subarray(out.length - 7)), Array.from(jpg.subarray(jpg.length - 7)), "the image data after it is untouched");
  const x = SC.readExif(out);
  assert.strictEqual(x._segmentStart, 20, "EXIF right after the JFIF header");
  assert.ok(/14,479 m vertical/.test(x.ImageDescription) && /Golden Eagle Express Gondola x10/.test(x.ImageDescription), x.ImageDescription);
  assert.ok(!/boot packs, \d/.test(x.ImageDescription), "no boot pack stats in the photo data either (2026-10-06): " + x.ImageDescription);
  assert.ok(/^[\x20-\x7e]*$/.test(x.ImageDescription), "EXIF ASCII only");
  assert.strictEqual(x.Make, "Ridge Quest");
  assert.strictEqual(x.Software, "Ridge Quest");
  assert.strictEqual(x.Artist, "Gary J.");
  assert.ok(/^\(c\) \d{4} Gary J\.$/.test(x.Copyright), x.Copyright);
  assert.ok(/^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d$/.test(x.DateTime) && x.DateTimeOriginal === x.DateTime);
  assert.strictEqual(x.GPSLatitudeRef, "N"); assert.strictEqual(x.GPSLongitudeRef, "W");
  assert.ok(Math.abs(x.GPSLatitude - 51.276) < 0.001 && Math.abs(x.GPSLongitude - 117.079) < 0.001, "Kicking Horse summit");
  assert.ok(/"image\/jpeg", 0\.92/.test(src) && /\.jpg";/.test(src) && /type: "image\/jpeg"/.test(src), "made, named and shared as a JPEG");
});

const rq = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");
const fe = fs.readFileSync(path.join(__dirname, "../frontend/fence-editor.html"), "utf8");
test("Ridge Quest: Social media export button, guard log kept as a small link, two-tap share", () => {
  assert.ok(rq.includes('<script src="/social-card.js"></script>'));
  assert.ok(/tile\("btnSocial","📸","Social export"\)/.test(rq), "Home tile (2026-10-06 grid)");
  assert.ok(/id="btnExportCgLog"[^>]*>guard log</.test(rq) && /btnExportCgLog"\)\.onclick=\(e\)=>\{ e\.preventDefault\(\); exportCgLog\(\); \}/.test(rq), "guard log still exports");
  const s = rq.indexOf("async function renderSocialExport(){"), body = rq.slice(s, rq.indexOf("async function renderYourChutes(mode){"));
  assert.ok(/SocialCard\.make\(/.test(body) && /SocialCard\.shareOrSave\(/.test(body));
  assert.ok(body.indexOf('$("seMake").onclick') < body.indexOf('$("seShare").onclick'), "make, then share on a second tap");
  assert.ok(!/SocialCard\.shareOrSave\([^)]*\)[\s\S]{0,40}\$\("seMake"\)/.test(body));
});
test("Fence Editor: 📸 Social test screen renders all 4 images from test data", () => {
  assert.ok(fe.includes('<script src="/social-card.js"></script>'));
  assert.ok(/id="socialTestBtn"[^>]*>📸 Social</.test(fe) && /id="socialTestOverlay"/.test(fe));
  // 2026-10-08 (Gary: "old test data for season ... needs to be flushed"): today only -- no season images, no "Season so far" line.
  assert.ok(/SocialCard\.testDay\(cors/.test(fe) && !/SocialCard\.testSeason\(/.test(fe));
  assert.ok(/const jobs=\[\[day,"story"\],\[day,"wide"\]\];/.test(fe) && /\{ season:null \}\)/.test(fe));
});

// 2026-10-01 field report: sharing to WhatsApp delivered no image. A share carrying title/text
// with the file lets WhatsApp take only the text, so the file goes on its own.
test("share sends the image on its own (no title / text), and downloads when sharing isn't possible", async () => {
  const calls = [];
  const env = {
    navigator: { canShare: () => true, share: async o => { calls.push(o); } },
    document: { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } }
  };
  const box = {};
  // eslint-disable-next-line no-new-func
  new Function("window", "globalThis", src)(Object.assign(box, env), box);
  global.File = global.File || class { constructor(parts, name, o) { this.name = name; this.type = o.type; } };
  const r = await box.SocialCard.shareOrSave(new Blob([new Uint8Array([1, 2])], { type: "image/jpeg" }), "x.jpg");
  assert.strictEqual(r, "shared");
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(Object.keys(calls[0]), ["files"], "only the file -- no title or text");
  assert.strictEqual(calls[0].files[0].name, "x.jpg");
  assert.strictEqual(calls[0].files[0].type, "image/jpeg", "shared as a photo");
  assert.ok(!/shareOrSave\(made\.blob, made\.filename, /.test(rq), "Ridge Quest passes no share text");
});

// 2026-10-01 field report "mountains are not same": a rider with nothing logged yet had no lines
// to frame the map on, so the phone export fell back to drawn mountain art while the Fence Editor
// test screen showed the real 3D mountain. Every card now carries the resort network and the
// camera is framed on it, so both always show the same mountain from the same camera.
test("every card carries the resort network, and the hero is framed on it", () => {
  const day = SC.testDay(cors), season = SC.testSeason(cors);
  for (const d of [day, season]) {
    assert.strictEqual(d.geo.network.chutes.length, cors.filter(c => c.runType === "chute").length, "all chutes");
    assert.deepStrictEqual(d.geo.network.lifts.map(l => l.name), ["Golden Eagle Express Gondola", "Stairway Chair"], "lifts, biggest first");
  }
  const g = day.geo.network.lifts[0].path;
  assert.ok(g[0][1] > g[g.length - 1][1], "lift paths run bottom -> top (gondola base is north-east of its top)");
  const hero = src.slice(src.indexOf("function renderHeroMap("), src.indexOf("function drawFallbackHero("));
  assert.ok(/var net = geo\.network \|\| \{\};/.test(hero) && /\(net\.chutes && net\.chutes\.length\)/.test(hero), "framing comes from the network first");
  assert.ok(/geo\.network && geo\.network\.lifts && geo\.network\.lifts\[0\]/.test(src), "bearing from the resort's biggest lift");
  for (const fn of ["async function collectDay(", "async function collectSeason("]) {
    const body = src.slice(src.indexOf(fn), src.indexOf(fn) + 4000);
    assert.ok(/network: networkOf\(ctx\.corridors\)/.test(body), fn + " attaches the network");
  }
});

// 2026-10-01: "make room for as many as 20 chute names" -- two columns of 10 on the Story.
test("the Story fits 20 chute names (two columns), says how many more, and stays clear of the footer", () => {
  const d = SC.testDay(cors);
  const diffs = ["double-black", "black", "blue", "green"];
  d.chutes = Array.from({ length: 25 }, (_, i) => ({ name: "Chute Number " + (i + 1), difficulty: diffs[i % 4], count: 1 + (i % 3), zoneId: "c" + i }));
  d.chuteCount = 25;
  const f = drawn(d, "story");
  const names = f.texts.filter(x => /^Chute Number /.test(x.t));
  assert.strictEqual(names.length, 20, "20 names drawn");
  assert.ok(f.texts.some(x => /\+5 MORE/.test(x.t)), "says +5 more");
  const xs = new Set(names.map(n => Math.round(n.x / 100)));
  assert.ok(xs.size >= 2, "two columns");
  const season = f.texts.find(x => /^Season so far/.test(x.t));
  assert.ok(names.every(n => n.y < season.y - 30), "the list ends above the season line");
  assert.ok(names.every(n => n.y > f.texts.find(x => x.t === "LIFTS").y), "below the lifts");
  // hardest first on a day card
  assert.ok(/Chute Number (1|5|9|13|17|21|25)\b/.test(names[0].t), "a double-black first: " + names[0].t);
});

// 2026-10-01 iPhone screenshot: the map area was BLACK. MapLibre 5 only reads preserveDrawingBuffer
// inside canvasContextAttributes (the top-level option is ignored), so Safari cleared the frame
// before it was copied. Desktop Chrome hid the bug.
test("the hero map keeps its frame for copying on iPhone, copies inside a render, never ships black", () => {
  const hero = src.slice(src.indexOf("function renderHeroMap("), src.indexOf("function drawFallbackHero("));
  assert.ok(/canvasContextAttributes: \{ preserveDrawingBuffer: true/.test(hero), "MapLibre 5 option name");
  assert.ok(!/^\s*preserveDrawingBuffer: true,/m.test(hero), "no ignored top-level option left");
  assert.ok(/map\.once\("idle", function \(\) \{\s*map\.once\("render", function \(\) \{/.test(hero) && /map\.triggerRepaint\(\);/.test(hero), "copied inside a render event after idle");
  assert.ok(/if \(isBlank\(octx, w, h\)\) \{ clearTimeout\(timer\); finish\(null\); return; \}/.test(hero), "a black frame falls back to the mountain art");
  assert.ok(!/left:-30000px/.test(hero) && /opacity:0;z-index:-1/.test(hero), "rendered on-screen but invisible");
  // isBlank itself
  // eslint-disable-next-line no-new-func
  const isBlank = new Function("return " + src.slice(src.indexOf("function isBlank("), src.indexOf("// A drawn mountain when")))();
  const ctxOf = v => ({ getImageData: () => ({ data: [v, v, v, 255] }) });
  assert.strictEqual(isBlank(ctxOf(0), 100, 100), true);
  assert.strictEqual(isBlank(ctxOf(140), 100, 100), false);
});

// 2026-10-01: "facebook image needs to have chutes skied like the story" -- up to 12 names, 2 columns.
test("the Facebook image lists the chutes skied (2 columns, up to 12, +N more), inside the frame", () => {
  const d = SC.testDay(cors);
  const diffs = ["double-black", "black", "blue", "green"];
  d.chutes = Array.from({ length: 15 }, (_, i) => ({ name: "Chute Number " + (i + 1), difficulty: diffs[i % 4], count: 1 + (i % 2), zoneId: "c" + i }));
  d.chuteCount = 15;
  const f = drawn(d, "wide");
  const names = f.texts.filter(x => /^Chute Number /.test(x.t));
  assert.strictEqual(names.length, 12, "12 names on the Facebook image");
  assert.ok(f.texts.some(x => /\+3 MORE/.test(x.t)), "says +3 more");
  assert.ok(new Set(names.map(n => Math.round(n.x / 100))).size >= 2, "two columns");
  const brand = f.texts.find(x => x.t === "Ridge Quest");
  assert.ok(names.every(n => n.y < brand.y - 20 && n.x >= SC.FORMATS.wide.heroW - 30), "in the right column, above the logo");
  assert.ok(f.texts.some(x => /24 cm fresh/.test(x.t) && x.x < SC.FORMATS.wide.heroW), "weather over the map");
});

// 2026-10-01: WhatsApp on iPhone drops the image when you pick the WhatsApp icon and then a chat;
// picking the person in the share sheet's top row works. The export says so under the button.
test("the export tells riders how to send to WhatsApp", () => {
  assert.ok(/id="seTip"[^>]*>Sending on WhatsApp\? Tap the person in the top row of the share sheet\./.test(rq));
  const body = rq.slice(rq.indexOf("async function renderSocialExport(){"), rq.indexOf("async function renderYourChutes(mode){"));
  assert.ok(/\$\("seShare"\)\.style\.display=""; \$\("seTip"\)\.style\.display="";/.test(body), "shown with the Save / Share button");
});

// 2026-10-06: "make sure social media list of chutes and runs does not push ridge quest off bottom
// of screen" — the preview is sized to the screen (status + image + Save / Share) and scrolled to.
test("the social preview fits on one screen with Save / Share under it", () => {
  const rqh = require("fs").readFileSync(require("path").join(__dirname, "../frontend/ridge-quest.html"), "utf8").replace(/\r/g, "");
  const body = rqh.slice(rqh.indexOf("async function renderSocialExport(){"), rqh.indexOf("async function renderYourChutes(mode){"));
  assert.ok(/max-height:"\+socialPreviewMaxPx\(\)\+"px/.test(body) && !/max-height:60vh/.test(body));
  assert.ok(/el\.scrollIntoView\(\{ block:"start" \}\)/.test(body) && /if\(img\.complete\) toTop\(\); else img\.onload=toTop;/.test(body), "scrolled (once the image has its height) so it starts at the top");
  assert.ok(/function socialPreviewMaxPx\(\)\{\n  return Math\.max\(240, Math\.floor\(window\.innerHeight - 34 - 64 - 16\)\);/.test(rqh));
});

// 2026-10-07: "when making the multimedia simple graphics not map image is created in jolivet walk"
// — a map with no chutes or lifts had nothing to frame the picture on, so it fell to the drawn art.
test("a map without chutes or lifts still gets the real map, named after its own resort", async () => {
  const walk = [
    { zoneId: "a", name: "Street", runType: "run", path: [L(51.3028, -117.0548), L(51.3023, -117.0546)], descentM: 3 },
    { zoneId: "b", name: "Trail", runType: "hike", path: [L(51.3021, -117.0555), L(51.3028, -117.0557)], climbM: 5 }
  ];
  const api = async () => ({});
  const ctx = { playerId: "p", rider: "G", corridors: walk, track: [], dayKey: () => "d", today: "d", seasonId: "s", dateLabel: "x", seasonLabel: "y", resort: "jolivetTest", ref: [51.3024, -117.0551] };
  const day = await SC.collectDay(api, ctx), season = await SC.collectSeason(api, ctx);
  assert.strictEqual(day.resort, "jolivetTest");
  assert.strictEqual(season.resort, "jolivetTest");
  assert.strictEqual(day.geo.network.chutes.length, 0);
  assert.strictEqual(day.geo.network.others.length, 2, "its other lines are what the picture is framed on");
  assert.deepStrictEqual(Array.from(day.geo.ref), [51.3024, -117.0551]);
  assert.strictEqual((await SC.collectDay(api, Object.assign({}, ctx, { resort: "" }))).resort, "Kicking Horse", "older callers unchanged");
  const hero = src.slice(src.indexOf("function renderHeroMap(geo, w, h) {"), src.indexOf("// True when a copied map frame"));
  assert.ok(/if \(!focus\.length\) focus = \[\]\.concat\(net\.others \|\| \[\]\);/.test(hero), "other lines");
  assert.ok(/if \(!b && geo\.ref && \(geo\.ref\[0\] \|\| geo\.ref\[1\]\)\) b = /.test(hero), "then the project's centre");
  assert.ok(/data: fc\(noChutes \? \(net\.others \|\| \[\]\) : \[\]\)/.test(hero), "a ski map's picture is unchanged (other lines only drawn without chutes)");
  assert.ok(/zoom: Math\.min\(17, /.test(hero) && /finish\(null\); \}, 25000\);/.test(hero));
  const rq = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");
  assert.ok(/resort:\(\(getWorkspace\(\)\|\|\{\}\)\.appName\)\|\|"", ref:Quest\.ref\|\|null,/.test(rq));
  assert.ok(/Quest\.corridorsProject !== RQ_PROJECT_ID\)\{ try\{ await Quest\.loadCorridors\(\); \}catch\(e\)\{\} \}\s*const ctx=socialDayCtx\(s\);/.test(rq), "this map's runs are loaded before the image is made");
});
