// pack.mjs — turn the vendored SBDB JSON into the binary the browser draws.
//
//   node --max-old-space-size=6144 scripts/pack.mjs
//
// Design decisions, all of which are measured rather than assumed:
//
//  1. COLUMN MAJOR, NOT ROW MAJOR. Seven Uint16 columns, each contiguous. The
//     browser makes a zero-copy Uint16Array view per column and hands each one
//     straight to a WebGL vertex attribute. No parse step, no de-interleave.
//
//  2. SORTED BY SEMI-MAJOR AXIS. Two payoffs. The `a` column becomes monotonic
//     so it delta-codes into something gzip can actually compress (angles
//     cannot be compressed; a sorted radius can). And the radial brush becomes
//     a single `setDrawRange`, because a shell of the belt is a contiguous run
//     of vertices. Additive blending is order independent, so sorting costs
//     nothing visually.
//
//  3. NO EPOCH COLUMN. 6,334 distinct epochs is a real honesty problem: 6% of
//     the catalogue is solved for a different date than the rest. Rather than
//     ship a coarse per-body epoch and re-derive it in float32 every frame,
//     every body's mean anomaly is advanced from ITS OWN epoch to one common
//     reference epoch here, in float64, exactly. Mean anomaly is linear in
//     time, so that advance is exact two-body motion and introduces no error
//     of its own. The epoch column then costs zero bytes.
//
//  4. THE PREVIEW TIER IS A SEEDED UNIFORM SAMPLE, NOT A BRIGHTNESS CUT.
//     scripts/audit.mjs measures why: an H<15 cut reports 51% of the belt
//     beyond 2.825 AU when the true figure is 34.5%, because at fixed size an
//     outer-belt body is fainter. A brightness tier would visibly lie about
//     the structure this page exists to show.

import { writeFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import { audit, uniformSampleMask, SAMPLE_SEED } from './audit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'public', 'data');

// Gaussian gravitational constant, rad/day. n = K_GAUSS / a^1.5.
const K_GAUSS = 0.01720209895;
const DEG = 180 / Math.PI;

export const PREVIEW_COUNT = 120000;

// Quantisation ranges. `a` is logarithmic because the catalogue spans
// 0.46 AU to 14,513 AU and linear steps would throw away the belt.
export const Q = {
  aMinAU: 0.3,
  aMaxAU: 20000,
  eMax: 1,
  iMaxDeg: 180,
  angleMaxDeg: 360,
  hMin: -2,
  hMax: 34.5,
  hMissing: 255,
};

const U16 = 65535;
const logAMin = Math.log(Q.aMinAU);
const logASpan = Math.log(Q.aMaxAU) - logAMin;

export const encodeA = (au) => Math.max(0, Math.min(U16, Math.round(((Math.log(au) - logAMin) / logASpan) * U16)));
export const decodeA = (q) => Math.exp((q / U16) * logASpan + logAMin);
const encodeLinear = (v, max) => Math.max(0, Math.min(U16, Math.round((v / max) * U16)));
const wrap360 = (d) => ((d % 360) + 360) % 360;

function jdToIso(jd) {
  const ms = (jd - 2440587.5) * 86400000;
  return new Date(ms).toISOString();
}

/** Encode one selected subset into the column-major buffer. */
function buildTier(src, indices, refEpochJD) {
  const n = indices.length;
  const cols = 7;
  const buf = new ArrayBuffer(n * cols * 2);
  const aCol = new Uint16Array(buf, 0 * n * 2, n);
  const eCol = new Uint16Array(buf, 1 * n * 2, n);
  const iCol = new Uint16Array(buf, 2 * n * 2, n);
  const omCol = new Uint16Array(buf, 3 * n * 2, n);
  const wCol = new Uint16Array(buf, 4 * n * 2, n);
  const mCol = new Uint16Array(buf, 5 * n * 2, n);
  const hcCol = new Uint16Array(buf, 6 * n * 2, n);

  let advanced = 0;
  let maxAdvanceDays = 0;

  for (let k = 0; k < n; k++) {
    const s = indices[k];
    const a = src.a[s];
    const e = src.e[s];

    // Advance mean anomaly from this body's own epoch to the common reference
    // epoch. Exact: M is linear in t for two-body motion.
    const dtDays = refEpochJD - src.epoch[s];
    if (dtDays !== 0) {
      advanced++;
      const ad = Math.abs(dtDays);
      if (ad > maxAdvanceDays) maxAdvanceDays = ad;
    }
    const nDegPerDay = (K_GAUSS / Math.pow(a, 1.5)) * DEG;
    const mRef = wrap360(src.ma[s] + nDegPerDay * dtDays);

    aCol[k] = encodeA(a);
    eCol[k] = encodeLinear(e, Q.eMax);
    iCol[k] = encodeLinear(src.i[s], Q.iMaxDeg);
    omCol[k] = encodeLinear(wrap360(src.om[s]), Q.angleMaxDeg);
    wCol[k] = encodeLinear(wrap360(src.w[s]), Q.angleMaxDeg);
    mCol[k] = encodeLinear(mRef, Q.angleMaxDeg);

    const h = src.H[s];
    let hByte = Q.hMissing;
    if (Number.isFinite(h)) {
      hByte = Math.max(0, Math.min(254, Math.round(((h - Q.hMin) / (Q.hMax - Q.hMin)) * 254)));
    }
    hcCol[k] = ((src.cls[s] & 0xff) << 8) | hByte;
  }

  return { buffer: buf, n, advanced, maxAdvanceDays, columns: { aCol } };
}

/** Delta-code the (already sorted, monotonic) `a` column in place. */
function deltaEncodeFirstColumn(buffer, n) {
  const out = buffer.slice(0);
  const col = new Uint16Array(out, 0, n);
  let prev = 0;
  for (let k = 0; k < n; k++) {
    const cur = col[k];
    col[k] = (cur - prev) & 0xffff;
    prev = cur;
  }
  return out;
}

function measure(buf) {
  const b = Buffer.from(buf);
  return {
    raw: b.length,
    gzip: gzipSync(b, { level: 9 }).length,
    brotli: brotliCompressSync(b, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: b.length },
    }).length,
  };
}

