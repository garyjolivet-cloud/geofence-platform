// Shared audio clip/folder tree browser — replaces the old single-level
// "folder tile" rail (audio-studio.html), tab+grid palette (fence-editor.html)
// and <select>-based folder switcher (the old standalone library.html, since
// retired) with one real nested tree, backed by GET /api/audio/tree + the
// audio-folder/audio-clip CRUD endpoints in worker.js. R2 keys are
// stable/opaque now — rename/move never touch storage, only the
// audio_folder/audio_clip rows.
//
// Usage:
//   const tree = AudioTree.mount(el, {
//     mode: 'project',            // or 'library'
//     projectId,                  // mode:'project'
//     projectLabel,               // mode:'project' — display name for the project's root row (defaults to projectId)
//     orgId,                      // mode:'library' (or when project has no org yet)
//     getToken: () => string,
//     readOnly: false,            // true = drag-source only, no CRUD controls (Fence Editor palette)
//     onPick: (clip) => {},       // "+" button on a clip
//     onTrim: (clip) => {},       // adds a "Trim" menu item, host page owns the actual trim UI
//     onOpenSession: (session) => {}, // "Open" button on a saved Studio session (mode:'project' only)
//     selectable: false,          // true = a checkbox per clip, for multi-select (e.g. Combine)
//     onSelectionChange: (clips) => {},
//     onError: (msg) => {},       // defaults to alert()
//   });
//   tree.refresh({ orgId: newOrg });   // re-fetch, optionally overriding opts
//   tree.getUploadTarget();            // -> {scope, scopeId, folderId} of the selected row
//   tree.getSelectedClips();           // -> clip[] currently checked (selectable mode)
//   tree.revealFolder(scope, folderId); // expands every ancestor so that folder is actually visible
//   tree.destroy();
(function () {
  "use strict";

  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const css = `
      .at-root{font-family:"Barlow Condensed",system-ui,sans-serif;font-size:13px;color:var(--snow,#fff);user-select:none}
      .at-row{display:flex;align-items:center;gap:5px;padding:5px 4px;border-radius:6px;cursor:pointer;position:relative}
      .at-row:hover{background:rgba(255,255,255,.04)}
      .at-row.selected{background:rgba(255,106,61,.15)}
      .at-row.dragover{background:rgba(255,106,61,.22);outline:1px dashed var(--coral,#ff6a3d)}
      .at-chevron{width:14px;flex:0 0 14px;text-align:center;color:var(--fog,#8aa5bf);font-size:10px}
      .at-icon{flex:0 0 auto}
      .at-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .at-name input{width:100%;box-sizing:border-box}
      .at-meta{flex:0 0 auto;color:var(--fog,#8aa5bf);font-size:11px}
      .at-btn{flex:0 0 auto;background:none;border:none;color:var(--ice,#c8dff2);cursor:pointer;font-size:12px;padding:2px 5px;border-radius:5px}
      .at-btn:hover{background:rgba(255,255,255,.08)}
      .at-children{margin-left:18px;border-left:1px solid var(--rim,#2e3f58);padding-left:2px}
      .at-empty{color:var(--fog,#8aa5bf);font-size:11px;padding:6px 4px}
      .at-menu{position:absolute;z-index:80;top:100%;right:4px;background:var(--slate-2,#1b2738);
        border:1px solid var(--rim,#2e3f58);border-radius:8px;box-shadow:0 8px 20px rgba(0,0,0,.45);
        min-width:150px;overflow:hidden}
      .at-menu-item{display:block;width:100%;text-align:left;background:none;border:none;color:var(--snow,#fff);
        padding:8px 12px;font-family:"Barlow Condensed";font-size:12px;cursor:pointer}
      .at-menu-item:hover{background:rgba(255,255,255,.06)}
      .at-menu-item.danger{color:var(--hazard,#ff2f4e)}
      .at-picker{padding:4px;max-height:220px;overflow-y:auto}
      .at-picker-item{padding:6px 10px;border-radius:5px;cursor:pointer;font-size:12px;white-space:nowrap}
      .at-picker-item:hover{background:rgba(255,106,61,.15)}
      .at-picker-item input{width:100%;box-sizing:border-box;font-size:12px}
      .at-toolbar{display:flex;gap:6px;padding:4px 2px 8px}
    `;
    const s = document.createElement("style");
    s.textContent = css;
    document.head.appendChild(s);
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function fmtExpiry(ts) {
    const ms = ts - Date.now(); if (ms <= 0) return "expiring…";
    const m = Math.round(ms / 60000);
    return m < 60 ? ("expires in " + m + "m") : ("expires in " + Math.round(m / 60) + "h");
  }
  function fmtSize(n) {
    if (n == null) return "";
    const kb = n / 1024;
    return kb > 1024 ? (kb / 1024).toFixed(1) + " MB" : Math.round(kb) + " KB";
  }

  function buildTree(scope, scopeId, folders, clips, sessions, scripts) {
    const byId = new Map();
    const root = { id: null, name: null, parentId: null, scope, scopeId, children: [], clips: [], sessions: [], scripts: [] };
    byId.set(null, root);
    (folders || []).forEach(f => byId.set(f.id, { id: f.id, name: f.name, parentId: f.parentId, scope, scopeId, children: [], clips: [], sessions: [], scripts: [] }));
    (folders || []).forEach(f => {
      const node = byId.get(f.id);
      const parent = byId.get(f.parentId) || root;
      parent.children.push(node);
    });
    (clips || []).forEach(c => {
      const parent = byId.get(c.folderId) || root;
      parent.clips.push({ ...c, scope, scopeId });
    });
    (sessions || []).forEach(s => {
      const parent = byId.get(s.folderId) || root;
      parent.sessions.push({ ...s, scope, scopeId });
    });
    (scripts || []).forEach(s => {
      const parent = byId.get(s.folderId) || root;
      parent.scripts.push({ ...s, scope, scopeId });
    });
    (function sortRec(node) {
      node.children.sort((a, b) => a.name.localeCompare(b.name));
      node.clips.sort((a, b) => a.name.localeCompare(b.name));
      node.sessions.sort((a, b) => a.name.localeCompare(b.name));
      node.scripts.sort((a, b) => a.name.localeCompare(b.name));
      node.children.forEach(sortRec);
    })(root);
    return root;
  }

  function mount(el, opts) {
    injectStyles();
    opts = Object.assign({ mode: "project", readOnly: false }, opts);
    el.innerHTML = "";
    el.classList.add("at-root");

    const state = {
      expanded: new Set(),      // "scope:folderId" (folderId "root" for the two pinned roots)
      seenRoots: new Set(),     // which root keys have already gotten their one-time default-expanded seed
      selected: null,           // {scope, scopeId, folderId}
      projectRoot: null,        // tree root for mode:'project'
      libraryRoot: null,        // tree root for the pinned/standalone Library
      projectMeta: null,        // {scopeId}
      libraryMeta: null,        // {scopeId}
      openMenu: null,
      sharedAudio: new Audio(),
      selectedClips: new Map(), // clip.id -> clip, only populated when opts.selectable
      parentById: new Map()     // "project"|"library" -> Map(folderId -> parentId), for revealFolder's ancestor walk
    };
    // Roots start expanded the first time they appear, but stay collapsible
    // after that — re-seeding on every load() would undo the user's own
    // collapse the moment anything else triggers a refresh.
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
    // Named + removed in destroy() — every mount() call used to add its own
    // permanent document-level listener with no way to remove it, so a page
    // that remounts on every project/client switch (chatterbox-studio.html
    // does, on every dropdown change) leaked one closure (holding the whole
    // old state/DOM) per switch for the rest of the session.
    function onDocMousedown(e) {
      if (state.openMenu && !state.openMenu.contains(e.target)) closeMenu();
    }
    document.addEventListener("mousedown", onDocMousedown);

    async function load() {
      if (opts.mode === "project") {
        if (!opts.projectId) { el.innerHTML = '<div class="at-empty">no project selected</div>'; return; }
        let qs = "project=" + encodeURIComponent(opts.projectId);
        if (opts.orgId) qs += "&org=" + encodeURIComponent(opts.orgId);
        const j = await api("/api/audio/tree?" + qs);
        state.projectRoot = buildTree("project", opts.projectId, j.project.folders, j.project.clips, j.project.sessions, j.project.scripts);
        state.projectMeta = { scopeId: opts.projectId };
        state.parentById.set("project", new Map((j.project.folders || []).map(f => [f.id, f.parentId])));
        seedRootExpanded("project:root");
        if (j.library) {
          state.libraryRoot = buildTree("library", j.library.scopeId, j.library.folders, j.library.clips);
          state.libraryMeta = { scopeId: j.library.scopeId };
          state.parentById.set("library", new Map((j.library.folders || []).map(f => [f.id, f.parentId])));
          seedRootExpanded("library:root");
        } else { state.libraryRoot = null; state.libraryMeta = null; state.parentById.delete("library"); }
        if (!state.selected) state.selected = { scope: "project", scopeId: opts.projectId, folderId: null };
      } else {
        if (!opts.orgId) { el.innerHTML = '<div class="at-empty">pick a company above</div>'; return; }
        const j = await api("/api/audio/tree?scope=library&org=" + encodeURIComponent(opts.orgId));
        state.libraryRoot = buildTree("library", opts.orgId, j.library.folders, j.library.clips);
        state.libraryMeta = { scopeId: opts.orgId };
        state.parentById.set("library", new Map((j.library.folders || []).map(f => [f.id, f.parentId])));
        seedRootExpanded("library:root");
        state.projectRoot = null; state.projectMeta = null; state.parentById.delete("project");
        if (!state.selected || state.selected.scopeId !== opts.orgId) state.selected = { scope: "library", scopeId: opts.orgId, folderId: null };
      }
      render();
    }
    // Expands every ancestor of a folder (and the folder itself) so it's
    // actually visible after e.g. an upload/export lands inside a folder
    // that happened to be collapsed — otherwise the new file is really
    // there, just invisible, which reads as "it didn't work."
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

    // Flat [{label, scope, scopeId, folderId}] of every folder (+root) across
    // whichever trees are loaded — feeds the Move/Copy target picker.
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
      // Resolve the stable .at-row BEFORE closeMenu() runs — when opened
      // from "Copy to…"/"Move to…" inside the first-level menu, anchorBtn's
      // ancestor chain runs through that menu, and closeMenu() below detaches
      // it (severing the link back to .at-row) as its very first act.
      // Resolving anchorBtn.closest(".at-row") any later finds nothing.
      const rowEl = anchorBtn.closest(".at-row") || anchorBtn.parentElement;
      closeMenu();
      const wrap = document.createElement("div");
      wrap.className = "at-menu at-picker";

      // "New folder…" creates it under wherever's currently selected in the
      // main tree (same default the toolbar's own "+ New folder" uses), then
      // immediately hands it to onPick — one step, matching how Drive-style
      // move/copy dialogs let you create-and-target a folder in one motion.
      const newRow = document.createElement("div");
      newRow.className = "at-picker-item";
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
            const created = await api("/api/audio-folder", {
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
        row.className = "at-picker-item";
        row.textContent = "📁 " + t.label;
        row.onmousedown = e => { e.preventDefault(); e.stopPropagation(); closeMenu(); onPick(t); };
        wrap.appendChild(row);
      });
      rowEl.appendChild(wrap);
      state.openMenu = wrap;
    }

    function flipToInput(nameEl, initial, onCommit) {
      const prev = nameEl.textContent;
      nameEl.innerHTML = '<input type="text" maxlength="80">';
      const inp = nameEl.querySelector("input");
      inp.value = initial || ""; inp.focus(); inp.select();
      let done = false;
      const commit = () => {
        if (done) return; done = true;
        const v = inp.value.trim();
        if (v && !v.includes("/")) onCommit(v); else render();
      };
      // Clicking inside the input (to reposition the cursor, select text)
      // must not bubble to the row's own click handler — that toggles
      // expand/select and re-renders, which would wipe this input mid-edit.
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
        await api("/api/audio-folder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope, scopeId, parentId, name }) });
        await load();
      } catch (e) { err("Create folder failed: " + e.message); }
    }
    async function renameFolder(id, name) {
      try { await api("/api/audio-folder/" + id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); await load(); }
      catch (e) { err("Rename failed: " + e.message); }
    }
    async function moveFolder(id, target) {
      try {
        await api("/api/audio-folder/" + id, {
          method: "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify({ parentId: target.folderId, targetScope: target.scope, targetScopeId: target.scopeId })
        });
        await load();
      } catch (e) { err("Move failed: " + e.message); }
    }
    async function copyFolder(id, targetScope, targetScopeId, targetParentId) {
      try { await api("/api/audio-folder/" + id + "/copy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetScope, targetScopeId, targetParentId }) }); await load(); }
      catch (e) { err("Copy failed: " + e.message); }
    }
    async function deleteFolder(id, label) {
      if (!confirm('Delete the folder "' + label + '" and everything in it? This cannot be undone.')) return;
      try { await api("/api/audio-folder/" + id, { method: "DELETE" }); await load(); }
      catch (e) { err("Delete failed: " + e.message); }
    }
    async function renameClip(id, name) {
      try { await api("/api/audio-clip/" + id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); await load(); }
      catch (e) { err("Rename failed: " + e.message); }
    }
    async function moveClip(id, target) {
      try {
        await api("/api/audio-clip/" + id, {
          method: "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: target.scope, scopeId: target.scopeId, folderId: target.folderId })
        });
        await load();
      } catch (e) { err("Move failed: " + e.message); }
    }
    async function copyClip(id, target) {
      try {
        await api("/api/audio-clip/" + id + "/copy", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetScope: target.scope, targetScopeId: target.scopeId, targetFolderId: target.folderId })
        });
        await load();
      } catch (e) { err("Copy failed: " + e.message); }
    }
    async function deleteClip(id, name) {
      if (!confirm('Delete "' + name + '"? This cannot be undone.')) return;
      try { await api("/api/audio-clip/" + id, { method: "DELETE" }); await load(); }
      catch (e) { err("Delete failed: " + e.message); }
    }
    async function renameSession(id, name) {
      try { await api("/api/studio-session/" + id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); await load(); }
      catch (e) { err("Rename failed: " + e.message); }
    }
    async function moveSession(id, target) {
      try {
        await api("/api/studio-session/" + id, {
          method: "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify({ folderId: target.folderId })
        });
        await load();
      } catch (e) { err("Move failed: " + e.message); }
    }
    async function copySession(id, target) {
      try {
        await api("/api/studio-session/" + id + "/copy", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetFolderId: target.folderId })
        });
        await load();
      } catch (e) { err("Copy failed: " + e.message); }
    }
    async function deleteSession(id, name) {
      if (!confirm('Delete the saved session "' + name + '"? This cannot be undone.')) return;
      try { await api("/api/studio-session/" + id, { method: "DELETE" }); await load(); }
      catch (e) { err("Delete failed: " + e.message); }
    }
    async function renameScript(id, name) {
      try { await api("/api/chatterbox-script/" + id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); await load(); }
      catch (e) { err("Rename failed: " + e.message); }
    }
    async function moveScript(id, target) {
      try {
        await api("/api/chatterbox-script/" + id, {
          method: "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify({ folderId: target.folderId })
        });
        await load();
      } catch (e) { err("Move failed: " + e.message); }
    }
    async function copyScript(id, target) {
      try {
        await api("/api/chatterbox-script/" + id + "/copy", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetFolderId: target.folderId })
        });
        await load();
      } catch (e) { err("Copy failed: " + e.message); }
    }
    async function deleteScript(id, name) {
      if (!confirm('Delete the saved script "' + name + '"? This cannot be undone.')) return;
      try { await api("/api/chatterbox-script/" + id, { method: "DELETE" }); await load(); }
      catch (e) { err("Delete failed: " + e.message); }
    }

    function togglePlay(clip, btn) {
      const a = state.sharedAudio;
      if (state._playingId === clip.id) { a.pause(); state._playingId = null; btn.textContent = "▶"; return; }
      if (state._playingBtn) state._playingBtn.textContent = "▶";
      a.src = clip.url; a.play();
      a.onended = () => { btn.textContent = "▶"; state._playingId = null; };
      state._playingId = clip.id; state._playingBtn = btn; btn.textContent = "⏸";
    }

    function selectRow(rowEl, sel) {
      el.querySelectorAll(".at-row.selected").forEach(r => r.classList.remove("selected"));
      rowEl.classList.add("selected");
      state.selected = sel;
    }

    function renderClipMenu(anchorBtn, clip) {
      closeMenu();
      const menu = document.createElement("div"); menu.className = "at-menu";
      const renameBtn = document.createElement("button"); renameBtn.className = "at-menu-item"; renameBtn.textContent = "✎ Rename";
      renameBtn.onclick = e => { e.stopPropagation(); closeMenu(); const nameEl = anchorBtn.closest(".at-row").querySelector(".at-name"); flipToInput(nameEl, clip.name, v => renameClip(clip.id, v)); };
      menu.appendChild(renameBtn);
      if (opts.onTrim) {
        const trimBtn = document.createElement("button"); trimBtn.className = "at-menu-item"; trimBtn.textContent = "✂ Trim";
        trimBtn.onclick = e => { e.stopPropagation(); closeMenu(); opts.onTrim(clip); };
        menu.appendChild(trimBtn);
      }
      const copyUrlBtn = document.createElement("button"); copyUrlBtn.className = "at-menu-item"; copyUrlBtn.textContent = "⧉ Copy URL";
      copyUrlBtn.onclick = e => {
        e.stopPropagation();
        closeMenu();
        navigator.clipboard && navigator.clipboard.writeText(location.origin + clip.url).catch(() => {});
      };
      menu.appendChild(copyUrlBtn);
      const copyBtn = document.createElement("button"); copyBtn.className = "at-menu-item"; copyBtn.textContent = "⧉ Copy to…";
      copyBtn.onclick = e => { e.stopPropagation(); openPicker(copyBtn, { onPick: t => copyClip(clip.id, t) }); };
      menu.appendChild(copyBtn);
      const moveBtn = document.createElement("button"); moveBtn.className = "at-menu-item"; moveBtn.textContent = "📁 Move to…";
      moveBtn.onclick = e => { e.stopPropagation(); openPicker(moveBtn, { onPick: t => moveClip(clip.id, t) }); };
      menu.appendChild(moveBtn);
      const delBtn = document.createElement("button"); delBtn.className = "at-menu-item danger"; delBtn.textContent = "🗑 Delete";
      delBtn.onclick = e => { e.stopPropagation(); closeMenu(); deleteClip(clip.id, clip.name); };
      menu.appendChild(delBtn);
      anchorBtn.parentElement.appendChild(menu);
      state.openMenu = menu;
    }

    function renderSessionMenu(anchorBtn, session) {
      closeMenu();
      const menu = document.createElement("div"); menu.className = "at-menu";
      const renameBtn = document.createElement("button"); renameBtn.className = "at-menu-item"; renameBtn.textContent = "✎ Rename";
      renameBtn.onclick = e => { e.stopPropagation(); closeMenu(); const nameEl = anchorBtn.closest(".at-row").querySelector(".at-name"); flipToInput(nameEl, session.name, v => renameSession(session.id, v)); };
      menu.appendChild(renameBtn);
      const copyBtn = document.createElement("button"); copyBtn.className = "at-menu-item"; copyBtn.textContent = "⧉ Copy to…";
      copyBtn.onclick = e => { e.stopPropagation(); openPicker(copyBtn, { filterScope: "project", onPick: t => copySession(session.id, t) }); };
      menu.appendChild(copyBtn);
      const moveBtn = document.createElement("button"); moveBtn.className = "at-menu-item"; moveBtn.textContent = "📁 Move to…";
      moveBtn.onclick = e => { e.stopPropagation(); openPicker(moveBtn, { filterScope: "project", onPick: t => moveSession(session.id, t) }); };
      menu.appendChild(moveBtn);
      const delBtn = document.createElement("button"); delBtn.className = "at-menu-item danger"; delBtn.textContent = "🗑 Delete";
      delBtn.onclick = e => { e.stopPropagation(); closeMenu(); deleteSession(session.id, session.name); };
      menu.appendChild(delBtn);
      anchorBtn.parentElement.appendChild(menu);
      state.openMenu = menu;
    }

    function renderScriptMenu(anchorBtn, script) {
      closeMenu();
      const menu = document.createElement("div"); menu.className = "at-menu";
      const renameBtn = document.createElement("button"); renameBtn.className = "at-menu-item"; renameBtn.textContent = "✎ Rename";
      renameBtn.onclick = e => { e.stopPropagation(); closeMenu(); const nameEl = anchorBtn.closest(".at-row").querySelector(".at-name"); flipToInput(nameEl, script.name, v => renameScript(script.id, v)); };
      menu.appendChild(renameBtn);
      const copyBtn = document.createElement("button"); copyBtn.className = "at-menu-item"; copyBtn.textContent = "⧉ Copy to…";
      copyBtn.onclick = e => { e.stopPropagation(); openPicker(copyBtn, { filterScope: "project", onPick: t => copyScript(script.id, t) }); };
      menu.appendChild(copyBtn);
      const moveBtn = document.createElement("button"); moveBtn.className = "at-menu-item"; moveBtn.textContent = "📁 Move to…";
      moveBtn.onclick = e => { e.stopPropagation(); openPicker(moveBtn, { filterScope: "project", onPick: t => moveScript(script.id, t) }); };
      menu.appendChild(moveBtn);
      const delBtn = document.createElement("button"); delBtn.className = "at-menu-item danger"; delBtn.textContent = "🗑 Delete";
      delBtn.onclick = e => { e.stopPropagation(); closeMenu(); deleteScript(script.id, script.name); };
      menu.appendChild(delBtn);
      anchorBtn.parentElement.appendChild(menu);
      state.openMenu = menu;
    }

    function renderFolderMenu(anchorBtn, node, scope, scopeId) {
      closeMenu();
      const menu = document.createElement("div"); menu.className = "at-menu";
      const newSub = document.createElement("button"); newSub.className = "at-menu-item"; newSub.textContent = "＋ New subfolder";
      newSub.onclick = e => { e.stopPropagation(); closeMenu(); createFolder(scope, scopeId, node.id, "New folder"); };
      menu.appendChild(newSub);
      if (node.id) {
        const renameBtn = document.createElement("button"); renameBtn.className = "at-menu-item"; renameBtn.textContent = "✎ Rename";
        renameBtn.onclick = e => { e.stopPropagation(); closeMenu(); const nameEl = anchorBtn.closest(".at-row").querySelector(".at-name"); flipToInput(nameEl, node.name, v => renameFolder(node.id, v)); };
        menu.appendChild(renameBtn);
        const copyBtn = document.createElement("button"); copyBtn.className = "at-menu-item"; copyBtn.textContent = "⧉ Copy to…";
        copyBtn.onclick = e => { e.stopPropagation(); openPicker(copyBtn, { onPick: t => copyFolder(node.id, t.scope, t.scopeId, t.folderId) }); };
        menu.appendChild(copyBtn);
        const moveBtn = document.createElement("button"); moveBtn.className = "at-menu-item"; moveBtn.textContent = "📁 Move to…";
        moveBtn.onclick = e => { e.stopPropagation(); openPicker(moveBtn, { excludeFolderId: node.id, onPick: t => moveFolder(node.id, t) }); };
        menu.appendChild(moveBtn);
        const delBtn = document.createElement("button"); delBtn.className = "at-menu-item danger"; delBtn.textContent = "🗑 Delete";
        delBtn.onclick = e => { e.stopPropagation(); closeMenu(); deleteFolder(node.id, node.name); };
        menu.appendChild(delBtn);
      }
      anchorBtn.parentElement.appendChild(menu);
      state.openMenu = menu;
    }

    function renderClipRow(clip) {
      const row = document.createElement("div"); row.className = "at-row";
      row.draggable = true;
      row.addEventListener("dragstart", e => {
        e.dataTransfer.setData("audiourl", clip.url);
        e.dataTransfer.setData("audiokey", clip.r2Key || clip.id);
        e.dataTransfer.setData("application/x-audio-clip-id", clip.id);
        // Full clip metadata, for drop targets (Audio Studio's timeline
        // lanes) that need scope/scopeId/folderId/name to correctly track
        // where the dropped clip actually came from — audiourl/audiokey
        // alone aren't enough for that, and dropping previously silently
        // defaulted to "current project" regardless of the clip's real
        // scope (e.g. a Library clip), breaking spatial-filter bake-back.
        e.dataTransfer.setData("application/x-audio-clip-json", JSON.stringify({
          name: clip.name, r2Key: clip.r2Key, scope: clip.scope, scopeId: clip.scopeId, folderId: clip.folderId || null, url: clip.url
        }));
        e.dataTransfer.effectAllowed = "copyMove";
      });
      if (opts.selectable) {
        const cb = document.createElement("input"); cb.type = "checkbox";
        cb.checked = state.selectedClips.has(clip.id);
        cb.onclick = e => e.stopPropagation();
        cb.onchange = () => {
          if (cb.checked) state.selectedClips.set(clip.id, clip); else state.selectedClips.delete(clip.id);
          if (opts.onSelectionChange) opts.onSelectionChange([...state.selectedClips.values()]);
        };
        row.appendChild(cb);
      }
      const playBtn = document.createElement("button"); playBtn.className = "at-btn"; playBtn.textContent = "▶"; playBtn.title = "Preview";
      playBtn.onclick = e => { e.stopPropagation(); togglePlay(clip, playBtn); };
      const icon = document.createElement("span"); icon.className = "at-icon"; icon.textContent = "🎵";
      const name = document.createElement("span"); name.className = "at-name"; name.textContent = clip.name;
      const meta = document.createElement("span"); meta.className = "at-meta";
      meta.textContent = clip.expiresAt ? ("⏳ " + fmtExpiry(clip.expiresAt)) : fmtSize(clip.sizeBytes);
      row.appendChild(playBtn); row.appendChild(icon); row.appendChild(name); row.appendChild(meta);
      if (opts.onPick) {
        const pickBtn = document.createElement("button"); pickBtn.className = "at-btn"; pickBtn.textContent = "+"; pickBtn.title = "Use this clip";
        pickBtn.onclick = e => { e.stopPropagation(); opts.onPick(clip); };
        row.appendChild(pickBtn);
      }
      if (!opts.readOnly) {
        const moreBtn = document.createElement("button"); moreBtn.className = "at-btn"; moreBtn.textContent = "⋯"; moreBtn.title = "Rename, move, copy, or delete";
        moreBtn.onclick = e => { e.stopPropagation(); renderClipMenu(moreBtn, clip); };
        row.appendChild(moreBtn);
      }
      return row;
    }

    // A saved Studio arrangement — which clips, trim points, fades, gain,
    // spatial filter, but no audio of its own. Lives in the same folders as
    // the clips it references (an Act/Scene structure is just folders).
    function renderSessionRow(session) {
      const row = document.createElement("div"); row.className = "at-row";
      const icon = document.createElement("span"); icon.className = "at-icon"; icon.textContent = "🎚";
      const name = document.createElement("span"); name.className = "at-name"; name.textContent = session.name;
      const meta = document.createElement("span"); meta.className = "at-meta";
      meta.textContent = session.updatedAt ? new Date(session.updatedAt).toLocaleDateString() : "";
      row.appendChild(icon); row.appendChild(name); row.appendChild(meta);
      if (opts.onOpenSession) {
        const openBtn = document.createElement("button"); openBtn.className = "at-btn"; openBtn.textContent = "Open"; openBtn.title = "Open in Studio";
        openBtn.onclick = e => { e.stopPropagation(); opts.onOpenSession(session); };
        row.appendChild(openBtn);
      }
      if (!opts.readOnly) {
        const moreBtn = document.createElement("button"); moreBtn.className = "at-btn"; moreBtn.textContent = "⋯"; moreBtn.title = "Rename, move, copy, or delete";
        moreBtn.onclick = e => { e.stopPropagation(); renderSessionMenu(moreBtn, session); };
        row.appendChild(moreBtn);
      }
      return row;
    }

    // A saved Chatterbox script (pasted text + per-line voice tagging +
    // generated-audio-URL state) — lives in the same folders as the clips it
    // produced, a straight parallel of renderSessionRow above.
    function renderScriptRow(script) {
      const row = document.createElement("div"); row.className = "at-row";
      row.draggable = true;
      row.addEventListener("dragstart", e => {
        e.dataTransfer.setData("application/x-chatterbox-script-id", script.id);
        e.dataTransfer.effectAllowed = "copy";
      });
      const icon = document.createElement("span"); icon.className = "at-icon"; icon.textContent = "📜";
      const name = document.createElement("span"); name.className = "at-name"; name.textContent = script.name;
      const meta = document.createElement("span"); meta.className = "at-meta";
      meta.textContent = script.updatedAt ? new Date(script.updatedAt).toLocaleDateString() : "";
      row.appendChild(icon); row.appendChild(name); row.appendChild(meta);
      if (opts.onOpenScript) {
        const openBtn = document.createElement("button"); openBtn.className = "at-btn"; openBtn.textContent = "Open"; openBtn.title = "Open in Chatterbox";
        openBtn.onclick = e => { e.stopPropagation(); opts.onOpenScript(script); };
        row.appendChild(openBtn);
      }
      if (!opts.readOnly) {
        const moreBtn = document.createElement("button"); moreBtn.className = "at-btn"; moreBtn.textContent = "⋯"; moreBtn.title = "Rename, move, copy, or delete";
        moreBtn.onclick = e => { e.stopPropagation(); renderScriptMenu(moreBtn, script); };
        row.appendChild(moreBtn);
      }
      return row;
    }

    function renderFolderNode(node, scope, scopeId, depth, labelOverride, isRoot) {
      const wrap = document.createElement("div");
      const row = document.createElement("div"); row.className = "at-row";
      const key = scope + ":" + (node.id || "root");
      // Every row is toggleable, roots included — they just start expanded
      // (seedRootExpanded, in load()) the first time they appear. A folder
      // is toggleable even brand-new/empty, so an empty one still expands to
      // show the "empty" placeholder below, confirming the click did something.
      const expanded = state.expanded.has(key);
      const toggleExpand = () => { if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key); render(); };

      const chevron = document.createElement("span"); chevron.className = "at-chevron";
      chevron.textContent = expanded ? "▾" : "▸";
      chevron.onclick = e => { e.stopPropagation(); toggleExpand(); };
      const icon = document.createElement("span"); icon.className = "at-icon"; icon.textContent = isRoot ? (labelOverride ? "📚" : "📂") : "📁";
      const name = document.createElement("span"); name.className = "at-name"; name.textContent = labelOverride || node.name;
      row.appendChild(chevron); row.appendChild(icon); row.appendChild(name);

      if (!opts.readOnly) {
        const moreBtn = document.createElement("button"); moreBtn.className = "at-btn"; moreBtn.textContent = "⋯";
        moreBtn.onclick = e => { e.stopPropagation(); renderFolderMenu(moreBtn, node, scope, scopeId); };
        row.appendChild(moreBtn);
      }

      // Clicking anywhere on the row (not just the tiny chevron) both selects
      // it as the upload target and toggles expand — roots included.
      row.onclick = () => { selectRow(row, { scope, scopeId, folderId: node.id }); toggleExpand(); };
      if (state.selected && state.selected.scope === scope && state.selected.scopeId === scopeId && state.selected.folderId === node.id) row.classList.add("selected");

      if (!opts.readOnly) {
        row.draggable = !isRoot; // real folders are drag sources for reparenting; roots aren't (nothing to move)
        if (row.draggable) {
          row.addEventListener("dragstart", e => {
            e.stopPropagation();
            e.dataTransfer.setData("application/x-audio-folder-id", node.id);
            e.dataTransfer.effectAllowed = "move";
          });
        }
        row.addEventListener("dragover", e => {
          if (e.dataTransfer.types.includes("application/x-audio-clip-id")) { e.preventDefault(); row.classList.add("dragover"); return; }
          if (e.dataTransfer.types.includes("application/x-audio-folder-id")) {
            e.preventDefault(); row.classList.add("dragover");
          }
        });
        row.addEventListener("dragleave", () => row.classList.remove("dragover"));
        row.addEventListener("drop", e => {
          e.preventDefault(); e.stopPropagation(); row.classList.remove("dragover");
          const clipId = e.dataTransfer.getData("application/x-audio-clip-id");
          if (clipId) { moveClip(clipId, { scope, scopeId, folderId: node.id }); return; }
          const folderId = e.dataTransfer.getData("application/x-audio-folder-id");
          if (folderId && folderId !== node.id) moveFolder(folderId, { scope, scopeId, folderId: node.id });
        });
      }

      wrap.appendChild(row);

      if (expanded) {
        const kids = document.createElement("div"); kids.className = "at-children";
        node.children.forEach(child => kids.appendChild(renderFolderNode(child, scope, scopeId, depth + 1, null, false)));
        node.sessions.forEach(session => kids.appendChild(renderSessionRow(session)));
        node.scripts.forEach(script => kids.appendChild(renderScriptRow(script)));
        node.clips.forEach(clip => kids.appendChild(renderClipRow(clip)));
        if (!node.children.length && !node.clips.length && !node.sessions.length && !node.scripts.length) { const e2 = document.createElement("div"); e2.className = "at-empty"; e2.textContent = "empty"; kids.appendChild(e2); }
        wrap.appendChild(kids);
      }
      return wrap;
    }

    function render() {
      el.innerHTML = "";
      if (!opts.readOnly) {
        const toolbar = document.createElement("div"); toolbar.className = "at-toolbar";
        const newFolderBtn = document.createElement("button"); newFolderBtn.className = "at-btn"; newFolderBtn.textContent = "＋ New folder";
        newFolderBtn.onclick = () => {
          const sel = state.selected || (state.projectRoot ? { scope: "project", scopeId: state.projectMeta.scopeId, folderId: null } : { scope: "library", scopeId: state.libraryMeta.scopeId, folderId: null });
          createFolder(sel.scope, sel.scopeId, sel.folderId, "New folder");
        };
        toolbar.appendChild(newFolderBtn);
        el.appendChild(toolbar);
      }
      if (state.projectRoot) el.appendChild(renderFolderNode(state.projectRoot, "project", state.projectMeta.scopeId, 0, opts.projectLabel || state.projectMeta.scopeId, true));
      if (state.libraryRoot) el.appendChild(renderFolderNode(state.libraryRoot, "library", state.libraryMeta.scopeId, 0, "Library", true));
      if (!state.projectRoot && !state.libraryRoot) el.innerHTML = '<div class="at-empty">no clips yet</div>';
    }

    load().catch(e => { el.innerHTML = '<div class="at-empty">error: ' + esc(e.message) + "</div>"; });

    return {
      refresh(partial) { Object.assign(opts, partial || {}); return load(); },
      getUploadTarget() { return state.selected || (state.projectRoot ? { scope: "project", scopeId: state.projectMeta.scopeId, folderId: null } : state.libraryRoot ? { scope: "library", scopeId: state.libraryMeta.scopeId, folderId: null } : null); },
      listFolders(filterScope) { return allTargets(filterScope); },
      getSelectedClips() { return [...state.selectedClips.values()]; },
      clearSelection() { state.selectedClips.clear(); render(); },
      revealFolder(scope, folderId) { revealFolder(scope, folderId); },
      destroy() { document.removeEventListener("mousedown", onDocMousedown); el.innerHTML = ""; }
    };
  }

  // Uploads one blob as a brand-new clip via POST /api/audio-clip. Not tied
  // to a mounted instance — host pages call this from their own record/file-
  // picker flows, typically with `tree.getUploadTarget()` as the target.
  //   AudioTree.upload(blob, { scope, scopeId, folderId, name, mimeType, getToken, onProgress })
  function upload(blob, o) {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams({ scope: o.scope, scopeId: o.scopeId, name: o.name });
      if (o.folderId) qs.set("folderId", o.folderId);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/audio-clip?" + qs.toString());
      xhr.setRequestHeader("authorization", "Bearer " + o.getToken());
      xhr.setRequestHeader("content-type", o.mimeType || "application/octet-stream");
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

  window.AudioTree = { mount, upload };
})();
