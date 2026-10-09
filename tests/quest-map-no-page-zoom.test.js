// My map never zooms the PAGE (2026-10-09, Gary: "at times the on screen button get panned off the screen
// leaving part or no on screen buttons"). A pinch or double-tap that started on a map button zoomed the whole
// page and the browser panned the buttons away; the map canvas itself was never affected (MapLibre owns it).
// Run: `node --test tests/quest-map-no-page-zoom.test.js` (or the full suite).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const rq = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8").replace(/\r/g, "");
const rule = sel => { const m = rq.match(new RegExp("\\n\\s*" + sel.replace(/[.#]/g, "\\$&") + "\\{([^}]*)\\}")); return m ? m[1] : ""; };

test("the map screen takes no page zoom or pan; the info panel still scrolls up and down", () => {
  assert.ok(/touch-action:none/.test(rule(".fogMapOverlay")), "overlay");
  assert.ok(/overflow-y:auto/.test(rule(".mapInfo")) && /touch-action:pan-y/.test(rule(".mapInfo")), "info panel");
});

test("arriving already zoomed is not a trap: the page pinch stays on, map held, until back to normal size", () => {
  assert.ok(/touch-action:auto/.test(rule(".fogMapOverlay.pageZoomed")));
  assert.ok(/pointer-events:none/.test(rule(".fogMapOverlay.pageZoomed #fogMap")));
  const src = rq.slice(rq.indexOf("function watchPageZoom(){"), rq.indexOf("function renderFogMap(){"));
  // Run the real function against a fake page.
  const run = scale => {
    const cls = new Set(), toasts = []; let onResize = null;
    const vv = { scale, addEventListener: (ev, f) => { if (ev === "resize") onResize = f; }, removeEventListener: (ev, f) => { if (onResize === f) onResize = null; } };
    const ov = { classList: { toggle: (c, on) => { on ? cls.add(c) : cls.delete(c); } } };
    const unwatch = new Function("window", "document", "rqToast", src + "; return watchPageZoom();")(
      { visualViewport: vv }, { querySelector: () => ov }, m => toasts.push(m));
    return { cls, toasts, vv, resize: () => onResize && onResize(), unwatch, watching: () => !!onResize };
  };
  const normal = run(1);
  assert.ok(!normal.cls.has("pageZoomed") && normal.toasts.length === 0, "normal size: locked, nothing said");
  const z = run(2.4);
  assert.ok(z.cls.has("pageZoomed") && z.toasts.length === 1, "zoomed: page pinch left on, rider told");
  z.vv.scale = 1.8; z.resize();
  assert.ok(z.cls.has("pageZoomed") && z.toasts.length === 1, "told once");
  z.vv.scale = 1; z.resize();
  assert.ok(!z.cls.has("pageZoomed"), "back to normal size: locked again");
  z.unwatch();
  assert.ok(!z.watching(), "Back stops watching");
});

test("both map screens watch, and Back stops it", () => {
  const fm = rq.slice(rq.indexOf("function renderFogMap(){"), rq.indexOf("function renderFogMap(){") + 6000);
  assert.strictEqual((fm.match(/ = watchPageZoom\(\)/g) || []).length, 2);
  assert.ok(/onclick=\(\)=>\{ unwatch\(\);/.test(fm) && /onclick=\(\)=>\{\n\s*unwatchPageZoom\(\);/.test(fm));
});
