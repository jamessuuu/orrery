// accuracy.mjs — how wrong is the picture?
//
//   npx vite preview --port 4173 --strictPort   (in another shell)
//   node --max-old-space-size=6144 scripts/accuracy.mjs
//
// Three separate error sources, measured rather than assumed, on a stratified
// sample that deliberately over-weights high eccentricity because that is where
// an iterative Kepler solve fails first:
//
//   quantisation  16-bit elements vs the full-precision catalogue values,
//                 both solved in float64. This is the cost of the file format.
//   solver        the PRODUCTION vertex shader in float32 vs the same quantised
//                 elements solved in float64 to convergence. This is the cost
//                 of doing it on the GPU with three Halley iterations.
//   total         the shader's answer vs the catalogue's own elements. This is
//                 the number that matters, and it is the one reported on the page.

import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { audit } from './audit.mjs';
import { encodeA, Q } from './pack.mjs';
import { solveKepler, K_GAUSS, DEG2RAD } from '../src/kepler.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BASE = process.env.ORRERY_URL || 'http://localhost:4173';
const PLAYWRIGHT = 'file:///C:/Users/admin/agentjames/node_modules/playwright/index.mjs';

const U16 = 65535;
const wrap360 = (d) => ((d % 360) + 360) % 360;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reference solve. NOT Newton: Newton from E = M diverges at high eccentricity,
// and an earlier version of this file used exactly that, which made a working
// solver look broken. f(E) = E - e sin E - M is strictly increasing for e < 1
// and |E - M| <= e < 1, so bisection on [M-1, M+1] cannot fail.
import { bisectionKepler } from './kepler-probe.mjs';
const referenceKepler = bisectionKepler;

function positionFrom(a, e, iDeg, omDeg, wDeg, mDeg, solver) {
  const i = iDeg * DEG2RAD;
  const om = omDeg * DEG2RAD;
  const w = wDeg * DEG2RAD;
  const M = mDeg * DEG2RAD;
  const E = solver(M, e);
  const xo = a * (Math.cos(E) - e);
  const yo = a * Math.sqrt(Math.max(0, 1 - e * e)) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w);
  const co = Math.cos(om), so = Math.sin(om);
  const ci = Math.cos(i), si = Math.sin(i);
  return [
    (cw * co - sw * so * ci) * xo + (-sw * co - cw * so * ci) * yo,
    (cw * so + sw * co * ci) * xo + (-sw * so + cw * co * ci) * yo,
    sw * si * xo + cw * si * yo,
  ];
}

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

function summarise(values) {
  const s = [...values].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    n: s.length,
    medianAU: Number(at(0.5).toExponential(3)),
    p95AU: Number(at(0.95).toExponential(3)),
    p99AU: Number(at(0.99).toExponential(3)),
    maxAU: Number(s[s.length - 1].toExponential(3)),
  };
}

