// Shared, persistent "active client" selector for admin pages. Renders a
// searchable input into a given nav element, and keeps the selection in
// localStorage so it survives normal navigation between pages, unlike a
// one-shot ?asClient= URL param alone.
//
// Built as a fully custom dropdown rather than native <input list>+<datalist>:
// browsers filter a datalist's suggestions against whatever text is already
// in the field, so once a client is picked, focusing the field again only
// shows entries matching that leftover label (often just the one already
// picked) — not the full list. Native datalist popups also aren't
// controllable from script in any reliable cross-browser way. See the
// matching searchableSelect() in dashboard.html for the project pickers —
// same bug, same fix, applied here too since this picker gates which
// client's projects every other picker on the page shows.
(function () {
  "use strict";
  const KEY = "gp.activeClient";

  function get() { try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; } }
  function set(id) {
    try { id ? localStorage.setItem(KEY, id) : localStorage.removeItem(KEY); } catch (e) {}
  }
  function resolve() {
    const url = new URLSearchParams(location.search).get("asClient");
    if (url) { set(url); return url; }
    return get();
  }

  function getToken() {
    try { return localStorage.getItem("gp.session") || localStorage.getItem("gp.admin") || ""; }
    catch (e) { return ""; }
  }

  async function init(opts) {
    opts = opts || {};
    const navEl = opts.navEl;
    if (!navEl) return;
    const allowAll = !!opts.allowAll;
    const onChange = opts.onChange || function () {};

    const wrap = document.createElement("span");
    wrap.style.cssText = "display:inline-flex;align-items:center;gap:4px";
    const input = document.createElement("input");
    input.id = "clientPickerInput";
    input.placeholder = allowAll ? "All clients" : "Client…";
    input.style.cssText = "font-family:'Barlow Condensed';font-size:13px;padding:8px 10px;" +
      "border:1px solid var(--rim,#2e3f58);border-radius:9px;background:rgba(20,29,43,.5);" +
      "color:var(--ice,#c8dff2);width:170px";
    wrap.appendChild(input);
    navEl.insertBefore(wrap, navEl.firstChild);

    let clients = [];
    let byLabel = {};
    let byId = {};
    function labelFor(c) { return (c.name || c.id) + " (" + c.id + ")"; }

    // Fully custom dropdown — mirrors searchableSelect() in dashboard.html.
    let menu = null, highlighted = -1;
    function closeMenu() {
      if (!menu) return;
      menu.remove(); menu = null; highlighted = -1;
      document.removeEventListener("mousedown", onDocMouseDown, true);
    }
    function onDocMouseDown(e) { if (menu && !menu.contains(e.target) && e.target !== input) closeMenu(); }
    function setHighlight(i) {
      if (!menu) return;
      const rows = [...menu.children];
      rows.forEach((r, idx) => { r.style.background = idx === i ? "rgba(255,106,61,.18)" : ""; });
      highlighted = i;
    }
    function selectClient(id) {
      set(id);
      const params = new URLSearchParams(location.search);
      if (id) params.set("asClient", id); else params.delete("asClient");
      const qs = params.toString();
      history.replaceState(null, "", location.pathname + (qs ? "?" + qs : ""));
      render(id);
      onChange(id);
    }
    function openMenu(filterText) {
      closeMenu();
      const q = (filterText || "").trim().toLowerCase();
      const rowDefs = (allowAll ? [{ id: "", label: "All clients" }] : [])
        .concat(clients.map(c => ({ id: c.id, label: labelFor(c) })));
      const matches = rowDefs.filter(r => !q || r.label.toLowerCase().includes(q)).slice(0, 200);
      if (!matches.length) return;
      menu = document.createElement("div");
      const r = input.getBoundingClientRect();
      menu.style.cssText = "position:fixed;z-index:500;background:var(--slate2,#1b2738);"
        + "border:1px solid var(--rim,#26344a);border-radius:9px;max-height:240px;overflow-y:auto;"
        + "box-shadow:0 8px 24px rgba(0,0,0,.4);font-family:'Barlow Condensed';font-size:13px;"
        + "top:" + (r.bottom + 4) + "px;left:" + r.left + "px;width:max(" + r.width + "px, 220px)";
      matches.forEach(m => {
        const row = document.createElement("div");
        row.textContent = m.label;
        row.style.cssText = "padding:8px 10px;cursor:pointer;color:var(--snow,#eef4fb)";
        row.addEventListener("mouseenter", () => { row.style.background = "rgba(255,106,61,.18)"; });
        row.addEventListener("mouseleave", () => { if (menu) row.style.background = ""; });
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          closeMenu();
          selectClient(m.id);
        });
        menu.appendChild(row);
      });
      document.body.appendChild(menu);
      document.addEventListener("mousedown", onDocMouseDown, true);
    }
    input.addEventListener("focus", () => openMenu(""));
    input.addEventListener("click", () => openMenu(""));
    input.addEventListener("input", () => openMenu(input.value));
    input.addEventListener("keydown", (e) => {
      if (!menu) return;
      const rows = [...menu.children];
      if (e.key === "ArrowDown") { e.preventDefault(); setHighlight(Math.min(rows.length - 1, highlighted + 1)); rows[highlighted]?.scrollIntoView({ block: "nearest" }); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight(Math.max(0, highlighted - 1)); rows[highlighted]?.scrollIntoView({ block: "nearest" }); }
      else if (e.key === "Enter") { if (highlighted >= 0) { e.preventDefault(); rows[highlighted].dispatchEvent(new Event("mousedown")); } }
      else if (e.key === "Escape") { closeMenu(); }
    });
    input.addEventListener("blur", () => {
      // Revert to the last valid selection if the field is left with
      // unmatched free text (e.g. typed then clicked away without picking).
      setTimeout(() => { if (!menu) render(resolve()); }, 0);
    });

    function render(selectedId) {
      const cur = clients.find(c => c.id === selectedId);
      input.value = cur ? labelFor(cur) : (allowAll ? "All clients" : "");
    }

    try {
      const r = await fetch("/api/clients", { headers: { authorization: "Bearer " + getToken() } });
      clients = r.ok ? ((await r.json()).clients || []) : [];
      byLabel = {}; byId = {};
      clients.forEach(c => { byLabel[labelFor(c)] = c.id; byId[c.id] = c; });
    } catch (e) { clients = []; }

    render(resolve() || opts.defaultId || "");
  }

  window.ClientPicker = { get, set, resolve, init };
})();
