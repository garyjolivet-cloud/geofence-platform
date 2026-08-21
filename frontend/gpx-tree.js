// Shared folder/tree browser for the GPX Editor — a structural port of
// asset-tree.js (window.AssetTree), itself a documented port of
// audio-tree.js, per this project's established "clone the tree module per
// new domain" pattern. Renders two peer roots in one panel — "Paths" and
// "Corridors" — instead of asset-tree.js's project/library dual-scope mode,
// since both roots here always share the same appId (walking_path and
// corridor are both app-scoped tables, not project-vs-library scoped).
//
// Differences from a mechanical port, called out because they'd otherwise
// be easy to get wrong:
//  - Row label appends ".p"/".c" at render time only — cosmetic, never
//    written to the stored name, never sent to the backend.
//  - Cross-root drag/drop is rejected. A path row and a corridor row are
//    different D1 tables, not a "move" — unlike asset-tree.js's legitimate
//    cross-scope drag between project/library (same table, different scope
//    column). Each kind uses its own dataTransfer MIME type namespace so a
//    drop target only ever recognizes its own kind's drag payload.
//  - No upload() export — nothing here is R2-backed. Importing a GPX file
//    into a new tree row is orchestrated by gpx-editor.html itself (POST
//    /api/walking-path or POST /api/corridor, then tree.refresh()).
//  - Clicking a leaf row (a saved path/corridor) calls onPick(item) directly
//    — the GPX Editor "opens" that item into the working canvas, it doesn't
//    attach it to something else the way AssetTree's "+" button did.
//
// Usage:
//   const tree = GpxTree.mount(el, {
//     appId,                     // required — both roots share it
//     getToken: () => string,
//     onPick: (item) => {},      // item = {kind:'path'|'corridor', id, name, folderId, distanceM, elevGainM, elevLossM, widthM, updatedAt}
//     onError: (msg) => {},      // defaults to alert()
//   });
//   tree.refresh({ appId: newAppId });
//   tree.getUploadTarget();      // -> {kind, folderId} — where a new Save As should land
//   tree.revealFolder(kind, folderId);
//   tree.destroy();
(function () {
  "use strict";

  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const css = `
      .gt-root{font-family:"Barlow Condensed",system-ui,sans-serif;font-size:13px;color:var(--snow,#fff);user-select:none}
      .gt-row{display:flex;align-items:center;gap:5px;padding:5px 4px;border-radius:6px;cursor:pointer;position:relative}
      .gt-row:hover{background:rgba(255,255,255,.04)}
      .gt-row.selected{background:rgba(255,106,61,.15)}
      .gt-row.dragover{background:rgba(255,106,61,.22);outline:1px dashed var(--coral,#ff6a3d)}
      .gt-chevron{width:14px;flex:0 0 14px;text-align:center;color:var(--fog,#8aa5bf);font-size:10px}
      .gt-icon{flex:0 0 auto}
      .gt-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .gt-name input{width:100%;box-sizing:border-box}
      .gt-meta{flex:0 0 auto;color:var(--fog,#8aa5bf);font-size:11px}
      .gt-btn{flex:0 0 auto;background:none;border:none;color:var(--ice,#c8dff2);cursor:pointer;font-size:12px;padding:2px 5px;border-radius:5px}
      .gt-btn:hover{background:rgba(255,255,255,.08)}
      .gt-children{margin-left:18px;border-left:1px solid var(--rim,#2e3f58);padding-left:2px}
      .gt-empty{color:var(--fog,#8aa5bf);font-size:11px;padding:6px 4px}
      .gt-menu{position:absolute;z-index:80;top:100%;right:4px;background:var(--slate-2,#1b2738);
        border:1px solid var(--rim,#2e3f58);border-radius:8px;box-shadow:0 8px 20px rgba(0,0,0,.45);
        min-width:150px;overflow:hidden}
      .gt-menu-item{display:block;width:100%;text-align:left;background:none;border:none;color:var(--snow,#fff);
        padding:8px 12px;font-family:"Barlow Condensed";font-size:12px;cursor:pointer}
      .gt-menu-item:hover{background:rgba(255,255,255,.06)}
      .gt-menu-item.danger{color:var(--hazard,#ff2f4e)}
      .gt-picker{padding:4px;max-height:220px;overflow-y:auto}
      .gt-picker-item{padding:6px 10px;border-radius:5px;cursor:pointer;font-size:12px;white-space:nowrap}
      .gt-picker-item:hover{background:rgba(255,106,61,.15)}
      .gt-picker-item input{width:100%;box-sizing:border-box;font-size:12px}
      .gt-toolbar{display:flex;gap:6px;padding:4px 2px 8px;flex-wrap:wrap}
    `;
    const s = document.createElement("style");
    s.textContent = css;
    document.head.appendChild(s);
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function enc(s) { return encodeURIComponent(s); }
  function fmtKm(distanceM) { return distanceM ? (distanceM / 1000).toFixed(2) + " km" : ""; }

  const KIND = {
    path: {
      label: "Paths", rootIcon: "🥾", leafIcon: "🥾", suffix: ".p",
      listItems: "/api/walking-path", listFolders: "/api/walking-path-folder",
      folderEp: "/api/walking-path-folder", itemEp: "/api/walking-path",
      itemsKey: "paths"
    },
    corridor: {
      label: "Corridors", rootIcon: "🛤️", leafIcon: "🛤️", suffix: ".c",
      listItems: "/api/corridor", listFolders: "/api/corridor-folder",
      folderEp: "/api/corridor-folder", itemEp: "/api/corridor",
      itemsKey: "corridors"
    }
  };

  function buildKindTree(kind, folders, items) {
    const byId = new Map();
    const root = { id: null, name: null, parentId: null, kind, children: [], items: [] };
    byId.set(null, root);
    (folders || []).forEach(f => byId.set(f.id, { id: f.id, name: f.name, parentId: f.parentId, kind, children: [], items: [] }));
    (folders || []).forEach(f => {
      const node = byId.get(f.id);
      const parent = byId.get(f.parentId) || root;
      parent.children.push(node);
    });
    (items || []).forEach(it => {
      const parent = byId.get(it.folderId) || root;
      parent.items.push(Object.assign({}, it, { kind }));
    });
    (function sortRec(node) {
      node.children.sort((a, b) => a.name.localeCompare(b.name));
      node.items.sort((a, b) => a.name.localeCompare(b.name));
      node.children.forEach(sortRec);
    })(root);
    return root;
  }

  function mount(el, opts) {
    injectStyles();
    opts = Object.assign({ readOnly: false }, opts);
    el.innerHTML = "";
    el.classList.add("gt-root");

    const state = {
      expanded: new Set(),
      seenRoots: new Set(),
      selected: null,
      roots: { path: null, corridor: null },
      openMenu: null,
      parentById: new Map()
    };
    function seedRootExpanded(key) {
      if (!state.seenRoots.has(key)) { state.seenRoots.add(key); state.expanded.add(key); }
    }

    function err(msg) { if (opts.onError) opts.onError(msg); else alert(msg); }
    function authHeaders(extra) { return Object.assign({ authorization: "Bearer " + opts.getToken() }, extra || {}); }

    async function api(path, init) {
      const r = await fetch(path, Object.assign({}, init, { headers: authHeaders(init && init.headers) }));
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || r.statusText); }
      return r.status === 204 ? null : r.json().catch(() => null);
    }

    function closeMenu() { if (state.openMenu) { state.openMenu.remove(); state.openMenu = null; } }
    function onDocMousedown(e) {
      if (state.openMenu && !state.openMenu.contains(e.target)) closeMenu();
    }
    document.addEventListener("mousedown", onDocMousedown);

    async function load() {
      if (!opts.appId) { el.innerHTML = '<div class="gt-empty">no workspace selected</div>'; return; }
      const [pl, pf, cl, cf] = await Promise.all([
        api(KIND.path.listItems + "?appId=" + enc(opts.appId)),
        api(KIND.path.listFolders + "?appId=" + enc(opts.appId)),
        api(KIND.corridor.listItems + "?appId=" + enc(opts.appId)),
        api(KIND.corridor.listFolders + "?appId=" + enc(opts.appId))
      ]);
      state.roots.path = buildKindTree("path", pf.folders, pl[KIND.path.itemsKey]);
      state.roots.corridor = buildKindTree("corridor", cf.folders, cl[KIND.corridor.itemsKey]);
      state.parentById.set("path", new Map((pf.folders || []).map(f => [f.id, f.parentId])));
      state.parentById.set("corridor", new Map((cf.folders || []).map(f => [f.id, f.parentId])));
      seedRootExpanded("path:root");
      seedRootExpanded("corridor:root");
      if (!state.selected) state.selected = { kind: "path", folderId: null };
      render();
    }

    function revealFolder(kind, folderId) {
      const parents = state.parentById.get(kind);
      let cur = folderId;
      const seen = new Set();
      while (true) {
        state.expanded.add(kind + ":" + (cur || "root"));
        if (!cur || seen.has(cur)) break;
        seen.add(cur);
        cur = parents ? parents.get(cur) : undefined;
      }
      render();
    }

    function allTargets(kind) {
      const out = [];
      function walk(node, path, rootLabel) {
        out.push({ label: path || rootLabel, kind, folderId: node.id });
        node.children.forEach(c => walk(c, (path ? path + " / " : "") + c.name, rootLabel));
      }
      const root = state.roots[kind];
      if (root) walk(root, "", KIND[kind].label + " (root)");
      return out;
    }

    function openPicker(anchorBtn, { kind, excludeFolderId, onPick }) {
      const rowEl = anchorBtn.closest(".gt-row") || anchorBtn.parentElement;
      closeMenu();
      const wrap = document.createElement("div");
      wrap.className = "gt-menu gt-picker";

      const newRow = document.createElement("div");
      newRow.className = "gt-picker-item";
      newRow.textContent = "＋ New folder…";
      newRow.onmousedown = e => {
        e.preventDefault(); e.stopPropagation();
        newRow.onmousedown = null;
        newRow.textContent = "";
        const inp = document.createElement("input");
        inp.type = "text"; inp.placeholder = "folder name"; inp.maxLength = 80;
        inp.style.cssText = "width:100%;box-sizing:border-box";
        newRow.appendChild(inp);
        inp.focus();
        inp.addEventListener("mousedown", ev => ev.stopPropagation());
        inp.addEventListener("click", ev => ev.stopPropagation());
        let done = false;
        const commit = async () => {
          if (done) return; done = true;
          const name = inp.value.trim();
          if (!name || name.includes("/")) { closeMenu(); return; }
          const sel = (state.selected && state.selected.kind === kind) ? state.selected : { kind, folderId: null };
          try {
            const created = await api(KIND[kind].folderEp, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ appId: opts.appId, parentId: sel.folderId, name })
            });
            closeMenu();
            onPick({ kind, folderId: created.id });
          } catch (e) { closeMenu(); err("Create folder failed: " + e.message); }
        };
        inp.addEventListener("keydown", ev => { ev.stopPropagation(); if (ev.key === "Enter") commit(); if (ev.key === "Escape") closeMenu(); });
        inp.addEventListener("blur", commit);
      };
      wrap.appendChild(newRow);

      allTargets(kind).forEach(t => {
        if (excludeFolderId && t.folderId === excludeFolderId) return;
        const row = document.createElement("div");
        row.className = "gt-picker-item";
        row.textContent = "📁 " + t.label;
        row.onmousedown = e => { e.preventDefault(); e.stopPropagation(); closeMenu(); onPick(t); };
        wrap.appendChild(row);
      });
      rowEl.appendChild(wrap);
      state.openMenu = wrap;
    }

    function flipToInput(nameEl, initial, onCommit) {
      nameEl.innerHTML = '<input type="text" maxlength="80">';
      const inp = nameEl.querySelector("input");
      inp.value = initial || ""; inp.focus(); inp.select();
      let done = false;
      const commit = () => {
        if (done) return; done = true;
        const v = inp.value.trim();
        if (v && !v.includes("/")) onCommit(v); else render();
      };
      inp.addEventListener("mousedown", e => e.stopPropagation());
      inp.addEventListener("click", e => e.stopPropagation());
      inp.addEventListener("keydown", e => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { done = true; render(); }
      });
      inp.addEventListener("blur", commit);
    }

    async function createFolder(kind, parentId, name) {
      try {
        await api(KIND[kind].folderEp, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: opts.appId, parentId, name }) });
        await load();
      } catch (e) { err("Create folder failed: " + e.message); }
    }
    async function renameFolder(kind, id, name) {
      try { await api(KIND[kind].folderEp + "/" + id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); await load(); }
      catch (e) { err("Rename failed: " + e.message); }
    }
    async function moveFolder(kind, id, target) {
      try {
        await api(KIND[kind].folderEp + "/" + id, {
          method: "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify({ parentId: target.folderId })
        });
        await load();
      } catch (e) { err("Move failed: " + e.message); }
    }
    async function deleteFolder(kind, id, label) {
      if (!confirm('Delete the folder "' + label + '" and move its contents up one level? This cannot be undone.')) return;
      try { await api(KIND[kind].folderEp + "/" + id, { method: "DELETE" }); await load(); }
      catch (e) { err("Delete failed: " + e.message); }
    }
    async function renameItem(kind, id, name) {
      try { await api(KIND[kind].itemEp + "/" + id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); await load(); }
      catch (e) { err("Rename failed: " + e.message); }
    }
    async function moveItem(kind, id, target) {
      try {
        await api(KIND[kind].itemEp + "/" + id, {
          method: "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify({ folderId: target.folderId })
        });
        await load();
      } catch (e) { err("Move failed: " + e.message); }
    }
    async function deleteItem(kind, id, name) {
      if (!confirm('Delete "' + name + '"? This cannot be undone.')) return;
      try { await api(KIND[kind].itemEp + "/" + id, { method: "DELETE" }); await load(); }
      catch (e) { err("Delete failed: " + e.message); }
    }

    function selectRow(rowEl, sel) {
      el.querySelectorAll(".gt-row.selected").forEach(r => r.classList.remove("selected"));
      rowEl.classList.add("selected");
      state.selected = sel;
    }

    function renderItemMenu(anchorBtn, item) {
      closeMenu();
      const menu = document.createElement("div"); menu.className = "gt-menu";
      const renameBtn = document.createElement("button"); renameBtn.className = "gt-menu-item"; renameBtn.textContent = "✎ Rename";
      renameBtn.onclick = e => { e.stopPropagation(); closeMenu(); const nameEl = anchorBtn.closest(".gt-row").querySelector(".gt-name"); flipToInput(nameEl, item.name, v => renameItem(item.kind, item.id, v)); };
      menu.appendChild(renameBtn);
      const moveBtn = document.createElement("button"); moveBtn.className = "gt-menu-item"; moveBtn.textContent = "📁 Move to…";
      moveBtn.onclick = e => { e.stopPropagation(); openPicker(moveBtn, { kind: item.kind, onPick: t => moveItem(item.kind, item.id, t) }); };
      menu.appendChild(moveBtn);
      const delBtn = document.createElement("button"); delBtn.className = "gt-menu-item danger"; delBtn.textContent = "🗑 Delete";
      delBtn.onclick = e => { e.stopPropagation(); closeMenu(); deleteItem(item.kind, item.id, item.name); };
      menu.appendChild(delBtn);
      anchorBtn.parentElement.appendChild(menu);
      state.openMenu = menu;
    }

    function renderFolderMenu(anchorBtn, node, kind) {
      closeMenu();
      const menu = document.createElement("div"); menu.className = "gt-menu";
      const newSub = document.createElement("button"); newSub.className = "gt-menu-item"; newSub.textContent = "＋ New subfolder";
      newSub.onclick = e => { e.stopPropagation(); closeMenu(); createFolder(kind, node.id, "New folder"); };
      menu.appendChild(newSub);
      if (node.id) {
        const renameBtn = document.createElement("button"); renameBtn.className = "gt-menu-item"; renameBtn.textContent = "✎ Rename";
        renameBtn.onclick = e => { e.stopPropagation(); closeMenu(); const nameEl = anchorBtn.closest(".gt-row").querySelector(".gt-name"); flipToInput(nameEl, node.name, v => renameFolder(kind, node.id, v)); };
        menu.appendChild(renameBtn);
        const moveBtn = document.createElement("button"); moveBtn.className = "gt-menu-item"; moveBtn.textContent = "📁 Move to…";
        moveBtn.onclick = e => { e.stopPropagation(); openPicker(moveBtn, { kind, excludeFolderId: node.id, onPick: t => moveFolder(kind, node.id, t) }); };
        menu.appendChild(moveBtn);
        const delBtn = document.createElement("button"); delBtn.className = "gt-menu-item danger"; delBtn.textContent = "🗑 Delete";
        delBtn.onclick = e => { e.stopPropagation(); closeMenu(); deleteFolder(kind, node.id, node.name); };
        menu.appendChild(delBtn);
      }
      anchorBtn.parentElement.appendChild(menu);
      state.openMenu = menu;
    }

    function renderItemRow(item) {
      const row = document.createElement("div"); row.className = "gt-row";
      row.draggable = true;
      row.addEventListener("dragstart", e => {
        e.stopPropagation();
        e.dataTransfer.setData("application/x-gpxitem-" + item.kind, item.id);
        e.dataTransfer.effectAllowed = "move";
      });
      const icon = document.createElement("span"); icon.className = "gt-icon"; icon.textContent = KIND[item.kind].leafIcon;
      const name = document.createElement("span"); name.className = "gt-name"; name.textContent = item.name + KIND[item.kind].suffix;
      const meta = document.createElement("span"); meta.className = "gt-meta"; meta.textContent = fmtKm(item.distanceM);
      row.appendChild(icon); row.appendChild(name); row.appendChild(meta);
      row.onclick = () => { if (opts.onPick) opts.onPick(item); };
      if (!opts.readOnly) {
        const moreBtn = document.createElement("button"); moreBtn.className = "gt-btn"; moreBtn.textContent = "⋯"; moreBtn.title = "Rename, move, or delete";
        moreBtn.onclick = e => { e.stopPropagation(); renderItemMenu(moreBtn, item); };
        row.appendChild(moreBtn);
      }
      return row;
    }

    function renderFolderNode(node, kind, depth, labelOverride, isRoot) {
      const wrap = document.createElement("div");
      const row = document.createElement("div"); row.className = "gt-row";
      const key = kind + ":" + (node.id || "root");
      const expanded = state.expanded.has(key);
      const toggleExpand = () => { if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key); render(); };

      const chevron = document.createElement("span"); chevron.className = "gt-chevron";
      chevron.textContent = expanded ? "▾" : "▸";
      chevron.onclick = e => { e.stopPropagation(); toggleExpand(); };
      const icon = document.createElement("span"); icon.className = "gt-icon"; icon.textContent = isRoot ? KIND[kind].rootIcon : "📁";
      const name = document.createElement("span"); name.className = "gt-name"; name.textContent = labelOverride || node.name;
      row.appendChild(chevron); row.appendChild(icon); row.appendChild(name);

      if (!opts.readOnly) {
        const moreBtn = document.createElement("button"); moreBtn.className = "gt-btn"; moreBtn.textContent = "⋯";
        moreBtn.onclick = e => { e.stopPropagation(); renderFolderMenu(moreBtn, node, kind); };
        row.appendChild(moreBtn);
      }

      row.onclick = () => { selectRow(row, { kind, folderId: node.id }); toggleExpand(); };
      if (state.selected && state.selected.kind === kind && state.selected.folderId === node.id) row.classList.add("selected");

      if (!opts.readOnly) {
        row.draggable = !isRoot;
        if (row.draggable) {
          row.addEventListener("dragstart", e => {
            e.stopPropagation();
            e.dataTransfer.setData("application/x-gpxfolder-" + kind, node.id);
            e.dataTransfer.effectAllowed = "move";
          });
        }
        // Cross-kind drops are rejected by construction: a path row's
        // dragstart only ever sets the "-path" MIME type, so a corridor
        // folder's dragover (which only checks for "-corridor" types)
        // never matches it, and vice versa.
        row.addEventListener("dragover", e => {
          if (e.dataTransfer.types.includes("application/x-gpxitem-" + kind)) { e.preventDefault(); row.classList.add("dragover"); return; }
          if (e.dataTransfer.types.includes("application/x-gpxfolder-" + kind)) { e.preventDefault(); row.classList.add("dragover"); }
        });
        row.addEventListener("dragleave", () => row.classList.remove("dragover"));
        row.addEventListener("drop", e => {
          e.preventDefault(); e.stopPropagation(); row.classList.remove("dragover");
          const itemId = e.dataTransfer.getData("application/x-gpxitem-" + kind);
          if (itemId) { moveItem(kind, itemId, { folderId: node.id }); return; }
          const folderId = e.dataTransfer.getData("application/x-gpxfolder-" + kind);
          if (folderId && folderId !== node.id) moveFolder(kind, folderId, { folderId: node.id });
        });
      }

      wrap.appendChild(row);

      if (expanded) {
        const kids = document.createElement("div"); kids.className = "gt-children";
        node.children.forEach(child => kids.appendChild(renderFolderNode(child, kind, depth + 1, null, false)));
        node.items.forEach(item => kids.appendChild(renderItemRow(item)));
        if (!node.children.length && !node.items.length) { const e2 = document.createElement("div"); e2.className = "gt-empty"; e2.textContent = "empty"; kids.appendChild(e2); }
        wrap.appendChild(kids);
      }
      return wrap;
    }

    function render() {
      el.innerHTML = "";
      if (!opts.readOnly) {
        const toolbar = document.createElement("div"); toolbar.className = "gt-toolbar";
        const newFolderBtn = document.createElement("button"); newFolderBtn.className = "gt-btn"; newFolderBtn.textContent = "＋ New folder";
        newFolderBtn.onclick = () => {
          const sel = state.selected || { kind: "path", folderId: null };
          createFolder(sel.kind, sel.folderId, "New folder");
        };
        toolbar.appendChild(newFolderBtn);
        el.appendChild(toolbar);
      }
      if (state.roots.path) el.appendChild(renderFolderNode(state.roots.path, "path", 0, KIND.path.label, true));
      if (state.roots.corridor) el.appendChild(renderFolderNode(state.roots.corridor, "corridor", 0, KIND.corridor.label, true));
      if (!state.roots.path && !state.roots.corridor) el.innerHTML = '<div class="gt-empty">no paths or corridors yet</div>';
    }

    load().catch(e => { el.innerHTML = '<div class="gt-empty">error: ' + esc(e.message) + "</div>"; });

    const tree = {
      refresh(partial) { Object.assign(opts, partial || {}); return load(); },
      getUploadTarget() { return state.selected || { kind: "path", folderId: null }; },
      listFolders(kind) { return allTargets(kind); },
      revealFolder(kind, folderId) { revealFolder(kind, folderId); },
      destroy() { document.removeEventListener("mousedown", onDocMousedown); el.innerHTML = ""; }
    };
    return tree;
  }

  window.GpxTree = { mount };
})();
