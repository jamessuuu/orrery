// audit.mjs — read the vendored SBDB catalogues and compute every number this
// project prints, from the bytes on disk. Nothing here is copied from a brief.
//
//   node scripts/audit.mjs
//
// Writes data/audit.json. scripts/check.mjs re-runs this and diffs the result
// against the committed copy, so a stale number cannot survive a build.

import { writeFileSync, statSync, createWriteStream, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { streamSbdbRows } from './lib/sbdb-stream.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA = join(ROOT, 'data');

// Semi-major axis of Jupiter, read from the JPL table this project already
// vendors, and used to LOCATE the mean-motion resonances arithmetically rather
// than hard-coding gap positions from memory.
const PLANETS = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'planets.json'), 'utf8'),
);
const A_JUPITER = PLANETS.planets.find((p) => p.name === 'Jupiter').elements[0];

const BIN = 0.005; // AU, the semi-major axis histogram bin
const BIN_MAX = 60; // AU
const NBINS = Math.round(BIN_MAX / BIN);

function sha256(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

function quantile(sortedArr, q) {
  if (sortedArr.length === 0) return null;
  const pos = (sortedArr.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (pos - lo);
}

/** Read one SBDB file into flat typed arrays. Names are streamed to disk. */
async function loadCatalogue(path, namesOut) {
  const size = statSync(path).size;
  // Over-allocate to the theoretical maximum then subarray down.
  let cap = 1 << 21;
  let a = new Float64Array(cap);
  let e = new Float64Array(cap);
  let inc = new Float64Array(cap);
  let om = new Float64Array(cap);
  let w = new Float64Array(cap);
  let ma = new Float64Array(cap);
  let epoch = new Float64Array(cap);
  let H = new Float64Array(cap);
  let cls = new Uint8Array(cap);
  let spkid = new Float64Array(cap);

  const grow = (n) => {
    const bigger = (arr, Ctor) => {
      const next = new Ctor(n);
      next.set(arr);
      return next;
    };
    a = bigger(a, Float64Array);
    e = bigger(e, Float64Array);
    inc = bigger(inc, Float64Array);
    om = bigger(om, Float64Array);
    w = bigger(w, Float64Array);
    ma = bigger(ma, Float64Array);
    epoch = bigger(epoch, Float64Array);
    H = bigger(H, Float64Array);
    cls = bigger(cls, Uint8Array);
    spkid = bigger(spkid, Float64Array);
    cap = n;
  };

  const classIndex = new Map();
  const classNames = [];
  const namesStream = namesOut ? createWriteStream(namesOut) : null;

  let missingElement = 0;
  let missingH = 0;
  const missingByField = { a: 0, e: 0, i: 0, om: 0, w: 0, ma: 0, epoch: 0 };
  const fieldKeys = ['a', 'e', 'i', 'om', 'w', 'ma', 'epoch'];

  const num = (v) => {
    if (v === null || v === undefined || v === '') return NaN;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  };

  const meta = await streamSbdbRows(path, (row, idx) => {
    if (idx >= cap) grow(cap * 2);
    // fields: spkid, full_name, a, e, i, om, w, ma, epoch, H, class
    const vals = [num(row[2]), num(row[3]), num(row[4]), num(row[5]), num(row[6]), num(row[7]), num(row[8])];
    let incomplete = false;
    for (let f = 0; f < 7; f++) {
      if (Number.isNaN(vals[f])) {
        missingByField[fieldKeys[f]]++;
        incomplete = true;
      }
    }
    if (incomplete) missingElement++;

    a[idx] = vals[0];
    e[idx] = vals[1];
    inc[idx] = vals[2];
    om[idx] = vals[3];
    w[idx] = vals[4];
    ma[idx] = vals[5];
    epoch[idx] = vals[6];

    const h = num(row[9]);
    if (Number.isNaN(h)) missingH++;
    H[idx] = h;

    const cname = row[10] === null || row[10] === undefined ? 'UNK' : String(row[10]);
    let ci = classIndex.get(cname);
    if (ci === undefined) {
      ci = classNames.length;
      classNames.push(cname);
      classIndex.set(cname, ci);
    }
    cls[idx] = ci;
    spkid[idx] = Number(row[0]);

    if (namesStream) namesStream.write(String(row[1]).trim() + '\n');
  });

  if (namesStream) {
    await new Promise((res) => namesStream.end(res));
  }

  const n = meta.rows;
  return {
    path,
    bytes: size,
    apiCount: meta.count,
    signature: meta.signature,
    fields: meta.fields,
    n,
    a: a.subarray(0, n),
    e: e.subarray(0, n),
    i: inc.subarray(0, n),
    om: om.subarray(0, n),
    w: w.subarray(0, n),
    ma: ma.subarray(0, n),
    epoch: epoch.subarray(0, n),
    H: H.subarray(0, n),
    cls: cls.subarray(0, n),
    spkid: spkid.subarray(0, n),
    classNames,
    missingElement,
    missingByField,
    missingH,
  };
}

/** Histogram of semi-major axis, one 0.005 AU bin, plus a boxcar smoother. */
function histogram(aVals, select) {
  const bins = new Float64Array(NBINS);
  let overflow = 0;
  let nonpositive = 0;
  let used = 0;
  for (let k = 0; k < aVals.length; k++) {
    if (select && !select(k)) continue;
    const v = aVals[k];
    if (!Number.isFinite(v)) continue;
    if (v <= 0) {
      nonpositive++;
      continue;
    }
    used++;
    const b = Math.floor(v / BIN);
    if (b >= NBINS) overflow++;
    else bins[b]++;
  }
  return { bins, overflow, nonpositive, used };
}

/** Boxcar mean over +/- half bins (window = 2*half+1 bins wide). */
function smooth(bins, half) {
  const out = new Float64Array(bins.length);
  for (let b = 0; b < bins.length; b++) {
    let sum = 0;
    let cnt = 0;
    for (let k = b - half; k <= b + half; k++) {
      if (k < 0 || k >= bins.length) continue;
      sum += bins[k];
      cnt++;
    }
    out[b] = sum / cnt;
  }
  return out;
}

const binOf = (au) => Math.floor(au / BIN);

/**
 * Find the gaps WITHOUT being told where they are: scan the smoothed belt
 * histogram for local minima that fall far below their own local baseline.
 */
function findGapsBlind(sm, loAU, hiAU) {
  const lo = binOf(loAU);
  const hi = binOf(hiAU);
  const baselineHalf = binOf(0.3); // +/- 0.3 AU baseline window
  const localHalf = binOf(0.04); // must be the minimum within +/- 0.04 AU
  const found = [];

  for (let b = lo; b <= hi; b++) {
    let isMin = true;
    for (let k = b - localHalf; k <= b + localHalf; k++) {
      if (k === b) continue;
      if (sm[k] < sm[b]) {
        isMin = false;
        break;
      }
    }
    if (!isMin) continue;

    // Local baseline = median of the smoothed histogram over +/- 0.3 AU.
    const window = [];
    for (let k = Math.max(0, b - baselineHalf); k <= Math.min(sm.length - 1, b + baselineHalf); k++) {
      window.push(sm[k]);
    }
    window.sort((x, y) => x - y);
    const baseline = window[Math.floor(window.length / 2)];
    if (baseline <= 0) continue;
    const depth = sm[b] / baseline;
    if (depth > 0.5) continue; // not a real gap, just noise

    // Suppress duplicates within 0.04 AU, keeping the deeper one.
    const prev = found[found.length - 1];
    if (prev && Math.abs(prev.binIndex - b) <= localHalf * 2) {
      if (depth < prev.relativeDepth) found[found.length - 1] = mk(b, sm, baseline, depth);
      continue;
    }
    found.push(mk(b, sm, baseline, depth));
  }
  return found;

  function mk(b, smArr, baseline, depth) {
    return {
      binIndex: b,
      aAU: Number((b * BIN + BIN / 2).toFixed(4)),
      smoothedCount: Number(smArr[b].toFixed(2)),
      localBaseline: Number(baseline.toFixed(2)),
      relativeDepth: Number(depth.toFixed(4)),
    };
  }
}

/** Resonance a from Jupiter's a: asteroid does p orbits per q of Jupiter. */
function resonanceAU(p, q) {
  return A_JUPITER * Math.pow(q / p, 2 / 3);
}

function gapProfile(bins, sm, p, q, offsetAU = 0.1) {
  const aRes = resonanceAU(p, q);
  const bGap = binOf(aRes);
  const bIn = binOf(aRes - offsetAU);
  const bOut = binOf(aRes + offsetAU);
  const inGapSm = sm[bGap];
  const neighbourMean = (sm[bIn] + sm[bOut]) / 2;
  return {
    resonance: `${p}:${q}`,
    aAU: Number(aRes.toFixed(4)),
    binRawInGap: bins[bGap],
    binRawInner: bins[bIn],
    binRawOuter: bins[bOut],
    smoothedInGap: Number(inGapSm.toFixed(2)),
    smoothedInner: Number(sm[bIn].toFixed(2)),
    smoothedOuter: Number(sm[bOut].toFixed(2)),
    depletionFactor: inGapSm > 0 ? Number((neighbourMean / inGapSm).toFixed(2)) : null,
  };
}

function statsOf(values, select) {
  const kept = [];
  for (let k = 0; k < values.length; k++) {
    if (select && !select(k)) continue;
    const v = values[k];
    if (Number.isFinite(v)) kept.push(v);
  }
  const arr = Float64Array.from(kept);
  arr.sort();
  return {
    n: arr.length,
    min: arr.length ? Number(arr[0].toFixed(6)) : null,
    median: arr.length ? Number(quantile(arr, 0.5).toFixed(4)) : null,
    p90: arr.length ? Number(quantile(arr, 0.9).toFixed(4)) : null,
    p99: arr.length ? Number(quantile(arr, 0.99).toFixed(4)) : null,
    max: arr.length ? Number(arr[arr.length - 1].toFixed(4)) : null,
  };
}

// Deterministic PRNG so the "uniform random sample" tier is reproducible.
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export const SAMPLE_SEED = 20260907;

/** Reproducible uniform sample of `k` indices out of `n` (Algorithm L reservoir-free). */
export function uniformSampleMask(n, k, seed = SAMPLE_SEED) {
  const rand = mulberry32(seed);
  const mask = new Uint8Array(n);
  // Selection sampling: walk once, choose with probability (needed / remaining).
  let needed = Math.min(k, n);
  for (let idx = 0; idx < n && needed > 0; idx++) {
    const remaining = n - idx;
    if (rand() < needed / remaining) {
      mask[idx] = 1;
      needed--;
    }
  }
  return mask;
}

export async function audit() {
  const asteroidPath = join(DATA, 'sbdb-asteroids-fullprec.json');
  const cometPath = join(DATA, 'sbdb-comets-fullprec.json');

  const ast = await loadCatalogue(asteroidPath, join(DATA, 'asteroid-names.txt'));
  const com = await loadCatalogue(cometPath, null);

  // ---- epochs -------------------------------------------------------------
  const epochCounts = new Map();
  for (let k = 0; k < ast.n; k++) {
    const ep = ast.epoch[k];
    if (!Number.isFinite(ep)) continue;
    epochCounts.set(ep, (epochCounts.get(ep) || 0) + 1);
  }
  let modeEpoch = null;
  let modeCount = 0;
  let minEpoch = Infinity;
  let maxEpoch = -Infinity;
  for (const [ep, c] of epochCounts) {
    if (c > modeCount) {
      modeCount = c;
      modeEpoch = ep;
    }
    if (ep < minEpoch) minEpoch = ep;
    if (ep > maxEpoch) maxEpoch = ep;
  }

  // ---- classes ------------------------------------------------------------
  const classCounts = ast.classNames.map((name, ci) => {
    let c = 0;
    for (let k = 0; k < ast.n; k++) if (ast.cls[k] === ci) c++;
    return { code: name, count: c };
  });
  classCounts.sort((x, y) => y.count - x.count);

  const cometClassCounts = com.classNames.map((name, ci) => {
    let c = 0;
    for (let k = 0; k < com.n; k++) if (com.cls[k] === ci) c++;
    return { code: name, count: c };
  });
  cometClassCounts.sort((x, y) => y.count - x.count);

  // ---- renderable set -----------------------------------------------------
  // A body is renderable if all six elements plus the epoch are present and
  // the orbit is elliptical (a > 0, 0 <= e < 1). Everything excluded is counted.
  const renderable = new Uint8Array(ast.n);
  let nRenderable = 0;
  let excludedIncomplete = 0;
  let excludedNonElliptical = 0;
  for (let k = 0; k < ast.n; k++) {
    const ok =
      Number.isFinite(ast.a[k]) &&
      Number.isFinite(ast.e[k]) &&
      Number.isFinite(ast.i[k]) &&
      Number.isFinite(ast.om[k]) &&
      Number.isFinite(ast.w[k]) &&
      Number.isFinite(ast.ma[k]) &&
      Number.isFinite(ast.epoch[k]);
    if (!ok) {
      excludedIncomplete++;
      continue;
    }
    if (!(ast.a[k] > 0) || !(ast.e[k] >= 0 && ast.e[k] < 1)) {
      excludedNonElliptical++;
      continue;
    }
    renderable[k] = 1;
    nRenderable++;
  }
  const isRenderable = (k) => renderable[k] === 1;

  // ---- histogram + blind gap detection ------------------------------------
  const full = histogram(ast.a, isRenderable);
  const smFull = smooth(full.bins, 2); // +/- 2 bins = 0.025 AU window

  const blindGaps = findGapsBlind(smFull, 2.0, 3.5);

  const resonances = [
    [3, 1],
    [5, 2],
    [7, 3],
    [2, 1],
  ];
  const gapTable = resonances.map(([p, q]) => gapProfile(full.bins, smFull, p, q));

  // Which blind minimum matches which resonance, and how far off?
  const blindMatches = resonances.map(([p, q]) => {
    const aRes = resonanceAU(p, q);
    let best = null;
    for (const g of blindGaps) {
      const d = Math.abs(g.aAU - aRes);
      if (!best || d < best.distanceAU) best = { ...g, distanceAU: Number(d.toFixed(4)) };
    }
    return { resonance: `${p}:${q}`, predictedAU: Number(aRes.toFixed(4)), nearestBlindMinimum: best };
  });

  // ---- selection-bias test: is an H-limited tier safe? --------------------
  // A brightness-limited subsample is radially biased (an outer-belt body of a
  // given size is fainter than an inner-belt one), so it can distort exactly
  // the structure this page is about. Measure it rather than assume it.
  const H_TIER = 15;
  let nBright = 0;
  for (let k = 0; k < ast.n; k++) if (isRenderable(k) && ast.H[k] < H_TIER) nBright++;

  const brightHist = histogram(ast.a, (k) => isRenderable(k) && ast.H[k] < H_TIER);
  const brightSm = smooth(brightHist.bins, 6); // wider window, far fewer bodies
  const brightGaps = resonances.map(([p, q]) => gapProfile(brightHist.bins, brightSm, p, q));

  const sampleMask = uniformSampleMask(ast.n, nBright, SAMPLE_SEED);
  let nSampleRenderable = 0;
  for (let k = 0; k < ast.n; k++) if (sampleMask[k] && isRenderable(k)) nSampleRenderable++;
  const sampleHist = histogram(ast.a, (k) => sampleMask[k] === 1 && isRenderable(k));
  const sampleSm = smooth(sampleHist.bins, 6);
  const sampleGaps = resonances.map(([p, q]) => gapProfile(sampleHist.bins, sampleSm, p, q));

  // Radial distribution comparison: fraction of the main belt beyond 2.82 AU
  // (the 5:2), full corpus vs H-limited vs uniform sample.
  const beltFraction = (select) => {
    let inner = 0;
    let outer = 0;
    for (let k = 0; k < ast.n; k++) {
      if (!isRenderable(k)) continue;
      if (select && !select(k)) continue;
      const v = ast.a[k];
      if (v < 2.0 || v > 3.5) continue;
      if (v < 2.825) inner++;
      else outer++;
    }
    return { inner, outer, outerFraction: Number((outer / (inner + outer)).toFixed(4)) };
  };

  // ---- shape stats --------------------------------------------------------
  const incStats = statsOf(ast.i, isRenderable);
  const eccStats = statsOf(ast.e, isRenderable);
  const aStats = statsOf(ast.a, isRenderable);
  const hStats = statsOf(ast.H, isRenderable);

  let inclinedOver30 = 0;
  for (let k = 0; k < ast.n; k++) if (isRenderable(k) && ast.i[k] > 30) inclinedOver30++;

  const audit = {
    generatedAt: new Date().toISOString(),
    generator: 'scripts/audit.mjs',
    method: {
      histogramBinAU: BIN,
      smoothingWindowBins: 5,
      smoothingWindowAU: 5 * BIN,
      blindGapSearchRangeAU: [2.0, 3.5],
      blindGapRule:
        'local minimum of the smoothed histogram within +/-0.04 AU whose value is below 50% of the median smoothed count over +/-0.30 AU',
      resonanceLocationsDerivedFrom: { jupiterSemiMajorAxisAU: A_JUPITER, formula: 'a = a_J * (q/p)^(2/3)' },
      sampleSeed: SAMPLE_SEED,
    },
    sources: {
      asteroids: {
        url: 'https://ssd-api.jpl.nasa.gov/sbdb_query.api?fields=spkid,full_name,a,e,i,om,w,ma,epoch,H,class&sb-kind=a&full-prec=true',
        file: 'data/sbdb-asteroids-fullprec.json',
        bytes: ast.bytes,
        sha256: await sha256(asteroidPath),
        apiReportedCount: ast.apiCount,
        parsedRows: ast.n,
        signature: ast.signature,
        fields: ast.fields,
      },
      comets: {
        url: 'https://ssd-api.jpl.nasa.gov/sbdb_query.api?fields=spkid,full_name,a,e,i,om,w,ma,epoch,H,class&sb-kind=c&full-prec=true',
        file: 'data/sbdb-comets-fullprec.json',
        bytes: com.bytes,
        sha256: await sha256(cometPath),
        apiReportedCount: com.apiCount,
        parsedRows: com.n,
      },
    },
    counts: {
      asteroidsParsed: ast.n,
      cometsParsed: com.n,
      renderable: nRenderable,
      excludedIncompleteElements: excludedIncomplete,
      excludedNonElliptical: excludedNonElliptical,
      missingByField: ast.missingByField,
      missingAbsoluteMagnitude: ast.missingH,
    },
    epochs: {
      distinct: epochCounts.size,
      modeJD: modeEpoch,
      modeCount,
      modeFraction: Number((modeCount / ast.n).toFixed(6)),
      offEpochCount: ast.n - modeCount,
      minJD: minEpoch,
      maxJD: maxEpoch,
      spanDays: Number((maxEpoch - minEpoch).toFixed(2)),
      decision:
        'Every body carries its own epoch. The propagator advances each body from its own epoch, so no body is drawn at a time it was not solved for.',
    },
    classes: classCounts,
    cometClasses: cometClassCounts,
    shape: {
      semiMajorAxisAU: aStats,
      eccentricity: eccStats,
      inclinationDeg: incStats,
      absoluteMagnitudeH: hStats,
      inclinedOver30Deg: inclinedOver30,
      histogramOverflowAbove60AU: full.overflow,
    },
    kirkwood: {
      blindMinimaFound: blindGaps,
      blindMatchToPredictedResonance: blindMatches,
      gapTableFullCorpus: gapTable,
    },
    tierSelectionBias: {
      note:
        'A brightness-limited (H<15) tier is radially biased: at fixed size an outer-belt body is fainter, so H-cuts thin the outer belt. Both candidate tiers are measured here and the unbiased one is what ships.',
      hLimit: H_TIER,
      hLimitedCount: nBright,
      uniformSampleCount: nSampleRenderable,
      beltRadialSplit: {
        fullCorpus: beltFraction(null),
        hLimited: beltFraction((k) => ast.H[k] < H_TIER),
        uniformSample: beltFraction((k) => sampleMask[k] === 1),
      },
      gapTableHLimited: brightGaps,
      gapTableUniformSample: sampleGaps,
    },
  };

  return { audit, ast, com, isRenderable };
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { audit: result } = await audit();
  const out = join(DATA, 'audit.json');
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(`wrote ${out}`);
  console.log(`  parsed rows        ${result.counts.asteroidsParsed.toLocaleString('en-US')}`);
  console.log(`  api count          ${String(result.sources.asteroids.apiReportedCount)}`);
  console.log(`  renderable         ${result.counts.renderable.toLocaleString('en-US')}`);
  console.log(`  excluded (bad e/a) ${result.counts.excludedNonElliptical}`);
  console.log(`  excluded (missing) ${result.counts.excludedIncompleteElements}`);
  console.log(`  distinct epochs    ${result.epochs.distinct}`);
  console.log(`  mode epoch JD      ${result.epochs.modeJD} x ${result.epochs.modeCount.toLocaleString('en-US')}`);
  console.log(`  blind minima       ${result.kirkwood.blindMinimaFound.map((g) => g.aAU).join(', ')}`);
  for (const g of result.kirkwood.gapTableFullCorpus) {
    console.log(`    ${g.resonance} @ ${g.aAU} AU  depletion x${g.depletionFactor}`);
  }
  process.exitCode = 0;
}
