// build-fallback.mjs — the no-JavaScript, no-WebGL2 twin.
//
// LIVENESS-STANDARD caps an SVG at roughly 2,400 marks. This catalogue has
// 1,562,531 renderable bodies, so a full-fidelity SVG is out by three orders of
// magnitude and pretending otherwise would be the dishonest option. Instead:
//
//   1. a plan view carrying an explicitly stated 2,400-body uniform sample,
//      with the decimation ratio printed inside the figure;
//   2. the semi-major-axis histogram computed over ALL 1,562,531 bodies, which
//      is not decimated at all and shows the Kirkwood gaps outright;
//   3. the complete class table as real HTML.
//
// Written into index.html at build time, so it is served markup rather than
// something JavaScript injects.

import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { audit, uniformSampleMask } from './audit.mjs';
import { propagate, DEG2RAD } from '../src/kepler.js';
import { classLabel, classNote } from '../src/palette.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const MARK_CAP = 2400;
const FALLBACK_SEED = 8112026;
const fmt = (n) => Number(n).toLocaleString('en-US');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function planView(ast, isRenderable, report) {
  const idx = [];
  for (let k = 0; k < ast.n; k++) if (isRenderable(k) && ast.a[k] < 6.2) idx.push(k);
  const mask = uniformSampleMask(idx.length, MARK_CAP, FALLBACK_SEED);
  const picked = [];
  for (let k = 0; k < idx.length; k++) if (mask[k]) picked.push(idx[k]);

  const W = 900;
  const H = 900;
  const AU_PX = (W / 2 - 30) / 6.0;
  const cx = W / 2;
  const cy = H / 2;

  const marks = picked
    .map((k) => {
      const p = propagate(
        ast.a[k],
        ast.e[k],
        ast.i[k] * DEG2RAD,
        ast.om[k] * DEG2RAD,
        ast.w[k] * DEG2RAD,
        ast.ma[k] * DEG2RAD,
        0,
        6,
      );
      const x = cx + p[0] * AU_PX;
      const y = cy - p[1] * AU_PX;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.1"/>`;
    })
    .filter(Boolean)
    .join('');

  const rings = [1, 2, 3, 4, 5]
    .map(
      (r) =>
        `<circle cx="${cx}" cy="${cy}" r="${(r * AU_PX).toFixed(1)}" fill="none" stroke="currentColor" stroke-opacity="0.16" stroke-width="1"/>` +
        `<text x="${cx + r * AU_PX + 4}" y="${cy - 4}" font-size="11" fill="currentColor" fill-opacity="0.45">${r} AU</text>`,
    )
    .join('');

  return `<figure style="margin:0 0 2.5rem">
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Plan view of ${fmt(picked.length)} small bodies sampled from the catalogue, seen from above the ecliptic" style="color:var(--ink)">
    <rect width="${W}" height="${H}" fill="none"/>
    ${rings}
    <circle cx="${cx}" cy="${cy}" r="4" fill="var(--signal)"/>
    <g fill="var(--ink)" fill-opacity="0.66">${marks}</g>
    <text x="18" y="${H - 18}" font-size="13" fill="currentColor" fill-opacity="0.7">${fmt(picked.length)} of ${fmt(
      report.counts.renderable,
    )} drawn — 1 in ${Math.round(report.counts.renderable / picked.length)}</text>
  </svg>
  <figcaption class="notice" style="margin-top:0.6rem">
    Plan view at epoch ${report.epochs.modeJD} JD, inner 6 AU only. This figure is decimated: it carries
    ${fmt(picked.length)} marks out of ${fmt(report.counts.renderable)} renderable bodies, a uniform random sample with
    seed ${FALLBACK_SEED}. At this density the Kirkwood gaps are not resolvable, which is exactly why the histogram
    below is computed over the whole catalogue instead.
  </figcaption>
</figure>`;
}

