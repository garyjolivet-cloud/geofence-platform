/* GPSFilter — Extended Kalman Filter for GPS position/velocity/altitude smoothing.
 *
 * Replaces the old speed-adaptive dual-EMA `Smoother` (see project history —
 * that approach ignored fix.acc entirely when weighting fixes, and needed a
 * hand-tuned, hardcoded speed clamp that had already drifted out of sync
 * across its three "verbatim mirror" copies within the same week it was
 * last touched).
 *
 * State runs directly in GEOGRAPHIC coordinates (degrees) for lat/lon, not a
 * local flat-metre projection, per explicit design direction — the
 * nonlinear lat/lon <-> physical-velocity relationship (longitude motion
 * depends on cos(latitude)) is carried through a proper Jacobian
 * linearization every step, rather than approximated away.
 *
 * State: X = [lat_deg, lon_deg, v_north_mps, v_east_mps, alt_m, v_alt_mps].
 * Altitude and vertical velocity (added 3D Mode, 2026-08-13) are appended
 * rather than interleaved so the original 4 indices are unchanged — every
 * existing call site that only ever fed lat/lon fixes keeps working
 * byte-for-byte identically, since the alt/v_alt block has zero coupling
 * with the lat/lon/v_n/v_e block in f()/jacobianF()/processNoise() (a
 * walking tourist's horizontal and vertical motion are treated as
 * independent — the same "no cross term between axes" reasoning already
 * used between the lat and lon axes themselves).
 *
 * f(X,dt) — the nonlinear state transition — and jacobianF(X,dt) — its
 * linearization, re-evaluated at the current estimate every step — are kept
 * as separate, independently-testable functions (exposed via _internal).
 *
 * The measurement update runs as up to TWO INDEPENDENT corrections per push()
 * (see push() below): horizontal (lat/lon) always, exactly reproducing the
 * original 4D filter's math and gated by its own NIS threshold; altitude,
 * only when `fix.alt` is present (phone `coords.altitude`, a terrain-DEM
 * lookup, or a real BLE barometer dongle — item D of the 3D-mode plan),
 * gated by its OWN separate NIS threshold. Deliberately not one joint 3D
 * update — a noisy/outlier altitude reading must never inflate the
 * horizontal measurement noise (or vice versa); see push()'s update
 * section for the full reasoning.
 * `fix.altAcc` (metres) and `fix.altSource` ("gps"|"terrain"|"baro") let a
 * caller signal how much to trust that particular altitude reading —
 * whenever `fix.altAcc` is provided explicitly (as both the terrain-DEM
 * fallback and a real dongle's readings do), it's used directly and
 * `altSource` only matters for the `fix.altAcc==null` default below.
 * Barometric altitude is far more stable than phone-GPS altitude, and
 * "gps" vs "baro" trust tiers are the mechanism that lets that trust
 * difference actually change the fused
 * output, not just the data model. NOTE: barometric altitude drifts with
 * pressure and is
 * relative, not absolute — anchoring a raw baro reading to GNSS altitude on
 * connect (a slow EMA, not a one-shot offset) is a data-prep step that
 * belongs in the BLE bridge that produces `fix.alt`, not here; this filter
 * only fuses whatever `fix.alt`/`fix.altAcc` it's handed.
 *
 * Output contract, backward-compatible with the old Smoother and the
 * pre-3D-mode 4D filter — every existing field keeps the same meaning:
 *   { lat, lon, acc, t, speed, headingTravel, alt, vAlt }
 * `alt`/`vAlt` are null until the filter has ever seen a fix with altitude
 * (tracked via `altKnown` below) — callers that don't care about altitude
 * (every page before 3D Mode) can simply ignore these two new fields.
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
const NIS_GATE_2D = 9;           // normalized-innovation-squared gate, ~99% for 2 degrees of freedom (unchanged from pre-3D-mode filter)
const NIS_GATE_ALT_1D = 6.63;    // chi-square 99% quantile for 1 degree of freedom — gates the altitude correction INDEPENDENTLY of the horizontal one (see push()'s update section for why these must never share a gate)
const MIN_HEADING_SPEED_MPS = 0.5; // below this, a velocity estimate's *direction* is noise, not signal (matches TravelHeading.MIN_SPEED)

// Vertical (altitude) tunables — same "starting guess, needs field tuning"
// caveat as Q_DENSITY above. ALT_Q_DENSITY reuses Q_DENSITY's magnitude as
// its initial guess; mountain-trail vertical motion (real elevation gain,
// not just noise) may warrant a larger value once field-tested.
const ALT_Q_DENSITY = 0.75;
const ALT_ACC_FLOOR_M = 1;
const ALT_ACC_CEIL_M = 50;
const DEFAULT_GPS_ALT_ACC_M = 15;   // phone GPS altitude: much noisier than horizontal, used when fix.altAcc is omitted and fix.altSource isn't "baro"
const DEFAULT_BARO_ALT_ACC_M = 2;   // barometric altitude: tight, used when fix.altSource==="baro" and fix.altAcc is omitted
const P0_ALT_KNOWN_M = 15;      // initial altitude uncertainty when the very first fix already carries an altitude
const P0_ALT_UNKNOWN_M = 1000;  // initial altitude uncertainty when it doesn't (effectively "no opinion" until a real alt fix arrives)
const P0_VALT_MPS = 2;          // initial vertical-velocity uncertainty

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
// General small-matrix inverse via Gauss-Jordan elimination. Only ever
// called here with n=2 (horizontal-only fix) or n=3 (fix with altitude) —
// replaces the old hardcoded inv2()'s closed-form formula, which only
// worked for exactly 2x2.
function invN(A){
  const n=A.length;
  const M=A.map((row,i)=>row.concat(zeros(1,n)[0].map((_,j)=>i===j?1:0)));
  for(let col=0; col<n; col++){
    let piv=col;
    for(let r=col+1;r<n;r++) if(Math.abs(M[r][col])>Math.abs(M[piv][col])) piv=r;
    if(piv!==col){ const tmp=M[col]; M[col]=M[piv]; M[piv]=tmp; }
    const pv=M[col][col];
    for(let j=0;j<2*n;j++) M[col][j]/=pv;
    for(let r=0;r<n;r++){
      if(r===col) continue;
      const factor=M[r][col];
      if(factor===0) continue;
      for(let j=0;j<2*n;j++) M[r][j]-=factor*M[col][j];
    }
  }
  return M.map(row=>row.slice(n));
}

/* ===================== nonlinear motion model ===================== */
// v_n/v_e/v_alt are metres/second; lat/lon are degrees; alt is metres.
// Converting a physical horizontal velocity into a rate-of-change-in-degrees
// requires dividing by the local metres-per-degree scale — for longitude
// that scale is R_LAT*cos(lat), which depends on latitude, which is itself
// part of the state. That coupling is the genuine nonlinearity an EKF
// exists to handle (as opposed to a plain linear KF). The alt/v_alt pair is
// plain linear motion (no such coupling), carried along in the same state
// vector for a single shared predict/update cycle.
function f(X, dt){
  const [lat, lon, vn, ve, alt, valt] = X;
  const phi = lat*D2R;
  return [
    lat + (vn*dt)/R_LAT,
    lon + (ve*dt)/(R_LAT*Math.cos(phi)),
    vn,
    ve,
    alt + valt*dt,
    valt
  ];
}
// Jacobian of f() w.r.t. X, evaluated at the CURRENT (pre-predict) estimate
// every step — this re-linearization, rather than a fixed matrix, is what
// "extended" means. The top-left 4x4 block (lat/lon/vn/ve) is verified
// against a finite-difference numerical Jacobian at 0°, 51.3° (Golden BC),
// and 70° latitude — matched to ~1e-9 — see ../tests/kalman-filter.test.js.
// The alt/v_alt block is plain linear motion, so its Jacobian entries are
// exact by construction (1/dt/1), not approximated.
function jacobianF(X, dt){
  const [lat, , , ve] = X;
  const phi = lat*D2R;
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
  const dLonDLat = (ve*dt*D2R*sinPhi) / (R_LAT*cosPhi*cosPhi);
  return [
    [1,        0, dt/R_LAT,           0,                 0, 0 ],
    [dLonDLat, 1, 0,                  dt/(R_LAT*cosPhi), 0, 0 ],
    [0,        0, 1,                  0,                 0, 0 ],
    [0,        0, 0,                  1,                 0, 0 ],
    [0,        0, 0,                  0,                 1, dt],
    [0,        0, 0,                  0,                 0, 1 ]
  ];
}
// Process noise, built in local metres (standard discretized white-noise-
// acceleration model) then transformed into the state's mixed degrees/(m/s)
// units for the lat/lon block using the same latitude-dependent scale
// factors as jacobianF() above: position-position terms scale by the
// metres-per-degree factor squared, position-velocity cross terms by the
// factor once (only one side of the term is a position), velocity-velocity
// terms are unchanged (velocity stays in m/s throughout). No cross term
// between the lat and lon axes (neither the motion model nor the
// projection couples them), and none between the horizontal block and the
// alt/v_alt block (independent axes, same reasoning).
function processNoise(X, dt){
  const phi = X[0]*D2R;
  const dt2=dt*dt, dt3=dt2*dt, dt4=dt3*dt;
  const qPP = Q_DENSITY*dt4/4, qPV = Q_DENSITY*dt3/2, qVV = Q_DENSITY*dt2;
  const mPerDegLat = R_LAT, mPerDegLon = R_LAT*Math.cos(phi);
  const aPP = ALT_Q_DENSITY*dt4/4, aPV = ALT_Q_DENSITY*dt3/2, aVV = ALT_Q_DENSITY*dt2;
  return [
    [ qPP/(mPerDegLat*mPerDegLat), 0,                            qPV/mPerDegLat, 0,              0,   0   ],
    [ 0,                           qPP/(mPerDegLon*mPerDegLon),  0,              qPV/mPerDegLon, 0,   0   ],
    [ qPV/mPerDegLat,              0,                            qVV,            0,              0,   0   ],
    [ 0,                           qPV/mPerDegLon,                0,             qVV,            0,   0   ],
    [ 0,                           0,                            0,              0,              aPP, aPV ],
    [ 0,                           0,                            0,              0,              aPV, aVV ]
  ];
}

