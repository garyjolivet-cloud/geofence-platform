/* TileFog — the shared corridor line renderer (window.TileFog).
 *
 * The name is historical: this file used to be the "Artistic Fog-of-War Tiles" module too
 * (H3 hex terrain art, per-device fog reveal, corridor ribbons, /api/.../reveal-cells,
 * /api/tile-assets). That whole feature was REMOVED 2026-09-24 — it was off for every app that
 * had Ridge Quest enabled and nobody used it. What remains is the part every map uses:
 * how a corridor (run / chute / lift / hike) is drawn — width band, glow, casing, grade-coloured
 * core, lift line and towers — so Ridge Quest's My map, Fence Editor Test Mode, the engine and
 * the sim all look the same. One module rather than copies, to avoid the "verbatim mirror" bug
 * class (see kalman-filter.js's header).
 *
 * API (all pure or map-instance only; no network, no DOM):
 *   TileFog.addCorridorLayers(map, opts)   add the whole layer stack for a corridor source
 *   TileFog.bringCorridorLayersToFront(map)   re-assert corridor layers above later additions
 *   TileFog.corridorStyle(c) / corridorFeatureProps(latRef, meta)   per-feature colours + props
 *   TileFog.towerFeatures(corridor)        lift-tower dots for a lift corridor
 *   TileFog.pxPerMeterAtZ0(lat), realWidthExpr(opts), runW(a,b,c)   width helpers
 *   TileFog.CORRIDOR_LAYER_SUFFIXES        layer-id suffixes addCorridorLayers creates
 */
