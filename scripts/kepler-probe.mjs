// kepler-probe.mjs — establish a reference that cannot diverge, then measure
// both candidate starters against it.
//
// The first version of this probe used Newton from E = M as its "reference".
// Newton from that start is unstable at high eccentricity, so the reference was
// the thing blowing up and it made a working solver look broken. f(E) = E - e
// sin E - M is strictly increasing for e < 1 and |E - M| <= e < 1, so bisection
// on [M-1, M+1] is guaranteed to converge. That is the reference now.

import { solveKepler, KEPLER_ITERATIONS } from '../src/kepler.js';

export function bisectionKepler(M, e) {
  let m = M % (2 * Math.PI);
  if (m > Math.PI) m -= 2 * Math.PI;
  if (m < -Math.PI) m += 2 * Math.PI;
  let lo = m - 1.0000001;
  let hi = m + 1.0000001;
  const f = (E) => E - e * Math.sin(E) - m;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) > 0) hi = mid;
    else lo = mid;
  }
  return 0.5 * (lo + hi);
}

function mikkolaStarter(M, e) {
  let m = M % (2 * Math.PI);
  if (m > Math.PI) m -= 2 * Math.PI;
  if (m < -Math.PI) m += 2 * Math.PI;
  const sign = m < 0 ? -1 : 1;
  const am = Math.abs(m);
  const alpha = (1 - e) / (4 * e + 0.5);
  const beta = (0.5 * am) / (4 * e + 0.5);
  const z = Math.cbrt(beta + Math.sqrt(beta * beta + alpha * alpha * alpha));
  let s = z - alpha / z;
  s = s - (0.078 * Math.pow(s, 5)) / (1 + e);
  return sign * (am + e * (3 * s - 4 * s * s * s));
}

function danbyStarter(M, e) {
  let m = M % (2 * Math.PI);
  if (m > Math.PI) m -= 2 * Math.PI;
  if (m < -Math.PI) m += 2 * Math.PI;
  return m + e * Math.sin(m) * (1 + e * Math.cos(m));
}

function halley(E, m, e, iterations) {
  for (let k = 0; k < iterations; k++) {
    const s = Math.sin(E);
    const c = Math.cos(E);
    const f = E - e * s - m;
    const fp = 1 - e * c;
    const fpp = e * s;
    E -= (2 * f * fp) / (2 * fp * fp - f * fpp);
  }
  return E;
}

function wrap(M) {
  let m = M % (2 * Math.PI);
  if (m > Math.PI) m -= 2 * Math.PI;
  if (m < -Math.PI) m += 2 * Math.PI;
  return m;
}

if (process.argv[1]) {
  const SAMPLES = 4001;
  console.log(`worst |E - E_exact| over ${SAMPLES} mean anomalies, reference = 200-step bisection`);
  console.log(`${'e'.padEnd(9)} ${'Danby+3H'.padStart(12)} ${'Mikkola+3H'.padStart(12)} ${'shipped'.padStart(12)}`);
  for (const e of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 0.95, 0.99, 0.999, 0.9996]) {
    let wD = 0;
    let wM = 0;
    let wS = 0;
    for (let k = 0; k < SAMPLES; k++) {
      const M = (k / (SAMPLES - 1)) * 2 * Math.PI - Math.PI;
      const m = wrap(M);
      const exact = bisectionKepler(M, e);
      wD = Math.max(wD, Math.abs(halley(danbyStarter(M, e), m, e, KEPLER_ITERATIONS) - exact));
      wM = Math.max(wM, Math.abs(halley(mikkolaStarter(M, e), m, e, KEPLER_ITERATIONS) - exact));
      wS = Math.max(wS, Math.abs(solveKepler(M, e) - exact));
    }
    console.log(
      `${String(e).padEnd(9)} ${wD.toExponential(2).padStart(12)} ${wM.toExponential(2).padStart(12)} ${wS
        .toExponential(2)
        .padStart(12)}`,
    );
  }
}
