// render-ablation.mjs — measure the rendering pipeline one variable at a time.
//
//   npx vite preview --port 4173 --strictPort   (or set ORRERY_URL)
//   node scripts/render-ablation.mjs
//
// Every case below differs from the shipped default in exactly one URL flag, so
// the deltas are ablations rather than opinions. Three things are recorded per
// case: the GPU time for the frame (EXT_disjoint_timer_query_webgl2, not a
// wall-clock guess), the luminance histogram of the rendered framebuffer, and
// the radial luminance profile that the Kirkwood gaps have to survive.
//
// The run FAILS rather than reports if the browser fell back to a software
// rasteriser, because a SwiftShader frame time is fiction.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DOCS = join(ROOT, 'docs');
const SHOTS = join(DOCS, 'ablation');
const BASE = process.env.ORRERY_URL || 'http://localhost:4173';
const PLAYWRIGHT = 'file:///C:/Users/admin/agentjames/node_modules/playwright/index.mjs';
const VIEW = { width: 1440, height: 900 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cases: [id, query string, note]
const CASES = (process.env.ORRERY_CASES ? JSON.parse(readFileSync(process.env.ORRERY_CASES, 'utf8')) : [
  ['00-before', 'tone=exp&encode=0', 'The pipeline as shipped before this change: exponential curve, no sRGB encode.'],
  ['01-encode-only', 'tone=exp&encode=1', 'Legacy curve, sRGB transfer function restored. Isolates the colour-space defect.'],
  ['02-neutral', 'tone=neutral', 'Khronos PBR Neutral + sRGB encode. The shipped configuration.'],
  ['03-agx', 'tone=agx', 'AgX + sRGB encode, same exposure.'],
  ['04-none', 'tone=none&exposure=0.62', 'No curve at all, clamp only. What clipping looks like.'],
  ['05-neutral-hot', 'tone=neutral&exposure=1.2', 'Neutral, deliberately over-exposed. The failure the report warns about.'],
  ['06-neutral-dim', 'tone=neutral&exposure=0.35', 'Neutral, under-exposed.'],
]);

// The resonances the manifest names, so gap depth is a continuous number rather
// than a pass/fail on a blind detector calibrated against one pipeline.
const RESONANCES = [['4:1', 2.0640], ['3:1', 2.5013], ['5:2', 2.8246], ['7:3', 2.9575], ['2:1', 3.2776]];

function luminanceStats(buf, w, h) {
  const hist = new Array(256).fill(0);
  let sum = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const l = Math.round(0.2126 * buf[o] + 0.7152 * buf[o + 1] + 0.0722 * buf[o + 2]);
    hist[l]++;
    sum += l;
  }
  const pct = (p) => {
    let acc = 0;
    const target = n * p;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= target) return v;
    }
    return 255;
  };
  let distinct = 0;
  for (let v = 0; v < 256; v++) if (hist[v] > 0) distinct++;
  return {
    meanLuma: Number((sum / n).toFixed(3)),
    p001: pct(0.001), p01: pct(0.01), p50: pct(0.5), p99: pct(0.99), p999: pct(0.999), max: pct(0.99999),
    // The two review-blocking defects from the report, as numbers.
    blackPointOk: pct(0.001) <= 3,
    clippedWhiteFraction: Number((hist[255] / n).toFixed(6)),
    distinctLumaValues: distinct,
    histogram: hist,
  };
}

