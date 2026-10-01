// Ridge Quest "Social media export" (frontend/social-card.js, 2026-09-30): the test day, the card
// layouts (against a recording fake 2D canvas), the PNG metadata, and the page wiring.
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
  assert.strictEqual(d.runs, 20, "one descent after every lift ride");
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
      "BOOT PACKS · 229 M", "RUNS", "CHUTES", "LIFT RIDES", "Ridge Quest", "LIVE TO SKI. SKI TO LIVE.", "24 cm fresh", "-8°C", "points"]) {
      assert.ok(all.includes(want), "shows " + want + " -- got: " + all);
    }
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

test("PNG metadata: valid iTXt chunks after IHDR, readable back, CRC correct", () => {
  // minimal 1x1 PNG
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082", "hex");
  const meta = SC.meta(SC.testDay(cors));
  const out = SC.pngWithText(new Uint8Array(png), meta);
  assert.deepStrictEqual(Array.from(out.subarray(0, 33)), Array.from(png.subarray(0, 33)), "signature + IHDR untouched");
  const back = SC.readText(out);
  for (const k of ["Title", "Description", "Author", "Creation Time", "Software", "Location", "Copyright"]) {
    assert.ok(back[k], "has " + k);
    assert.strictEqual(back["_crcOk_" + k], true, k + " CRC");
  }
  assert.ok(/14,479 m vertical/.test(back.Description) && /Golden Eagle Express Gondola x10/.test(back.Description) && /3 boot packs, 229 m climbed/.test(back.Description), back.Description);
  assert.strictEqual(back.Software, "Ridge Quest");
  assert.strictEqual(SC.crc32(new TextEncoder().encode("IEND")), 0xae426082, "crc32 matches PNG's own IEND CRC");
});

const rq = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");
const fe = fs.readFileSync(path.join(__dirname, "../frontend/fence-editor.html"), "utf8");
test("Ridge Quest: Social media export button, guard log kept as a small link, two-tap share", () => {
  assert.ok(rq.includes('<script src="/social-card.js"></script>'));
  assert.ok(/id="btnSocial"[^>]*>📸 Social media export</.test(rq));
  assert.ok(/id="btnExportCgLog"[^>]*>guard log</.test(rq) && /btnExportCgLog"\)\.onclick=\(e\)=>\{ e\.preventDefault\(\); exportCgLog\(\); \}/.test(rq), "guard log still exports");
  const s = rq.indexOf("async function renderSocialExport(){"), body = rq.slice(s, rq.indexOf("async function renderYourChutes(mode){"));
  assert.ok(/SocialCard\.make\(/.test(body) && /SocialCard\.shareOrSave\(/.test(body));
  assert.ok(body.indexOf('$("seMake").onclick') < body.indexOf('$("seShare").onclick'), "make, then share on a second tap");
  assert.ok(!/SocialCard\.shareOrSave\([^)]*\)[\s\S]{0,40}\$\("seMake"\)/.test(body));
});
test("Fence Editor: 📸 Social test screen renders all 4 images from test data", () => {
  assert.ok(fe.includes('<script src="/social-card.js"></script>'));
  assert.ok(/id="socialTestBtn"[^>]*>📸 Social</.test(fe) && /id="socialTestOverlay"/.test(fe));
  assert.ok(/SocialCard\.testDay\(cors/.test(fe) && /SocialCard\.testSeason\(cors/.test(fe));
  assert.ok(/\[\[day,"story"\],\[day,"wide"\],\[season,"story"\],\[season,"wide"\]\]/.test(fe));
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
  const r = await box.SocialCard.shareOrSave(new Blob([new Uint8Array([1, 2])], { type: "image/png" }), "x.png");
  assert.strictEqual(r, "shared");
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(Object.keys(calls[0]), ["files"], "only the file -- no title or text");
  assert.strictEqual(calls[0].files[0].name, "x.png");
  assert.ok(!/shareOrSave\(made\.blob, made\.filename, /.test(rq), "Ridge Quest passes no share text");
});
