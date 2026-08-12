// Shared 3D-asset (glTF/GLB) folder/tree browser — the AR/3D plan's asset
// library, structurally a straight port of audio-tree.js (window.AudioTree)
// onto asset_folder/asset_object + GET /api/assets/tree, with everything
// audio-specific (play preview, studio sessions, chatterbox scripts)
// stripped and one addition: an asset can be kind:'upload' (own R2 object,
// stable r2Key) or kind:'url' (an externally-hosted glTF/GLB link — no R2
// object at all). Deliberately reuses AudioTree's exact interaction
// language (same toolbar, same drag-drop, same rename/move/copy/delete
// menu) rather than inventing a new one, per this project's existing
// preference for reusing an established UI pattern.
//
// Usage:
//   const tree = AssetTree.mount(el, {
//     mode: 'project',            // or 'library'
//     projectId, projectLabel,    // mode:'project'
//     orgId,                      // mode:'library' (or when project has no org yet)
//     getToken: () => string,
//     readOnly: false,            // true = drag-source only, no CRUD controls (Fence Editor palette)
//     onPick: (asset) => {},      // "+" button on an asset — host attaches it to the selected zone
//     onError: (msg) => {},       // defaults to alert()
//   });
//   tree.refresh({ orgId: newOrg });
//   tree.getUploadTarget();       // -> {scope, scopeId, folderId} of the selected row
//   tree.revealFolder(scope, folderId);
//   tree.destroy();
(function () {
  "use strict";

  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const css = `
      .as-root{font-family:"Barlow Condensed",system-ui,sans-serif;font-size:13px;color:var(--snow,#fff);user-select:none}
      .as-row{display:flex;align-items:center;gap:5px;padding:5px 4px;border-radius:6px;cursor:pointer;position:relative}
      .as-row:hover{background:rgba(255,255,255,.04)}
      .as-row.selected{background:rgba(255,106,61,.15)}
      .as-row.dragover{background:rgba(255,106,61,.22);outline:1px dashed var(--coral,#ff6a3d)}
      .as-chevron{width:14px;flex:0 0 14px;text-align:center;color:var(--fog,#8aa5bf);font-size:10px}
      .as-icon{flex:0 0 auto}
      .as-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .as-name input{width:100%;box-sizing:border-box}
      .as-meta{flex:0 0 auto;color:var(--fog,#8aa5bf);font-size:11px}
      .as-btn{flex:0 0 auto;background:none;border:none;color:var(--ice,#c8dff2);cursor:pointer;font-size:12px;padding:2px 5px;border-radius:5px}
      .as-btn:hover{background:rgba(255,255,255,.08)}
      .as-children{margin-left:18px;border-left:1px solid var(--rim,#2e3f58);padding-left:2px}
      .as-empty{color:var(--fog,#8aa5bf);font-size:11px;padding:6px 4px}
      .as-menu{position:absolute;z-index:80;top:100%;right:4px;background:var(--slate-2,#1b2738);
        border:1px solid var(--rim,#2e3f58);border-radius:8px;box-shadow:0 8px 20px rgba(0,0,0,.45);
        min-width:150px;overflow:hidden}
      .as-menu-item{display:block;width:100%;text-align:left;background:none;border:none;color:var(--snow,#fff);
        padding:8px 12px;font-family:"Barlow Condensed";font-size:12px;cursor:pointer}
      .as-menu-item:hover{background:rgba(255,255,255,.06)}
      .as-menu-item.danger{color:var(--hazard,#ff2f4e)}
      .as-picker{padding:4px;max-height:220px;overflow-y:auto}
      .as-picker-item{padding:6px 10px;border-radius:5px;cursor:pointer;font-size:12px;white-space:nowrap}
      .as-picker-item:hover{background:rgba(255,106,61,.15)}
      .as-picker-item input{width:100%;box-sizing:border-box;font-size:12px}
      .as-toolbar{display:flex;gap:6px;padding:4px 2px 8px;flex-wrap:wrap}
    `;
    const s = document.createElement("style");
    s.textContent = css;
    document.head.appendChild(s);
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function fmtSize(n) {
    if (n == null) return "";
    const kb = n / 1024;
    return kb > 1024 ? (kb / 1024).toFixed(1) + " MB" : Math.round(kb) + " KB";
  }

  function buildTree(scope, scopeId, folders, objects) {
    const byId = new Map();
    const root = { id: null, name: null, parentId: null, scope, scopeId, children: [], objects: [] };
    byId.set(null, root);
    (folders || []).forEach(f => byId.set(f.id, { id: f.id, name: f.name, parentId: f.parentId, scope, scopeId, children: [], objects: [] }));
    (folders || []).forEach(f => {
      const node = byId.get(f.id);
      const parent = byId.get(f.parentId) || root;
      parent.children.push(node);
    });
    (objects || []).forEach(o => {
      const parent = byId.get(o.folderId) || root;
      parent.objects.push({ ...o, scope, scopeId });
    });
    (function sortRec(node) {
      node.children.sort((a, b) => a.name.localeCompare(b.name));
      node.objects.sort((a, b) => a.name.localeCompare(b.name));
      node.children.forEach(sortRec);
    })(root);
    return root;
  }

  function mount(el, opts) {
    injectStyles();
    opts = Object.assign({ mode: "project", readOnly: false }, opts);
    el.innerHTML = "";
    el.classList.add("as-root");

    const state = {
      expanded: new Set(),
      seenRoots: new Set(),
      selected: null,
      projectRoot: null,
      libraryRoot: null,
      projectMeta: null,
      libraryMeta: null,
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
      if (opts.mode === "project") {
        if (!opts.projectId) { el.innerHTML = '<div class="as-empty">no project selected</div>'; return; }
        let qs = "project=" + encodeURIComponent(opts.projectId);
        if (opts.orgId) qs += "&org=" + encodeURIComponent(opts.orgId);
        const j = await api("/api/assets/tree?" + qs);
        state.projectRoot = buildTree("project", opts.projectId, j.project.folders, j.project.objects);
        state.projectMeta = { scopeId: opts.projectId };
        state.parentById.set("project", new Map((j.project.folders || []).map(f => [f.id, f.parentId])));
        seedRootExpanded("project:root");
        if (j.library) {
          state.libraryRoot = buildTree("library", j.library.scopeId, j.library.folders, j.library.objects);
          state.libraryMeta = { scopeId: j.library.scopeId };
          state.parentById.set("library", new Map((j.library.folders || []).map(f => [f.id, f.parentId])));
          seedRootExpanded("library:root");
        } else { state.libraryRoot = null; state.libraryMeta = null; state.parentById.delete("library"); }
        if (!state.selected) state.selected = { scope: "project", scopeId: opts.projectId, folderId: null };
      } else {
        if (!opts.orgId) { el.innerHTML = '<div class="as-empty">pick a company above</div>'; return; }
        const j = await api("/api/assets/tree?scope=library&org=" + encodeURIComponent(opts.orgId));
        state.libraryRoot = buildTree("library", opts.orgId, j.library.folders, j.library.objects);
        state.libraryMeta = { scopeId: opts.orgId };
        state.parentById.set("library", new Map((j.library.folders || []).map(f => [f.id, f.parentId])));
        seedRootExpanded("library:root");
        state.projectRoot = null; state.projectMeta = null; state.parentById.delete("project");
        if (!state.selected || state.selected.scopeId !== opts.orgId) state.selected = { scope: "library", scopeId: opts.orgId, folderId: null };
      }
      render();
    }
    function revealFolder(scope, folderId) {
      const parents = state.parentById.get(scope);
      let cur = folderId;
      const seen = new Set();
      while (true) {
        state.expanded.add(scope + ":" + (cur || "root"));
        if (!cur || seen.has(cur)) break;
        seen.add(cur);
        cur = parents ? parents.get(cur) : undefined;
      }
      render();
    }

    function allTargets(filterScope) {
      const out = [];
      function walk(node, scope, scopeId, path, rootLabel) {
        if (filterScope && scope !== filterScope) return;
        out.push({ label: path || rootLabel, scope, scopeId, folderId: node.id });
        node.children.forEach(c => walk(c, scope, scopeId, (path ? path + " / " : "") + c.name, rootLabel));
      }
      if (state.projectRoot) walk(state.projectRoot, "project", state.projectMeta.scopeId, "", (opts.projectLabel || state.projectMeta.scopeId) + " (root)");
      if (state.libraryRoot) walk(state.libraryRoot, "library", state.libraryMeta.scopeId, "", "Library (root)");
      return out;
    }

    function openPicker(anchorBtn, { filterScope, excludeFolderId, onPick }) {
      const rowEl = anchorBtn.closest(".as-row") || anchorBtn.parentElement;
      closeMenu();
      const wrap = document.createElement("div");
      wrap.className = "as-menu as-picker";

      const newRow = document.createElement("div");
      newRow.className = "as-picker-item";
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
          const fallback = state.projectRoot ? { scope: "project", scopeId: state.projectMeta.scopeId, folderId: null } : { scope: "library", scopeId: state.libraryMeta.scopeId, folderId: null };
          const sel = state.selected || fallback;
          try {
            const created = await api("/api/asset-folder", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ scope: sel.scope, scopeId: sel.scopeId, parentId: sel.folderId, name })
            });
            closeMenu();
            onPick({ scope: sel.scope, scopeId: sel.scopeId, folderId: created.id });
          } catch (e) { closeMenu(); err("Create folder failed: " + e.message); }
        };
        inp.addEventListener("keydown", ev => { ev.stopPropagation(); if (ev.key === "Enter") commit(); if (ev.key === "Escape") closeMenu(); });
        inp.addEventListener("blur", commit);
      };
      wrap.appendChild(newRow);

      allTargets(filterScope).forEach(t => {
        if (excludeFolderId && t.folderId === excludeFolderId) return;
        const row = document.createElement("div");
        row.className = "as-picker-item";
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

    async function createFolder(scope, scopeId, parentId, name) {
      try {
        await api("/api/asset-folder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope, scopeId, parentId, name }) });
        await load();
      } catch (e) { err("Create folder failed: " + e.message); }
    }
    async function renameFolder(id, name) {
      try { await api("/api/asset-folder/" + id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); await load(); }
      catch (e) { err("Rename failed: " + e.message); }
    }
    async function moveFolder(id, target) {
      try {
        await api("/api/asset-folder/" + id, {
          method: "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify({ parentId: target.folderId, targetScope: target.scope, targetScopeId: target.scopeId })
        });
        await load();
      } catch (e) { err("Move failed: " + e.message); }
    }
    async function copyFolder(id, targetScope, targetScopeId, targetParentId) {
      try { await api("/api/asset-folder/" + id + "/copy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetScope, targetScopeId, targetParentId }) }); await load(); }
      catch (e) { err("Copy failed: " + e.message); }
    }
    async function deleteFolder(id, label) {
      if (!confirm('Delete the folder "' + label + '" and everything in it? This cannot be undone.')) return;
      try { await api("/api/asset-folder/" + id, { method: "DELETE" }); await load(); }
      catch (e) { err("Delete failed: " + e.message); }
    }
    async function renameAsset(id, name) {
      try { await api("/api/asset-object/" + id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); await load(); }
      catch (e) { err("Rename failed: " + e.message); }
    }
    async function moveAsset(id, target) {
      try {
        await api("/api/asset-object/" + id, {
          method: "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: target.scope, scopeId: target.scopeId, folderId: target.folderId })
        });
        await load();
      } catch (e) { err("Move failed: " + e.message); }
    }
    async function copyAsset(id, target) {
      try {
        await api("/api/asset-object/" + id + "/copy", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetScope: target.scope, targetScopeId: target.scopeId, targetFolderId: target.folderId })
        });
        await load();
      } catch (e) { err("Copy failed: " + e.message); }
    }
    async function deleteAsset(id, name) {
      if (!confirm('Delete "' + name + '"? This cannot be undone.')) return;
      try { await api("/api/asset-object/" + id, { method: "DELETE" }); await load(); }
      catch (e) { err("Delete failed: " + e.message); }
    }

    function selectRow(rowEl, sel) {
      el.querySelectorAll(".as-row.selected").forEach(r => r.classList.remove("selected"));
      rowEl.classList.add("selected");
      state.selected = sel;
    }

    function renderAssetMenu(anchorBtn, asset) {
      closeMenu();
      const menu = document.createElement("div"); menu.className = "as-menu";
      const renameBtn = document.createElement("button"); renameBtn.className = "as-menu-item"; renameBtn.textContent = "✎ Rename";
      renameBtn.onclick = e => { e.stopPropagation(); closeMenu(); const nameEl = anchorBtn.closest(".as-row").querySelector(".as-name"); flipToInput(nameEl, asset.name, v => renameAsset(asset.id, v)); };
      menu.appendChild(renameBtn);
      const copyUrlBtn = document.createElement("button"); copyUrlBtn.className = "as-menu-item"; copyUrlBtn.textContent = "⧉ Copy URL";
      copyUrlBtn.onclick = e => {
        e.stopPropagation();
        closeMenu();
        const full = asset.kind === "url" ? asset.url : (location.origin + asset.url);
        navigator.clipboard && navigator.clipboard.writeText(full).catch(() => {});
      };
      menu.appendChild(copyUrlBtn);
      const copyBtn = document.createElement("button"); copyBtn.className = "as-menu-item"; copyBtn.textContent = "⧉ Copy to…";
      copyBtn.onclick = e => { e.stopPropagation(); openPicker(copyBtn, { onPick: t => copyAsset(asset.id, t) }); };
      menu.appendChild(copyBtn);
      const moveBtn = document.createElement("button"); moveBtn.className = "as-menu-item"; moveBtn.textContent = "📁 Move to…";
      moveBtn.onclick = e => { e.stopPropagation(); openPicker(moveBtn, { onPick: t => moveAsset(asset.id, t) }); };
      menu.appendChild(moveBtn);
      const delBtn = document.createElement("button"); delBtn.className = "as-menu-item danger"; delBtn.textContent = "🗑 Delete";
      delBtn.onclick = e => { e.stopPropagation(); closeMenu(); deleteAsset(asset.id, asset.name); };
      menu.appendChild(delBtn);
      anchorBtn.parentElement.appendChild(menu);
      state.openMenu = menu;
    }

    function renderFolderMenu(anchorBtn, node, scope, scopeId) {
      closeMenu();
      const menu = document.createElement("div"); menu.className = "as-menu";
      const newSub = document.createElement("button"); newSub.className = "as-menu-item"; newSub.textContent = "＋ New subfolder";
      newSub.onclick = e => { e.stopPropagation(); closeMenu(); createFolder(scope, scopeId, node.id, "New folder"); };
      menu.appendChild(newSub);
      if (node.id) {
        const renameBtn = document.createElement("button"); renameBtn.className = "as-menu-item"; renameBtn.textContent = "✎ Rename";
        renameBtn.onclick = e => { e.stopPropagation(); closeMenu(); const nameEl = anchorBtn.closest(".as-row").querySelector(".as-name"); flipToInput(nameEl, node.name, v => renameFolder(node.id, v)); };
        menu.appendChild(renameBtn);
        const copyBtn = document.createElement("button"); copyBtn.className = "as-menu-item"; copyBtn.textContent = "⧉ Copy to…";
        copyBtn.onclick = e => { e.stopPropagation(); openPicker(copyBtn, { onPick: t => copyFolder(node.id, t.scope, t.scopeId, t.folderId) }); };
        menu.appendChild(copyBtn);
        const moveBtn = document.createElement("button"); moveBtn.className = "as-menu-item"; moveBtn.textContent = "📁 Move to…";
        moveBtn.onclick = e => { e.stopPropagation(); openPicker(moveBtn, { excludeFolderId: node.id, onPick: t => moveFolder(node.id, t) }); };
        menu.appendChild(moveBtn);
        const delBtn = document.createElement("button"); delBtn.className = "as-menu-item danger"; delBtn.textContent = "🗑 Delete";
        delBtn.onclick = e => { e.stopPropagation(); closeMenu(); deleteFolder(node.id, node.name); };
        menu.appendChild(delBtn);
      }
      anchorBtn.parentElement.appendChild(menu);
      state.openMenu = menu;
    }

    function renderAssetRow(asset) {
      const row = document.createElement("div"); row.className = "as-row";
      row.draggable = true;
      row.addEventListener("dragstart", e => {
        e.dataTransfer.setData("application/x-asset-object-id", asset.id);
        // Full asset metadata for drop targets (the map/zone list) — enough
        // to build a zone.arObjects entry without a follow-up fetch.
        e.dataTransfer.setData("application/x-asset-object-json", JSON.stringify({
          id: asset.id, name: asset.name, kind: asset.kind, format: asset.format, url: asset.url
        }));
        e.dataTransfer.effectAllowed = "copyMove";
      });
      const icon = document.createElement("span"); icon.className = "as-icon"; icon.textContent = asset.kind === "url" ? "🔗" : "🧊";
      const name = document.createElement("span"); name.className = "as-name"; name.textContent = asset.name;
      const meta = document.createElement("span"); meta.className = "as-meta";
      meta.textContent = asset.kind === "url" ? "external" : fmtSize(asset.sizeBytes);
      row.appendChild(icon); row.appendChild(name); row.appendChild(meta);
      if (opts.onPick) {
        const pickBtn = document.createElement("button"); pickBtn.className = "as-btn"; pickBtn.textContent = "+"; pickBtn.title = "Attach to selected stop";
        pickBtn.onclick = e => { e.stopPropagation(); opts.onPick(asset); };
        row.appendChild(pickBtn);
      }
      if (!opts.readOnly) {
        const moreBtn = document.createElement("button"); moreBtn.className = "as-btn"; moreBtn.textContent = "⋯"; moreBtn.title = "Rename, move, copy, or delete";
        moreBtn.onclick = e => { e.stopPropagation(); renderAssetMenu(moreBtn, asset); };
        row.appendChild(moreBtn);
      }
      return row;
    }

    function renderFolderNode(node, scope, scopeId, depth, labelOverride, isRoot) {
      const wrap = document.createElement("div");
      const row = document.createElement("div"); row.className = "as-row";
      const key = scope + ":" + (node.id || "root");
      const expanded = state.expanded.has(key);
      const toggleExpand = () => { if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key); render(); };

      const chevron = document.createElement("span"); chevron.className = "as-chevron";
      chevron.textContent = expanded ? "▾" : "▸";
      chevron.onclick = e => { e.stopPropagation(); toggleExpand(); };
      const icon = document.createElement("span"); icon.className = "as-icon"; icon.textContent = isRoot ? (labelOverride === "Library" ? "📚" : "📂") : "📁";
      const name = document.createElement("span"); name.className = "as-name"; name.textContent = labelOverride || node.name;
      row.appendChild(chevron); row.appendChild(icon); row.appendChild(name);

      if (!opts.readOnly) {
        const moreBtn = document.createElement("button"); moreBtn.className = "as-btn"; moreBtn.textContent = "⋯";
        moreBtn.onclick = e => { e.stopPropagation(); renderFolderMenu(moreBtn, node, scope, scopeId); };
        row.appendChild(moreBtn);
      }

      row.onclick = () => { selectRow(row, { scope, scopeId, folderId: node.id }); toggleExpand(); };
      if (state.selected && state.selected.scope === scope && state.selected.scopeId === scopeId && state.selected.folderId === node.id) row.classList.add("selected");

      if (!opts.readOnly) {
        row.draggable = !isRoot;
        if (row.draggable) {
          row.addEventListener("dragstart", e => {
            e.stopPropagation();
            e.dataTransfer.setData("application/x-asset-folder-id", node.id);
            e.dataTransfer.effectAllowed = "move";
          });
        }
        row.addEventListener("dragover", e => {
          if (e.dataTransfer.types.includes("application/x-asset-object-id")) { e.preventDefault(); row.classList.add("dragover"); return; }
          if (e.dataTransfer.types.includes("application/x-asset-folder-id")) {
            e.preventDefault(); row.classList.add("dragover");
          }
        });
        row.addEventListener("dragleave", () => row.classList.remove("dragover"));
        row.addEventListener("drop", e => {
          e.preventDefault(); e.stopPropagation(); row.classList.remove("dragover");
          const assetId = e.dataTransfer.getData("application/x-asset-object-id");
          if (assetId) { moveAsset(assetId, { scope, scopeId, folderId: node.id }); return; }
          const folderId = e.dataTransfer.getData("application/x-asset-folder-id");
          if (folderId && folderId !== node.id) moveFolder(folderId, { scope, scopeId, folderId: node.id });
        });
      }

      wrap.appendChild(row);

      if (expanded) {
        const kids = document.createElement("div"); kids.className = "as-children";
        node.children.forEach(child => kids.appendChild(renderFolderNode(child, scope, scopeId, depth + 1, null, false)));
        node.objects.forEach(asset => kids.appendChild(renderAssetRow(asset)));
        if (!node.children.length && !node.objects.length) { const e2 = document.createElement("div"); e2.className = "as-empty"; e2.textContent = "empty"; kids.appendChild(e2); }
        wrap.appendChild(kids);
      }
      return wrap;
    }

    function render() {
      el.innerHTML = "";
      if (!opts.readOnly) {
        const toolbar = document.createElement("div"); toolbar.className = "as-toolbar";
        const newFolderBtn = document.createElement("button"); newFolderBtn.className = "as-btn"; newFolderBtn.textContent = "＋ New folder";
        newFolderBtn.onclick = () => {
          const sel = state.selected || (state.projectRoot ? { scope: "project", scopeId: state.projectMeta.scopeId, folderId: null } : { scope: "library", scopeId: state.libraryMeta.scopeId, folderId: null });
          createFolder(sel.scope, sel.scopeId, sel.folderId, "New folder");
        };
        toolbar.appendChild(newFolderBtn);
        if (opts.onAddUrl) {
          const urlBtn = document.createElement("button"); urlBtn.className = "as-btn"; urlBtn.textContent = "🔗 Add URL…";
          urlBtn.title = "Reference an externally-hosted glTF/GLB (e.g. a Sketchfab link)";
          urlBtn.onclick = () => opts.onAddUrl(tree.getUploadTarget());
          toolbar.appendChild(urlBtn);
        }
        el.appendChild(toolbar);
      }
      if (state.projectRoot) el.appendChild(renderFolderNode(state.projectRoot, "project", state.projectMeta.scopeId, 0, opts.projectLabel || state.projectMeta.scopeId, true));
      if (state.libraryRoot) el.appendChild(renderFolderNode(state.libraryRoot, "library", state.libraryMeta.scopeId, 0, "Library", true));
      if (!state.projectRoot && !state.libraryRoot) el.innerHTML = '<div class="as-empty">no 3D assets yet</div>';
    }

    load().catch(e => { el.innerHTML = '<div class="as-empty">error: ' + esc(e.message) + "</div>"; });

    const tree = {
      refresh(partial) { Object.assign(opts, partial || {}); return load(); },
      getUploadTarget() { return state.selected || (state.projectRoot ? { scope: "project", scopeId: state.projectMeta.scopeId, folderId: null } : state.libraryRoot ? { scope: "library", scopeId: state.libraryMeta.scopeId, folderId: null } : null); },
      listFolders(filterScope) { return allTargets(filterScope); },
      revealFolder(scope, folderId) { revealFolder(scope, folderId); },
      destroy() { document.removeEventListener("mousedown", onDocMousedown); el.innerHTML = ""; }
    };
    return tree;
  }

  // Uploads one blob as a brand-new asset via POST /api/asset-object.
  //   AssetTree.upload(blob, { scope, scopeId, folderId, name, mimeType, getToken, onProgress })
  function upload(blob, o) {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams({ scope: o.scope, scopeId: o.scopeId, name: o.name });
      if (o.folderId) qs.set("folderId", o.folderId);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/asset-object?" + qs.toString());
      xhr.setRequestHeader("authorization", "Bearer " + o.getToken());
      xhr.setRequestHeader("content-type", o.mimeType || "model/gltf-binary");
      xhr.upload.onprogress = ev => { if (o.onProgress && ev.lengthComputable) o.onProgress(ev.loaded / ev.total); };
      xhr.onload = () => {
        let j = {}; try { j = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(j);
        else reject(new Error(j.error || xhr.statusText));
      };
      xhr.onerror = () => reject(new Error("network error"));
      xhr.timeout = 180000;
      xhr.send(blob);
    });
  }

  // Registers an externally-hosted glTF/GLB via POST /api/asset-object?kind=url.
  //   AssetTree.addUrl({ scope, scopeId, folderId, name, sourceUrl, format, getToken })
  async function addUrl(o) {
    const r = await fetch("/api/asset-object?kind=url", {
      method: "POST",
      headers: { authorization: "Bearer " + o.getToken(), "content-type": "application/json" },
      body: JSON.stringify({ scope: o.scope, scopeId: o.scopeId, folderId: o.folderId || null, name: o.name, sourceUrl: o.sourceUrl, format: o.format || "glb" })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }

  window.AssetTree = { mount, upload, addUrl };
})();
