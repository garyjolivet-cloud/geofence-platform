/* Ridge Quest outbox (2026-09-24): logged runs and saved chute lines that could not reach the
   server (no phone signal on the hill, a server blip, an expired login) are kept on the phone
   and sent when the connection comes back.

   Every item carries a phone-made clientId, and the server treats a clientId it has already
   stored as done, so a retry can never count a run twice -- even when the first attempt
   actually reached the server and only the reply was lost.

   window.RQOutbox = {
     OUTBOX,
     createOutbox({ storage, send, playerId, onSent, onChange })
       .add(item)      item: { kind:"run"|"line", path, body }   (body.clientId required)
       .deliver(item)  try now; on a retryable failure keep it; resolves "sent"|"queued"|"dropped"
       .flush()        send everything waiting for the current player, oldest first; stops at
                       the first retryable failure (no signal = no point hammering)
       .pending()      items waiting for the current player
     newClientId()
   }

   send(path, body) -> Promise<{ status }> (status 0 = network failure). Retryable: 0, 401
   (logged out -- kept until the rider logs back in), 408, 429 and 5xx. Anything else (a 4xx the
   server will never accept) is dropped so one bad item can't block the queue forever.
   storage may throw or be missing (private mode): the queue then lives in memory for this
   session only. Items are tagged with the player id and only ever sent by that player. */
(function (root) {
  "use strict";

  var OUTBOX = {
    KEY: "rq.outbox",
    MAX_ITEMS: 200,      // ~a very big offline day; beyond this the OLDEST line is dropped first
    MAX_CHARS: 1500000   // stay well inside the ~5 MB localStorage quota shared with the rest of the app
  };

  function newClientId() {
    try { if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID(); } catch (e) {}
    return "c" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
  }

  function retryable(status) {
    return status === 0 || status === 401 || status === 408 || status === 429 || status >= 500;
  }

  function createOutbox(opts) {
    var storage = opts.storage, memory = null, busy = false;
    function read() {
      if (memory) return memory;
      try { var v = JSON.parse(storage.getItem(OUTBOX.KEY) || "[]"); return Array.isArray(v) ? v : []; }
      catch (e) { return memory = []; }
    }
    function write(list) {
      // keep it bounded: drop the oldest LINE first (a run is a count/points, a line is a nicety)
      while (list.length > OUTBOX.MAX_ITEMS || JSON.stringify(list).length > OUTBOX.MAX_CHARS) {
        var i = list.findIndex(function (x) { return x.kind === "line"; });
        list.splice(i >= 0 ? i : 0, 1);
      }
      if (memory) { memory = list; }
      else {
        try { storage.setItem(OUTBOX.KEY, JSON.stringify(list)); }
        catch (e) { memory = list; }
      }
      if (opts.onChange) { try { opts.onChange(); } catch (e) {} }
    }
    function mine(x) { return x.playerId === opts.playerId(); }
    function remove(clientId) { write(read().filter(function (x) { return x.body.clientId !== clientId; })); }

    function add(item) {
      var list = read();
      if (list.some(function (x) { return x.body.clientId === item.body.clientId; })) return;
      list.push({ kind: item.kind, path: item.path, body: item.body, playerId: opts.playerId(), queuedAt: Date.now() });
      write(list);
    }
    function attempt(item) {
      return Promise.resolve().then(function () { return opts.send(item.path, item.body); })
        .then(function (r) { return (r && typeof r.status === "number") ? r.status : 0; }, function () { return 0; });
    }
    function sent(item) { if (opts.onSent) { try { opts.onSent(item); } catch (e) {} } }

    // Try once now. Kept on the phone (not lost) on any retryable failure.
    function deliver(item) {
      return attempt(item).then(function (status) {
        if (status >= 200 && status < 300) { sent(item); return "sent"; }
        if (retryable(status)) { add(item); return "queued"; }
        return "dropped";
      });
    }
    function flush() {
      if (busy) return Promise.resolve(0);
      busy = true;
      var n = 0;
      function next() {
        var item = read().filter(mine)[0];
        if (!item) return n;
        return attempt(item).then(function (status) {
          if (status >= 200 && status < 300) { remove(item.body.clientId); n++; sent(item); return next(); }
          if (retryable(status)) return n;
          remove(item.body.clientId);   // never going to be accepted; don't block the queue on it
          return next();
        });
      }
      return Promise.resolve().then(next).then(function (x) { busy = false; return x; }, function () { busy = false; return n; });
    }
    return {
      add: add, deliver: deliver, flush: flush,
      pending: function () { return read().filter(mine); }
    };
  }

  root.RQOutbox = { OUTBOX: OUTBOX, createOutbox: createOutbox, newClientId: newClientId, retryable: retryable };
})(typeof window !== "undefined" ? window : globalThis);
