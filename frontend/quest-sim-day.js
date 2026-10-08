/* quest-sim-day.js -- one simulated Ridge Quest day, held in memory only (2026-10-08, Gary:
   "test needs to be a true simulator ... only today data will be used no year to date or saving of
   test data"). The Fence Editor's Test Mode fills it with the runs the real run engine
   (quest-core.js) logs; the rider's own simulator will use it the same way later.

   Nothing here touches localStorage or the network. Never show or reward speed (house rule).

   window.QuestSimDay.create({ rider, corridors }) -> {
     addRun(run, points)   run = what QuestCore.runMethods hands _postRun
     runs()                newest first
     totals()              { verticalM, chutes, chutesTotal, runs, runsSkied, runsTotal, liftRides, points } -- Home's rules
     skiedSet()            zone ids of chutes skied (for RidgeVisuals.completion)
     board()               [{ playerId, name, points, verticalM, runsCount }] -- the test rider only
     socialDay(ctx)        the day object SocialCard.make draws (SocialCard.dayFromRuns)
     reset()
   } */
(function (root) {
  "use strict";

  function create(opts) {
    opts = opts || {};
    var rider = opts.rider || "Test rider";
    var corridors = opts.corridors || [];
    var list = [];

    function addRun(run, points) {
      var r = {
        zoneId: run.zoneId, runName: run.runName, difficulty: run.difficulty || null, runType: run.runType || "run",
        activity: run.activity, verticalM: run.verticalM != null ? run.verticalM : null,
        distanceM: run.distanceM != null ? run.distanceM : null, durationS: run.durationS || 0,
        startedAt: run.startedAt, endedAt: run.endedAt,
        points: Math.round(points || 0)
      };
      list.push(r);
      return r;
    }
    function isChuteSkied(r) { return r.activity === "ski" && r.runType === "chute"; }
    function skiedSet() {
      var s = new Set();
      list.forEach(function (r) { if (isChuteSkied(r)) s.add(r.zoneId); });
      return s;
    }
    // Home's numbers: vertical = lift rides + boot packs (not chute descents); Chutes = different
    // chutes skied, of the map's chutes; Runs = ski descents that aren't chutes, every lap counted.
    function totals() {
      var vert = 0, runs = 0, lifts = 0, points = 0, runIds = new Set();
      list.forEach(function (r) {
        if (r.activity === "ski" && r.runType !== "chute") runIds.add(r.zoneId);
        if (r.activity === "lift" || r.activity === "hike") vert += Math.abs(r.verticalM || 0);
        if (r.activity === "ski" && r.runType !== "chute") runs++;
        if (r.activity === "lift") lifts++;
        points += r.points;
      });
      return {
        verticalM: Math.round(vert), chutes: skiedSet().size,
        chutesTotal: corridors.filter(function (c) { return c.runType === "chute"; }).length,
        runs: runs, liftRides: lifts, points: points,
        // like chutes n/total: different runs skied, of the map's runs (2026-10-08, Gary: "runs need to show in the leader board like chutes")
        runsSkied: runIds.size, runsTotal: corridors.filter(function (c) { return (c.runType || "run") === "run"; }).length
      };
    }
    // The leaderboard row, as /api/leaderboard/daily builds it from player_day_stats: scored
    // (ski + boot pack) vertical, ski runs counted.
    function board() {
      var vert = 0, runs = 0, points = 0;
      list.forEach(function (r) {
        if (r.activity !== "lift") vert += Math.abs(r.verticalM || 0);
        if (r.activity === "ski") runs++;
        points += r.points;
      });
      return [{ playerId: "sim", name: rider, points: points, verticalM: Math.round(vert), runsCount: runs }];
    }
    function socialDay(ctx) {
      var c = Object.assign({ rider: rider, corridors: corridors }, ctx || {});
      return root.SocialCard.dayFromRuns(list, c);
    }
    return {
      addRun: addRun, runs: function () { return list.slice().reverse(); },
      totals: totals, skiedSet: skiedSet, board: board, socialDay: socialDay,
      reset: function () { list = []; }, rider: rider
    };
  }

  root.QuestSimDay = { create: create };
})(typeof window !== "undefined" ? window : globalThis);
