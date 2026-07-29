// Shared floating "Code Objects" palette — reusable, pre-built behaviors
// (internally a pipeline-runtime.js template, see zone.codeObjects) that get
// dragged onto stops instead of hand-wiring the same pipeline graph per stop.
// One implementation, mounted from multiple host pages (fence-editor.html
// today; field-recorder.html in a later phase) so palette rendering,
// entitlement filtering, and drop-handling never diverge between them —
// this codebase has been bitten before by the same logic drifting when
// copy-pasted per page (see pipeline-runtime.js's own header note).
//
// Host pages own their own data (the `zones` array, selection state, map);
// this module only owns rendering the palette + the generic attach/detach/
// badge helpers + the drag-source wiring. Hosts wire drop targets via
// makeDroppable() and decide what a card click/drop means for their UI.
(function () {
  "use strict";

  let _cache = null;      // list of {id,name,icon,category,description,paramSchema,version}
  let _cacheOrg = null;   // orgId the current _cache was fetched for — refetch on change

  // The list endpoint is entitlement-gated (unlike the single-object GET
  // used by pipeline-runtime.js's runtime resolver, which stays public —
  // see worker.js's comment on that route) so it needs an org + bearer token.
  async function fetchList(orgId, getToken) {
    if (_cache && _cacheOrg === orgId) return _cache;
    if (!orgId) { _cache = []; _cacheOrg = orgId; return _cache; }
    try {
      const token = getToken ? getToken() : "";
      const r = await fetch("/api/code-objects?org=" + encodeURIComponent(orgId), {
        headers: token ? { authorization: "Bearer " + token } : {}
      });
      if (r.ok) { _cache = await r.json(); _cacheOrg = orgId; }
    } catch (e) { /* degrade silently — palette just renders empty */ }
    return _cache || [];
  }

  function latestVersion(objectId) {
    const obj = (_cache || []).find(o => o.id === objectId);
    return obj ? obj.version : 1;
  }

  function attach(zone, objectId, version, params) {
    zone.codeObjects = zone.codeObjects || [];
    if (zone.codeObjects.some(co => co.objectId === objectId)) return false;
    zone.codeObjects.push({ objectId, version: version || latestVersion(objectId), params: params || {} });
    return true;
  }

  function detach(zone, objectId) {
    if (!zone || !zone.codeObjects) return false;
    const before = zone.codeObjects.length;
    zone.codeObjects = zone.codeObjects.filter(co => co.objectId !== objectId);
    return zone.codeObjects.length !== before;
  }

  function summarize(zone) {
    const list = (zone && zone.codeObjects) || [];
    if (!list.length) return "none attached";
    const names = list.map(co => {
      const obj = (_cache || []).find(o => o.id === co.objectId);
      return obj ? obj.name : co.objectId;
    });
    return list.length + " object" + (list.length === 1 ? "" : "s") + ": " + names.join(", ");
  }

  function renderBadge(zone) {
    const list = (zone && zone.codeObjects) || [];
    if (!list.length) return "";
    return '<span class="co-badge" title="' + list.length + ' code object' + (list.length === 1 ? "" : "s") + ' attached" ' +
      'style="font-size:10px;margin-left:3px;vertical-align:middle">🧩' + (list.length > 1 ? "×" + list.length : "") + '</span>';
  }

  // rowEl: any element (zone-list row, map marker wrapper) to accept a drop.
  // getZone(): () => the zone this element represents, resolved at drop time
  // (not attach time) so hosts can reuse one handler across re-rendered rows.
  function makeDroppable(rowEl, getZone, onAttach) {
    rowEl.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("codeobjectid")) return;
      e.preventDefault();
      rowEl.classList.add("co-drop-hover");
    });
    rowEl.addEventListener("dragleave", () => rowEl.classList.remove("co-drop-hover"));
    rowEl.addEventListener("drop", (e) => {
      if (!e.dataTransfer.types.includes("codeobjectid")) return;
      e.preventDefault();
      rowEl.classList.remove("co-drop-hover");
      const objectId = e.dataTransfer.getData("codeobjectid");
      const zone = getZone();
      if (!objectId || !zone) return;
      const added = attach(zone, objectId, latestVersion(objectId), {});
      if (added && onAttach) onAttach(objectId, zone);
    });
  }

  const STYLE = `
    .co-float{position:fixed;z-index:400;top:80px;right:16px;width:220px;
      background:var(--slate-2,#1b2738);border:1px solid var(--rim,#2e3f58);border-radius:12px;
      box-shadow:0 8px 24px rgba(0,0,0,.4);font-family:'Barlow Condensed',sans-serif;
      color:var(--snow,#eef4fb);user-select:none}
    .co-float-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;
      border-bottom:1px solid var(--rim,#2e3f58);cursor:grab;font-size:13px;font-weight:600;
      letter-spacing:.5px;text-transform:uppercase;color:var(--coral,#ff6a3d)}
    .co-float-head button{background:none;border:none;color:var(--fog,#8aa5bf);cursor:pointer;font-size:14px;padding:0 2px}
    .co-float-body{padding:8px;max-height:320px;overflow-y:auto}
    .co-float.collapsed .co-float-body{display:none}
    .co-card{display:flex;align-items:center;gap:6px;padding:7px 8px;margin-bottom:6px;border-radius:8px;
      background:rgba(255,255,255,.03);border:1px solid var(--rim,#2e3f58);cursor:grab;font-size:13px}
    .co-card:hover{border-color:var(--coral,#ff6a3d)}
    .co-card .ic{flex:0 0 auto;font-size:15px}
    .co-card .nm{flex:1;line-height:1.2}
    .co-card .co-remove{flex:0 0 auto;background:none;border:1px solid var(--rim,#2e3f58);border-radius:6px;
      color:var(--fog,#8aa5bf);cursor:pointer;font-size:13px;line-height:1;padding:2px 6px}
    .co-card .co-remove:hover{border-color:var(--hazard,#ff2f4e);color:var(--hazard,#ff2f4e)}
    .co-target-hint{font-size:11px;color:var(--fog,#8aa5bf);padding:0 2px 8px}
    .co-empty{font-size:12px;color:var(--fog,#8aa5bf);padding:6px 2px}
    .co-drop-hover{outline:2px dashed var(--coral,#ff6a3d);outline-offset:1px}
    .co-matrix-btn{width:100%;margin-top:4px;padding:6px;border-radius:8px;border:1px solid var(--rim,#2e3f58);
      background:none;color:var(--ice,#c8dff2);font-size:12px;cursor:pointer}
    .co-matrix-btn:hover{border-color:var(--coral,#ff6a3d)}
    .co-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:500;
      display:flex;align-items:center;justify-content:center}
    .co-modal{background:var(--slate-2,#1b2738);border:1px solid var(--rim,#2e3f58);border-radius:12px;
      padding:14px;max-width:90vw;max-height:80vh;overflow:auto;font-family:'Barlow Condensed',sans-serif;color:var(--snow,#eef4fb)}
    .co-modal table{border-collapse:collapse;font-size:12px}
    .co-modal th,.co-modal td{padding:5px 8px;border-bottom:1px solid var(--rim,#2e3f58);text-align:left}
    .co-modal th{color:var(--fog,#8aa5bf);font-weight:600;white-space:nowrap}
    .co-modal input[type=checkbox]{accent-color:var(--coral,#ff6a3d)}
    .co-modal-close{float:right;background:none;border:none;color:var(--fog,#8aa5bf);cursor:pointer;font-size:16px}
  `;

  function injectStyle() {
    if (document.getElementById("co-style")) return;
    const s = document.createElement("style");
    s.id = "co-style";
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function makeHeaderDraggable(float, head) {
    let dragging = null;
    head.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      const r = float.getBoundingClientRect();
      dragging = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      float.style.right = "auto";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    function onMove(e) {
      if (!dragging) return;
      float.style.left = Math.max(0, e.clientX - dragging.dx) + "px";
      float.style.top = Math.max(0, e.clientY - dragging.dy) + "px";
    }
    function onUp() {
      dragging = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
  }

  // Renders the object x stop checkbox matrix for project-wide auditing/
  // bulk correction — reads/writes zone.codeObjects directly on the array
  // the host gave us, then calls onChange() so the host re-renders itself.
  function openMatrix(zones, onChange) {
    const list = _cache || [];
    const backdrop = document.createElement("div");
    backdrop.className = "co-modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "co-modal";
    let html = '<button class="co-modal-close">✕</button><h3 style="margin:0 0 8px;font-size:14px">Code Object Assignments</h3>';
    if (!list.length || !zones.length) {
      html += '<div class="co-empty">' + (!list.length ? "no code objects available" : "no stops yet") + '</div>';
    } else {
      html += '<table><tr><th>Stop</th>' + list.map(o => '<th>' + o.icon + ' ' + o.name + '</th>').join("") + '</tr>';
      zones.forEach((z, zi) => {
        html += '<tr><td>' + (z.name || "Stop " + (zi + 1)) + '</td>' + list.map(o => {
          const checked = (z.codeObjects || []).some(co => co.objectId === o.id);
          return '<td style="text-align:center"><input type="checkbox" data-zi="' + zi + '" data-oid="' + o.id + '" ' + (checked ? "checked" : "") + '></td>';
        }).join("") + '</tr>';
      });
      html += '</table>';
    }
    modal.innerHTML = html;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    modal.querySelector(".co-modal-close").onclick = () => backdrop.remove();
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) backdrop.remove(); });
    modal.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener("change", () => {
        const zone = zones[+cb.dataset.zi];
        if (cb.checked) attach(zone, cb.dataset.oid, latestVersion(cb.dataset.oid), {});
        else detach(zone, cb.dataset.oid);
        if (onChange) onChange();
      });
    });
  }

  let _mountEls = null; // {float, head, body} — set by mount(), used by refresh()
  let _mountOpts = null;

  // opts:
  //   getOrgId()      — () => current orgId (may change after mount, e.g. the
  //                     client picker changing — call refresh() when it does)
  //   getToken()      — () => bearer token for the entitlement-gated list
  //   getTargets()    — () => array of zones a card click/✕ should act on
  //                     (host decides: [selectedZone], or the bulk-checked
  //                     set — empty array means "nothing selected", a silent
  //                     no-op, same degrade-gracefully convention as the rest
  //                     of this app). Dragging a card is always single-target,
  //                     resolved by whichever element makeDroppable() is on.
  //   onZonesChanged()— called after any attach/detach so the host re-renders
  //   getZones()      — optional; enables the "Manage assignments…" matrix
  async function mount(container, opts) {
    opts = opts || {};
    injectStyle();
    const float = document.createElement("div");
    float.className = "co-float";
    float.innerHTML =
      '<div class="co-float-head">🧩 Code Objects<button class="co-toggle" title="collapse">–</button></div>' +
      '<div class="co-float-body"><div class="co-empty">loading…</div></div>';
    (container || document.body).appendChild(float);

    const head = float.querySelector(".co-float-head");
    const body = float.querySelector(".co-float-body");
    makeHeaderDraggable(float, head);
    head.querySelector(".co-toggle").onclick = () => {
      float.classList.toggle("collapsed");
      head.querySelector(".co-toggle").textContent = float.classList.contains("collapsed") ? "+" : "–";
    };

    _mountEls = { float, head, body };
    _mountOpts = opts;
    await refresh();
    return float;
  }

  // Re-fetches the (org-gated) list and re-renders cards — call this when
  // the host's notion of "current org" changes (e.g. the client picker).
  async function refresh() {
    if (!_mountEls) return;
    const { body } = _mountEls;
    const opts = _mountOpts || {};
    const orgId = opts.getOrgId ? opts.getOrgId() : null;
    const targets = () => (opts.getTargets ? opts.getTargets() : []) || [];

    const list = await fetchList(orgId, opts.getToken);
    body.innerHTML = "";
    if (!orgId) {
      body.innerHTML = '<div class="co-empty">select a customer to see available code objects</div>';
      return;
    }
    if (opts.getTargets) {
      const hint = document.createElement("div");
      hint.className = "co-target-hint";
      hint.textContent = "drag onto a stop, or click +/− to apply to the current selection";
      body.appendChild(hint);
    }
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "co-empty";
      empty.textContent = "no code objects available";
      body.appendChild(empty);
    } else {
      list.forEach(obj => {
        const card = document.createElement("div");
        card.className = "co-card";
        card.draggable = true;
        card.title = obj.description || "";
        card.innerHTML = '<span class="ic">' + obj.icon + '</span><span class="nm">' + obj.name + '</span>' +
          '<button class="co-remove" title="remove from current selection">−</button>';
        card.addEventListener("dragstart", (e) => {
          e.dataTransfer.setData("codeobjectid", obj.id);
          e.dataTransfer.effectAllowed = "copy";
        });
        card.addEventListener("click", (e) => {
          if (e.target.classList.contains("co-remove")) return;
          const ts = targets();
          if (!ts.length) return;
          ts.forEach(z => attach(z, obj.id, latestVersion(obj.id), {}));
          if (opts.onZonesChanged) opts.onZonesChanged();
        });
        card.querySelector(".co-remove").addEventListener("click", (e) => {
          e.stopPropagation();
          const ts = targets();
          if (!ts.length) return;
          ts.forEach(z => detach(z, obj.id));
          if (opts.onZonesChanged) opts.onZonesChanged();
        });
        body.appendChild(card);
      });
    }
    if (opts.getZones) {
      const btn = document.createElement("button");
      btn.className = "co-matrix-btn";
      btn.textContent = "Manage assignments…";
      btn.onclick = () => openMatrix(opts.getZones(), opts.onZonesChanged);
      body.appendChild(btn);
    }
  }

  function getCached() { return _cache || []; }

  window.CodeObjects = { mount, refresh, attach, detach, summarize, renderBadge, makeDroppable, fetchList, latestVersion, openMatrix, getCached };
})();