async function run() {
  const { chromium } = await import(PLAYWRIGHT);
  mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--hide-scrollbars', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });

  const out = { measuredAt: new Date().toISOString(), base: BASE, viewport: VIEW, cases: [] };

  for (const [id, query, note] of CASES) {
    const url = `${BASE}/?${query}`;
    const errors = [];
    page.removeAllListeners('console');
    page.removeAllListeners('pageerror');
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

    await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForFunction(() => window.__orrery && window.__orrery.ready, { timeout: 90000 });

    const gpu = await page.evaluate(() => {
      const gl = document.getElementById('stage').getContext('webgl2');
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        devicePixelRatio: window.devicePixelRatio,
      };
    });
    if (/swiftshader|software|llvmpipe|basic render/i.test(gpu.renderer)) {
      throw new Error(`software rasteriser detected (${gpu.renderer}) — frame times would be fiction, refusing to report`);
    }
    out.gpu = gpu;

    // Load the whole catalogue and go to the gaps view: that is the frame whose
    // legibility this change is not allowed to damage.
    await page.evaluate(() => window.__orrery.loadFull());
    await page.waitForFunction(() => window.__orrery.tier() === 'full', { timeout: 240000 });
    await page.evaluate(() => { window.__orrery.setRate(0); window.__orrery.preset('gaps'); });
    await sleep(3200);

    const gpuCost = await page.evaluate(() => window.__orrery.gpuCost(120));
    const shot = join(SHOTS, `${id}.png`);
    await page.screenshot({ path: shot, type: 'png' });

    const pixels = await page.evaluate(() => {
      const app = window.__orrery.app;
      const { width, height, pixels } = app.readCompositePixels();
      return { width, height, data: Array.from(pixels) };
    });
    const buf = Uint8Array.from(pixels.data);
    const stats = luminanceStats(buf, pixels.width, pixels.height);

    const radial = await page.evaluate((RES) => {
      // Same method as scripts/shoot.mjs: mean luminance over concentric 1 px
      // annuli about the Sun, smoothed over ~0.024 AU, minima at least 20 %
      // below the local peak. Kept in the harness rather than the app so the
      // shipped bundle carries none of it.
      const app = window.__orrery.app;
      const { width: w, height: h, pixels: buf } = app.readCompositePixels();
      const V = app.camera.position.constructor;
      const project = (v) => {
        const p = v.clone().project(app.camera);
        return [((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h];
      };
      const origin = project(new V(0, 0, 0));
      const oneAu = project(new V(10, 0, 0));
      const pxPerAu = Math.hypot(oneAu[0] - origin[0], oneAu[1] - origin[1]);
      const cx = origin[0];
      const cy = h - origin[1];
      const maxR = Math.min(cx, cy, w - cx, h - cy) - 4;
      const bins = Math.floor(maxR);
      const sum = new Float64Array(bins);
      const cnt = new Float64Array(bins);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = x - cx;
          const dy = y - cy;
          const b = Math.floor(Math.sqrt(dx * dx + dy * dy));
          if (b >= bins) continue;
          const o = (y * w + x) * 4;
          sum[b] += 0.2126 * buf[o] + 0.7152 * buf[o + 1] + 0.0722 * buf[o + 2];
          cnt[b]++;
        }
      }
      const profile = [];
      for (let b = 0; b < bins; b++) profile.push(cnt[b] ? sum[b] / cnt[b] : 0);
      const half = Math.max(2, Math.round(0.012 * pxPerAu));
      const sm = profile.map((_, b) => {
        let t = 0;
        let n = 0;
        for (let k = b - half; k <= b + half; k++) {
          if (k < 0 || k >= profile.length) continue;
          t += profile[k];
          n++;
        }
        return t / n;
      });
      const lo = Math.floor(2.05 * pxPerAu);
      const hi = Math.min(sm.length - 2, Math.floor(3.45 * pxPerAu));
      const localHalf = Math.max(3, Math.round(0.05 * pxPerAu));
      const minima = [];
      for (let b = lo; b <= hi; b++) {
        let isMin = true;
        for (let k = b - localHalf; k <= b + localHalf; k++) {
          if (k !== b && sm[k] < sm[b]) { isMin = false; break; }
        }
        if (!isMin) continue;
        let peak = 0;
        const win = Math.round(0.25 * pxPerAu);
        for (let k = Math.max(0, b - win); k <= Math.min(sm.length - 1, b + win); k++) if (sm[k] > peak) peak = sm[k];
        if (peak <= 0 || sm[b] / peak > 0.8) continue;
        const entry = {
          aAU: Number(((b + 0.5) / pxPerAu).toFixed(3)),
          luma: Number(sm[b].toFixed(2)),
          localPeak: Number(peak.toFixed(2)),
          contrast: Number((sm[b] / peak).toFixed(3)),
        };
        const prev = minima[minima.length - 1];
        if (prev && Math.abs(prev.aAU - entry.aAU) < 0.06) {
          if (entry.contrast < prev.contrast) minima[minima.length - 1] = entry;
        } else minima.push(entry);
      }
      // Continuous gap depth at each named resonance: luminance in the lane
      // divided by the mean luminance 0.12 AU either side. Lower is a deeper,
      // more legible gap. This is the number that decides whether a rendering
      // change helped or hurt the thing the page exists to show.
      const at = (au) => {
        const b = Math.round(au * pxPerAu - 0.5);
        return b >= 0 && b < sm.length ? sm[b] : null;
      };
      const depth = {};
      for (const [name, au] of RES) {
        const inLane = at(au);
        const inner = at(au - 0.12);
        const outer = at(au + 0.12);
        depth[name] = inLane != null && inner != null && outer != null && inner + outer > 0
          ? Number((inLane / ((inner + outer) / 2)).toFixed(4))
          : null;
      }
      return { pxPerAu: Number(pxPerAu.toFixed(2)), minima, depth };
    }, RESONANCES);

    out.cases.push({ id, query, note, url, gpuCost, stats: { ...stats, histogram: undefined }, radial, errors, shot: `docs/ablation/${id}.png` });
    console.log(
      `${id.padEnd(18)} gpu ${String(gpuCost?.medianMs ?? '?').padStart(7)} ms  ` +
        `mean ${String(stats.meanLuma).padStart(7)}  p0.1 ${String(stats.p001).padStart(3)}  ` +
        `p99.9 ${String(stats.p999).padStart(3)}  clipped ${stats.clippedWhiteFraction}  ` +
        `gaps ${radial.minima.map((m) => m.aAU).join(',') || 'NONE'}`,
    );
    console.log(`   gap depth (lower is deeper): ` + RESONANCES.map(([n]) => `${n} ${radial.depth[n]}`).join('  '));
    if (errors.length) console.log(`   console errors: ${errors.join(' | ')}`);
  }

  await browser.close();
  writeFileSync(join(DOCS, 'render-ablation.json'), JSON.stringify(out, null, 2));
  console.log(`\nwrote docs/render-ablation.json`);
}

run().catch((e) => { console.error(e); process.exit(1); });