/* ===================== filter state + public API ===================== */
let X = null; // [lat,lon,vn,ve,alt,valt]
let P = null; // 6x6 covariance
let lastT = null;
let altKnown = false; // true once ANY fix has ever supplied fix.alt

function reset(){ X=null; P=null; lastT=null; altKnown=false; }

function output(fix){
  const [lat, lon, vn, ve, alt, valt] = X;
  const speed = Math.hypot(vn, ve);
  let headingTravel = null;
  if (speed >= MIN_HEADING_SPEED_MPS) headingTravel = (Math.atan2(ve, vn)*180/Math.PI + 360) % 360;
  return {
    lat, lon, acc: fix.acc, t: fix.t, speed, headingTravel,
    alt: altKnown ? alt : null,
    vAlt: altKnown ? valt : null
  };
}

function push(fix){
  const fixHasAlt = fix.alt!=null;
  if (X === null){
    // First fix is trusted outright as the seed, matching the old filter's
    // this.s={lat:fix.lat,lon:fix.lon} — but with a loose (not zero)
    // covariance, so the first real correction isn't distrusted relative
    // to this seed. Altitude seeds the same way IF the first fix has one;
    // otherwise it starts at 0 with a huge uncertainty (effectively
    // "unknown") until a fix with real altitude arrives.
    altKnown = fixHasAlt;
    X = [fix.lat, fix.lon, 0, 0, fixHasAlt ? fix.alt : 0, 0];
    const altP0 = fixHasAlt ? P0_ALT_KNOWN_M : P0_ALT_UNKNOWN_M;
    P = [
      [P0_POS_DEG*P0_POS_DEG, 0, 0, 0, 0, 0],
      [0, P0_POS_DEG*P0_POS_DEG, 0, 0, 0, 0],
      [0, 0, P0_VEL_MPS*P0_VEL_MPS, 0, 0, 0],
      [0, 0, 0, P0_VEL_MPS*P0_VEL_MPS, 0, 0],
      [0, 0, 0, 0, altP0*altP0, 0],
      [0, 0, 0, 0, 0, P0_VALT_MPS*P0_VALT_MPS]
    ];
    lastT = fix.t;
    return output(fix);
  }

  const dt = Math.max(0, (fix.t - lastT)/1000);
  lastT = fix.t;
  if (fixHasAlt) altKnown = true;

  // ---- predict ----
  // EKF procedure, the precise distinction that makes this "extended"
  // rather than an implementation bug: the STATE prediction uses the exact
  // nonlinear f(), not the linearized F — only the COVARIANCE prediction
  // uses F. Using F for the state step too is a common EKF bug; don't.
  // let, not const — applyUpdate() below reassigns these as each
  // independent correction (horizontal, then altitude) is applied.
  let Xpred = dt>0 ? f(X, dt) : X.slice();
  const F = jacobianF(X, dt);
  const Q = processNoise(X, dt);
  let Ppred = matAdd(matMul(matMul(F,P), transpose(F)), Q);

  // ---- update ----
  // Two INDEPENDENT corrections — horizontal (always) then altitude (only
  // when this fix has one) — rather than one joint 3D update, and each
  // gated against the OTHER's own NIS threshold separately. This is
  // deliberate, not just simpler code: the alt/v_alt block has zero
  // cross-covariance with lat/lon/vn/ve by construction (see f()/
  // jacobianF()/processNoise() above), so a joint update's single scalar
  // d2 = d2_horizontal + d2_altitude would let a noisy/outlier altitude
  // reading (phone GPS altitude is routinely worse than its own claimed
  // accuracy) trip the shared NIS gate and inflate R for BOTH blocks —
  // silently degrading the horizontal correction on every fix that
  // happens to carry a bad altitude, on the one code path (the live
  // production player, since coords.altitude now flows in from
  // navigator.geolocation) most exposed to real GPS altitude noise. Doing
  // two independent updates removes that coupling entirely: an altitude
  // outlier can never touch the horizontal fix, and vice versa. See
  // tests/kalman-filter.test.js's testAltitudeDoesNotDegradeHorizontal for
  // the regression guard.
  applyUpdate([0,1], [fix.lat,fix.lon],
    (()=>{ const phi=Xpred[0]*D2R, sigma=Math.min(ACC_CEIL_M,Math.max(ACC_FLOOR_M,fix.acc||ACC_CEIL_M));
      return [sigma/R_LAT, sigma/(R_LAT*Math.cos(phi))]; })(),
    NIS_GATE_2D);
  if (fixHasAlt){
    let altSigma;
    if (fix.altAcc!=null) altSigma = Math.min(ALT_ACC_CEIL_M, Math.max(ALT_ACC_FLOOR_M, fix.altAcc));
    else altSigma = fix.altSource==="baro" ? DEFAULT_BARO_ALT_ACC_M : DEFAULT_GPS_ALT_ACC_M;
    applyUpdate([4], [fix.alt], [altSigma], NIS_GATE_ALT_1D);
  }

  // Applies one measurement correction against state indices `idx`,
  // mutating the module-level X/P (Ppred/Xpred already hold the latest
  // prediction — a second call here, e.g. for altitude, corrects further
  // from wherever the first call already landed, which is exact rather
  // than approximate specifically because idx sets never share a state
  // index and Ppred's cross terms between them are always zero).
  function applyUpdate(idx, z, sigmas, NIS_GATE){
    const n=idx.length;
    const y = idx.map((si,k)=>z[k]-Xpred[si]);
    const Ptop = idx.map(i=>idx.map(j=>Ppred[i][j]));
    let R = zeros(n,n);
    for(let k=0;k<n;k++) R[k][k]=sigmas[k]*sigmas[k];
    let S = matAdd(Ptop, R);
    let Sinv = invN(S);
    let d2 = 0;
    for(let a=0;a<n;a++) for(let b=0;b<n;b++) d2 += y[a]*Sinv[a][b]*y[b];
    if (d2 > NIS_GATE){
      // Inflate R rather than reject outright — lets a real fast/surprising
      // movement still pull the state, cautiously, instead of the filter
      // starving of correction during a genuine sustained fast movement.
      // This is the structural, self-scaling replacement for the old
      // filter's hardcoded speed-based spike clamp (which needed manual
      // re-tuning, 25->160 m/s, the moment Test Mode's supported speed range
      // widened — exactly the class of bug this design eliminates).
      const scale = Math.max(1, d2/NIS_GATE);
      R = zeros(n,n);
      for(let k=0;k<n;k++) R[k][k]=sigmas[k]*sigmas[k]*scale;
      S = matAdd(Ptop, R);
      Sinv = invN(S);
    }
    // PHt (6 x n) = columns of Ppred at `idx` — what H^T would select.
    const PHt = Ppred.map(row=>idx.map(i=>row[i]));
    const K = matMul(PHt, Sinv); // 6 x n
    Xpred = Xpred.map((v,i)=>v + idx.reduce((s,_,k)=>s + K[i][k]*y[k], 0));
    const KH_Ppred = zeros(6,6);
    for(let i=0;i<6;i++) for(let j=0;j<6;j++){
      let s=0; for(let k=0;k<n;k++) s += K[i][k]*Ppred[idx[k]][j];
      KH_Ppred[i][j]=s;
    }
    Ppred = matSub(Ppred, KH_Ppred);
  }

  X = Xpred; P = Ppred;
  return output(fix);
}

global.GPSFilter = {
  push, reset,
  // Exposed for the standalone Jacobian/process-noise regression test —
  // not intended for use by host pages.
  _internal: { f, jacobianF, processNoise, R_LAT, D2R }
};
})(typeof window !== "undefined" ? window : globalThis);
