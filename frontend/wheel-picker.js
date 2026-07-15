/* wheel-picker.js — scroll-wheel date/time picker
 * Replaces native <input type="date">/<input type="time"> with an
 * iOS-style scrollable wheel popover. No dependencies; uses CSS
 * scroll-snap so mouse-wheel, click-drag, and touch-scroll all work
 * for free. Styled entirely from the host page's existing :root
 * custom properties (--night/--slate2/--rim/--snow/--fog/--ice/--coral).
 * Exposes window.WheelPicker.
 */
(function(){
'use strict';

const ITEM_H = 36;
const VISIBLE = 5;
const COL_H = ITEM_H * VISIBLE;
const PAD_ROWS = Math.floor(VISIBLE / 2);

let styleInjected = false;
function injectStyle(){
  if (styleInjected) return;
  styleInjected = true;
  const css = `
  .wp-overlay{position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.35)}
  .wp-pop{position:fixed;background:var(--slate,#141d2b);border:1px solid var(--rim,#26344a);
    border-radius:14px;padding:14px;box-shadow:0 12px 40px rgba(0,0,0,.5);z-index:1000;
    font-family:"Barlow Condensed",system-ui,sans-serif}
  @media (max-width:520px){
    .wp-pop{left:0 !important;right:0;bottom:0;top:auto !important;border-radius:16px 16px 0 0;width:auto}
  }
  .wp-cols{display:flex;gap:4px;position:relative}
  .wp-col{width:84px;height:${COL_H}px;overflow-y:auto;scroll-snap-type:y mandatory;
    -webkit-overflow-scrolling:touch;scrollbar-width:none}
  .wp-col::-webkit-scrollbar{display:none}
  .wp-item{height:${ITEM_H}px;display:flex;align-items:center;justify-content:center;
    scroll-snap-align:center;color:var(--fog,#5b7088);font-size:15px;font-weight:600;
    user-select:none;cursor:pointer}
  .wp-item.wp-sel{color:var(--snow,#eef4fb)}
  .wp-center-bar{position:absolute;left:0;right:0;top:${ITEM_H*PAD_ROWS}px;height:${ITEM_H}px;
    border-top:1px solid var(--rim,#26344a);border-bottom:1px solid var(--rim,#26344a);
    pointer-events:none}
  .wp-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
  .wp-btn{font-family:"Barlow Condensed";font-weight:700;font-size:13px;letter-spacing:.4px;
    text-transform:uppercase;border-radius:9px;padding:8px 14px;cursor:pointer;border:none}
  .wp-btn.wp-cancel{background:var(--slate2,#1b2738);color:var(--fog,#5b7088);border:1px solid var(--rim,#26344a)}
  .wp-btn.wp-done{background:var(--coral,#ff6a3d);color:#1a0d07}
  `;
  const tag = document.createElement("style");
  tag.textContent = css;
  document.head.appendChild(tag);
}

function pad2(n){ return String(n).padStart(2,"0"); }
function isLeap(y){ return (y%4===0 && y%100!==0) || y%400===0; }
function daysInMonth(y,m){ return [31, isLeap(y)?29:28, 31,30,31,30,31,31,30,31,30,31][m]; }

function buildCol(container, items, selectedIndex, onSettle){
  container.className = "wp-col";
  const spacerTop = document.createElement("div"); spacerTop.style.height = (ITEM_H*PAD_ROWS)+"px";
  const spacerBot = document.createElement("div"); spacerBot.style.height = (ITEM_H*PAD_ROWS)+"px";
  container.appendChild(spacerTop);
  const rows = items.map((label, i)=>{
    const el = document.createElement("div");
    el.className = "wp-item"; el.textContent = label;
    el.addEventListener("click", ()=>{ container.scrollTop = i*ITEM_H; });
    container.appendChild(el);
    return el;
  });
  container.appendChild(spacerBot);

  let current = selectedIndex;
  function markSelected(idx){
    rows.forEach((el,i)=> el.classList.toggle("wp-sel", i===idx));
  }
  markSelected(current);
  container.scrollTop = selectedIndex * ITEM_H;

  let debounceTimer = null;
  container.addEventListener("scroll", ()=>{
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(()=>{
      let idx = Math.round(container.scrollTop / ITEM_H);
      idx = Math.max(0, Math.min(items.length-1, idx));
      if (idx !== current){ current = idx; markSelected(idx); onSettle && onSettle(idx); }
      const target = idx*ITEM_H;
      if (Math.abs(container.scrollTop - target) > 1) container.scrollTop = target;
    }, 120);
  }, { passive:true });

  return {
    get index(){ return current; },
    setItems(newItems, newIndex){
      items = newItems;
      rows.length = 0;
      container.innerHTML = "";
      const st = document.createElement("div"); st.style.height=(ITEM_H*PAD_ROWS)+"px";
      const sb = document.createElement("div"); sb.style.height=(ITEM_H*PAD_ROWS)+"px";
      container.appendChild(st);
      newItems.forEach((label,i)=>{
        const el = document.createElement("div");
        el.className = "wp-item"; el.textContent = label;
        el.addEventListener("click", ()=>{ container.scrollTop = i*ITEM_H; });
        container.appendChild(el);
        rows.push(el);
      });
      container.appendChild(sb);
      current = Math.max(0, Math.min(newItems.length-1, newIndex));
      markSelected(current);
      container.scrollTop = current * ITEM_H;
    }
  };
}

function openPopover(anchorEl, buildContent){
  injectStyle();
  const overlay = document.createElement("div");
  overlay.className = "wp-overlay";
  const pop = document.createElement("div");
  pop.className = "wp-pop";
  pop.style.visibility = "hidden"; // built off-screen first so we can measure its real size below
  document.body.appendChild(overlay);
  document.body.appendChild(pop);

  function close(){ overlay.remove(); pop.remove(); document.removeEventListener("keydown", onKey); }
  function onKey(e){ if (e.key === "Escape") close(); }
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey);

  const api = buildContent(pop, close);

  // Position using the popup's actual rendered size, not a guessed height —
  // a hardcoded estimate drifts out of sync with real content/fonts/zoom and
  // is what let the popup render past the bottom of the viewport before.
  const isNarrow = window.matchMedia && window.matchMedia("(max-width:520px)").matches;
  if (!isNarrow){
    const r = anchorEl.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const popWidth = popRect.width;
    const popHeight = popRect.height;
    const margin = 12;
    let top = r.bottom + 8;
    if (top + popHeight > window.innerHeight - margin) {
      // doesn't fit below the anchor — try above it instead, else just clamp to the viewport
      const above = r.top - popHeight - 8;
      top = above >= margin ? above : Math.max(margin, window.innerHeight - popHeight - margin);
    }
    pop.style.top = top + "px";
    let left = r.left;
    if (left + popWidth > window.innerWidth - margin) left = window.innerWidth - popWidth - margin;
    pop.style.left = Math.max(margin, left) + "px";
  }
  pop.style.visibility = "";

  return { close, ...api };
}

function attachDate(inputEl, opts){
  opts = opts || {};
  const now = new Date();
  const minYear = opts.minYear || now.getFullYear();
  const maxYear = opts.maxYear || (now.getFullYear() + 2);
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  inputEl.readOnly = true;
  function open(){
    let y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    const existing = /^(\d{4})-(\d{2})-(\d{2})$/.exec(inputEl.value || "");
    if (existing){ y = Number(existing[1]); m = Number(existing[2])-1; d = Number(existing[3]); }
    y = Math.max(minYear, Math.min(maxYear, y));

    openPopover(inputEl, (pop, close)=>{
      const cols = document.createElement("div"); cols.className = "wp-cols";
      const bar = document.createElement("div"); bar.className = "wp-center-bar";
      const monthEl = document.createElement("div"), dayEl = document.createElement("div"), yearEl = document.createElement("div");
      cols.appendChild(monthEl); cols.appendChild(dayEl); cols.appendChild(yearEl); cols.appendChild(bar);
      pop.appendChild(cols);

      const years = []; for(let yy=minYear; yy<=maxYear; yy++) years.push(String(yy));

      const monthCol = buildCol(monthEl, MONTHS, m, (idx)=>{ m = idx; refreshDays(); });
      let dayCol;
      function refreshDays(){
        const n = daysInMonth(y, m);
        if (d > n) d = n;
        const dayLabels = Array.from({length:n}, (_,i)=>String(i+1));
        if (dayCol) dayCol.setItems(dayLabels, d-1);
      }
      dayCol = buildCol(dayEl, Array.from({length:daysInMonth(y,m)}, (_,i)=>String(i+1)), d-1, (idx)=>{ d = idx+1; });
      buildCol(yearEl, years, years.indexOf(String(y)), (idx)=>{ y = Number(years[idx]); refreshDays(); });

      const actions = document.createElement("div"); actions.className = "wp-actions";
      const cancelBtn = document.createElement("button"); cancelBtn.className = "wp-btn wp-cancel"; cancelBtn.textContent = "Cancel";
      const doneBtn = document.createElement("button"); doneBtn.className = "wp-btn wp-done"; doneBtn.textContent = "Done";
      cancelBtn.addEventListener("click", close);
      doneBtn.addEventListener("click", ()=>{
        inputEl.value = y + "-" + pad2(m+1) + "-" + pad2(d);
        inputEl.dispatchEvent(new Event("input", { bubbles:true }));
        inputEl.dispatchEvent(new Event("change", { bubbles:true }));
        close();
      });
      actions.appendChild(cancelBtn); actions.appendChild(doneBtn);
      pop.appendChild(actions);
      return {};
    });
  }
  inputEl.addEventListener("click", open);
  inputEl.addEventListener("keydown", (e)=>{ if (e.key==="Enter" || e.key===" "){ e.preventDefault(); open(); } });
  return function teardown(){ inputEl.removeEventListener("click", open); };
}

function attachTime(inputEl, opts){
  opts = opts || {};
  const minuteStep = opts.minuteStep || 15;
  inputEl.readOnly = true;

  function open(){
    let h24 = 9, mi = 0;
    const existing = /^(\d{1,2}):(\d{2})/.exec(inputEl.value || "");
    if (existing){ h24 = Number(existing[1]); mi = Number(existing[2]); }
    let ap = h24 >= 12 ? "PM" : "AM";
    let h12 = h24 % 12 || 12;
    mi = Math.round(mi / minuteStep) * minuteStep % 60;

    openPopover(inputEl, (pop, close)=>{
      const cols = document.createElement("div"); cols.className = "wp-cols";
      const bar = document.createElement("div"); bar.className = "wp-center-bar";
      const hourEl = document.createElement("div"), minEl = document.createElement("div"), apEl = document.createElement("div");
      cols.appendChild(hourEl); cols.appendChild(minEl); cols.appendChild(apEl); cols.appendChild(bar);
      pop.appendChild(cols);

      const hours = Array.from({length:12}, (_,i)=>String(i+1));
      const minutes = []; for(let mm=0; mm<60; mm+=minuteStep) minutes.push(pad2(mm));
      const ampm = ["AM","PM"];

      buildCol(hourEl, hours, h12-1, (idx)=>{ h12 = idx+1; });
      buildCol(minEl, minutes, Math.max(0, minutes.indexOf(pad2(mi))), (idx)=>{ mi = Number(minutes[idx]); });
      buildCol(apEl, ampm, ampm.indexOf(ap), (idx)=>{ ap = ampm[idx]; });

      const actions = document.createElement("div"); actions.className = "wp-actions";
      const cancelBtn = document.createElement("button"); cancelBtn.className = "wp-btn wp-cancel"; cancelBtn.textContent = "Cancel";
      const doneBtn = document.createElement("button"); doneBtn.className = "wp-btn wp-done"; doneBtn.textContent = "Done";
      cancelBtn.addEventListener("click", close);
      doneBtn.addEventListener("click", ()=>{
        let h = h12 % 12; if (ap === "PM") h += 12;
        inputEl.value = pad2(h) + ":" + pad2(mi);
        inputEl.dispatchEvent(new Event("input", { bubbles:true }));
        inputEl.dispatchEvent(new Event("change", { bubbles:true }));
        close();
      });
      actions.appendChild(cancelBtn); actions.appendChild(doneBtn);
      pop.appendChild(actions);
      return {};
    });
  }
  inputEl.addEventListener("click", open);
  inputEl.addEventListener("keydown", (e)=>{ if (e.key==="Enter" || e.key===" "){ e.preventDefault(); open(); } });
  return function teardown(){ inputEl.removeEventListener("click", open); };
}

window.WheelPicker = { attachDate, attachTime };
})();
