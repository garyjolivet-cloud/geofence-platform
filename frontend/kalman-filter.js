/* GPSFilter — Extended Kalman Filter for GPS position/velocity smoothing.
 *
 * Replaces the old speed-adaptive dual-EMA `Smoother` (see project history —
 * that approach ignored fix.acc entirely when weighting fixes, and needed a
 * hand-tuned, hardcoded speed clamp that had already drifted out of sync
 * across its three "verbatim mirror" copies within the same week it was
 * last touched).
 *
 * State runs directly in GEOGRAPHIC coordinates (degrees), not a local
 * flat-metre projection, per explicit design direction — the nonlinear
 * lat/lon <-> physical-velocity relationship (longitude motion depends on
 * cos(latitude)) is carried through a proper Jacobian linearization every
 * step, rather than approximated away. This keeps the module correct and
 * extensible toward future non-walking-tour applications (larger operating
 * areas, higher latitudes, eventually a 3D/altitude state — e.g. a drone)
 * where the flat-earth shortcut this codebase's own Geo.toXY relies on for
 * zone geometry wouldn't hold up as well.
 *
 * State: X = [lat_deg, lon_deg, v_north_mps, v_east_mps].
 * f(X,dt) — the nonlinear state transition — and jacobianF(X,dt) — its
 * linearization, re-evaluated at the current estimate every step — are kept
 * as separate, independently-testable functions (exposed via _internal),
 * and predict/update below are written against "whatever f()/jacobianF()
 * return" rather than hardcoding 4 dimensions, so a future richer state
 * (e.g. + altitude + vertical velocity) is an additive swap, not a rewrite.
 *
 * Output contract, matching the old Smoother exactly so every downstream
 * consumer (Geofencer, TravelHeading, GuidanceBot, pipeline-runtime.js's
 * data.position block) keeps working unmodified:
 *   { lat, lon, acc, t, speed, headingTravel }
 */
