// kepler.js — the propagation contract.
//
// The GPU does this maths 1.5 million times a frame; scripts/accuracy.mjs does
// it on the CPU in float64 to find out how wrong the GPU is. Both read their
// constants from here so the two cannot silently drift apart.

/** Gaussian gravitational constant, radians per day. n = K_GAUSS / a^1.5. */
export const K_GAUSS = 0.01720209895;

/** Halley iterations used in the vertex shader. Cubic convergence. */
export const KEPLER_ITERATIONS = 3;

export const DEG2RAD = Math.PI / 180;

/**
 * The starter and iteration below are mirrored verbatim in the vertex shader
 * (src/shaders.js). Changing one without the other is what accuracy.mjs exists
 * to catch.
 */
export function solveKepler(M, e, iterations = KEPLER_ITERATIONS) {
  // Wrap M to [-PI, PI] so the starter is always on the right branch.
  let m = M % (2 * Math.PI);
  if (m > Math.PI) m -= 2 * Math.PI;
  if (m < -Math.PI) m += 2 * Math.PI;

  const sign = m < 0 ? -1 : 1;
  const am = Math.abs(m);

  // Mikkola's cubic starter. The obvious starter (E = M + e sin M) is fine to
  // e ~ 0.9 and then falls apart: measured, three Halley steps from it DIVERGED
  // at e = 0.9996, and this catalogue contains a body at exactly that
  // eccentricity. This starter is accurate to about 1e-4 for every e < 1, so a
  // fixed iteration count is safe across the whole catalogue.
  const alpha = (1 - e) / (4 * e + 0.5);
  const beta = (0.5 * am) / (4 * e + 0.5);
  const z = Math.cbrt(beta + Math.sqrt(beta * beta + alpha * alpha * alpha));
  let sVal = z - alpha / z;
  sVal = sVal - (0.078 * Math.pow(sVal, 5)) / (1 + e);
  let E = sign * (am + e * (3 * sVal - 4 * sVal * sVal * sVal));

  for (let k = 0; k < iterations; k++) {
    const s = Math.sin(E);
    const c = Math.cos(E);
    const f = E - e * s - m;
    const fp = 1 - e * c;
    const fpp = e * s;
    // Halley step.
    E -= (2 * f * fp) / (2 * fp * fp - f * fpp);
  }
  return E;
}

/**
 * Heliocentric ecliptic position from classical elements.
 * Angles in radians, a in AU, tDays measured from the element epoch.
 * Returns [x, y, z] in AU.
 */
export function propagate(a, e, i, om, w, M0, tDays, iterations = KEPLER_ITERATIONS) {
  const n = K_GAUSS / Math.pow(a, 1.5);
  const M = M0 + n * tDays;
  const E = solveKepler(M, e, iterations);

  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const xo = a * (cosE - e);
  const yo = a * Math.sqrt(Math.max(0, 1 - e * e)) * sinE;

  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const co = Math.cos(om);
  const so = Math.sin(om);
  const ci = Math.cos(i);
  const si = Math.sin(i);

  return [
    (cw * co - sw * so * ci) * xo + (-sw * co - cw * so * ci) * yo,
    (cw * so + sw * co * ci) * xo + (-sw * so + cw * co * ci) * yo,
    sw * si * xo + cw * si * yo,
  ];
}

/** Julian Date to a JS Date. */
export function jdToDate(jd) {
  return new Date((jd - 2440587.5) * 86400000);
}

/** JS Date to Julian Date. */
export function dateToJd(date) {
  return date.getTime() / 86400000 + 2440587.5;
}