(function(global){

// Every layer-id prefix addCorridorLayers() has ever registered on a given
// map, so bringCorridorLayersToFront() (below) can re-assert corridor
// layers above whatever else got added later, without every caller having
// to know each other's layer ids.
const corridorLayerPrefixes = new Map();  // map -> Set<prefix>
const CORRIDOR_LAYER_SUFFIXES = ["-width", "-halo", "-casing", "-core", "-liftline", "-hot", "-tower", "-edge-l", "-edge-r"];

// Real-world-to-screen-pixel line width, exact at a given reference
// latitude: pixels-per-meter scales as exactly 2^zoom (Web Mercator), so an
// "exponential base 2" interpolation between a zoom-0 and zoom-20 anchor
// reproduces widthM*pxPerMeter(lat,z) exactly at every intermediate zoom —
// not an approximation. One reference latitude per corridor (its first
// point) is a deliberate simplification; error over a typical trail's
// latitude span is negligible at this app's zoom range (13-18, see
// CLAUDE.md's zoom-level survey).
function pxPerMeterAtZ0(lat){ return 1 / (156543.03392 * Math.cos(lat * Math.PI / 180)); }

// ===================================================================
// Shared corridor rendering (width band + piste-glow). Used by EVERY
// surface that draws a corridor: fence-editor (Edit map + Test Mode),
// geofence-engine, geofence-sim, ridge-quest, gpx-editor.
// One implementation here, per the "no verbatim mirror" rule this file
// already follows -- previously each surface styled corridors its own
// way (dashed coral line in the editors/sim, difficulty-coloured
// piste-glow with per-activity line-dasharray in ridge-quest, nothing
// at all in the engine). Now identical everywhere, and NO dashes.
// ===================================================================

// Grade -> core colour + glow colour + double-black "tier". A verbatim
// port of the old ridge-quest.html runStyleFor(), minus the dash.
// Callers pass { difficulty, activityType, runType }.
// black/double-black halo darkened from periwinkle/pink (#89b4ff/#ff6f91)
// to near-black -- confirmed live (2026-09) that once the halo layer was
// wide/opaque enough to actually be visible on mobile, a bright colour
// there reads as "the line is [that colour]" (a pink halo got reported as
// "red"), not as a subtle glow accent on a white core.
const RUN_STYLE_DIFF = {
  "green":        { col: "#57e06f", halo: "#22c246", tier: "" },
  "blue":         { col: "#6bb6ff", halo: "#2f86ff", tier: "" },
  "black":        { col: "#ffffff", halo: "#1a1a1a", tier: "black" },
  "double-black": { col: "#ffffff", halo: "#0d0d0d", tier: "dblack" },
  "":             { col: "#ffd166", halo: "#ffab1f", tier: "" }   // no difficulty set
};
const RUN_STYLE_ACT = {
  "xcountry":     { col: "#cbb0ff", halo: "#9a63ff" },
  "bike":         { col: "#ffab5e", halo: "#ff7a1a" },
  "walking_city": { col: "#bcd8ee", halo: "#79b3dc" },
  "hike":         { col: "#b3e37f", halo: "#63c23a" }
};
function corridorStyle(c){
  c = c || {};
  const act = c.activityType || (c.runType === "hike" ? "hike" : "");
  if(RUN_STYLE_ACT[act]){ const s = RUN_STYLE_ACT[act]; return { col: s.col, halo: s.halo, tier: "" }; }
  // Was a pale grey (#c2cec9/#8ea79c) -- confirmed live (2026-09) it all but
  // vanished against snow/satellite imagery, especially on a phone screen.
  // A dark charcoal-slate reads as "steel cable" while staying genuinely
  // visible against bright terrain.
  if(c.runType === "lift") return { col: "#3a4650", halo: "#1c2327", tier: "" };
  const d = RUN_STYLE_DIFF[c.difficulty || ""] || RUN_STYLE_DIFF[""];
  // Chutes used to force pure black (core AND halo) here regardless of
  // difficulty -- confirmed live (2026-09) this made every unselected chute
  // render as a flat black line instead of the normal difficulty-coloured
  // glow every other corridor gets. Reverted per direct feedback: chutes
  // should always look like a selected/highlighted run (coloured core +
  // halo), never solid black. `tier` still comes from difficulty so the
  // ◆/◆◆ badge and double-black tag keep working.
  return { col: d.col, halo: d.halo, tier: d.tier };
}

// Real-world-width `line-width` expression -- the exact Web-Mercator
// metres->pixels curve documented on tile-corridors-line below, factored
// out so the width band and the tile-art ribbon share ONE copy. A feature
// carries `widthM` (metres) and `pxPerMeterAtZ0` (from pxPerMeterAtZ0()).
// MUST stay ONE zoom-based interpolate subexpression -- never wrap the
// return value in another max()/interpolate (see the long note below).
//   floor:"ribbon" -> the textured ribbon's original visible floors
//   floor:"band"   -> gentler floors, for a translucent band that has a
//                     solid grade centre line drawn over it
// `band` floors briefly shrunk (2026-09) then restored to their original
// size after mobile visibility complaints -- see addCorridorLayers()'s own
// note on the halo/casing/core widths for the full story. `ribbon` (the
// tile-art texture ribbon) was never touched: its floors are already tuned
// to the minimum that still reads as a texture rather than "no path drawn"
// (see the long note on tile-corridors-line below).
const WIDTH_FLOORS = { ribbon: [1, 4, 10, 18, 30, 60, 120], band: [0, 4, 6, 8, 12, 20, 40] };
const WIDTH_STOPS  = [ [0, 1], [12, 4096], [16, 65536], [18, 262144], [20, 1048576], [22, 4194304], [24, 16777216] ];
function realWidthExpr(opts){
  opts = opts || {};
  const wp = opts.widthProp || "widthM";
  const pp = opts.pxProp || "pxPerMeterAtZ0";
  const floors = WIDTH_FLOORS[opts.floor] || WIDTH_FLOORS.ribbon;
  const expr = ["interpolate", ["exponential", 2], ["zoom"]];
  WIDTH_STOPS.forEach((s, i) => {
    const scaled = s[1] === 1
      ? ["*", ["get", wp], ["get", pp]]
      : ["*", ["get", wp], ["get", pp], s[1]];
    expr.push(s[0], ["max", scaled, floors[i]]);
  });
  return expr;
}

// Real-world-metre PERPENDICULAR OFFSET in pixels, same "one top-level
// interpolate, exact meter-to-pixel via pxPerMeterAtZ0" technique as
// realWidthExpr() above (see its own comment for why this must stay a
// single top-level zoom expression). Used for the Corridor Guard boundary
// lines below -- `edgeM` (half the corridor's real widthM, plus a small
// buffer) computed inline from the feature's own `widthM` property, not a
// separate feature property, since it's simple arithmetic on data already
// there. `edgeBufferM` mirrors chute-guard.js's TUNING.OUTSIDE_BUFFER_M
// (kept as a literal here, not imported -- these two files are
// deliberately decoupled, see chute-guard.js's own header comment) so the
// drawn line matches the actual distance the alarm triggers on, not just
// the corridor's nominal half-width.
//
// `sign` (1 or -1) flips which side this offsets to. Real bug found
// 2026-09-20 (field report: "only a border line on skier's right"): the
// first version of this always returned the POSITIVE expression, and the
// left-side caller wrapped it in `["*", -1, expr]` to flip it -- exactly
// the failure class realWidthExpr()'s own comment already documents
// elsewhere in this file (a zoom expression must be the SOLE top-level
// expression; wrapping ["interpolate",...,["zoom"],...] inside another
// operator like `*` makes MapLibre's addLayer() throw, silently caught by
// add()'s own try/catch, so the layer never gets created at all). Fixed by
// baking the sign into each interpolate STOP's value instead -- each
// stop's value is an ordinary data expression (no zoom inside it), so
// negating it there doesn't touch the outer interpolate's own top-level
// shape.
function realOffsetExpr(edgeBufferM, sign){
  sign = sign || 1;
  const pp = "pxPerMeterAtZ0";
  const edgeM = ["+", ["/", ["get", "widthM"], 2], edgeBufferM];
  const expr = ["interpolate", ["exponential", 2], ["zoom"]];
  WIDTH_STOPS.forEach(s => {
    const scaled = s[1] === 1 ? ["*", sign, edgeM, ["get", pp]] : ["*", sign, edgeM, ["get", pp], s[1]];
    expr.push(s[0], scaled);
  });
  return expr;
}

// Cosmetic (screen-pixel) glow widths ramped by zoom -- mirrors the old
// ridge-quest _runW(a,b,c) / fence-editor _simRunW(a,b,c).
function runW(a, b, c){ return ["interpolate", ["linear"], ["zoom"], 12, a, 15, b, 18, c]; }

// runW(), scaled up per runType. Lift and chute lines started out THINNER
// than a regular run (a lift's cable is a thin wire; a chute is a narrow
// feature) but confirmed live (2026-09) that thinner read as too faint to
// register against bright snow/satellite imagery, especially lift's pale
// grey and a black-difficulty chute's white core -- both wrongly
// disappeared instead of standing out, so both now render WIDER than a
// normal run instead.
//
// A previous version of this used ["case", cond, ["interpolate",...zoom],
// cond2, ["interpolate",...zoom], ["interpolate",...zoom]] -- three
// separate zoom-based interpolate expressions nested inside a case.
// Confirmed live (2026-09) this is EXACTLY the failure class this file's
// own realWidthExpr() comment already documents from an earlier bug: a
// zoom expression must be the sole top-level expression (or the value it's
// nested in must not itself be another operator), and addLayer() rejects
// an invalid expression by throwing -- caught by addCorridorLayers()'s own
// try/catch, so halo/casing/core silently failed to ever get added, with
// no visible error (only a console.warn easy to miss), while -width
// (single interpolate, valid) and -tower (no case-wrapped zoom expr) kept
// rendering fine. Same fix realWidthExpr() already uses successfully:
// ONE top-level interpolate, with the runType scale factor (itself a
// zoom-free case/data expression, fine to nest) multiplied into each
// stop's value instead of picking between separate interpolates.
// chute no longer gets its own multiplier -- per direct feedback, a chute
// should render at the same width as a regular run now that the base line
// is actually visible (the old 4x was compensating for chutes being
// invisible, not a real design intent). Its pure-black colour override in
// corridorStyle() stays -- this is a width-only change.
// Lift no longer goes through this graded width stack at all (see the
// dedicated "-liftline" layer in addCorridorLayers() below) and chute
// dropped its multiplier earlier -- so no runType still needs a scale here.
function runWByRunType(a, b, c){
  return ["interpolate", ["linear"], ["zoom"], 12, a, 15, b, 18, c];
}

// Add the shared corridor layer stack to `map`, reading from an existing
// GeoJSON source whose corridor features carry:
//   corridor:true, widthM:<metres>, pxPerMeterAtZ0:<pxPerMeterAtZ0(refLat)>,
//   col:<core colour>, halo:<glow colour>, tier:"" | "dblack"
// Layers bottom->top: width band, glow halo, dark casing, solid grade
// core, (lift only: a separate thin plain line instead of the above four),
// tower dots. `id` prefixes the layer names (so one map
// can host more than one corridor source); `before` is an optional
// beforeId. Idempotent -- safe to call again after a setStyle() wipe.
function addCorridorLayers(map, o){
  o = o || {};
  const src = o.source;
  const pfx = o.id || (src + "-c");
  const before = o.before;
  if(!src) return;
  if(map.getLayer(pfx + "-core")){
    // Already built (idempotent re-call, e.g. after a setStyle() wipe was
    // already recovered from elsewhere) -- still worth re-asserting z-order
    // below, in case something else got added on top since.
    bringCorridorLayersToFront(map);
    return;
  }
  // A corridor feature must be flagged AND carry a real widthM -- lets a
  // surface flag a corridor purely as a hit target (no widthM) without it
  // getting a band drawn (the Fence Editor does this in Test Mode, where
  // the Test-Mode runLines stack already draws the glow). Lift is excluded
  // here entirely -- it gets its own thin plain line below instead of the
  // width-band/halo/casing/core glow stack, which read as too bold/wide for
  // a lift cable per direct feedback.
  const only = ["all", ["==", ["get", "corridor"], true], ["has", "widthM"], ["!=", ["get", "runType"], "lift"]];
  const liftOnly = ["all", ["==", ["get", "corridor"], true], ["has", "widthM"], ["==", ["get", "runType"], "lift"]];
  // Corridor Guard "armed" state (press-and-hold to arm a chute, 2026-09-20):
  // a `guarded:true` feature property, set per-corridor by whichever host
  // page tracks its own runtime armed set (ridge-quest.html/fence-editor.html
  // Test Mode — see chute-guard.js's getActiveAlarm(isEligible)). Every other
  // caller simply never sets the property, so ["get","guarded"] reads
  // undefined/false and this is a no-op for them (geofence-engine.html/
  // geofence-sim.html unaffected). Bright color always wins over the normal
  // grade/activity color, but a caller's own explicit coreColor override
  // (e.g. the Fence Editor's selected-corridor green) still wins over THIS —
  // set below.
  const guardedExpr = ["==", ["get", "guarded"], true];
  const GUARD_COLOR = "#00e5ff";
  // Corridor Guard "muted" state (2026-09-23, ridge-quest.html): guarding is
  // on for EVERY run by default there, so highlighting guarded ones would light
  // up the whole map — instead only the ones a rider deliberately muted are
  // drawn differently (greyed). Same additive pattern as `guarded`: any caller
  // that never sets a `muted` property reads it as false and is unaffected.
  // `o.guardByState` (2026-09-23, ridge-quest.html): read `muted` from per-feature
  // STATE (map.setFeatureState) instead of a feature property, and skip the
  // line-offset boundary lines below (the host draws real-geometry ones). Changing
  // a GeoJSON property means source.setData(), which reloads and re-layouts every
  // tile of the source (and re-drapes it on 3D terrain) — a toggle then took
  // seconds on a phone. Feature-state is applied at paint time with no data reload.
  // Needs the source built with promoteId so features have ids. Opt-in: every other
  // caller keeps the property-based behaviour untouched.
  const stateMode = !!o.guardByState;
  const mutedExpr = stateMode ? ["boolean", ["feature-state", "muted"], false] : ["==", ["get", "muted"], true];
  const MUTED_COLOR = "#6b7a89";
  const rawCol  = ["coalesce", ["get", "col"], "#ff6a3d"];
  const rawHalo = ["coalesce", ["get", "halo"], rawCol];
  const col  = ["case", guardedExpr, GUARD_COLOR, mutedExpr, MUTED_COLOR, rawCol];
  const halo = ["case", guardedExpr, GUARD_COLOR, mutedExpr, MUTED_COLOR, rawHalo];
  // Optional core-colour override (e.g. the Fence Editor turns the selected
  // corridor's centre line green). Other surfaces just use the grade colour
  // (already guard-aware via `col` above).
  const coreCol = o.coreColor || col;
  const add = (def) => { try { map.addLayer(def, before); } catch(e){ console.warn("TileFog.addCorridorLayers:", def.id, e && e.message); } };
  // This band is the corridor's REAL declared width_m rendered true-to-scale
  // (e.g. a run whose library entry says 100m or 150m wide draws genuinely
  // that wide in real-world meters) -- confirmed live via a screenshot that
  // for corridors with a large widthM this dwarfs the ~20-30px casing/core
  // sitting on top of it, so what should read as "a thin black line" reads
  // instead as "a big pale wash," especially against light snow/rock. 0.20
  // opacity was already an attempt to keep it subtle; dropped further so it
  // stays a faint true-width tint rather than competing with the line.
  //
  // Real bug found 2026-09-19 (Fence Editor Test Mode, field report: exit/
  // re-entry crossings looked wildly asymmetric): the halo/casing/core
  // "piste-glow" drawn below is a FIXED, decorative pixel width per
  // runWByRunType() -- it has nothing to do with the corridor's actual
  // widthM. On a narrow corridor (a few meters), the glow's apparent width
  // on screen bears no relation to Corridor Guard's real edgeM threshold,
  // so a user judging "inside vs outside" by eye against the glow sees a
  // "safe zone" that doesn't match the math at all -- this band is the
  // ONLY thing that does, and at 7% opacity it's effectively invisible.
  // o.trueWidthOpacity lets a caller that needs precise visual testing
  // (Test Mode) override it; every other caller keeps the original faint
  // tint unchanged.
  add({ id: pfx + "-width", type: "line", source: src, filter: only,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": col, "line-opacity": o.trueWidthOpacity!=null ? o.trueWidthOpacity : 0.07, "line-blur": 0,
      "line-width": realWidthExpr({ floor: "band" }) } });
  // Widths went through several rounds live (2026-09): halved from this
  // file's original values for a less-oversized line, then that read as
  // too faint on a phone screen, so thickened well past the original --
  // darker/thicker was the explicit ask. Casing (the dark outline, the
  // main driver of "readable at a glance") carries that.
  //
  // The HALO's own width was a separate, uncaught bug through those same
  // rounds: it was already wider than casing in this file's original
  // pre-2026-09 numbers (8/14/22 vs casing's 3.5/6.5/10), and casing/core
  // grew much faster than halo across the widening rounds since only they
  // were runType-scaled for lift/chute -- so on a real device screenshot
  // the halo (bright, only lightly blurred, 0.85 opacity) was reading as a
  // solid, dominant colour FILL with the actual black casing/core reduced
  // to a thin stripe buried inside it -- "wide red/pink, not thin black."
  // A glow belongs just outside the casing's edge, not multiples of its
  // width: halo now tracks casing's own width (same runWByRunType scale,
  // so the ratio holds across lift/chute too) at a fixed ~1.35x, softer
  // blur, and much lower opacity so it reads as a fringe, not a fill.
  // Halved again (2026-09) once the runWByRunType() fix above actually made
  // these render for the first time in several rounds of "bigger" -- turns
  // out every one of those rounds was tuning a value that was silently
  // never being applied. Also: `line-width` is CSS pixels, and a phone
  // screenshot is taken at the device's native pixel ratio (3x on most
  // current iPhones) -- a 28px CSS halo shows up as ~84 raw pixels in the
  // screenshot, which reads as enormous compared to how it'd look on a 1x
  // desktop display at the "same" zoom. Sized down with that in mind.
  add({ id: pfx + "-halo", type: "line", source: src, filter: only,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": halo,
      // 2026-09-23: the glow must actually be SEEN. Once the width expression below
      // stopped being rejected the layer rendered, but at 5.5/9.5/14 px against a
      // 4/7/10.5 px casing it stuck out only 0.75-1.75 px per side, blurred, at 45%
      // opacity — invisible. Those numbers were tuned while the layer wasn't drawing
      // at all. Now ~4-6 px of soft colour beyond the black outline.
      "line-opacity": ["case", guardedExpr, 0.85, 0.6],
      "line-blur": ["case", guardedExpr, 4, 6],
      // ONE top-level zoom interpolate, with the guarded 1.4x multiplied into each
      // stop's value. This used to be ["case", guarded, ["*",1.4,interpolate], interpolate]:
      // two zoom curves in one expression, which MapLibre's validator rejects ("Only one
      // zoom-based step or interpolate subexpression may be used"). addLayer() then
      // threw, addCorridorLayers' try/catch swallowed it, and this halo layer silently
      // never rendered on any map. Same fix as realWidthExpr() above.
      "line-width": ["interpolate", ["linear"], ["zoom"],
        12, ["*", ["case", guardedExpr, 1.4, 1], 12],
        15, ["*", ["case", guardedExpr, 1.4, 1], 17],
        18, ["*", ["case", guardedExpr, 1.4, 1], 22]] } });
  add({ id: pfx + "-casing", type: "line", source: src, filter: only,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#05070b", "line-opacity": 1, "line-width": runWByRunType(4, 7, 10.5) } });
  add({ id: pfx + "-core", type: "line", source: src, filter: only,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": coreCol, "line-width": runWByRunType(2, 3.3, 4.8) } });
  // Corridor Guard boundary lines (2026-09-20, per explicit request): when a
  // corridor is armed ("guarded":true — see the press-and-hold feature in
  // ridge-quest.html/fence-editor.html Test Mode), draw the EXACT left/right
  // trigger edge as a solid, high-contrast line — not the decorative
  // piste-glow width band above, which has no relationship to Corridor
  // Guard's real edgeM threshold (a narrow corridor's glow is a fixed
  // cosmetic pixel width, per runWByRunType()'s own comment). `line-offset`
  // (perpendicular to the line, in pixels) computed via realOffsetExpr() so
  // this is the true edgeM = halfWidthM + OUTSIDE_BUFFER_M distance in real
  // metres at every zoom, the identical math chute-guard.js's tick() itself
  // uses to decide the tone. Filtered to guarded corridors only — an
  // unarmed corridor never sounds the alarm, so its boundary isn't relevant
  // to show. Bright yellow, solid (not dashed), deliberately distinct from
  // both the cyan "armed" halo/core color and the separate pink DASHED
  // diagnostic edge lines Test Mode already draws for every corridor
  // (`runLines-edge` in fence-editor.html) — that one stays as its own
  // always-on authoring diagnostic; this one is the rider-facing "you are
  // about to cross the line" marker for whichever corridor is actually
  // armed right now.
  // `guardEdges:true` (2026-09-23, ridge-quest.html) draws these lines WITHOUT
  // also recoloring the corridor cyan: Ridge Quest guards every run by default,
  // so `guarded` (cyan) would erase the grade colors everywhere, but the
  // boundary lines are exactly what a rider wants to see on every guarded run.
  // `guarded` still draws them too, so every other host is unchanged.
  const edgesExpr = ["any", guardedExpr, ["==", ["get", "guardEdges"], true]];
  const guardedAndAlertable = ["all", only, edgesExpr];
  // These two are the `line-offset` boundary lines: the centreline pushed sideways in
  // pixels. That shifts every vertex along its own normal, so on a wide corridor that
  // bends, the inside of each bend folds into loops and every kink grows a spike
  // ("any change in direction causes a weird line"). Hosts that opt into `guardByState`
  // (ridge-quest.html) draw the TRUE boundary from real geometry instead — see
  // frontend/guard-edge.js — so this offset version is skipped for them; every other
  // host (fence-editor Test Mode, the engine, the sim) keeps it unchanged.
  // `smoothEdges:true` (fence-editor Test Mode) opts out of the offset lines the same way, because
  // that host draws the smooth GuardEdge outline itself.
  if(!stateMode && !o.smoothEdges){
    // 0.5 mirrors chute-guard.js's TUNING.OUTSIDE_BUFFER_M. Two SEPARATE
    // interpolate expressions (sign baked in per-stop), not one expression
    // negated afterward — see realOffsetExpr()'s own comment for why.
    add({ id: pfx + "-edge-r", type: "line", source: src, filter: guardedAndAlertable,
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: { "line-color": "#ffe600", "line-opacity": 1, "line-width": runW(2, 2.6, 3.2), "line-offset": realOffsetExpr(0.5, 1) } });
    add({ id: pfx + "-edge-l", type: "line", source: src, filter: guardedAndAlertable,
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: { "line-color": "#ffe600", "line-opacity": 1, "line-width": runW(2, 2.6, 3.2), "line-offset": realOffsetExpr(0.5, -1) } });
  }
  // Lift: a single thin plain black line, no halo/casing/width-band glow --
  // the previous graded stack (scaled 1.5x wider than a normal run) read as
  // too bold for a lift cable per direct feedback. Towers (added below)
  // already mark the line's stations in grey.
  add({ id: pfx + "-liftline", type: "line", source: src, filter: liftOnly,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#111318", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1, 15, 1.6, 18, 2.2] } });
  // Double-black used to get a red (#ff5a5f) accent centre-line here on top
  // of everything else. Removed entirely (2026-09) -- confirmed live this
  // was the direct cause of a second "it's red, not black" report, this
  // time on a double-black RUN rather than a chute (excluding just chutes,
  // the previous fix, wasn't enough: any bright accent color on top of the
  // line reads as "the line is that color" once the line itself is this
  // wide). The ◆◆ badge elsewhere already marks double-black; that's
  // enough without a red stripe on the line itself.
  // Lift towers -- one small dot per drawn node of a runType:"lift"
  // corridor (the user draws each tower as a point when authoring the
  // line, so every vertex IS a tower location). A `circle` layer, not an
  // icon/HTML marker: crisp at 2-3px and needs no image asset, and GPU
  // point rendering handles any number of towers with no viewport-culling
  // machinery (unlike the HTML run-name-label markers elsewhere). Features
  // come from towerFeatures() below, pushed into the same source as the
  // corridor LineString by each caller.
  // Solid white, dark-stroked -- the previous mid-grey (#8a939a) didn't
  // stand out against bright snow/satellite imagery per direct feedback.
  // Stroke stays dark so a white dot doesn't disappear against snow itself.
  add({ id: pfx + "-tower", type: "circle", source: src,
    filter: ["==", ["get", "kind"], "towerNode"],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 0.8, 15, 1.2, 18, 1.6],
      "circle-color": "#ffffff",
      "circle-stroke-width": 0.6,
      "circle-stroke-color": "#05070b"
    } });
  if(!corridorLayerPrefixes.has(map)) corridorLayerPrefixes.set(map, new Set());
  corridorLayerPrefixes.get(map).add(pfx);
  // `before` (an explicit beforeId) means the caller deliberately wants
  // these layers slotted at a specific spot, not forced to the absolute
  // top -- respect that. With no `before`, addLayer() already put these at
  // the top of whatever existed so far, but confirmed live (2026-09) that
  // winter-treatment / hex-terrain-art layers added to the map AFTER a
  // corridor source (a later applyWinter() call) land above
  // it and fully hide it regardless of how wide/dark it's drawn -- so
  // re-assert top-of-stack now too, and expose bringCorridorLayersToFront()
  // for other code (Terrain3D.applyWinter()) to call
  // again whenever THEY add layers later.
  if(!before) bringCorridorLayersToFront(map);
}

// Re-moves every corridor layer stack ever registered on `map` (via
// addCorridorLayers()) to the very top of the style's layer list, in their
// own bottom->top order (width/halo/casing/core/hot/tower). Safe to call
// any time, including before any corridor layers exist (no-op) or after a
// setStyle() wipe (skips missing ids). Call this after adding ANY layer
// that must never visually bury a corridor line -- hex terrain art, the
// tile-art ribbon, winter recolor/relief/sky layers, fog-of-war shrouds.
function bringCorridorLayersToFront(map){
  const prefixes = corridorLayerPrefixes.get(map);
  if(!prefixes) return;
  prefixes.forEach(pfx => {
    CORRIDOR_LAYER_SUFFIXES.forEach(suf => {
      const id = pfx + suf;
      if(map.getLayer(id)){
        try { map.moveLayer(id); } catch(e){}  // no 2nd arg = move to the very top
      }
    });
  });
}

// One small circle-marker Point feature per vertex of a runType:"lift"
// corridor -- each drawn node is a lift tower. No-op for any other
// runType. `corridor` is whatever per-corridor object the caller already
// has on hand (must carry `runType` and a lon/lat point array under
// `points` or `coords`, each point [lon, lat, ...]).
function towerFeatures(corridor){
  corridor = corridor || {};
  if(corridor.runType !== "lift") return [];
  const pts = corridor.points || corridor.coords || [];
  const col = corridorStyle(corridor).col;
  return pts.map(p => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [p[0], p[1]] },
    properties: { kind: "towerNode", col }
  }));
}

// Build the shared per-feature props for a corridor LineString. `latRef`
// is the corridor's first-point latitude. `meta` is { difficulty,
// activityType, runType, widthM }.
function corridorFeatureProps(latRef, meta){
  meta = meta || {};
  const st = corridorStyle(meta);
  return {
    corridor: true,
    widthM: (typeof meta.widthM === "number" && meta.widthM > 0) ? meta.widthM : 10,
    pxPerMeterAtZ0: pxPerMeterAtZ0(latRef || 0),
    col: st.col, halo: st.halo, tier: st.tier
  };
}

global.TileFog = {
  pxPerMeterAtZ0, realWidthExpr, runW, corridorStyle, addCorridorLayers, corridorFeatureProps, towerFeatures,
  bringCorridorLayersToFront,
  // Exported so callers that build their OWN corridor source (fence-editor.html's
  // Test Mode "runLines" stack) can tear down exactly the layer set
  // addCorridorLayers() actually creates, instead of keeping a second
  // hardcoded copy of these suffixes that silently drifts out of sync every
  // time a new layer is added here (confirmed live -- a fence-editor.html
  // copy of this list was missing "-tower" from day one, and then also
  // "-liftline" when that was added: map.removeSource() throws if any
  // layer still references the source, so a stale suffix list meant
  // clearSimCorridorLabels() threw on re-entering Test Mode and aborted
  // before rebuilding -- corridor lines silently vanished on 2nd+ entry).
  CORRIDOR_LAYER_SUFFIXES };

})(typeof window !== "undefined" ? window : globalThis);