function histogram(report, ast, isRenderable) {
  // 0.005 AU bins over 1.7 to 3.6 AU, every renderable body, nothing decimated.
  const LO = 1.7;
  const HI = 3.6;
  const BIN = 0.005;
  const N = Math.round((HI - LO) / BIN);
  const bins = new Float64Array(N);
  let total = 0;
  for (let k = 0; k < ast.n; k++) {
    if (!isRenderable(k)) continue;
    const a = ast.a[k];
    if (a < LO || a >= HI) continue;
    bins[Math.floor((a - LO) / BIN)]++;
    total++;
  }
  let peak = 0;
  for (const v of bins) if (v > peak) peak = v;

  const W = 900;
  const H = 340;
  const PAD_L = 46;
  const PAD_B = 34;
  const PAD_T = 14;
  const plotW = W - PAD_L - 14;
  const plotH = H - PAD_B - PAD_T;
  const xOf = (a) => PAD_L + ((a - LO) / (HI - LO)) * plotW;
  const yOf = (v) => PAD_T + plotH - (v / peak) * plotH;

  let path = '';
  for (let b = 0; b < N; b++) {
    const x0 = xOf(LO + b * BIN);
    const x1 = xOf(LO + (b + 1) * BIN);
    const y = yOf(bins[b]);
    path += `${b === 0 ? 'M' : 'L'}${x0.toFixed(1)},${y.toFixed(1)}L${x1.toFixed(1)},${y.toFixed(1)}`;
  }
  path += `L${xOf(HI).toFixed(1)},${yOf(0).toFixed(1)}L${xOf(LO).toFixed(1)},${yOf(0).toFixed(1)}Z`;

  const markers = report.kirkwood.gapTableFullCorpus
    .map(
      (g) =>
        `<line x1="${xOf(g.aAU).toFixed(1)}" y1="${PAD_T}" x2="${xOf(g.aAU).toFixed(1)}" y2="${PAD_T + plotH}" stroke="var(--signal)" stroke-opacity="0.75" stroke-width="1" stroke-dasharray="3 3"/>` +
        `<text x="${xOf(g.aAU).toFixed(1)}" y="${PAD_T - 2}" font-size="11" text-anchor="middle" fill="var(--signal)">${g.resonance}</text>`,
    )
    .join('');

  const ticks = [1.8, 2.0, 2.2, 2.4, 2.6, 2.8, 3.0, 3.2, 3.4, 3.6]
    .map(
      (a) =>
        `<text x="${xOf(a).toFixed(1)}" y="${H - 12}" font-size="11" text-anchor="middle" fill="currentColor" fill-opacity="0.55">${a.toFixed(
          1,
        )}</text>`,
    )
    .join('');

  return `<figure style="margin:0 0 2.5rem">
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Histogram of semi-major axis for ${fmt(
    total,
  )} main-belt bodies, showing the Kirkwood gaps as deep notches at the 3:1, 5:2, 7:3 and 2:1 resonances" style="color:var(--ink);height:auto">
    <path d="${path}" fill="var(--ink)" fill-opacity="0.22" stroke="var(--ink)" stroke-opacity="0.75" stroke-width="1"/>
    ${markers}
    ${ticks}
    <text x="${PAD_L}" y="${H - 12}" font-size="11" text-anchor="start" fill="currentColor" fill-opacity="0.55" transform="translate(-30,0)">AU</text>
    <text x="6" y="${PAD_T + 10}" font-size="11" fill="currentColor" fill-opacity="0.55">${fmt(Math.round(peak))}</text>
    <text x="6" y="${PAD_T + plotH}" font-size="11" fill="currentColor" fill-opacity="0.55">0</text>
  </svg>
  <figcaption class="notice" style="margin-top:0.6rem">
    Every one of the ${fmt(total)} renderable bodies between ${LO} and ${HI} AU, in ${BIN} AU bins. Not decimated. The
    notches are the Kirkwood gaps; the dashed lines are the resonance positions computed independently from Jupiter’s
    semi-major axis, not fitted to the data.
  </figcaption>
</figure>`;
}

