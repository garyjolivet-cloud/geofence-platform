// The map's overlay buttons (Back, 3D/2D, recenter, 🔋, the yellow Guard button) sit on top of
// bright satellite imagery, so they must be SOLID with high-contrast text.
//
// They were unreadable because every one also carries the generic class "ghost"
// (`button.ghost{background:transparent;color:var(--ice)}`), and `button.ghost` out-ranks the
// single-class `.fogMapBack{background:var(--slate);color:var(--snow)}` rules — so the solid
// background and white text were silently overridden and the buttons rendered transparent with
// faint text. The Guard OFF state was also transparent by design.
//
// This reads the real CSS out of ridge-quest.html, resolves the colours, and computes the
// WCAG contrast ratio (translucent fills are blended over WHITE, the worst case for a dark fill
// on bright snow imagery).
//
// Run: `node --test tests/quest-button-contrast.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8").replace(/\r/g, "");
// Comments removed: a comment sitting right before a rule would otherwise be read as part of its selector.
const css = html.slice(html.indexOf("<style"), html.indexOf("</style>")).replace(/\/\*[\s\S]*?\*\//g, "");

// :root custom properties
const vars = {};
(css.match(/:root\s*\{([^}]*)\}/) || ["", ""])[1].split(";").forEach(d => {
  const m = d.match(/--([\w-]+)\s*:\s*(.+)/); if (m) vars[m[1]] = m[2].trim();
});

function parseColor(v) {
  v = (v || "").trim();
  let m = v.match(/^var\(--([\w-]+)\)$/); if (m) return parseColor(vars[m[1]]);
  if (v === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  m = v.match(/^#([0-9a-f]{3})$/i); if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
  m = v.match(/^#([0-9a-f]{6})$/i); if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 };
  m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/); if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  return null;
}
const over = (c, bg) => ({ r: c.r * c.a + bg.r * (1 - c.a), g: c.g * c.a + bg.g * (1 - c.a), b: c.b * c.a + bg.b * (1 - c.a), a: 1 });
const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };

// Find the LAST rule whose selector list contains `sel`, return its declarations as a map.
function ruleFor(sel) {
  const re = /([^{}]+)\{([^{}]*)\}/g; let m, found = null;
  while ((m = re.exec(css))) {
    const sels = m[1].split(",").map(s => s.trim());
    if (sels.includes(sel)) { const d = {}; m[2].split(";").forEach(x => { const i = x.indexOf(":"); if (i > 0) d[x.slice(0, i).trim()] = x.slice(i + 1).trim(); }); found = { d, sels }; }
  }
  return found;
}

const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const MIN = 7;   // WCAG AAA for normal text

// ---- the four plain overlay buttons ----
["fogMapBack", "fogMapTilt", "fogMapRecenter", "fogMapBattery"].forEach(cls => {
  const sel = "button." + cls;
  const r = ruleFor(sel);
  assert(!!r, sel + ": has a rule that out-ranks `button.ghost` (a bare ." + cls + " loses to it and renders transparent)");
  if (!r) return;
  const bg = parseColor(r.d.background), fg = parseColor(r.d.color);
  assert(bg && fg, sel + ": background and colour resolve to real colours (got " + r.d.background + " / " + r.d.color + ")");
  if (!bg || !fg) return;
  assert(bg.a >= 0.9, sel + ": the fill is (near) opaque, alpha " + bg.a + " — transparent over satellite imagery is what made these unreadable");
  const c = ratio(fg, over(bg, WHITE));
  assert(c >= MIN, sel + ": text contrast " + c.toFixed(1) + ":1 over the worst-case (white) imagery, need >= " + MIN);
});

// ---- the yellow Guard button, both states ----
(function testGuardButton() {
  const on = ruleFor(".guardBtn.on"), off = ruleFor(".guardBtn.off");
  [["ON", on], ["OFF", off]].forEach(([label, r]) => {
    assert(!!r, "Guard " + label + ": has a rule");
    if (!r) return;
    const bg = parseColor(r.d.background), fg = parseColor(r.d.color);
    assert(bg && bg.a >= 0.9, "Guard " + label + ": solid fill, never transparent (got " + r.d.background + ")");
    if (!bg || !fg) return;
    const c = ratio(fg, over(bg, WHITE));
    assert(c >= MIN, "Guard " + label + ": text contrast " + c.toFixed(1) + ":1, need >= " + MIN);
  });
})();

// ---- these buttons really do carry the class that caused the override ----
(function testStillNeedsTheOverride() {
  assert(/button\.ghost\s*\{[^}]*background:\s*transparent/.test(css),
    "button.ghost is still transparent — so the higher-specificity overrides above are still required");
  assert(/class="ghost fogMapBack"/.test(html) && /class="ghost fogMapBattery"/.test(html),
    "the map buttons still carry `ghost`");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
