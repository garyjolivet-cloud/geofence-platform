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

  let _cache = null;      // list of {id,name,icon,category,description,paramSchema,version,folderId}
  let _cacheOrg = null;   // orgId the current _cache was fetched for — refetch on change
  let _folders = [];      // list of {id,parentId,name} for the current org's code_object_folder tree
  let _foldersOrg = null;
  let _treeExpanded = new Set([null]); // folder ids expanded in the palette — root (id null) starts expanded

  // obj.name/obj.icon (and zone.name, used in openMatrix()) are attacker-
  // controllable — any org with "publish" scope sets them via POST
  // /api/code-objects with no server-side sanitization — so every innerHTML
  // interpolation of them in this module must go through this first.
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

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

  async function fetchFolders(orgId, getToken) {
    if (_foldersOrg === orgId) return _folders;
    if (!orgId) { _folders = []; _foldersOrg = orgId; return _folders; }
    try {
      const token = getToken ? getToken() : "";
      const r = await fetch("/api/code-object-folder?org=" + encodeURIComponent(orgId), {
        headers: token ? { authorization: "Bearer " + token } : {}
      });
      if (r.ok) { _folders = (await r.json()).folders || []; _foldersOrg = orgId; }
    } catch (e) { /* degrade silently — palette just renders a flat root */ }
    return _folders;
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
    .co-float{position:fixed;z-index:400;bottom:16px;right:16px;width:220px;
      background:var(--slate-2,#1b2738);border:1px solid var(--rim,#2e3f58);border-radius:12px;
      box-shadow:0 8px 24px rgba(0,0,0,.4);font-family:'Barlow Condensed',sans-serif;
      color:var(--snow,#eef4fb);user-select:none}
    .co-float-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;
      border-bottom:1px solid var(--rim,#2e3f58);cursor:grab;font-size:13px;font-weight:600;
      letter-spacing:.5px;text-transform:uppercase;color:var(--coral,#ff6a3d)}
    .co-float-head button{background:none;border:none;color:var(--fog,#8aa5bf);cursor:pointer;font-size:14px;padding:0 2px}
    .co-float-body{padding:8px;max-height:320px;overflow-y:auto}
    .co-float.collapsed .co-float-body{display:none}
    .co-float.embedded{position:static;width:100%;height:100%;display:flex;flex-direction:column;
      box-shadow:none;border:none;border-radius:0;background:none}
    .co-float.embedded .co-float-body{max-height:none;flex:1 1 auto;padding:0}
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
    .co-folder-row{display:flex;align-items:center;gap:5px;padding:5px 4px;margin-bottom:2px;border-radius:7px;
      cursor:pointer;font-size:13px}
    .co-folder-row:hover{background:rgba(255,255,255,.04)}
    .co-folder-row.co-drop-hover{outline:2px dashed var(--coral,#ff6a3d);outline-offset:1px}
    .co-folder-chevron{width:12px;flex:0 0 12px;text-align:center;color:var(--fog,#8aa5bf);font-size:10px}
    .co-folder-count{flex:0 0 auto;color:var(--fog,#8aa5bf);font-size:11px}
    .co-folder-more{flex:0 0 auto;background:none;border:none;color:var(--ice,#c8dff2);cursor:pointer;
      font-size:12px;padding:2px 6px;border-radius:5px}
    .co-folder-more:hover{background:rgba(255,255,255,.08)}
    .co-folder-children{margin-left:14px;border-left:1px solid var(--rim,#2e3f58);padding-left:6px}
    .co-folder-menu{position:fixed;z-index:600;background:var(--slate-2,#1b2738);border:1px solid var(--rim,#2e3f58);
      border-radius:8px;box-shadow:0 8px 20px rgba(0,0,0,.45);min-width:150px;overflow:hidden}
    .co-folder-menu button{display:block;width:100%;text-align:left;background:none;border:none;
      color:var(--snow,#eef4fb);padding:8px 12px;font-family:'Barlow Condensed',sans-serif;font-size:12px;cursor:pointer}
    .co-folder-menu button:hover{background:rgba(255,255,255,.06)}
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
      float.style.bottom = "auto"; // default position is bottom-anchored — clear it so top+bottom can't both apply and stretch the box while dragging
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
      html += '<table><tr><th>Stop</th>' + list.map(o => '<th>' + esc(o.icon) + ' ' + esc(o.name) + '</th>').join("") + '</tr>';
      zones.forEach((z, zi) => {
        html += '<tr><td>' + esc(z.name || "Stop " + (zi + 1)) + '</td>' + list.map(o => {
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

  // Tiny self-contained "⋯" menu, shared by folder rows and (in library mode)
  // object cards — this module doesn't have access to fence-editor.html's
  // openPortalMenu (it's mounted on multiple host pages per this file's own
  // header note), so it builds its own, positioned the same way (document.body
  // + position:fixed, clamped to the viewport) to avoid getting clipped by
  // whatever scrollable box the host page's palette happens to sit inside.
  function closeCoFolderMenus() { document.querySelectorAll(".co-folder-menu").forEach(m => m.remove()); }
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest(".co-folder-menu") && !e.target.closest(".co-folder-more") && !e.target.closest(".co-card-more")) closeCoFolderMenus();
  });
  function openCoMenu(anchorBtn, buildItemsFn) {
    closeCoFolderMenus();
    const menu = document.createElement("div");
    menu.className = "co-folder-menu";
    menu.style.top = "0"; menu.style.left = "0"; menu.style.visibility = "hidden";
    const mkItem = (label, fn) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = label;
      b.onclick = (e) => { e.stopPropagation(); closeCoFolderMenus(); fn(); };
      menu.appendChild(b);
    };
    buildItemsFn(mkItem);
    document.body.appendChild(menu);
    const ar = anchorBtn.getBoundingClientRect(), mr = menu.getBoundingClientRect();
    let top = ar.bottom + 4;
    if (top + mr.height > window.innerHeight) top = Math.max(4, ar.top - mr.height - 4);
    let left = Math.min(ar.left, window.innerWidth - mr.width - 4);
    menu.style.top = top + "px"; menu.style.left = Math.max(4, left) + "px"; menu.style.visibility = "visible";
  }
  function openCoFolderMenu(anchorBtn, node, orgId, opts) {
    openCoMenu(anchorBtn, mkItem => {
      mkItem("＋📁 New subfolder", async () => {
        const name = (prompt("New subfolder name:") || "").trim();
        if (!name) return;
        const token = opts.getToken ? opts.getToken() : "";
        await fetch("/api/code-object-folder", {
          method: "POST", headers: Object.assign({ "content-type": "application/json" }, token ? { authorization: "Bearer " + token } : {}),
          body: JSON.stringify({ orgId, name, parentId: node.id })
        }).catch(() => {});
        _treeExpanded.add(node.id);
        _foldersOrg = null; // force refetch
        await refresh();
      });
      if (node.id !== null) {
        mkItem("✎ Rename", async () => {
          const name = (prompt("Rename folder:", node.name) || "").trim();
          if (!name || name === node.name) return;
          const token = opts.getToken ? opts.getToken() : "";
          await fetch("/api/code-object-folder/" + encodeURIComponent(node.id), {
            method: "PATCH", headers: Object.assign({ "content-type": "application/json" }, token ? { authorization: "Bearer " + token } : {}),
            body: JSON.stringify({ name })
          }).catch(() => {});
          _foldersOrg = null;
          await refresh();
        });
        mkItem("🗑 Delete", async () => {
          if (!confirm('Delete the folder "' + node.name + '"? Objects inside move up to its parent folder — nothing is deleted.')) return;
          const token = opts.getToken ? opts.getToken() : "";
          await fetch("/api/code-object-folder/" + encodeURIComponent(node.id), {
            method: "DELETE", headers: token ? { authorization: "Bearer " + token } : {}
          }).catch(() => {});
          _foldersOrg = null; _cacheOrg = null;
          await refresh();
        });
      }
    });
  }
  // Library-mode object actions: Duplicate (built-ins → a custom copy you can
  // edit) or Delete (customs only — built-ins are shared, master-only via a
  // different surface). Ported from code-library.html's per-card actions.
  function openCoObjectMenu(anchorBtn, obj, orgId, opts) {
    openCoMenu(anchorBtn, mkItem => {
      const isBuiltIn = obj.orgId == null;
      const token = opts.getToken ? opts.getToken() : "";
      const authHeaders = Object.assign({ "content-type": "application/json" }, token ? { authorization: "Bearer " + token } : {});
      if (isBuiltIn) {
        mkItem("⧉ Duplicate as custom", async () => {
          const name = (prompt("Name for the duplicate:", obj.name + " (copy)") || "").trim();
          if (!name) return;
          try {
            const full = await fetch("/api/code-objects/" + encodeURIComponent(obj.id)).then(r => r.json());
            const r = await fetch("/api/code-objects", {
              method: "POST", headers: authHeaders,
              body: JSON.stringify({ orgId, name, description: full.description, icon: full.icon, category: full.category, template: full.template, paramSchema: full.paramSchema })
            });
            if (!r.ok) { alert("Duplicate failed: " + ((await r.json().catch(() => ({}))).error || r.status)); return; }
            const created = await r.json();
            _cacheOrg = null;
            await refresh();
            if (opts.onCardClick) opts.onCardClick(created.id);
          } catch (e) { alert("Duplicate failed: " + e.message); }
        });
      } else {
        mkItem("🗑 Delete", async () => {
          if (!confirm('Delete "' + obj.name + '"? Stops that already reference it will simply stop finding a definition to execute.')) return;
          try {
            const r = await fetch("/api/code-objects/" + encodeURIComponent(obj.id), { method: "DELETE", headers: token ? { authorization: "Bearer " + token } : {} });
            if (!r.ok) { alert("Delete failed: " + ((await r.json().catch(() => ({}))).error || r.status)); return; }
            _cacheOrg = null;
            await refresh();
          } catch (e) { alert("Delete failed: " + e.message); }
        });
      }
    });
  }

  // Groups the flat _cache/_folders lists into a tree, root id=null — same
  // shape/algorithm as fence-editor.html's buildWpTree() for the Walking
  // Path picker (folder tree over an app/org-scoped flat resource list).
  function buildCoTree(list, folders) {
    const byId = new Map();
    const root = { id: null, name: null, parentId: null, children: [], objects: [] };
    byId.set(null, root);
    folders.forEach(f => byId.set(f.id, { id: f.id, name: f.name, parentId: f.parentId, children: [], objects: [] }));
    folders.forEach(f => { const node = byId.get(f.id); (byId.get(f.parentId) || root).children.push(node); });
    list.forEach(obj => { (byId.get(obj.folderId) || root).objects.push(obj); });
    (function sortRec(node) {
      node.children.sort((a, b) => a.name.localeCompare(b.name));
      node.objects.sort((a, b) => a.name.localeCompare(b.name));
      node.children.forEach(sortRec);
    })(root);
    return root;
  }

  function buildCoObjectRow(obj, orgId, opts) {
    const targets = () => (opts.getTargets ? opts.getTargets() : []) || [];
    const libraryMode = !!opts.onCardClick;
    const card = document.createElement("div");
    card.className = "co-card";
    card.draggable = true;
    card.title = obj.description || "";
    card.innerHTML = '<span class="ic">' + esc(obj.icon) + '</span><span class="nm">' + esc(obj.name) + '</span>' +
      (libraryMode
        ? '<button class="co-remove co-card-more" title="duplicate or delete">⋯</button>'
        : '<button class="co-remove" title="remove from current selection">−</button>');
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("codeobjectid", obj.id);
      e.dataTransfer.effectAllowed = "copy";
    });
    card.addEventListener("click", (e) => {
      if (e.target.classList.contains("co-remove")) return;
      if (libraryMode) { opts.onCardClick(obj.id); return; }
      const ts = targets();
      if (!ts.length) return;
      ts.forEach(z => attach(z, obj.id, latestVersion(obj.id), {}));
      if (opts.onZonesChanged) opts.onZonesChanged();
    });
    card.querySelector(".co-remove").addEventListener("click", (e) => {
      e.stopPropagation();
      if (libraryMode) { openCoObjectMenu(e.currentTarget, obj, orgId, opts); return; }
      const ts = targets();
      if (!ts.length) return;
      ts.forEach(z => detach(z, obj.id));
      if (opts.onZonesChanged) opts.onZonesChanged();
    });
    return card;
  }

  // Root (id null) renders as a collapsible row too, same as the Walking
  // Path picker's tree — collapsing it hides every top-level folder/object
  // at once, useful since this whole tree lives inside a small fixed-height
  // floating palette rather than a full page.
  function buildCoFolderRow(node, orgId, opts) {
    const isRoot = node.id === null;
    const wrap = document.createElement("div");
    const expanded = _treeExpanded.has(node.id);
    const row = document.createElement("div");
    row.className = "co-folder-row";
    const chevron = document.createElement("span");
    chevron.className = "co-folder-chevron";
    chevron.textContent = expanded ? "▾" : "▸";
    const toggle = () => { if (_treeExpanded.has(node.id)) _treeExpanded.delete(node.id); else _treeExpanded.add(node.id); refresh(); };
    chevron.onclick = (e) => { e.stopPropagation(); toggle(); };
    const icon = document.createElement("span");
    icon.textContent = isRoot ? "📂" : "📁";
    const nameEl = document.createElement("span");
    nameEl.style.flex = "1"; nameEl.style.minWidth = "0"; nameEl.style.overflow = "hidden";
    nameEl.style.textOverflow = "ellipsis"; nameEl.style.whiteSpace = "nowrap";
    nameEl.textContent = isRoot ? "All objects" : node.name;
    const count = document.createElement("span");
    count.className = "co-folder-count";
    count.textContent = node.objects.length;
    row.appendChild(chevron); row.appendChild(icon); row.appendChild(nameEl); row.appendChild(count);
    const moreBtn = document.createElement("button");
    moreBtn.className = "co-folder-more"; moreBtn.textContent = "⋯";
    moreBtn.title = isRoot ? "New folder" : "New subfolder, rename, or delete";
    moreBtn.onclick = (e) => { e.stopPropagation(); openCoFolderMenu(moreBtn, node, orgId, opts); };
    row.appendChild(moreBtn);
    row.onclick = toggle;
    // Drag an object card here to move it into this folder (mirrors the
    // drag-onto-a-stop attach mechanism — same "codeobjectid" payload, a
    // different destination). Root drop moves it to no folder.
    row.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("codeobjectid")) return;
      e.preventDefault();
      row.classList.add("co-drop-hover");
    });
    row.addEventListener("dragleave", () => row.classList.remove("co-drop-hover"));
    row.addEventListener("drop", async (e) => {
      if (!e.dataTransfer.types.includes("codeobjectid")) return;
      e.preventDefault();
      row.classList.remove("co-drop-hover");
      const objectId = e.dataTransfer.getData("codeobjectid");
      if (!objectId) return;
      const token = opts.getToken ? opts.getToken() : "";
      await fetch("/api/code-objects/" + encodeURIComponent(objectId), {
        method: "PATCH", headers: Object.assign({ "content-type": "application/json" }, token ? { authorization: "Bearer " + token } : {}),
        body: JSON.stringify({ folderId: node.id })
      }).catch(() => {});
      _cacheOrg = null;
      await refresh();
    });
    wrap.appendChild(row);
    if (expanded) {
      const kids = document.createElement("div");
      kids.className = "co-folder-children";
      node.children.forEach(child => kids.appendChild(buildCoFolderRow(child, orgId, opts)));
      node.objects.forEach(obj => kids.appendChild(buildCoObjectRow(obj, orgId, opts)));
      if (!node.children.length && !node.objects.length) {
        const e2 = document.createElement("div");
        e2.className = "co-empty";
        e2.textContent = "empty";
        kids.appendChild(e2);
      }
      wrap.appendChild(kids);
    }
    return wrap;
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
  //   embedded         — optional; renders as a normal block filling its
  //                      container (no fixed floating position, no drag
  //                      header, no collapse toggle) for hosts that already
  //                      have their own layout column, e.g. pipeline-editor.html's
  //                      library sidebar. Default false = the original
  //                      floating-over-the-map palette (fence-editor.html).
  //   onCardClick(id)   — optional; if set, clicking a card calls this
  //                      instead of attaching to getTargets() — "library
  //                      browse" mode instead of "attach" mode. The card's
  //                      "−" remove button also becomes a "⋯" Duplicate/
  //                      Delete menu in this mode.
  async function mount(container, opts) {
    opts = opts || {};
    injectStyle();
    const float = document.createElement("div");
    float.className = opts.embedded ? "co-float embedded" : "co-float";
    float.innerHTML = opts.embedded
      ? '<div class="co-float-body"></div>'
      : '<div class="co-float-head">🧩 Code Objects<button class="co-toggle" title="collapse">–</button></div>' +
        '<div class="co-float-body"><div class="co-empty">loading…</div></div>';
    (container || document.body).appendChild(float);

    const head = float.querySelector(".co-float-head");
    const body = float.querySelector(".co-float-body");
    if (!opts.embedded) {
      makeHeaderDraggable(float, head);
      head.querySelector(".co-toggle").onclick = () => {
        float.classList.toggle("collapsed");
        head.querySelector(".co-toggle").textContent = float.classList.contains("collapsed") ? "+" : "–";
      };
    }

    _mountEls = { float, head, body };
    _mountOpts = opts;
    await refresh();
    return float;
  }

  // Re-fetches the (org-gated) list and re-renders cards — call this when
  // the host's notion of "current org" changes (e.g. the client picker), or
  // pass force=true after a mutation the host itself made outside this
  // module (e.g. creating a new object via its own toolbar) so the stale
  // same-org cache doesn't hide it.
  async function refresh(force) {
    if (!_mountEls) return;
    if (force) { _cacheOrg = null; _foldersOrg = null; }
    const { body } = _mountEls;
    const opts = _mountOpts || {};
    const orgId = opts.getOrgId ? opts.getOrgId() : null;

    const [list, folders] = await Promise.all([
      fetchList(orgId, opts.getToken),
      fetchFolders(orgId, opts.getToken)
    ]);
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
    if (!list.length && !folders.length) {
      const empty = document.createElement("div");
      empty.className = "co-empty";
      empty.textContent = "no code objects available";
      body.appendChild(empty);
    } else {
      body.appendChild(buildCoFolderRow(buildCoTree(list, folders), orgId, opts));
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