function tables(report, manifest) {
  const cls = [...report.classes]
    .map((c) => `<tr><td>${c.code}</td><td>${esc(classLabel(c.code))}</td><td>${fmt(c.count)}</td><td>${esc(classNote(c.code))}</td></tr>`)
    .join('');

  const gaps = report.kirkwood.gapTableFullCorpus
    .map(
      (g) =>
        `<tr><td>${g.resonance}</td><td>${g.aAU}</td><td>${fmt(g.smoothedInGap)}</td><td>${fmt(
          g.smoothedInner,
        )}</td><td>${fmt(g.smoothedOuter)}</td><td>×${g.depletionFactor}</td></tr>`,
    )
    .join('');

  return `
<h3>Populations</h3>
<div class="table-wrap"><table class="data">
<thead><tr><th>code</th><th>class</th><th>bodies</th><th>definition</th></tr></thead>
<tbody>${cls}</tbody></table></div>

<h3>The gaps, measured</h3>
<div class="table-wrap"><table class="data">
<thead><tr><th>resonance</th><th>a (AU)</th><th>in the gap</th><th>0.1 AU inner</th><th>0.1 AU outer</th><th>depletion</th></tr></thead>
<tbody>${gaps}</tbody></table></div>

<h3>Provenance</h3>
<div class="table-wrap"><table class="data">
<thead><tr><th>item</th><th>value</th></tr></thead>
<tbody>
<tr><td>source</td><td>NASA/JPL Small-Body Database Query API</td></tr>
<tr><td>fetched</td><td>2026-09-07</td></tr>
<tr><td>response bytes</td><td>${fmt(report.sources.asteroids.bytes)}</td></tr>
<tr><td>rows parsed</td><td>${fmt(report.counts.asteroidsParsed)}</td></tr>
<tr><td>API reported count</td><td>${fmt(report.sources.asteroids.apiReportedCount)}</td></tr>
<tr><td>renderable</td><td>${fmt(report.counts.renderable)}</td></tr>
<tr><td>comets catalogued</td><td>${fmt(report.counts.cometsParsed)}</td></tr>
<tr><td>reference epoch</td><td>JD ${manifest.referenceEpoch.jd} (${manifest.referenceEpoch.iso.slice(0, 10)})</td></tr>
<tr><td>full tier on the wire</td><td>${fmt(manifest.tiers.full.bytes)} B raw</td></tr>
</tbody></table></div>`;
}

export async function buildFallback() {
  const { audit: report, ast, isRenderable } = await audit();
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'orrery-manifest.json'), 'utf8'));

  const html = `<div class="fallback__inner">
  <h1 class="wordmark" style="font-size:1.6rem"><span class="wordmark__dot" aria-hidden="true"></span>orrery</h1>
  <p class="lede" style="max-width:44rem">
    ${fmt(report.counts.renderable)} catalogued small bodies of the solar system. The interactive map needs WebGL2 and
    JavaScript; this is the same catalogue, measured and drawn at build time.
  </p>
  ${planView(ast, isRenderable, report)}
  ${histogram(report, ast, isRenderable)}
  ${tables(report, manifest)}
  <p class="aj-attribution" style="margin-top:2.5rem">
    <svg class="aj-attribution__mark" viewBox="0 0 64 64" width="16" height="16" role="img" aria-label="Agent James"><path fill="currentColor" fill-rule="evenodd" d="M4 16h8v4h-8zM52 16h8v4h-8zM16 4h4v8h-4zM16 52h4v8h-4zM4 28h8v4h-8zM52 28h8v4h-8zM28 4h4v8h-4zM28 52h4v8h-4zM4 40h8v4h-8zM52 40h8v4h-8zM40 4h4v8h-4zM40 52h4v8h-4zM12 12h40v40h-40zM16 16v32h32v-32zM36 20h4v20h-16v-4h12z"/><rect x="20" y="20" width="4" height="4" fill="var(--signal, #B45309)"/></svg>Built by <a href="https://agentjames.vercel.app" rel="me noopener">James Lorenz Santos</a><span class="aj-attribution__sep" aria-hidden="true">&middot;</span><a href="https://www.linkedin.com/in/james-lorenz-santos-720776251/" rel="me noopener" target="_blank">LinkedIn</a>
  </p>
</div>`;

  const tokens = {
    RENDERABLE: String(report.counts.renderable),
    RENDERABLE_FMT: fmt(report.counts.renderable),
    NAMED_FMT: fmt(manifest.search.entries),
    MEDIAN_INC: String(report.shape.inclinationDeg.median),
    MEDIAN_ECC: String(report.shape.eccentricity.median),
  };

  return { html, tokens };
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { html, tokens } = await buildFallback();
  writeFileSync(join(ROOT, 'src', 'fallback.generated.html'), html);
  writeFileSync(join(ROOT, 'src', 'fallback.tokens.json'), JSON.stringify(tokens, null, 2) + '\n');
  console.log(`fallback: ${Buffer.byteLength(html).toLocaleString('en-US')} B`);
  console.log(tokens);
  process.exitCode = 0;
}