export async function measureAccuracy() {
  const { audit: report, ast, isRenderable } = await audit();
  const manifest = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'orrery-manifest.json'), 'utf8'));
  const refEpochJD = manifest.referenceEpoch.jd;

  // Rebuild the a-sorted order the packer used, so a tier index maps back to a
  // catalogue row and the comparison is against the right body.
  const buckets = new Uint32Array(65537);
  const aq = new Uint16Array(ast.n);
  let renderableCount = 0;
  for (let k = 0; k < ast.n; k++) {
    if (!isRenderable(k)) continue;
    const q = encodeA(ast.a[k]);
    aq[k] = q;
    buckets[q + 1]++;
    renderableCount++;
  }
  for (let b = 1; b < buckets.length; b++) buckets[b] += buckets[b - 1];
  const sorted = new Uint32Array(renderableCount);
  const cursor = buckets.slice(0);
  for (let k = 0; k < ast.n; k++) {
    if (!isRenderable(k)) continue;
    sorted[cursor[aq[k]]++] = k;
  }

  // Stratified over eccentricity: equal counts from each decile, so the sample
  // is not dominated by the low-e main belt where any solver looks perfect.
  const PER_BAND = 220;
  const bands = [];
  for (let b = 0; b < 10; b++) bands.push([]);
  for (let t = 0; t < renderableCount; t++) {
    const row = sorted[t];
    const e = ast.e[row];
    const band = Math.min(9, Math.floor(e * 10));
    if (bands[band].length < PER_BAND * 40 && bands[band].length % 1 === 0) bands[band].push(t);
  }
  const picked = [];
  for (let b = 0; b < 10; b++) {
    const src = bands[b];
    if (src.length === 0) continue;
    const step = Math.max(1, Math.floor(src.length / PER_BAND));
    for (let k = 0; k < src.length && picked.length % PER_BAND !== PER_BAND - 1 + 1; k += step) {
      picked.push(src[k]);
      if (picked.length >= (b + 1) * PER_BAND) break;
    }
  }
  const tierIndices = picked.slice(0, 2000);

  // Two evaluation times. At the reference epoch the error is pure element
  // quantisation; ten years out, the semi-major-axis quantisation has been
  // multiplied by the mean motion and shows up as along-track drift. Reporting
  // only one of them would misrepresent the time control.
  const TIMES = [0, 3652.5];

  const { chromium } = await import(PLAYWRIGHT);
  const browser = await chromium.launch({
    headless: false,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--hide-scrollbars'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForFunction(() => window.__orrery && window.__orrery.ready, { timeout: 60000 });
  await page.evaluate(() => window.__orrery.loadFull());
  await page.waitForFunction(() => window.__orrery.tier() === 'full', { timeout: 180000 });
  await sleep(1500);

  const gpuByTime = {};
  for (const t of TIMES) {
    gpuByTime[t] = await page.evaluate(([idx, tt]) => window.__orrery.probe(idx, tt), [Array.from(tierIndices), t]);
  }
  const gpuInfo = await page.evaluate(() => {
    const gl = document.getElementById('stage').getContext('webgl2');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  await browser.close();

  const perTime = {};
  let maxCase = null;

  for (const T_DAYS of TIMES) {
    const gpu = gpuByTime[T_DAYS];
    const quantErr = [];
    const solverErr = [];
    const totalErr = [];
    const byBand = Array.from({ length: 10 }, () => ({ total: [], solver: [] }));

    for (let k = 0; k < tierIndices.length; k++) {
      const row = sorted[tierIndices[k]];

      const aTrue = ast.a[row];
      const eTrue = ast.e[row];
      const iTrue = ast.i[row];
      const omTrue = wrap360(ast.om[row]);
      const wTrue = wrap360(ast.w[row]);
      const nDeg = (K_GAUSS / Math.pow(aTrue, 1.5)) * (180 / Math.PI);
      const mTrue = wrap360(ast.ma[row] + nDeg * (refEpochJD - ast.epoch[row]));

      const aQ = encodeA(aTrue);
      const aDq = Math.exp((aQ / U16) * (Math.log(Q.aMaxAU) - Math.log(Q.aMinAU)) + Math.log(Q.aMinAU));
      const eDq = Math.round((eTrue / Q.eMax) * U16) / U16;
      const iDq = (Math.round((iTrue / Q.iMaxDeg) * U16) / U16) * Q.iMaxDeg;
      const omDq = (Math.round((omTrue / 360) * U16) / U16) * 360;
      const wDq = (Math.round((wTrue / 360) * U16) / U16) * 360;
      const mDq = (Math.round((mTrue / 360) * U16) / U16) * 360;

      const advance = (a, m) => wrap360(m + (K_GAUSS / Math.pow(a, 1.5)) * (180 / Math.PI) * T_DAYS);

      const pTrue = positionFrom(aTrue, eTrue, iTrue, omTrue, wTrue, advance(aTrue, mTrue), referenceKepler);
      const pQuant = positionFrom(aDq, eDq, iDq, omDq, wDq, advance(aDq, mDq), referenceKepler);
      const pGpu = gpu[k];

      const qe = dist(pTrue, pQuant);
      const se = dist(pQuant, pGpu);
      const te = dist(pTrue, pGpu);
      quantErr.push(qe);
      solverErr.push(se);
      totalErr.push(te);

      const band = Math.min(9, Math.floor(eTrue * 10));
      byBand[band].total.push(te);
      byBand[band].solver.push(se);

      if (!maxCase || se > maxCase.solverErrorAU) {
        maxCase = {
          atDaysFromEpoch: T_DAYS,
          semiMajorAxisAU: Number(aTrue.toFixed(6)),
          eccentricity: Number(eTrue.toFixed(6)),
          inclinationDeg: Number(iTrue.toFixed(4)),
          solverErrorAU: se,
          quantisationErrorAU: qe,
          totalErrorAU: te,
        };
      }
    }

    perTime[T_DAYS] = {
      daysFromReferenceEpoch: T_DAYS,
      quantisation16Bit: summarise(quantErr),
      shaderSolverFloat32: summarise(solverErr),
      total: summarise(totalErr),
      byEccentricityDecile: byBand
        .map((b, k2) =>
          b.total.length
            ? {
                band: `${(k2 / 10).toFixed(1)}-${((k2 + 1) / 10).toFixed(1)}`,
                bodies: b.total.length,
                medianTotalErrorAU: Number(
                  [...b.total].sort((x, y) => x - y)[Math.floor(b.total.length / 2)].toExponential(3),
                ),
                maxSolverErrorAU: Number(Math.max(...b.solver).toExponential(3)),
              }
            : null,
        )
        .filter(Boolean),
    };
  }

  // How far does the shipped solve sit from convergence, purely as an angle,
  // across the whole eccentricity range the catalogue contains?
  const angleProbe = [];
  for (const e of [0.0, 0.2, 0.4, 0.6, 0.8, 0.9, 0.95, 0.99, 0.999, 0.9996]) {
    let worst = 0;
    for (let s = 0; s < 720; s++) {
      const M = (s / 720) * 2 * Math.PI - Math.PI;
      const approx = solveKepler(M, e);
      const exact = referenceKepler(M, e);
      worst = Math.max(worst, Math.abs(approx - exact));
    }
    angleProbe.push({ eccentricity: e, worstEccentricAnomalyErrorRad: Number(worst.toExponential(3)) });
  }

  const result = {
    measuredAt: new Date().toISOString(),
    gpu: gpuInfo,
    pageErrors: errors,
    sample: {
      bodies: tierIndices.length,
      stratifiedBy: 'eccentricity decile, so high-e bodies are over-represented relative to the catalogue',
      evaluatedAtDaysFromReferenceEpoch: TIMES,
    },
    solverConfiguration: {
      method: "Mikkola cubic starter, 3 Halley iterations, float32 in the vertex shader",
      sourceOfTruth: 'src/shaders.js PROPAGATE_GLSL, shared verbatim with the drawing shader',
      cpuReference: '200-step bisection in float64 (cannot diverge; Newton from E=M does)',
      starterChoice:
        'A Danby starter with the same 3 Halley steps was measured at 7.63e-2 rad of eccentric-anomaly error at e = 0.9996, the highest eccentricity in this catalogue. Mikkola holds 1.3e-15 rad there. scripts/kepler-probe.mjs prints the comparison.',
    },
    errorBudgetAU: perTime,
    worstSolverCase: maxCase,
    eccentricAnomalyErrorVsEccentricity: angleProbe,
    catalogueMaxEccentricity: report.shape.eccentricity.max,
  };

  return result;
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  const r = await measureAccuracy();
  writeFileSync(join(ROOT, 'docs', 'accuracy-report.json'), JSON.stringify(r, null, 2) + '\n');
  console.log(`GPU: ${r.gpu}`);
  console.log(`sample: ${r.sample.bodies} bodies, evaluated ${r.sample.evaluatedAtDaysFromReferenceEpoch} days from epoch`);
  console.log('');
  console.log('error budget, AU:');
  for (const [t, v] of Object.entries(r.errorBudgetAU)) {
    console.log(`  at ${t} days from the reference epoch:`);
    for (const key of ['quantisation16Bit', 'shaderSolverFloat32', 'total']) {
      const m = v[key];
      console.log(`    ${key.padEnd(22)} median ${String(m.medianAU).padStart(11)}  p99 ${String(m.p99AU).padStart(11)}  max ${String(m.maxAU).padStart(11)}`);
    }
  }
  console.log('');
  console.log('eccentric anomaly error of 3 Halley steps:');
  for (const a of r.eccentricAnomalyErrorVsEccentricity) {
    console.log(`  e = ${String(a.eccentricity).padEnd(7)} worst ${a.worstEccentricAnomalyErrorRad} rad`);
  }
  process.exitCode = 0;
}
