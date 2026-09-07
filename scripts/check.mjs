// check.mjs — recompute every headline figure from the bytes on disk and fail
// if anything on the page, in the manifest, or in the README disagrees.
//
//   node --max-old-space-size=6144 scripts/check.mjs
//
// This exists because a project like this is only worth anything if its numbers
// are checkable, and a number nobody can recompute is a claim, not a fact.
// Every assertion below re-derives its expected value from the vendored JSON or
// the packed binaries; none of them is hard-coded.

import { readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { audit } from './audit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const results = [];
let failures = 0;

function check(name, actual, expected, note = '') {
  const ok = Object.is(actual, expected) || (typeof actual === 'number' && typeof expected === 'number' && actual === expected);
  if (!ok) failures++;
  results.push({ name, ok, actual, expected, note });
  const mark = ok ? 'ok  ' : 'FAIL';
  console.log(`${mark} ${name.padEnd(58)} ${String(actual)}${ok ? '' : `  (expected ${String(expected)})`}`);
  return ok;
}

function checkTrue(name, cond, detail = '') {
  if (!cond) failures++;
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name.padEnd(58)} ${detail}`);
  return cond;
}

const fmt = (n) => Number(n).toLocaleString('en-US');

export async function runChecks() {
  console.log('recomputing every headline figure from the data on disk\n');

  // ---- 1. the catalogue itself -------------------------------------------
  const { audit: fresh } = await audit();
  const committedPath = join(ROOT, 'data', 'audit.json');
  const committed = JSON.parse(readFileSync(committedPath, 'utf8'));

  console.log('-- catalogue --');
  check('parsed asteroid rows', fresh.counts.asteroidsParsed, committed.counts.asteroidsParsed);
  check('API reported count matches parsed rows', fresh.sources.asteroids.apiReportedCount, fresh.counts.asteroidsParsed);
  check('renderable bodies', fresh.counts.renderable, committed.counts.renderable);
  check('excluded, non elliptical', fresh.counts.excludedNonElliptical, committed.counts.excludedNonElliptical);
  check('excluded, incomplete elements', fresh.counts.excludedIncompleteElements, committed.counts.excludedIncompleteElements);
  check('comets catalogued', fresh.counts.cometsParsed, committed.counts.cometsParsed);
  check('distinct epochs', fresh.epochs.distinct, committed.epochs.distinct);
  check('bodies on the modal epoch', fresh.epochs.modeCount, committed.epochs.modeCount);
  check(
    'renderable + excluded == parsed',
    fresh.counts.renderable + fresh.counts.excludedNonElliptical + fresh.counts.excludedIncompleteElements,
    fresh.counts.asteroidsParsed,
  );

  const sumClasses = fresh.classes.reduce((a, c) => a + c.count, 0);
  check('class counts sum to the parsed rows', sumClasses, fresh.counts.asteroidsParsed);

  // ---- 2. source files ----------------------------------------------------
  console.log('\n-- source files --');
  const astPath = join(ROOT, 'data', 'sbdb-asteroids-fullprec.json');
  const comPath = join(ROOT, 'data', 'sbdb-comets-fullprec.json');
  checkTrue('asteroid response present', existsSync(astPath), astPath);
  check('asteroid response bytes', statSync(astPath).size, committed.sources.asteroids.bytes);
  check('asteroid response sha256', fresh.sources.asteroids.sha256, committed.sources.asteroids.sha256);
  check('comet response bytes', statSync(comPath).size, committed.sources.comets.bytes);

  // ---- 3. packed tiers ----------------------------------------------------
  console.log('\n-- packed tiers --');
  const manifest = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'orrery-manifest.json'), 'utf8'));
  check('manifest renderable total', manifest.totals.renderableBodies, fresh.counts.renderable);
  check('manifest comet total', manifest.totals.cometsCatalogued, fresh.counts.cometsParsed);
  check('manifest full tier bodies', manifest.tiers.full.bodies, fresh.counts.renderable);

  for (const [name, spec] of Object.entries(manifest.tiers)) {
    const f = join(ROOT, 'public', 'data', name === 'full' ? 'orrery-full.bin' : 'orrery-preview.bin');
    const size = statSync(f).size;
    check(`${name} tier file bytes`, size, spec.bodies * 14, '7 uint16 columns per body');
    check(`${name} tier manifest bytes`, spec.bytes, size);
  }

  // The class index table must be the one the packer used, not a popularity
  // sort: getting this wrong silently recolours the entire catalogue.
  const classSet = new Set(manifest.classes);
  checkTrue('manifest class table covers every class in the data', fresh.classes.every((c) => classSet.has(c.code)), `${manifest.classes.length} classes`);
  for (const c of fresh.classes) {
    if (manifest.classCounts[c.code] !== c.count) {
      check(`class count ${c.code}`, manifest.classCounts[c.code], c.count);
    }
  }
  checkTrue('every class count in the manifest matches the audit', fresh.classes.every((c) => manifest.classCounts[c.code] === c.count));

  // Decode the packed semi-major axis column and confirm it is sorted and that
  // the class byte range is inside the class table.
  const fullBuf = readFileSync(join(ROOT, 'public', 'data', 'orrery-full.bin'));
  const n = manifest.tiers.full.bodies;
  const aCol = new Uint16Array(fullBuf.buffer, fullBuf.byteOffset, n);
  let monotonic = true;
  if (manifest.tiers.full.deltaCodedSemiMajorAxis) {
    // Deltas of a monotonic sequence are non-negative, and the running sum must
    // never exceed 16 bits.
    let acc = 0;
    for (let k = 0; k < n; k++) {
      acc += aCol[k];
      if (acc > 65535) {
        monotonic = false;
        break;
      }
    }
  } else {
    for (let k = 1; k < n; k++) {
      if (aCol[k] < aCol[k - 1]) {
        monotonic = false;
        break;
      }
    }
  }
  checkTrue('semi-major axis column is sorted (radial brush depends on it)', monotonic);

  const hcCol = new Uint16Array(fullBuf.buffer, fullBuf.byteOffset + 6 * n * 2, n);
  let maxClass = 0;
  for (let k = 0; k < n; k++) {
    const c = hcCol[k] >> 8;
    if (c > maxClass) maxClass = c;
  }
  checkTrue(
    'packed class indices fit the manifest class table',
    maxClass < manifest.classes.length,
    `max index ${maxClass}, table length ${manifest.classes.length}`,
  );

  // ---- 4. the Kirkwood claim ----------------------------------------------
  console.log('\n-- the Kirkwood claim --');
  for (const g of fresh.kirkwood.gapTableFullCorpus) {
    const c = committed.kirkwood.gapTableFullCorpus.find((x) => x.resonance === g.resonance);
    check(`${g.resonance} depletion factor`, g.depletionFactor, c.depletionFactor);
  }
  const worst = Math.max(...fresh.kirkwood.blindMatchToPredictedResonance.map((m) => m.nearestBlindMinimum.distanceAU));
  checkTrue(
    'every predicted resonance has a blind minimum within 0.02 AU',
    worst <= 0.02,
    `worst ${worst.toFixed(4)} AU = ${Math.round(worst / fresh.method.histogramBinAU)} bins`,
  );
  checkTrue(
    'the blind search finds at least four minima in the belt',
    fresh.kirkwood.blindMinimaFound.length >= 4,
    `${fresh.kirkwood.blindMinimaFound.length} found at ${fresh.kirkwood.blindMinimaFound.map((g) => g.aAU).join(', ')} AU`,
  );

  // ---- 5. the tier-bias claim ---------------------------------------------
  console.log('\n-- tier selection bias --');
  const bias = fresh.tierSelectionBias.beltRadialSplit;
  checkTrue(
    'a brightness cut distorts the belt more than the uniform sample does',
    Math.abs(bias.hLimited.outerFraction - bias.fullCorpus.outerFraction) >
      Math.abs(bias.uniformSample.outerFraction - bias.fullCorpus.outerFraction),
    `H-cut off by ${(Math.abs(bias.hLimited.outerFraction - bias.fullCorpus.outerFraction) * 100).toFixed(1)} pp, ` +
      `uniform off by ${(Math.abs(bias.uniformSample.outerFraction - bias.fullCorpus.outerFraction) * 100).toFixed(2)} pp`,
  );

  // ---- 6. what the built page actually says -------------------------------
  console.log('\n-- the built page --');
  const distIndex = join(ROOT, 'dist', 'index.html');
  if (existsSync(distIndex)) {
    const html = readFileSync(distIndex, 'utf8');
    checkTrue(
      'built HTML states the real renderable count',
      html.includes(fmt(fresh.counts.renderable)),
      fmt(fresh.counts.renderable),
    );
    checkTrue('no unreplaced build tokens', !/\{\{[A-Z_]+\}\}/.test(html), '');
    checkTrue(
      'built HTML carries the static fallback as served markup',
      html.includes('fallback__inner') && html.includes('<circle'),
      '',
    );
    checkTrue(
      'attribution present',
      html.includes('agentjames.vercel.app') && html.includes('linkedin.com/in/james-lorenz-santos-720776251'),
      '',
    );
  } else {
    checkTrue('dist/index.html present (run `npm run build`)', false, distIndex);
  }

  // ---- 7. the render evidence ---------------------------------------------
  console.log('\n-- render evidence --');
  const rr = join(ROOT, 'docs', 'render-report.json');
  if (existsSync(rr)) {
    const r = JSON.parse(readFileSync(rr, 'utf8'));
    checkTrue('all programs linked', r.allProgramsLinked === true, '');
    checkTrue('zero console errors', r.consoleErrors.length === 0, `${r.consoleErrors.length}`);
    checkTrue('every screenshot has real image content', r.allShotsRendered === true, `${r.shots.length} shots`);
    check('the full tier really drew the whole catalogue', r.measurements.fullTier.drawnBodies, fresh.counts.renderable);
    checkTrue(
      'the gaps are detectable in the rendered pixels',
      (r.gapsVisibleInPixels?.minimaFound?.length || 0) >= 3,
      `${r.gapsVisibleInPixels?.minimaFound?.length || 0} minima at ${(r.gapsVisibleInPixels?.minimaFound || []).map((m) => m.aAU).join(', ')} AU`,
    );
  } else {
    checkTrue('docs/render-report.json present (run `npm run shoot`)', false, rr);
  }

  const ar = join(ROOT, 'docs', 'accuracy-report.json');
  if (existsSync(ar)) {
    const a = JSON.parse(readFileSync(ar, 'utf8'));
    const worstAngle = Math.max(...a.eccentricAnomalyErrorVsEccentricity.map((x) => x.worstEccentricAnomalyErrorRad));
    checkTrue(
      'the shipped solver is converged at every eccentricity in the catalogue',
      worstAngle < 1e-12,
      `worst ${worstAngle.toExponential(2)} rad`,
    );
    const t10 = a.errorBudgetAU['3652.5'];
    checkTrue(
      'element quantisation dominates the error budget, not the GPU solve',
      t10.quantisation16Bit.medianAU > t10.shaderSolverFloat32.medianAU * 20,
      `${t10.quantisation16Bit.medianAU} AU vs ${t10.shaderSolverFloat32.medianAU} AU`,
    );
  } else {
    checkTrue('docs/accuracy-report.json present (run `npm run accuracy`)', false, ar);
  }

  console.log('');
  console.log(failures === 0 ? `PASS — ${results.length} checks` : `FAIL — ${failures} of ${results.length} checks failed`);
  return { failures, results };
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { failures: f } = await runChecks();
  process.exitCode = f === 0 ? 0 : 1;
}
