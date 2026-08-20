// Persistent cross-tool top nav bar — Company/Project pickers + Settings
// gear + tool links, shared across every tool page so switching tools while
// working on one project doesn't mean losing your place. Built 2026-08-07,
// replacing the old homepage-as-hub model (index.html, now unlinked but
// left in place as the reference implementation for the CRUD actions ported
// below — see CLAUDE.md/project memory for the full migration writeup).
//
// Left to right: Company pulldown, Project pulldown, ⚙ Settings, then tool
// links (Edit/Audio Studio/Chatterbox/Code Library/Dashboard/Clients).
//
// Company pulldown wraps client-picker.js unchanged (ClientPicker.init) —
// not forked, so localStorage["gp.activeClient"] stays the one shared
// source of truth everywhere, including pages that still mount ClientPicker
// standalone (e.g. pipeline-editor.html's Code Library sidebar, which is
// deliberately NOT migrated to this module's Company picker — that sidebar
// is a library-scoped filter that's allowed to diverge from the page-level
// company, not "the page's" company selector).
//
// Project pulldown matches searchable-select.js's interaction pattern
// (type-to-filter, custom position:fixed menu, mousedown-not-click rows) but
// is implemented directly here rather than calling searchableSelect() —
// that widget's menu is self-contained with no hook for the extra pinned
// "+ New Project"/"Manage workspaces" rows this dropdown also needs, so
// reusing it as-is would mean two disjoint interactive zones instead of one
// cohesive menu. The management view itself (rename/delete workspace,
// delete project, combine, merge) is ported from index.html's mutating
// actions — same endpoints, same gp.admin token-prompt auth pattern, just
// re-skinned into this dropdown instead of three separate full-screen modals.
//
// Switching Company or Project navigates to a fresh URL by default — every
// tool already re-derives its state from ?project=/?org= at top-of-script
// (no shared router exists), so a real navigation is the simplest way to
// reset state correctly without rewriting each tool's own loading logic.
// Pass onCompanyChange/onProjectChange to hot-swap instead, for pages that
// already have the machinery (Dashboard's refreshForClient, Chatterbox's
// mountTree(), Fence Editor's CodeObjects.refresh()+doAudioRefresh()).
// onProjectChange receives (projectId, projectObj) — the full object from
// the last /api/projects fetch, so a host page doesn't need a redundant
// lookup just to get the project's display name.
//
// init(opts): navEl (required), active (tool-link key to highlight, or
// null), allowAllCompany, defaultCompany (a fallback org id used — both
// functionally and for display — when nothing's been picked/stored yet,
// e.g. an admin's own home org; matches the pattern dashboard.html's own
// orgParam() already used before this module existed), onCompanyChange,
// onProjectChange.
//
// renderSettings(popoverEl): if provided, the ⚙ gear button shows (hidden
// otherwise) and this is called exactly once, the first time it's ever
// clicked, with the popover's real container element — build/insert the
// host page's own settings content into it then. Each page's content is
// independent; nothing here is shared between pages beyond the container's
// own chrome (position/sizing/background/outside-click-close), by design —
// e.g. Fence Editor's project settings today, potentially different
// per-page defaults on other tools later (Chatterbox, Pipeline Editor,
// etc.) without changing this module.
// onSettingsOpen(popoverEl): optional, called every time the popover is
// about to become visible (including the first, right after
// renderSettings) — for refreshing whatever part of the host's content is
// genuinely live/stale-prone, since renderSettings itself only ever runs
// once.
(function(){
  "use strict";

  const PROJECT_KEY = "gp.activeProject";
  function getProject(){ try{ return localStorage.getItem(PROJECT_KEY)||""; }catch(e){ return ""; } }
  function setProject(id){ try{ id?localStorage.setItem(PROJECT_KEY,id):localStorage.removeItem(PROJECT_KEY); }catch(e){} }
  function resolveProject(){
    const url=new URLSearchParams(location.search).get("project");
    if(url){ setProject(url); return url; }
    return getProject();
  }

  // Sidecar for a project that's been "created" (picked in the Project
  // pulldown, name chosen) but has no D1 row yet — publishing is what
  // actually creates the row (lazy creation, deliberate — see worker.js's
  // createIfMissing), so between those two moments something has to carry
  // the id/name/workspace/org a fresh project was created under. Single
  // slot, like PROJECT_KEY/gp.activeClient — only ever holds the most
  // recently created pending project, not a list.
  const PENDING_KEY = "gp.pendingProject";
  function getPendingProject(){
    try{ const raw=localStorage.getItem(PENDING_KEY); return raw?JSON.parse(raw):null; }catch(e){ return null; }
  }
  function setPendingProject(id, name, appId, orgId){
    setProject(id);
    try{ localStorage.setItem(PENDING_KEY, JSON.stringify({id, name, appId, orgId})); }catch(e){}
  }
  function clearPendingProject(){ try{ localStorage.removeItem(PENDING_KEY); }catch(e){} }

  function getToken(){
    try{ return localStorage.getItem("gp.session")||localStorage.getItem("gp.admin")||""; }catch(e){ return ""; }
  }
  function askToken(){
    let t=getToken();
    if(t) return t;
    t=(prompt("Admin token:")||"").trim();
    if(t){ try{ localStorage.setItem("gp.admin",t); }catch(e){} }
    return t;
  }

  // needsStops: real feedback, 2026-08-12 — a brand-new project has nothing
  // for these four to actually operate on (no stops to attach audio/code
  // objects to, nothing to record against) until at least one real stop has
  // been published. Edit itself, and the two workspace/company-level tools,
  // don't need this — Edit is precisely how a stop gets created in the
  // first place.
  const TOOLS = [
    { key:"edit",         label:"Edit",          href:"/editor" },
    { key:"audio",        label:"Audio Studio",  href:"/studio",       needsStops:true },
    { key:"chatterbox",   label:"Chatterbox",    href:"/chatterbox",   needsStops:true },
    { key:"code-library", label:"Code Library",  href:"/code-library", needsStops:true },
    { key:"record",       label:"Record",        href:"/record",       needsStops:true },
    { key:"dashboard",    label:"Dashboard",     href:"/dashboard" },
    { key:"clients",      label:"Clients",       href:"/clients" }
  ];

  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

  // Single source of truth for "does this project row have a published
  // stop yet" — was previously computed inline, separately, at both
  // selectProject() and init()'s tail, the exact "field parity" duplication
  // pattern this codebase has been bitten by before (see CLAUDE.md's
  // editorToSimBundle() note). zoneCount (server-known) wins when present;
  // hasStops (a locally-pushed just-created row) is the fallback; anything
  // with neither is assumed to already have stops (permissive default, same
  // reasoning as the original inline version — wrongly gating a real
  // existing project shut is worse than the reverse).
  function computeHasStops(p){
    return (p.zoneCount !== undefined) ? (p.zoneCount > 0) : (p.hasStops !== undefined ? p.hasStops : true);
  }

  function toolHref(base, projectId, companyId){
    const parts=[];
    if(projectId) parts.push("project="+encodeURIComponent(projectId));
    if(companyId) parts.push("asClient="+encodeURIComponent(companyId));
    return base + (parts.length ? "?"+parts.join("&") : "");
  }

  const CSS = "font-family:'Barlow Condensed';font-size:13px;background:var(--slate,#141d2b);"
    + "color:var(--snow,#eef4fb);border:1px solid var(--rim,#26344a);border-radius:8px;padding:7px 10px";
  const PILL = "font-family:'Barlow Condensed';font-weight:600;font-size:13px;letter-spacing:.4px;text-transform:uppercase;"
    + "padding:8px 12px;border:1px solid var(--rim,#26344a);border-radius:9px;color:var(--ice,#8fb6d4);"
    + "background:rgba(20,29,43,.5);cursor:pointer;text-decoration:none;display:inline-block";

  async function init(opts){
    opts = opts || {};
    const navEl = opts.navEl;
    if(!navEl) return;
    navEl.innerHTML = "";
    navEl.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px;"
      + "background:var(--slate2,#1b2738);border-bottom:1px solid var(--rim,#26344a)";

    // client-picker.js's own defaultId is display-only (render(), not set())
    // — resolve()/get() stay empty until a real pick happens. Fall back to
    // opts.defaultCompany here too so the Project pulldown/tool-link hrefs
    // work correctly on a first visit, not just look right.
    let company = (window.ClientPicker ? window.ClientPicker.resolve() : "") || opts.defaultCompany || "";
    let project = resolveProject();
    let projects = []; // this company's projects, refetched whenever company changes
    // Defaults true — an existing/already-selected project (picked from the
    // dropdown, or arrived at via a direct ?project= link) is assumed to
    // already have stops; there's no cheap way to know otherwise without an
    // extra fetch, and wrongly gating a real project's tools shut would be
    // far more disruptive than the reverse. Only a project this session
    // just eagerly created (startNewProject) is known to start empty, and
    // only markHasStops() (called by fence-editor.html after a real
    // publish) flips it true from there.
    let projectHasStops = true;

    // ---- Company pulldown ----
    const companySlot = document.createElement("span");
    navEl.appendChild(companySlot);

    // ---- Project pulldown ----
    const projWrap = document.createElement("span");
    projWrap.style.cssText = "position:relative";
    const projInput = document.createElement("input");
    projInput.type = "text"; projInput.placeholder = "Project…"; projInput.autocomplete = "off";
    projInput.style.cssText = CSS + ";width:170px";
    projWrap.appendChild(projInput);
    navEl.appendChild(projWrap);

    // ---- Home link ---- fills the gap left when per-page "<- Home" links
    // (Fence Editor's old breadcrumb, etc.) were dropped as this bar rolled
    // out across every tool — sits directly left of the gear so there's
    // still one consistent way back to "/" regardless of which tool a page
    // is showing settings for.
    const homeLink = document.createElement("a");
    homeLink.href = "/"; homeLink.title = "Home"; homeLink.textContent = "⌂";
    homeLink.style.cssText = "display:inline-flex;align-items:center;justify-content:center;"
      + "background:none;border:1px solid var(--rim,#26344a);color:var(--ice,#8fb6d4);"
      + "border-radius:8px;padding:6px 10px;text-decoration:none;font-size:15px;flex:0 0 auto";
    navEl.appendChild(homeLink);

    // ---- Settings gear ----
    const gearBtn = document.createElement("button");
    gearBtn.textContent = "⚙"; gearBtn.title = "Settings";
    // flex:0 0 auto is deliberate, not decorative — at least one host page
    // (Fence Editor) has a global `button{flex:1 1 auto}` rule that would
    // otherwise stretch this real <button> to fill the row's entire free
    // space (confirmed live: rendered ~630px wide instead of icon-sized).
    // The <a> tool-links next to it aren't affected since they're anchors,
    // not buttons, but this one needs its own explicit override.
    gearBtn.style.cssText = "background:none;border:1px solid var(--rim,#26344a);color:var(--ice,#8fb6d4);"
      + "border-radius:8px;padding:6px 10px;cursor:pointer;font-size:15px;flex:0 0 auto";
    navEl.appendChild(gearBtn);
    let gearPopover = null;
    if(opts.renderSettings){
      gearBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleGearPopover(); });
    } else {
      gearBtn.style.display = "none"; // no-op when the host page has nothing to put in it
    }
    function closeGearPopover(){ if(gearPopover){ gearPopover.style.display="none"; } }
    function toggleGearPopover(){
      if(!gearPopover){
        gearPopover = document.createElement("div");
        gearPopover.id = "topNavSettingsPopover";
        // min-width intentionally tight (2026-08-08) — just enough for the
        // dot-buttons/selects inside Fence Editor's settings to stay usable,
        // not the wider fixed panel this content used to live in as its own
        // floating popover. Revisit if a future renderSettings consumer
        // needs more room than this.
        gearPopover.style.cssText = "position:fixed;z-index:600;min-width:180px;max-width:92vw;max-height:75vh;"
          + "overflow-y:auto;background:var(--slate2,#1b2738);border:1px solid var(--rim,#26344a);border-radius:10px;"
          + "box-shadow:0 8px 20px rgba(0,0,0,.45);padding:10px;display:none";
        document.body.appendChild(gearPopover); // top-level sibling of <body>'s children — never nested inside a
        opts.renderSettings(gearPopover);       // page's own backdrop-filter panel, which would clip position:fixed descendants
      }
      if(gearPopover.style.display !== "none"){ closeGearPopover(); return; }
      // Runs on every open, not just the first (renderSettings above is
      // build-once) — for host content with genuinely live bits (Fence
      // Editor's attached Code Objects chip list) that need refreshing each
      // time, the same way the page's own popover-open handler used to
      // before this content lived in a shared, page-agnostic container.
      if(opts.onSettingsOpen) opts.onSettingsOpen(gearPopover);
      gearPopover.style.display = "block"; gearPopover.style.visibility = "hidden";
      const ar = gearBtn.getBoundingClientRect(), mr = gearPopover.getBoundingClientRect();
      let top = ar.bottom + 4;
      if(top + mr.height > window.innerHeight) top = Math.max(4, ar.top - mr.height - 4);
      let left = Math.min(ar.left, window.innerWidth - mr.width - 4);
      gearPopover.style.top = top+"px"; gearPopover.style.left = Math.max(4,left)+"px"; gearPopover.style.visibility = "visible";
    }
    // click, not mousedown — this popover may host native <select> elements
    // (e.g. Fence Editor's dot-slider rows), whose own option-list clicks
    // would otherwise be misread as an outside click by a mousedown listener.
    document.addEventListener("click", (e) => {
      if(gearPopover && gearPopover.style.display!=="none" && !gearPopover.contains(e.target) && e.target!==gearBtn) closeGearPopover();
    });

    // ---- Tool links ----
    // Gated on !company||!project — no tool is reachable until both a
    // workspace and a project are selected, no exceptions (Dashboard/Clients
    // included, per explicit product decision even though those two pages
    // have no internal notion of "project" today). An href-less <a> drops
    // out of tab order and does nothing on click/Enter by construction, so
    // there's no separate click-handler/keyboard-a11y gap to also patch.
    const toolLinks = {};
    TOOLS.forEach(t => {
      const a = document.createElement("a");
      a.textContent = t.label;
      a.style.cssText = PILL;
      if(t.key === opts.active){ a.style.color = "var(--snow,#eef4fb)"; a.style.borderColor = "var(--coral,#ff6a3d)"; }
      navEl.appendChild(a);
      toolLinks[t.key] = a;
    });
    function refreshToolHrefs(){
      const baseGated = !company || !project;
      TOOLS.forEach(t => {
        const a = toolLinks[t.key];
        const gated = baseGated || (t.needsStops && !projectHasStops);
        if(gated){
          a.removeAttribute("href");
          a.setAttribute("aria-disabled","true");
          a.title = baseGated ? "Select a workspace and project first" : "Add at least one stop in Edit first";
          a.style.opacity = "0.4"; a.style.cursor = "not-allowed";
        } else {
          a.href = toolHref(t.href, project, company);
          a.removeAttribute("aria-disabled");
          a.title = "";
          a.style.opacity = ""; a.style.cursor = "";
        }
      });
    }
    refreshToolHrefs();
    // markHasStops needs projectHasStops/refreshToolHrefs, both local to
    // this init() closure (one shared nav bar per page load) — attached
    // onto the shared window.TopNav object here rather than as a plain
    // module-level export, since there's no per-page closure to reach at
    // that outer scope. Called by fence-editor.html right after a real
    // (non-empty) publish succeeds, to unlock the needsStops tools.
    window.TopNav.markHasStops = function(id){
      if(id !== project) return; // stale call from a page the user already navigated away from
      projectHasStops = true;
      const entry = projects.find(p => p.id === id);
      if(entry) entry.hasStops = true;
      refreshToolHrefs();
    };
    // Real bug, 2026-08-13: deleting a project from index.html's own
    // Client->Project tree ("..." menu -> Delete) only ever refreshed that
    // tree's own separate fetch (via its local load()) — TopNav mounts a
    // SECOND, independent copy of the project list for its own Project
    // pulldown, and nothing told *that* one to refetch. A deleted (or
    // multiple-clicks-duplicated-then-cleaned-up) project kept showing in
    // the pulldown, confirmed live via screenshot, until a full page
    // reload or company switch happened to force loadProjects() again.
    // The Manage-workspaces panel's own inline delete handler already got
    // this right (loadProjects() + clear selection if it was active) —
    // exposing the same sequence here so any other page's mutation (not
    // just this panel's own UI) can trigger the same refresh.
    window.TopNav.refreshProjects = async function(){
      await loadProjects();
      if(project && !projects.some(p => p.id === project)){
        project = ""; setProject(""); projInput.value = ""; projectHasStops = true;
      }
      refreshToolHrefs();
    };

    // ---- Project pulldown behavior ----
    let menu = null, highlighted = -1;
    function closeMenu(){ if(menu){ menu.remove(); menu=null; highlighted=-1; document.removeEventListener("mousedown", onDocDown, true); } }
    function onDocDown(e){ if(menu && !menu.contains(e.target) && e.target!==projInput) closeMenu(); }

    async function loadProjects(){
      projects = [];
      if(!company) return;
      try{
        const r = await fetch("/api/projects?org="+encodeURIComponent(company), { headers:{authorization:"Bearer "+getToken()} });
        if(r.ok) projects = (await r.json()).projects || [];
      }catch(e){}
      // A just-created project has no D1 row until first Publish, so it
      // never comes back from the fetch above — without this, navigating to
      // a second gated page re-fetches from scratch and the Project
      // pulldown goes blank even though gating correctly shows the tools as
      // unlocked. Splice it back in from the sidecar whenever it matches
      // this company and isn't already in the real list (i.e. hasn't been
      // published yet).
      const pending = getPendingProject();
      if(pending && pending.orgId === company && !projects.some(p => p.id === pending.id)){
        // hasStops:false explicit here (not left undefined) — a pending
        // sidecar entry is by definition a project that hasn't been
        // published yet, so computeHasStops() must never fall through to
        // its permissive default for this row.
        projects.push({ id: pending.id, name: pending.name, appId: pending.appId, orgId: pending.orgId, _pending: true, hasStops: false });
      }
    }
    function findUnfinishedProject(){
      // Real feedback, 2026-08-13: startNewProject() eagerly creates a real
      // D1 row on every click with no check for an existing one already
      // sitting empty — clicking "+ New Project" a few times in a row
      // silently produced that many stopless projects. This scans the
      // current company's own project list (already loaded/kept fresh by
      // loadProjects()) for the first one with no published stop; the
      // "+ New Project" row itself is blocked whenever this returns non-null.
      return projects.find(p => !computeHasStops(p));
    }
    function projectLabel(p){ return p.name || p.id; }
    function selectProject(p){
      project = p.id; setProject(project);
      projectHasStops = computeHasStops(p);
      projInput.value = projectLabel(p);
      closeMenu();
      refreshToolHrefs();
      if(opts.onProjectChange){ opts.onProjectChange(project, p); return; }
      location.href = toolHref(location.pathname, project, company);
    }

    function openMenu(filterText){
      closeMenu();
      if(!company){
        menu = document.createElement("div");
        menu.style.cssText = menuBoxCss();
        menu.innerHTML = '<div style="padding:8px 10px;color:var(--fog,#5b7088);font-size:12px">pick a company first</div>';
        document.body.appendChild(menu);
        document.addEventListener("mousedown", onDocDown, true);
        return;
      }
      const q = (filterText||"").trim().toLowerCase();
      const matches = projects.filter(p => !q || projectLabel(p).toLowerCase().includes(q)).slice(0,200);
      menu = document.createElement("div");
      menu.style.cssText = menuBoxCss();

      const blockingProject = findUnfinishedProject();
      const newRow = document.createElement("div");
      newRow.textContent = "+ New Project";
      if(blockingProject){
        // Real feedback, 2026-08-13: block rather than create a second
        // eagerly-created empty project — see findUnfinishedProject() above.
        newRow.title = "Finish \""+projectLabel(blockingProject)+"\" first";
        newRow.style.cssText = "padding:8px 10px;cursor:not-allowed;color:var(--fog,#5b7088);font-weight:600;border-bottom:1px solid var(--rim,#26344a)";
        newRow.addEventListener("mousedown", (e) => { e.preventDefault(); closeMenu(); showBlockedInfo(blockingProject); });
      } else {
        newRow.style.cssText = "padding:8px 10px;cursor:pointer;color:var(--coral,#ff6a3d);font-weight:600;border-bottom:1px solid var(--rim,#26344a)";
        newRow.addEventListener("mouseenter", () => newRow.style.background="rgba(255,106,61,.12)");
        newRow.addEventListener("mouseleave", () => newRow.style.background="");
        // Real bug, 2026-08-12: whatever the user had already typed into
        // projInput (hoping it would BE the new project's name — a completely
        // reasonable reading of a text box labeled "Project…") was silently
        // thrown away here. Captured now and threaded through startNewProject()
        // so it actually becomes the tour's name instead of a random default.
        newRow.addEventListener("mousedown", (e) => { e.preventDefault(); const typedName=projInput.value.trim(); closeMenu(); startNewProject(typedName); });
      }
      menu.appendChild(newRow);

      if(!matches.length){
        const empty = document.createElement("div");
        empty.textContent = projects.length ? "no matches" : "no projects yet";
        empty.style.cssText = "padding:8px 10px;color:var(--fog,#5b7088);font-size:12px";
        menu.appendChild(empty);
      }
      matches.forEach(p => {
        const row = document.createElement("div");
        row.textContent = projectLabel(p) + (p.is_template ? " (template)" : "");
        row.style.cssText = "padding:8px 10px;cursor:pointer;color:var(--snow,#eef4fb)";
        row.addEventListener("mouseenter", () => row.style.background="rgba(255,106,61,.18)");
        row.addEventListener("mouseleave", () => { if(menu) row.style.background=""; });
        row.addEventListener("mousedown", (e) => { e.preventDefault(); selectProject(p); });
        menu.appendChild(row);
      });

      const manageRow = document.createElement("div");
      manageRow.textContent = "⋯ Manage workspaces";
      manageRow.style.cssText = "padding:8px 10px;cursor:pointer;color:var(--ice,#8fb6d4);border-top:1px solid var(--rim,#26344a);font-size:12px";
      manageRow.addEventListener("mouseenter", () => manageRow.style.background="rgba(255,106,61,.12)");
      manageRow.addEventListener("mouseleave", () => manageRow.style.background="");
      manageRow.addEventListener("mousedown", (e) => { e.preventDefault(); closeMenu(); openManagePanel(); });
      menu.appendChild(manageRow);

      document.body.appendChild(menu);
      document.addEventListener("mousedown", onDocDown, true);
    }
    // Real feedback, 2026-08-13: an alert()/prompt() would work but this
    // codebase deliberately avoids native dialogs everywhere else (see
    // CLAUDE.md/project memory) in favor of graphical, dismissable panels —
    // this mirrors that convention rather than reaching for alert().
    function showBlockedInfo(p){
      const existing = document.getElementById("tnBlockedInfo");
      if(existing) existing.remove();
      const box = document.createElement("div");
      box.id = "tnBlockedInfo";
      box.style.cssText = "position:fixed;z-index:700;left:50%;top:50%;transform:translate(-50%,-50%);"
        + "background:var(--slate2,#1b2738);border:1px solid var(--coral,#ff6a3d);border-radius:10px;"
        + "padding:16px 18px;max-width:340px;box-shadow:0 12px 32px rgba(0,0,0,.5);"
        + "font-family:'Barlow Condensed';color:var(--snow,#eef4fb)";
      box.innerHTML =
        '<div style="font-weight:700;color:var(--coral,#ff6a3d);margin-bottom:8px;font-size:15px">Finish your current project first</div>'
        + '<div style="font-size:13px;line-height:1.45;margin-bottom:14px">&ldquo;'+esc(projectLabel(p))+'&rdquo; doesn&rsquo;t have any stops yet. '
        + 'Open Edit, add at least one stop, and Publish it before starting another new project.</div>'
        + '<div style="display:flex;gap:8px;justify-content:flex-end">'
        + '<button type="button" id="tnBlockedClose" style="padding:6px 12px;border-radius:6px;border:1px solid var(--rim,#26344a);'
        + 'background:transparent;color:var(--snow,#eef4fb);cursor:pointer;font-family:inherit">Close</button>'
        + '<button type="button" id="tnBlockedEdit" style="padding:6px 12px;border-radius:6px;border:none;'
        + 'background:var(--coral,#ff6a3d);color:#141d2b;font-weight:700;cursor:pointer;font-family:inherit">Go to Edit</button>'
        + '</div>';
      document.body.appendChild(box);
      function close(){ box.remove(); document.removeEventListener("mousedown", onBoxDocDown, true); }
      function onBoxDocDown(e){ if(!box.contains(e.target)) close(); }
      document.addEventListener("mousedown", onBoxDocDown, true);
      box.querySelector("#tnBlockedClose").addEventListener("click", close);
      box.querySelector("#tnBlockedEdit").addEventListener("click", () => {
        close();
        location.href = toolHref("/editor", p.id, company);
      });
    }
    function menuBoxCss(){
      const r = projInput.getBoundingClientRect();
      return "position:fixed;z-index:500;background:var(--slate2,#1b2738);border:1px solid var(--rim,#26344a);"
        + "border-radius:9px;max-height:320px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.4);"
        + "font-family:'Barlow Condensed';font-size:13px;top:"+(r.bottom+4)+"px;left:"+r.left+"px;width:"+Math.max(r.width,220)+"px";
    }
    projInput.addEventListener("focus", () => openMenu(""));
    projInput.addEventListener("click", () => openMenu(""));
    projInput.addEventListener("input", () => openMenu(projInput.value));

    // A "workspace" (the app table) is purely an internal grouping detail —
    // every client gets exactly one, auto-created alongside it with an id
    // MATCHING the client's own id (see worker.js's client-create handler:
    // `INSERT INTO app (id,orgId,...) VALUES (?,?,...)` bound to
    // `(clientId, clientId, ...)`). Real feedback, 2026-08-12: surfacing
    // this as a "which workspace?" question during project creation — first
    // as a confusing native prompt(), then as a nicer-but-still-visible
    // custom picker — was wrong at a more basic level than either UI
    // attempt: the user's own mental model is Client -> Project, full stop,
    // and creating a project should never reference a workspace at all.
    // This resolves (or silently recreates, if it was ever deleted) that
    // one matching-id workspace and returns its id — no prompt, no picker,
    // ever, for this flow. POST /api/apps is already idempotent on a
    // matching id (worker.js returns the existing row instead of erroring),
    // so this is safe to call every time without a GET-first round trip.
    async function ensureDefaultWorkspace(){
      const token = askToken(); if(!token) return null;
      try{
        const r = await fetch("/api/apps",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+token},
          body:JSON.stringify({id:company, orgId:company, name:company})});
        if(r.ok) return (await r.json()).id;
      }catch(e){}
      return null;
    }

    // ---- "+ New Project" — the ONE place a new project gets created
    // (2026-08-12 redesign: index.html's separate "+ New tour" links were
    // removed). Requires a company, silently resolves its default workspace
    // (see ensureDefaultWorkspace above), then just selects the new project
    // in this pulldown and unlocks the gated tool links — it does NOT
    // navigate anywhere. Publishing (from whichever tool the user picks
    // next) is what actually creates the D1 row; fence-editor.html's
    // loadFromPlatform() adopts this id on its 404. ----
    async function startNewProject(presetName){
      if(!company){ alert("Pick a company first."); return; }
      const appId = await ensureDefaultWorkspace();
      if(!appId) return;
      // Timestamp+random, deliberately not a slug of the name — decouples
      // the id from a later rename, and this repo's own 409 collision guard
      // (worker.js's bundle PUT handler) only gets stronger from ids being
      // harder to accidentally collide, not weaker.
      const id = "tour-"+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
      const name = (presetName||"").trim() || ("New Tour "+Date.now().toString(36).slice(-4));
      // Real feedback, 2026-08-12: "creating" a project used to only set
      // local/pending state — nothing actually existed until the user drew
      // a stop and hit Publish, so it never showed up under the workspace
      // right away, which read as broken rather than just "not saved yet".
      // This now creates a REAL project immediately (a version-1 bundle
      // with zero zones — worker.js's bundle PUT handler only checks that
      // `zones` is an array, not that it's non-empty, so this is a
      // legitimate, supported publish, not a hack). It's visible in the
      // workspace's tour list and every project picker the instant this
      // call returns.
      const token = askToken(); if(!token) return;
      try{
        const r = await fetch("/api/projects/"+encodeURIComponent(id)+"/bundle",{
          method:"PUT", headers:{"content-type":"application/json", authorization:"Bearer "+token},
          body: JSON.stringify({ createIfMissing:true, appId, orgId:company, name, zones:[] })
        });
        if(!r.ok){ const j=await r.json().catch(()=>({})); alert("Couldn't create project: "+(j.error||r.status)); return; }
      }catch(e){ alert("Couldn't create project: "+e.message); return; }
      project = id; setProject(id);
      projectHasStops = false; // real feedback: only Edit unlocks until a stop exists — see refreshToolHrefs()
      // Kept as a defensive fallback, not the primary mechanism anymore —
      // now that creation is eager, a fresh loadProjects() fetch finds this
      // project immediately on its own; the sidecar only still matters if
      // that fetch has any latency/race on a page loaded a moment later.
      setPendingProject(id, name, appId, company);
      projects.push({ id, name, appId, orgId: company, bundleVersion: 1, hasStops: false });
      projInput.value = name;
      closeMenu();
      refreshToolHrefs();
      // Distinct from onProjectChange (which is for switching to an
      // EXISTING project, and reloads the page by default if the host
      // doesn't handle it) — this one has no default behavior at all when
      // absent, purely opt-in, so pages that don't wire it up keep the
      // "stay put, no navigation" behavior exactly as specified. Real gap
      // found via live testing, 2026-08-12: without this, a page already
      // showing its own "no project selected" state (fence-editor.html's
      // #noProjectHint) never found out a project now exists — the nav
      // buttons correctly unlocked, but the page content stayed stuck.
      if(opts.onProjectCreated) opts.onProjectCreated(id, name, appId, company);
    }
    // ---- Management panel — rename/delete workspace, delete project,
    // combine, merge. Same endpoints/auth as index.html, ported not redesigned. ----
    let managePopover = null;
    function closeManagePanel(){ if(managePopover) managePopover.remove(); managePopover=null; document.removeEventListener("mousedown", onManageDocDown, true); }
    function onManageDocDown(e){ if(managePopover && !managePopover.contains(e.target)) closeManagePanel(); }
    async function openManagePanel(){
      closeManagePanel();
      if(!company){ alert("Pick a company first."); return; }
      managePopover = document.createElement("div");
      managePopover.style.cssText = "position:fixed;z-index:600;width:340px;max-width:92vw;max-height:75vh;overflow-y:auto;"
        + "background:var(--slate2,#1b2738);border:1px solid var(--rim,#26344a);border-radius:10px;"
        + "box-shadow:0 8px 20px rgba(0,0,0,.45);padding:14px;font-family:'Barlow Condensed';color:var(--snow,#eef4fb)";
      managePopover.innerHTML = '<div style="font-size:12px;color:var(--fog,#5b7088)">loading…</div>';
      const r = projWrap.getBoundingClientRect();
      managePopover.style.top = (r.bottom+4)+"px"; managePopover.style.left = r.left+"px";
      document.body.appendChild(managePopover);
      document.addEventListener("mousedown", onManageDocDown, true);

      let apps = [];
      try{
        const ar = await fetch("/api/apps?org="+encodeURIComponent(company), { headers:{authorization:"Bearer "+getToken()} });
        if(ar.ok) apps = (await ar.json()).apps || [];
      }catch(e){}
      if(!projects.length) await loadProjects();

      managePopover.innerHTML = "";
      apps.forEach(app => {
        const row = document.createElement("div");
        row.style.cssText = "border:1px solid var(--rim,#26344a);border-radius:8px;padding:8px 10px;margin-bottom:8px";
        const appProjects = projects.filter(p => p.appId === app.id);
        row.innerHTML = '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">'
          + '<b style="flex:1;font-size:13px">'+esc(app.name||app.id)+'</b>'
          + '<span style="font-size:11px;color:var(--fog,#5b7088)">'+appProjects.length+' project(s)</span></div>'
          + '<div class="tn-row-btns" style="display:flex;gap:6px;flex-wrap:wrap"></div>';
        const btns = row.querySelector(".tn-row-btns");
        const mkBtn = (label, fn) => {
          const b = document.createElement("button");
          b.textContent = label;
          b.style.cssText = "font-family:'Barlow Condensed';font-size:11px;background:none;border:1px solid var(--rim,#26344a);"
            + "color:var(--ice,#8fb6d4);border-radius:6px;padding:4px 8px;cursor:pointer";
          b.addEventListener("click", fn);
          btns.appendChild(b);
        };
        mkBtn("Rename", async () => {
          const name = (prompt("New name:", app.name)||"").trim();
          if(!name || name===app.name) return;
          const token = askToken(); if(!token) return;
          const r = await fetch("/api/apps/"+encodeURIComponent(app.id),{method:"PUT",headers:{"content-type":"application/json",authorization:"Bearer "+token},body:JSON.stringify({name})});
          if(r.ok) openManagePanel(); else alert("Rename failed: "+r.status);
        });
        mkBtn("Delete", async () => {
          if(!confirm('Delete workspace "'+(app.name||app.id)+'" and all its projects? Cannot be undone.')) return;
          const token = askToken(); if(!token) return;
          const r = await fetch("/api/apps/"+encodeURIComponent(app.id)+"?cascade=true",{method:"DELETE",headers:{authorization:"Bearer "+token}});
          if(r.ok) openManagePanel(); else alert("Delete failed: "+r.status);
        });
        // Single tenant-level toggle for the whole AR/3D upgrade (terrain on
        // every map surface once built, plus the Fence Editor's AR Objects
        // panel today) — every project in this workspace shares it, there's
        // no per-project override. See design-a-best-in-cosmic-pudding.md.
        mkBtn(app.threeDEnabled ? "3D: On" : "3D: Off", async () => {
          const next = !app.threeDEnabled;
          if(!confirm((next?"Turn ON":"Turn OFF")+' 3D mode for "'+(app.name||app.id)+'"? This affects every project in this workspace.')) return;
          const token = askToken(); if(!token) return;
          const r = await fetch("/api/apps/"+encodeURIComponent(app.id),{method:"PUT",headers:{"content-type":"application/json",authorization:"Bearer "+token},body:JSON.stringify({name:app.name,threeDEnabled:next})});
          if(r.ok) openManagePanel(); else alert("Toggle failed: "+r.status);
        });
        // Separate, off-by-default toggle (item D, rescoped 2026-08-14):
        // whether the production player defaults an altitude-gated stop's
        // trigger to terrain-DEM elevation instead of raw phone GPS
        // altitude. Deliberately NOT folded into 3D Mode above — that
        // toggle only ever affected rendering/UI before this; changing it
        // must never silently change a live tour's trigger behavior too.
        // Only shown once 3D Mode is on (terrain-gated altitude makes no
        // sense without terrain), and only takes effect on a project once
        // republished (denormalized into the bundle, same as 3D Mode).
        if(app.threeDEnabled) mkBtn(app.terrainAltitudeEnabled ? "Terrain Altitude: On" : "Terrain Altitude: Off", async () => {
          const next = !app.terrainAltitudeEnabled;
          if(!confirm((next?"Turn ON":"Turn OFF")+' terrain elevation as the default altitude source for "'+(app.name||app.id)+'"? Changes trigger behavior for every altitude-gated stop in this workspace, once each project is republished.')) return;
          const token = askToken(); if(!token) return;
          const r = await fetch("/api/apps/"+encodeURIComponent(app.id),{method:"PUT",headers:{"content-type":"application/json",authorization:"Bearer "+token},body:JSON.stringify({name:app.name,terrainAltitudeEnabled:next})});
          if(r.ok) openManagePanel(); else alert("Toggle failed: "+r.status);
        });
        // Third, separate toggle (item A, paraglider/drone stops,
        // 2026-08-14): stops the terrain-altitude default above from
        // clobbering a flying visitor's real GPS altitude with ground
        // elevation — a workspace hosting a walking tour should NOT turn
        // this on, it's specifically for airborne visitors. Shown
        // alongside Terrain Altitude (same 3D-Mode-on gate) since it only
        // matters in relation to that flag.
        if(app.threeDEnabled) mkBtn(app.visitorsFly ? "Flying Visitors: On" : "Flying Visitors: Off", async () => {
          const next = !app.visitorsFly;
          if(!confirm((next?"Turn ON":"Turn OFF")+' "visitors fly" for "'+(app.name||app.id)+'"? When on, a flying visitor\'s real GPS altitude always wins over the terrain-elevation default, once each project is republished.')) return;
          const token = askToken(); if(!token) return;
          const r = await fetch("/api/apps/"+encodeURIComponent(app.id),{method:"PUT",headers:{"content-type":"application/json",authorization:"Bearer "+token},body:JSON.stringify({name:app.name,visitorsFly:next})});
          if(r.ok) openManagePanel(); else alert("Toggle failed: "+r.status);
        });
        // Fourth toggle (Phase 5a, forward hazard raycasting, 2026-08-17):
        // gates the proactive "walking toward a hazard" warning — the
        // safety feature for the cm-accurate/off-grid "hazard aware" tier.
        // Shown alongside Terrain Altitude/Flying Visitors (same 3D-Mode-on
        // gate) since the warning needs a circle+altM hazard zone, which
        // only exists meaningfully once 3D Mode is on.
        if(app.threeDEnabled) mkBtn(app.hazardAwareEnabled ? "Hazard Aware: On" : "Hazard Aware: Off", async () => {
          const next = !app.hazardAwareEnabled;
          if(!confirm((next?"Turn ON":"Turn OFF")+' hazard-ahead warnings for "'+(app.name||app.id)+'"? Affects every circle+altitude hazard zone in this workspace, once each project is republished.')) return;
          const token = askToken(); if(!token) return;
          const r = await fetch("/api/apps/"+encodeURIComponent(app.id),{method:"PUT",headers:{"content-type":"application/json",authorization:"Bearer "+token},body:JSON.stringify({name:app.name,hazardAwareEnabled:next})});
          if(r.ok) openManagePanel(); else alert("Toggle failed: "+r.status);
        });
        // Fifth toggle (Ridge Quest R5, 2026-08-20): gates ONLY the fog-of-war
        // VISUAL layer on the player-facing /quest map — unrelated to 3D
        // Mode, so unconditional like threeDEnabled itself (not gated behind
        // `if(app.threeDEnabled)` like its three siblings above). Ridge
        // Quest's H3 coverage TRACKING keeps working regardless of this
        // flag — it only hides the shroud/colored-cell overlay.
        // Bug fixed 2026-08-20: D1 returns fog_enabled as a raw SQLite
        // INTEGER (a JS number, 0 or 1) — never the boolean `false`. The
        // old `app.fogEnabled===false` check could therefore never match,
        // so the button always displayed "On" and every click always sent
        // fogEnabled:false, silently forcing it off no matter what — it
        // could only ever turn fog OFF, never back on, while lying about
        // the current state. `===0` is the correct check for a D1 integer
        // column; questEnabled's sibling toggle below already gets this
        // right via truthy coercion (`!app.questEnabled`), which also works
        // for 0/1 — this one used strict-equality-against-boolean instead
        // and that was the actual defect.
        const fogIsOff = app.fogEnabled === 0;
        mkBtn(fogIsOff ? "Fog of War: Off" : "Fog of War: On", async () => {
          const next = fogIsOff; // off(0) -> turn on; on(1)/undefined -> turn off
          if(!confirm((next?"Turn ON":"Turn OFF")+' the fog-of-war reveal visuals for "'+(app.name||app.id)+'" in Ridge Quest? Fog TRACKING keeps working either way — this only hides the shroud/colored map layer.')) return;
          const token = askToken(); if(!token) return;
          const r = await fetch("/api/apps/"+encodeURIComponent(app.id),{method:"PUT",headers:{"content-type":"application/json",authorization:"Bearer "+token},body:JSON.stringify({name:app.name,fogEnabled:next})});
          if(r.ok) openManagePanel(); else alert("Toggle failed: "+r.status);
        });
        // Sixth toggle (Ridge Quest R7, 2026-08-20): whether this workspace
        // appears at all in the new PUBLIC workspace picker (GET
        // /api/quest-workspaces, no staff token needed). Separate from
        // fogEnabled — a workspace can be publicly listed with fog visuals
        // off, or vice versa. Turning this on does NOT expose every project
        // inside it — each project also needs its own "Public" toggle
        // (below, per-project) before it shows up in the picker.
        mkBtn(app.questEnabled ? "Ridge Quest: Public" : "Ridge Quest: Hidden", async () => {
          const next = !app.questEnabled;
          if(!confirm((next?"List":"Hide")+' "'+(app.name||app.id)+'" in Ridge Quest\'s public workspace picker? Individual projects still need their own "Public" toggle before they actually show up.')) return;
          const token = askToken(); if(!token) return;
          const r = await fetch("/api/apps/"+encodeURIComponent(app.id),{method:"PUT",headers:{"content-type":"application/json",authorization:"Bearer "+token},body:JSON.stringify({name:app.name,questEnabled:next})});
          if(r.ok) openManagePanel(); else alert("Toggle failed: "+r.status);
        });
        if(apps.length > 1) mkBtn("Merge into…", async () => {
          const others = apps.filter(a => a.id!==app.id);
          const names = others.map((a,i)=>(i+1)+". "+(a.name||a.id)).join("\n");
          const pick = prompt("Merge every project from \""+(app.name||app.id)+"\" into which workspace?\n"+names, "1");
          const idx = parseInt(pick,10);
          if(!pick || isNaN(idx) || !others[idx-1]) return;
          const target = others[idx-1];
          if(!confirm('Move every project from "'+(app.name||app.id)+'" into "'+(target.name||target.id)+'"? Source is left empty.')) return;
          const token = askToken(); if(!token) return;
          const r = await fetch("/api/apps/"+encodeURIComponent(target.id)+"/merge",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+token},body:JSON.stringify({sourceAppId:app.id})});
          if(r.ok) openManagePanel(); else alert("Merge failed: "+r.status);
        });
        if(appProjects.length){
          const list = document.createElement("div");
          list.style.cssText = "margin-top:6px;display:flex;flex-direction:column;gap:3px";
          appProjects.forEach(p => {
            const pr = document.createElement("div");
            pr.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px";
            pr.innerHTML = '<span style="flex:1">'+esc(p.name||p.id)+(p.is_template?' <i style="color:var(--fog,#5b7088)">(template)</i>':'')+'</span>';
            // Ridge Quest R7 (2026-08-20) — per-project half of the two-level
            // public-picker opt-in (the app-level "Ridge Quest: Public/Hidden"
            // toggle above is the other half). A project only appears in
            // GET /api/quest-projects once BOTH are on.
            const pub = document.createElement("button");
            pub.textContent = p.questPublic ? "Public" : "Not public";
            pub.title = "Toggle whether this project shows in Ridge Quest's public project picker";
            pub.style.cssText = "background:none;border:1px solid var(--rim,#26344a);color:"+(p.questPublic?"var(--go,#38e0a6)":"var(--fog,#5b7088)")+";border-radius:6px;padding:2px 6px;cursor:pointer;font-size:11px";
            pub.addEventListener("click", async () => {
              const next = !p.questPublic;
              const token = askToken(); if(!token) return;
              const r = await fetch("/api/projects/"+encodeURIComponent(p.id),{method:"PATCH",headers:{"content-type":"application/json",authorization:"Bearer "+token},body:JSON.stringify({questPublic:next})});
              if(r.ok){ await loadProjects(); openManagePanel(); } else alert("Toggle failed: "+r.status);
            });
            pr.appendChild(pub);
            const del = document.createElement("button");
            del.textContent = "✕"; del.title = "Delete project";
            del.style.cssText = "background:none;border:none;color:var(--fog,#5b7088);cursor:pointer;font-size:12px";
            del.addEventListener("click", async () => {
              if(!confirm('Delete project "'+(p.name||p.id)+'"? Removes walk links, assignments, bundle history. Cannot be undone.')) return;
              const token = askToken(); if(!token) return;
              const r = await fetch("/api/projects/"+encodeURIComponent(p.id),{method:"DELETE",headers:{authorization:"Bearer "+token}});
              if(r.ok){
                // Real bug, 2026-08-12: loadProjects() only re-fetches when
                // `projects` is CURRENTLY EMPTY (its first-load guard) - once
                // populated, every later call (including right after a
                // delete) silently reused the stale array, so a deleted
                // project kept showing here AND in the Project pulldown
                // (which reads the exact same array) until something else
                // happened to trigger a fresh fetch. Force one explicitly.
                await loadProjects();
                // If the deleted project was ever "pending" (created via the
                // picker, never published), that sidecar has no way to know
                // it's gone now - loadProjects()'s splice would otherwise
                // keep resurrecting it forever, since it never finds a real
                // match and never gets told to stop trying.
                const pending = getPendingProject();
                if(pending && pending.id===p.id) clearPendingProject();
                if(project===p.id){ project=""; setProject(""); projInput.value=""; }
                refreshToolHrefs();
                openManagePanel();
              } else alert("Delete failed: "+r.status);
            });
            pr.appendChild(del);
            list.appendChild(pr);
          });
          row.appendChild(list);
          const eligible = appProjects.filter(p => !p.archived && (p.is_template || !p.guide_id));
          if(eligible.length >= 2) mkBtn("Combine…", async () => {
            const picks = prompt("Combine which projects (comma-separated numbers)?\n"+eligible.map((p,i)=>(i+1)+". "+(p.name||p.id)).join("\n"));
            if(!picks) return;
            const idxs = picks.split(",").map(s=>parseInt(s.trim(),10)).filter(n=>!isNaN(n)&&eligible[n-1]);
            if(idxs.length < 2){ alert("Pick at least 2."); return; }
            const name = (prompt("New combined project name:")||"").trim();
            if(!name) return;
            const token = askToken(); if(!token) return;
            const sourceIds = idxs.map(i => eligible[i-1].id);
            const r = await fetch("/api/projects/combine",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+token},body:JSON.stringify({name,sourceIds,isTemplate:true})});
            if(r.ok){ await openManagePanel(); alert('Combined into "'+name+'". Open it in the editor to review.'); }
            else alert("Combine failed: "+r.status);
          });
        }
        managePopover.appendChild(row);
      });
      if(!apps.length){
        managePopover.innerHTML = '<div style="font-size:12px;color:var(--fog,#5b7088)">no workspaces yet for this company</div>';
      }
    }

    // ---- Mount Company picker, wire company-change behavior ----
    if(window.ClientPicker){
      await window.ClientPicker.init({
        navEl: companySlot,
        allowAll: !!opts.allowAllCompany,
        defaultId: opts.defaultCompany,
        onChange: async (newCompany) => {
          company = newCompany || "";
          // Company changed — the current project (if any) belongs to the
          // OLD company's list, so it's no longer valid context. Drop it
          // rather than carry a project id that silently means nothing (or
          // worse, means a different project) under the new company. This
          // used to only happen in the full-page-navigation branch below —
          // the onCompanyChange (hot-swap-in-place) branch left `project`
          // and projInput.value pointing at the old company's project,
          // confirmed live: every TOOLS link (rebuilt by refreshToolHrefs()
          // right after) carried the stale id straight into the new
          // company's tools, e.g. Edit opening company B's editor against
          // company A's project.
          project = ""; setProject("");
          projInput.value = "";
          if(opts.onCompanyChange){ opts.onCompanyChange(company); await loadProjects(); refreshToolHrefs(); return; }
          location.href = toolHref(location.pathname, "", company);
        }
      });
    }
    await loadProjects();
    const initialProj = projects.find(p => p.id === project);
    projInput.value = initialProj ? projectLabel(initialProj) : "";
    // A direct/reloaded page load (e.g. a bookmarked /studio?project=X)
    // resolves `project` from the URL/localStorage without ever going
    // through selectProject() — without this, projectHasStops stayed at its
    // permissive `true` default (line ~156) and a project with zero
    // published stops would show every needsStops tool as unlocked the
    // instant you reloaded, even though picking it from the dropdown
    // correctly gated it. A brand-new project with no D1 row at all (the
    // pending sidecar's case) has no `initialProj` from the real fetch, so
    // it correctly falls through to the sidecar-aware default below instead.
    if(initialProj && !initialProj._pending){
      projectHasStops = computeHasStops(initialProj);
    } else if(project){
      // Either the sidecar-spliced pending entry (no zoneCount, not
      // published yet) or no matching project row was found at all —
      // neither can have a published stop.
      projectHasStops = false;
    }
    refreshToolHrefs();
  }

  // Company get/set/resolve are pure pass-throughs to ClientPicker — kept on
  // TopNav too so a host page only needs one global to reference, without
  // caring whether a given method is "really" implemented here or there.
  function getCompany(){ return window.ClientPicker ? window.ClientPicker.get() : ""; }
  function setCompany(id){ if(window.ClientPicker) window.ClientPicker.set(id); }
  function resolveCompany(){ return window.ClientPicker ? window.ClientPicker.resolve() : ""; }

  window.TopNav = { getCompany, setCompany, resolveCompany, getProject, setProject, resolveProject,
    getPendingProject, setPendingProject, clearPendingProject, init };
})();
