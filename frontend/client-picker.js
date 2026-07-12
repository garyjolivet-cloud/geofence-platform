// Shared, persistent "active client" selector for admin pages. Renders a
// searchable input (backed by a <datalist>, not a plain <select> — stays
// usable at 100+ clients) into a given nav element, and keeps the selection
// in localStorage so it survives normal navigation between pages, unlike a
// one-shot ?asClient= URL param alone.
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
    input.setAttribute("list", "clientPickerList");
    input.placeholder = allowAll ? "All clients" : "Client…";
    input.style.cssText = "font-family:'Barlow Condensed';font-size:13px;padding:8px 10px;" +
      "border:1px solid var(--rim,#2e3f58);border-radius:9px;background:rgba(20,29,43,.5);" +
      "color:var(--ice,#c8dff2);width:170px";
    const list = document.createElement("datalist");
    list.id = "clientPickerList";
    wrap.appendChild(input);
    wrap.appendChild(list);
    navEl.insertBefore(wrap, navEl.firstChild);

    let clients = [];
    let byLabel = {};
    function labelFor(c) { return (c.name || c.id) + " (" + c.id + ")"; }
    function render(selectedId) {
      list.innerHTML = (allowAll ? ['<option value="All clients">']: [])
        .concat(clients.map(c => '<option value="' + labelFor(c).replace(/"/g, "&quot;") + '">'))
        .join("");
      const cur = clients.find(c => c.id === selectedId);
      input.value = cur ? labelFor(cur) : (allowAll ? "All clients" : "");
    }

    try {
      const r = await fetch("/api/clients", { headers: { authorization: "Bearer " + getToken() } });
      clients = r.ok ? ((await r.json()).clients || []) : [];
      byLabel = {};
      clients.forEach(c => { byLabel[labelFor(c)] = c.id; });
    } catch (e) { clients = []; }

    render(resolve() || opts.defaultId || "");

    input.addEventListener("change", () => {
      const val = input.value.trim();
      let id = byLabel[val] || "";
      if (allowAll && (val === "" || val === "All clients")) id = "";
      else if (!id) { render(resolve()); return; } // unrecognized text, revert
      set(id);
      const params = new URLSearchParams(location.search);
      if (id) params.set("asClient", id); else params.delete("asClient");
      const qs = params.toString();
      history.replaceState(null, "", location.pathname + (qs ? "?" + qs : ""));
      render(id);
      onChange(id);
    });
  }

  window.ClientPicker = { get, set, resolve, init };
})();
