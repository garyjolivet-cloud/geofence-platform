// Shared page-access gate. Include as the first <script src> in <head> on
// any staff-only page, then call RoleGate.require([...allowedRoles]).
// admin always passes regardless of the allowed list; everyone else gets
// redirected to a role-appropriate landing page instead of a blank/broken
// view. Resolves with the /api/auth/me payload for pages that need it.
(function () {
  "use strict";
  function require(allowedRoles) {
    return new Promise(function (resolve) {
      var s = localStorage.getItem("gp.session");
      var next = encodeURIComponent(location.pathname + location.search);
      if (!s) { location.replace("/login?next=" + next); return; }
      fetch("/api/auth/me", { headers: { authorization: "Bearer " + s } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (me) {
          if (!me) {
            localStorage.removeItem("gp.session");
            location.replace("/login?next=" + next);
            return;
          }
          if (me.role !== "admin" && allowedRoles.indexOf(me.role) === -1) {
            location.replace(me.role === "guide" ? "/field" : "/dashboard");
            return;
          }
          resolve(me);
        })
        .catch(function () { location.replace("/login?next=" + next); });
    });
  }
  window.RoleGate = { require: require };
})();