export async function pack() {
  mkdirSync(OUT, { recursive: true });
  const { audit: report, ast, isRenderable } = await audit();

  const refEpochJD = report.epochs.modeJD;

  // Renderable indices, counting-sorted by quantised semi-major axis.
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

  // Preview tier: seeded uniform sample of the RENDERABLE set, then kept in
  // the same a-sorted order so the radial brush works identically.
  const sampleMask = uniformSampleMask(renderableCount, PREVIEW_COUNT, SAMPLE_SEED);
  const previewIdx = [];
  for (let k = 0; k < renderableCount; k++) if (sampleMask[k]) previewIdx.push(sorted[k]);

  const tiers = {};
  const specs = [
    ['preview', Uint32Array.from(previewIdx)],
    ['full', sorted],
  ];

  for (const [name, idx] of specs) {
    const built = buildTier(ast, idx, refEpochJD);
    const plain = measure(built.buffer);
    const delta = measure(deltaEncodeFirstColumn(built.buffer, built.n));

    // Ship whichever is smaller on the wire, and record both so the choice is
    // a measurement rather than a preference.
    const useDelta = delta.brotli < plain.brotli;
    const shipped = useDelta ? deltaEncodeFirstColumn(built.buffer, built.n) : built.buffer;
    const file = join(OUT, `orrery-${name}.bin`);
    writeFileSync(file, Buffer.from(shipped));

    tiers[name] = {
      file: `data/orrery-${name}.bin`,
      bodies: built.n,
      bytesPerBody: 14,
      bytes: statSync(file).size,
      deltaCodedSemiMajorAxis: useDelta,
      measured: { plain, delta },
      bodiesAdvancedFromOwnEpoch: built.advanced,
      maxEpochAdvanceDays: Number(built.maxAdvanceDays.toFixed(2)),
    };
    console.log(
      `${name.padEnd(8)} ${built.n.toLocaleString('en-US').padStart(11)} bodies  ` +
        `raw ${plain.raw.toLocaleString('en-US')}  gzip ${(useDelta ? delta : plain).gzip.toLocaleString('en-US')}  ` +
        `brotli ${(useDelta ? delta : plain).brotli.toLocaleString('en-US')}  delta=${useDelta}`,
    );
  }

  // ---- preview -> full index map ------------------------------------------
  // The preview tier is a subset of the same a-sorted order, so this map is
  // strictly increasing and delta-codes to almost nothing. It is only fetched
  // when the reader searches or clicks something while on the preview tier.
  const mapDelta = new Uint32Array(previewIdx.length);
  {
    let prev = 0;
    for (let k = 0; k < previewIdx.length; k++) {
      const posFull = k; // filled below
      void posFull;
    }
    // previewIdx holds source-row ids; convert to positions in the full tier.
    const posLookup = new Int32Array(ast.n).fill(-1);
    for (let k = 0; k < sorted.length; k++) posLookup[sorted[k]] = k;
    for (let k = 0; k < previewIdx.length; k++) {
      const p = posLookup[previewIdx[k]];
      mapDelta[k] = p - prev;
      prev = p;
    }
  }
  const mapFile = join(OUT, 'orrery-preview-map.bin');
  writeFileSync(mapFile, Buffer.from(mapDelta.buffer));
  const mapMeasured = measure(mapDelta.buffer);

  // ---- search index: the named bodies -------------------------------------
  // Position in the FULL tier, so a search result can be highlighted directly.
  const posInFull = new Int32Array(ast.n).fill(-1);
  for (let k = 0; k < sorted.length; k++) posInFull[sorted[k]] = k;

  const { readFileSync } = await import('node:fs');
  const names = readFileSync(join(ROOT, 'data', 'asteroid-names.txt'), 'latin1').split('\n');
  const named = [];
  const namedRe = /^(\d+)\s+([A-Za-z][^(]*?)\s*(?:\(([^)]*)\))?$/;
  for (let k = 0; k < ast.n; k++) {
    if (posInFull[k] < 0) continue;
    const raw = (names[k] || '').trim();
    const m = namedRe.exec(raw);
    if (!m) continue;
    named.push([m[2].trim(), Number(m[1]), posInFull[k]]);
  }
  named.sort((x, y) => x[1] - y[1]);
  const searchFile = join(OUT, 'orrery-names.json');
  writeFileSync(searchFile, JSON.stringify({ format: ['name', 'number', 'indexInFullTier'], entries: named }));
  const searchBytes = statSync(searchFile).size;
  const searchGzip = gzipSync(Buffer.from(JSON.stringify({ entries: named })), { level: 9 }).length;

  // ---- epoch age distribution, for the honesty panel ----------------------
  const ageBuckets = { onReferenceEpoch: 0, within1Year: 0, within10Years: 0, over10Years: 0 };
  let oldestDays = 0;
  for (let k = 0; k < ast.n; k++) {
    if (!isRenderable(k)) continue;
    const d = Math.abs(refEpochJD - ast.epoch[k]);
    if (d === 0) ageBuckets.onReferenceEpoch++;
    else if (d <= 365.25) ageBuckets.within1Year++;
    else if (d <= 3652.5) ageBuckets.within10Years++;
    else ageBuckets.over10Years++;
    if (d > oldestDays) oldestDays = d;
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    generator: 'scripts/pack.mjs',
    referenceEpoch: {
      jd: refEpochJD,
      iso: jdToIso(refEpochJD),
      chosenBecause: 'it is the published epoch shared by the largest share of the catalogue',
      sharedBy: report.epochs.modeCount,
    },
    epochHandling: {
      policy:
        'every body is advanced from its own published epoch to the reference epoch at build time, in float64, by exact two-body mean-motion',
      distinctEpochsInSource: report.epochs.distinct,
      ...ageBuckets,
      oldestEpochAgeDays: Number(oldestDays.toFixed(2)),
    },
    quantisation: {
      semiMajorAxis: { bits: 16, scale: 'log', minAU: Q.aMinAU, maxAU: Q.aMaxAU },
      eccentricity: { bits: 16, scale: 'linear', min: 0, max: Q.eMax },
      inclination: { bits: 16, scale: 'linear', minDeg: 0, maxDeg: Q.iMaxDeg },
      node: { bits: 16, scale: 'linear', minDeg: 0, maxDeg: Q.angleMaxDeg },
      argPeriapsis: { bits: 16, scale: 'linear', minDeg: 0, maxDeg: Q.angleMaxDeg },
      meanAnomalyAtReferenceEpoch: { bits: 16, scale: 'linear', minDeg: 0, maxDeg: Q.angleMaxDeg },
      absoluteMagnitude: { bits: 8, min: Q.hMin, max: Q.hMax, missingSentinel: Q.hMissing },
      dynamicalClass: { bits: 8, table: 'classes' },
    },
    layout: {
      order: 'column major, ascending semi-major axis',
      columns: ['a', 'e', 'i', 'om', 'w', 'M0', 'classH'],
      columnType: 'Uint16',
      classHPacking: '(classIndex << 8) | magnitudeByte',
    },
    // MUST be first-appearance order: this array is indexed by the class byte
    // packed into the high byte of the classH column, not by popularity.
    classes: ast.classNames,
    classCounts: Object.fromEntries(report.classes.map((c) => [c.code, c.count])),
    tiers,
    search: { file: 'data/orrery-names.json', entries: named.length, bytes: searchBytes, gzip: searchGzip },
    previewMap: {
      file: 'data/orrery-preview-map.bin',
      entries: mapDelta.length,
      encoding: 'Uint32 deltas of the position in the full tier',
      measured: mapMeasured,
    },
    sampleSeed: SAMPLE_SEED,
    previewNote: `uniform random sample, seed ${SAMPLE_SEED}, drawn from the renderable set; NOT a brightness cut (see README)`,
    sourceFile: 'data/sbdb-asteroids-fullprec.json',
    // Everything the receipts sheet prints, lifted straight from the audit so
    // the page cannot state a number the audit did not compute.
    receipts: {
      binAU: report.method.histogramBinAU,
      smoothWindowAU: report.method.smoothingWindowAU,
      jupiterA: report.method.resonanceLocationsDerivedFrom.jupiterSemiMajorAxisAU,
      medianInclinationDeg: report.shape.inclinationDeg.median,
      medianEccentricity: report.shape.eccentricity.median,
      inclinedOver30Deg: report.shape.inclinedOver30Deg,
      aMinAU: report.shape.semiMajorAxisAU.min,
      aMaxAU: report.shape.semiMajorAxisAU.max,
      kirkwood: report.kirkwood.gapTableFullCorpus,
      blindMinima: report.kirkwood.blindMinimaFound,
      worstBlindMatchAU: Math.max(
        ...report.kirkwood.blindMatchToPredictedResonance.map((m) => m.nearestBlindMinimum.distanceAU),
      ),
      gap31Depletion: report.kirkwood.gapTableFullCorpus.find((g) => g.resonance === '3:1')?.depletionFactor,
      tierBias: [
        { tier: 'full catalogue', ...report.tierSelectionBias.beltRadialSplit.fullCorpus },
        { tier: `brightness cut, H < ${report.tierSelectionBias.hLimit}`, ...report.tierSelectionBias.beltRadialSplit.hLimited },
        { tier: 'uniform random sample', ...report.tierSelectionBias.beltRadialSplit.uniformSample },
      ],
    },
    totals: {
      parsedAsteroidRows: report.counts.asteroidsParsed,
      renderableBodies: report.counts.renderable,
      excludedNonElliptical: report.counts.excludedNonElliptical,
      excludedIncompleteElements: report.counts.excludedIncompleteElements,
      cometsCatalogued: report.counts.cometsParsed,
    },
  };

  writeFileSync(join(OUT, 'orrery-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`search index  ${named.length.toLocaleString('en-US')} named bodies  ${searchBytes.toLocaleString('en-US')} B`);
  console.log(`reference epoch JD ${refEpochJD} = ${jdToIso(refEpochJD)}`);
  console.log(
    `epoch ages: exact ${ageBuckets.onReferenceEpoch.toLocaleString('en-US')}, <=1y ${ageBuckets.within1Year.toLocaleString('en-US')}, <=10y ${ageBuckets.within10Years.toLocaleString('en-US')}, >10y ${ageBuckets.over10Years.toLocaleString('en-US')}`,
  );
  return manifest;
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  await pack();
  process.exitCode = 0;
}
