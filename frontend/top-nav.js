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

  const TOOLS = [
    { key:"edit",         label:"Edit",          href:"/editor" },
    { key:"audio",        label:"Audio Studio",  href:"/studio" },
    { key:"chatterbox",   label:"Chatterbox",    href:"/chatterbox" },
    { key:"code-library", label:"Code Library",  href:"/code-library" },
    { key:"dashboard",    label:"Dashboard",     href:"/dashboard" },
    { key:"clients",      label:"Clients",       href:"/clients" }
  ];

  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

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

    // ---- Settings gear ----
    const gearBtn = document.createElement("button");
    gearBtn.textContent = "⚙"; gearBtn.title = "Settings";
    gearBtn.style.cssText = "background:none;border:1px solid var(--rim,#26344a);color:var(--ice,#8fb6d4);"
      + "border-radius:8px;padding:6px 10px;cursor:pointer;font-size:15px";
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
        gearPopover.style.cssText = "position:fixed;z-index:600;min-width:240px;max-width:92vw;max-height:75vh;"
          + "overflow-y:auto;background:var(--slate2,#1b2738);border:1px solid var(--rim,#26344a);border-radius:10px;"
          + "box-shadow:0 8px 20px rgba(0,0,0,.45);padding:12px;display:none";
        document.body.appendChild(gearPopover); // top-level sibling of <body>'s children — never nested inside a
        opts.renderSettings(gearPopover);       // page's own backdrop-filter panel, which would clip position:fixed descendants
      }
      if(gearPopover.style.display !== "none"){ closeGearPopover(); return; }
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
    const toolLinks = {};
    TOOLS.forEach(t => {
      const a = document.createElement("a");
      a.textContent = t.label;
      a.style.cssText = PILL;
      if(t.key === opts.active){ a.style.color = "var(--snow,#eef4fb)"; a.style.borderColor = "var(--coral,#ff6a3d)"; }
      a.href = toolHref(t.href, project, company);
      navEl.appendChild(a);
      toolLinks[t.key] = a;
    });
    function refreshToolHrefs(){
      TOOLS.forEach(t => { toolLinks[t.key].href = toolHref(t.href, project, company); });
    }

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
    }
    function projectLabel(p){ return p.name || p.id; }
    function selectProject(p){
      project = p.id; setProject(project);
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

      const newRow = document.createElement("div");
      newRow.textContent = "+ New Project";
      newRow.style.cssText = "padding:8px 10px;cursor:pointer;color:var(--coral,#ff6a3d);font-weight:600;border-bottom:1px solid var(--rim,#26344a)";
      newRow.addEventListener("mouseenter", () => newRow.style.background="rgba(255,106,61,.12)");
      newRow.addEventListener("mouseleave", () => newRow.style.background="");
      newRow.addEventListener("mousedown", (e) => { e.preventDefault(); closeMenu(); startNewProject(); });
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
    function menuBoxCss(){
      const r = projInput.getBoundingClientRect();
      return "position:fixed;z-index:500;background:var(--slate2,#1b2738);border:1px solid var(--rim,#26344a);"
        + "border-radius:9px;max-height:320px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.4);"
        + "font-family:'Barlow Condensed';font-size:13px;top:"+(r.bottom+4)+"px;left:"+r.left+"px;width:"+Math.max(r.width,220)+"px";
    }
    projInput.addEventListener("focus", () => openMenu(""));
    projInput.addEventListener("click", () => openMenu(""));
    projInput.addEventListener("input", () => openMenu(projInput.value));

    // ---- "+ New Project" — requires a company, picks/creates a workspace,
    // then lands on Fence Editor for a brand-new (unpublished) project.
    // Mirrors index.html's newTour()/newClient() flow. ----
    async function startNewProject(){
      if(!company){ alert("Pick a company first."); return; }
      let apps = [];
      try{
        const r = await fetch("/api/apps?org="+encodeURIComponent(company), { headers:{authorization:"Bearer "+getToken()} });
        if(r.ok) apps = (await r.json()).apps || [];
      }catch(e){}
      let appId = null;
      if(apps.length){
        const names = apps.map((a,i)=>(i+1)+". "+(a.name||a.id)).join("\n");
        const pick = prompt("Which workspace?\n"+names+"\n\n(enter a number, or a new name to create one)", apps[0].name||apps[0].id);
        if(!pick) return;
        const idx = parseInt(pick,10);
        if(!isNaN(idx) && apps[idx-1]) appId = apps[idx-1].id;
        else appId = await createWorkspace(pick.trim());
      } else {
        const name = (prompt("No workspaces yet for this company — name the first one:")||"").trim();
        if(!name) return;
        appId = await createWorkspace(name);
      }
      if(!appId) return;
      location.href = "/editor?app="+encodeURIComponent(appId)+"&asClient="+encodeURIComponent(company);
    }
    async function createWorkspace(name){
      if(!name) return null;
      const token = askToken(); if(!token) return null;
      try{
        const r = await fetch("/api/apps",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+token},body:JSON.stringify({name,orgId:company})});
        if(r.ok) return (await r.json()).id;
        const j = await r.json().catch(()=>({}));
        alert("Couldn't create workspace: "+(j.error||r.status));
      }catch(e){ alert("Failed: "+e.message); }
      return null;
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
            const del = document.createElement("button");
            del.textContent = "✕"; del.title = "Delete project";
            del.style.cssText = "background:none;border:none;color:var(--fog,#5b7088);cursor:pointer;font-size:12px";
            del.addEventListener("click", async () => {
              if(!confirm('Delete project "'+(p.name||p.id)+'"? Removes walk links, assignments, bundle history. Cannot be undone.')) return;
              const token = askToken(); if(!token) return;
              const r = await fetch("/api/projects/"+encodeURIComponent(p.id),{method:"DELETE",headers:{authorization:"Bearer "+token}});
              if(r.ok) openManagePanel(); else alert("Delete failed: "+r.status);
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
          if(opts.onCompanyChange){ opts.onCompanyChange(company); await loadProjects(); refreshToolHrefs(); return; }
          // Company changed — the current project (if any) belongs to the
          // OLD company's list, so it's no longer valid context. Drop it
          // rather than carry a project id that silently means nothing (or
          // worse, means a different project) under the new company.
          location.href = toolHref(location.pathname, "", company);
        }
      });
    }
    await loadProjects();
    const initialProj = projects.find(p => p.id === project);
    projInput.value = initialProj ? projectLabel(initialProj) : "";
    refreshToolHrefs();
  }

  // Company get/set/resolve are pure pass-throughs to ClientPicker — kept on
  // TopNav too so a host page only needs one global to reference, without
  // caring whether a given method is "really" implemented here or there.
  function getCompany(){ return window.ClientPicker ? window.ClientPicker.get() : ""; }
  function setCompany(id){ if(window.ClientPicker) window.ClientPicker.set(id); }
  function resolveCompany(){ return window.ClientPicker ? window.ClientPicker.resolve() : ""; }

  window.TopNav = { getCompany, setCompany, resolveCompany, getProject, setProject, resolveProject, init };
})();
