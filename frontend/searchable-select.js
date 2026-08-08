// Searchable text-input backing for label/value pickers (project pickers,
// etc.) — a plain <select> stops being usable once a list has 50+ entries,
// since there's no real search, just scroll/type-to-jump. Mimics just enough
// of a <select>'s API (set options, get/set the chosen id) that call sites
// don't need much rework.
//
// Extracted from dashboard.html (2026-08-07), which originally had this
// inline before top-nav.js needed the same widget for the Project pulldown.
// dashboard.html's own project pickers (schedTemplateSel, lnkProjSel,
// lnkListProjSel) now load this file instead of a local copy.
//
// Built as a fully custom dropdown rather than native <input list>+<datalist>:
// browsers filter a datalist's suggestions against whatever text is already
// in the field, so once an option is picked, focusing the field again only
// shows entries matching that leftover label (often just the one already
// picked) — not the full list. Native datalist popups also aren't
// controllable from script in any reliable cross-browser way (Chrome only
// shows/refreshes them heuristically, and they render outside the page's own
// layer so they can't even be inspected/verified via a screenshot). A
// hand-rolled menu sidesteps all of that: focus always shows every option,
// typing filters, clicking a row selects it. See client-picker.js's header
// comment — same bug, same fix, applied there too for the client picker.
function searchableSelect(inputId){
  const input=document.getElementById(inputId);
  input.removeAttribute("list"); // fully custom now — don't let a native datalist popup compete
  let items=[], labelFn=null, map={}, rmap={};
  let menu=null, highlighted=-1;

  function closeMenu(){
    if(!menu) return;
    menu.remove(); menu=null; highlighted=-1;
    document.removeEventListener("mousedown", onDocMouseDown, true);
  }
  function onDocMouseDown(e){ if(menu && !menu.contains(e.target) && e.target!==input) closeMenu(); }
  function setHighlight(i){
    if(!menu) return;
    const rows=[...menu.children];
    rows.forEach((r,idx)=>{ r.style.background = idx===i ? "rgba(255,106,61,.18)" : ""; });
    highlighted=i;
  }
  function openMenu(filterText){
    closeMenu();
    const q=(filterText||"").trim().toLowerCase();
    const matches=items.filter(it=>!q || labelFn(it).toLowerCase().includes(q)).slice(0,200);
    if(!matches.length) return;
    menu=document.createElement("div");
    const r=input.getBoundingClientRect();
    menu.style.cssText="position:fixed;z-index:500;background:var(--slate2,#1b2738);"
      +"border:1px solid var(--rim,#26344a);border-radius:9px;max-height:240px;overflow-y:auto;"
      +"box-shadow:0 8px 24px rgba(0,0,0,.4);font-family:'Barlow Condensed';font-size:13px;"
      +"top:"+(r.bottom+4)+"px;left:"+r.left+"px;width:"+r.width+"px";
    matches.forEach(it=>{
      const row=document.createElement("div");
      row.textContent=labelFn(it);
      row.style.cssText="padding:8px 10px;cursor:pointer;color:var(--snow,#eef4fb)";
      row.addEventListener("mouseenter", ()=>{ row.style.background="rgba(255,106,61,.18)"; });
      row.addEventListener("mouseleave", ()=>{ if(menu) row.style.background=""; });
      // mousedown (not click) + preventDefault so the input never loses focus
      // first — a plain click would blur the input before this handler runs.
      row.addEventListener("mousedown", (e)=>{
        e.preventDefault();
        input.value=labelFn(it);
        closeMenu();
      });
      menu.appendChild(row);
    });
    document.body.appendChild(menu);
    document.addEventListener("mousedown", onDocMouseDown, true);
  }
  // "focus" alone isn't enough: it only fires the first time a field gains
  // focus, so re-clicking a field that's already focused (e.g. right after
  // picking an option, since selecting one deliberately keeps focus on the
  // input) would never reopen the menu — you'd have to type something to
  // trigger the "input" handler instead, which is exactly the "one result,
  // have to backspace to empty" symptom this was built to avoid. "click"
  // fires every time regardless of prior focus state, so pair both.
  input.addEventListener("focus", ()=> openMenu(""));
  input.addEventListener("click", ()=> openMenu(""));
  input.addEventListener("input", ()=> openMenu(input.value));
  input.addEventListener("keydown", (e)=>{
    if(!menu) return;
    const rows=[...menu.children];
    if(e.key==="ArrowDown"){ e.preventDefault(); setHighlight(Math.min(rows.length-1, highlighted+1)); rows[highlighted]?.scrollIntoView({block:"nearest"}); }
    else if(e.key==="ArrowUp"){ e.preventDefault(); setHighlight(Math.max(0, highlighted-1)); rows[highlighted]?.scrollIntoView({block:"nearest"}); }
    else if(e.key==="Enter"){ if(highlighted>=0){ e.preventDefault(); rows[highlighted].dispatchEvent(new Event("mousedown")); } }
    else if(e.key==="Escape"){ closeMenu(); }
  });
  return {
    setOptions(newItems, valueFn, lFn){
      const cur=this.value();
      items=newItems; labelFn=lFn;
      map={}; rmap={};
      items.forEach(it=>{ const label=lFn(it), id=valueFn(it); map[label]=id; rmap[id]=label; });
      if(cur) this.setValue(cur);
    },
    value(){ const v=input.value.trim(); return map[v]!==undefined?map[v]:(rmap[v]!==undefined?v:""); },
    setValue(id){ input.value=rmap[id]||""; },
    clear(){ input.value=""; }
  };
}