(function(global){
"use strict";

const D2R = Math.PI/180;
const R_LAT = 111320; // metres per degree latitude (spherical approximation — matches Geo.hav/Geo.toXY elsewhere in this codebase)

// ---- tunables ----
// Process noise (acceleration) spectral density, (m/s^2)^2/s — the ONE knob
// replacing the old filter's four interacting constants (SMOOTH_TAU_MAX_S/
// MIN_S/SMOOTH_SPEED_LO_MPS/HI_MPS). Reasoned to roughly match the old
// filter's walking-pace settling time (SMOOTH_TAU_MAX_S=2.3s) — this is a
// starting guess from the math, not a field-validated value; needs real
// tuning against recorded walking/bike/ski GPS traces, same as 2.3s itself
// was field-validated on 2026-06-23 rather than derived from first
// principles.
const Q_DENSITY = 0.75;
const ACC_FLOOR_M = 5;          // never trust a fix as better than this even if fix.acc reports lower
const ACC_CEIL_M = 50;          // beyond this a fix is very low-confidence but still incorporated, not discarded
                                 // (that decision-gating already happens downstream via Geofencer's ACCURACY_CAP_M)
const P0_POS_DEG = 10 / R_LAT;  // initial position uncertainty (~10m) — loose enough the first real fix dominates
const P0_VEL_MPS = 5;           // initial velocity uncertainty — velocity is entirely unknown at reset
const NIS_GATE = 9;             // normalized-innovation-squared gate, ~99% for 2 degrees of freedom
const MIN_HEADING_SPEED_MPS = 0.5; // below this, a velocity estimate's *direction* is noise, not signal (matches TravelHeading.MIN_SPEED)

// ---- small matrix helpers (kept local — this module has no external dependency) ----
function zeros(n,m){ const a=[]; for(let i=0;i<n;i++) a.push(new Array(m).fill(0)); return a; }
function matMul(A,B){
  const n=A.length, k=A[0].length, m=B[0].length;
  const C=zeros(n,m);
  for(let i=0;i<n;i++) for(let j=0;j<m;j++){ let s=0; for(let t=0;t<k;t++) s+=A[i][t]*B[t][j]; C[i][j]=s; }
  return C;
}
function transpose(A){ const n=A.length,m=A[0].length; const T=zeros(m,n); for(let i=0;i<n;i++) for(let j=0;j<m;j++) T[j][i]=A[i][j]; return T; }
function matAdd(A,B){ const n=A.length,m=A[0].length; const C=zeros(n,m); for(let i=0;i<n;i++) for(let j=0;j<m;j++) C[i][j]=A[i][j]+B[i][j]; return C; }
function matSub(A,B){ const n=A.length,m=A[0].length; const C=zeros(n,m); for(let i=0;i<n;i++) for(let j=0;j<m;j++) C[i][j]=A[i][j]-B[i][j]; return C; }
function inv2(A){ const [[a,b],[c,d]]=A; const det=a*d-b*c; return [[d/det,-b/det],[-c/det,a/det]]; }

/* ===================== nonlinear motion model ===================== */
// v_n/v_e are metres/second; lat/lon are degrees. Converting a physical
// velocity into a rate-of-change-in-degrees requires dividing by the local
// metres-per-degree scale — for longitude that scale is R_LAT*cos(lat),
// which depends on latitude, which is itself part of the state. That
// coupling is the genuine nonlinearity an EKF exists to handle (as opposed
// to a plain linear KF).
function f(X, dt){
  const [lat, lon, vn, ve] = X;
  const phi = lat*D2R;
  return [
    lat + (vn*dt)/R_LAT,
    lon + (ve*dt)/(R_LAT*Math.cos(phi)),
    vn,
    ve
  ];
}
// Jacobian of f() w.r.t. X, evaluated at the CURRENT (pre-predict) estimate
// every step — this re-linearization, rather than a fixed matrix, is what
// "extended" means. Verified against a finite-difference numerical Jacobian
// at 0°, 51.3° (Golden BC), and 70° latitude — matched to ~1e-9. See
// ../tests/kalman-filter.test.js, which keeps that check as a permanent
// regression test (a hand-derived EKF Jacobian is exactly the kind of
// thing that's easy to get subtly wrong and hard to catch by eye).
function jacobianF(X, dt){
  const [lat, , , ve] = X;
  const phi = lat*D2R;
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
  const dLonDLat = (ve*dt*D2R*sinPhi) / (R_LAT*cosPhi*cosPhi);
  return [
    [1,        0, dt/R_LAT,           0                 ],
    [dLonDLat, 1, 0,                  dt/(R_LAT*cosPhi) ],
    [0,        0, 1,                  0                 ],
    [0,        0, 0,                  1                 ]
  ];
}
// Process noise, built in local metres (standard discretized white-noise-
// acceleration model) then transformed into the state's mixed degrees/(m/s)
// units using the same latitude-dependent scale factors as jacobianF()
// above: position-position terms scale by the metres-per-degree factor
// squared, position-velocity cross terms by the factor once (only one side
// of the term is a position), velocity-velocity terms are unchanged
// (velocity stays in m/s throughout). No cross term between the lat and lon
// axes — neither the motion model nor the projection couples them.
function processNoise(X, dt){
  const phi = X[0]*D2R;
  const dt2=dt*dt, dt3=dt2*dt, dt4=dt3*dt;
  const qPP = Q_DENSITY*dt4/4, qPV = Q_DENSITY*dt3/2, qVV = Q_DENSITY*dt2;
  const mPerDegLat = R_LAT, mPerDegLon = R_LAT*Math.cos(phi);
  return [
    [ qPP/(mPerDegLat*mPerDegLat), 0,                            qPV/mPerDegLat, 0              ],
    [ 0,                           qPP/(mPerDegLon*mPerDegLon),  0,              qPV/mPerDegLon ],
    [ qPV/mPerDegLat,              0,                            qVV,            0              ],
    [ 0,                           qPV/mPerDegLon,                0,             qVV            ]
  ];
}

/* ===================== filter state + public API ===================== */
let X = null; // [lat,lon,vn,ve]
let P = null; // 4x4 covariance
let lastT = null;

function reset(){ X=null; P=null; lastT=null; }

function output(fix){
  const [lat, lon, vn, ve] = X;
  const speed = Math.hypot(vn, ve);
  let headingTravel = null;
  if (speed >= MIN_HEADING_SPEED_MPS) headingTravel = (Math.atan2(ve, vn)*180/Math.PI + 360) % 360;
  return { lat, lon, acc: fix.acc, t: fix.t, speed, headingTravel };
}

function push(fix){
  if (X === null){
    // First fix is trusted outright as the seed, matching the old filter's
    // this.s={lat:fix.lat,lon:fix.lon} — but with a loose (not zero)
    // covariance, so the first real correction isn't distrusted relative
    // to this seed.
    X = [fix.lat, fix.lon, 0, 0];
    P = [
      [P0_POS_DEG*P0_POS_DEG, 0, 0, 0],
      [0, P0_POS_DEG*P0_POS_DEG, 0, 0],
      [0, 0, P0_VEL_MPS*P0_VEL_MPS, 0],
      [0, 0, 0, P0_VEL_MPS*P0_VEL_MPS]
    ];
    lastT = fix.t;
    return output(fix);
  }

  const dt = Math.max(0, (fix.t - lastT)/1000);
  lastT = fix.t;

  // ---- predict ----
  // EKF procedure, the precise distinction that makes this "extended"
  // rather than an implementation bug: the STATE prediction uses the exact
  // nonlinear f(), not the linearized F — only the COVARIANCE prediction
  // uses F. Using F for the state step too is a common EKF bug; don't.
  const Xpred = dt>0 ? f(X, dt) : X.slice();
  const F = jacobianF(X, dt);
  const Q = processNoise(X, dt);
  const Ppred = matAdd(matMul(matMul(F,P), transpose(F)), Q);

  // ---- update ----
  // H = [[1,0,0,0],[0,1,0,0]] (fix measures position only) — its structure
  // means H*P*H^T is just P's top-left 2x2 block, and P*H^T is just P's
  // first two columns; both shortcuts are used directly below instead of a
  // general matrix multiply.
  const phi = Xpred[0]*D2R;
  const sigma = Math.min(ACC_CEIL_M, Math.max(ACC_FLOOR_M, fix.acc||ACC_CEIL_M));
  const sigLat = sigma/R_LAT, sigLon = sigma/(R_LAT*Math.cos(phi));
  const R = [[sigLat*sigLat,0],[0,sigLon*sigLon]];

  const y = [fix.lat-Xpred[0], fix.lon-Xpred[1]]; // innovation
  const Ptop = [[Ppred[0][0],Ppred[0][1]],[Ppred[1][0],Ppred[1][1]]];
  let S = matAdd(Ptop, R);
  let Sinv = inv2(S);
  const d2 = y[0]*(Sinv[0][0]*y[0]+Sinv[0][1]*y[1]) + y[1]*(Sinv[1][0]*y[0]+Sinv[1][1]*y[1]);
  if (d2 > NIS_GATE){
    // Inflate R rather than reject outright — lets a real fast/surprising
    // movement still pull the state, cautiously, instead of the filter
    // starving of correction during a genuine sustained fast movement.
    // This is the structural, self-scaling replacement for the old
    // filter's hardcoded speed-based spike clamp (which needed manual
    // re-tuning, 25->160 m/s, the moment Test Mode's supported speed range
    // widened — exactly the class of bug this design eliminates).
    const scale = Math.max(1, d2/NIS_GATE);
    S = matAdd(Ptop, [[R[0][0]*scale,0],[0,R[1][1]*scale]]);
    Sinv = inv2(S);
  }
  const K = [
    [Ppred[0][0]*Sinv[0][0]+Ppred[0][1]*Sinv[1][0], Ppred[0][0]*Sinv[0][1]+Ppred[0][1]*Sinv[1][1]],
    [Ppred[1][0]*Sinv[0][0]+Ppred[1][1]*Sinv[1][0], Ppred[1][0]*Sinv[0][1]+Ppred[1][1]*Sinv[1][1]],
    [Ppred[2][0]*Sinv[0][0]+Ppred[2][1]*Sinv[1][0], Ppred[2][0]*Sinv[0][1]+Ppred[2][1]*Sinv[1][1]],
    [Ppred[3][0]*Sinv[0][0]+Ppred[3][1]*Sinv[1][0], Ppred[3][0]*Sinv[0][1]+Ppred[3][1]*Sinv[1][1]]
  ];
  X = Xpred.map((v,i)=>v + K[i][0]*y[0] + K[i][1]*y[1]);
  const KH_Ppred = zeros(4,4);
  for(let i=0;i<4;i++) for(let j=0;j<4;j++) KH_Ppred[i][j] = K[i][0]*Ppred[0][j] + K[i][1]*Ppred[1][j];
  P = matSub(Ppred, KH_Ppred);

  return output(fix);
}

global.GPSFilter = {
  push, reset,
  // Exposed for the standalone Jacobian/process-noise regression test —
  // not intended for use by host pages.
  _internal: { f, jacobianF, processNoise, R_LAT, D2R }
};
})(typeof window !== "undefined" ? window : globalThis);
