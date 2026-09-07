// shoot.mjs — drive the built site in a real browser, measure it, and prove
// the screenshots contain a scene.
//
//   npx vite preview --port 4173 --strictPort   (in another shell)
//   node scripts/shoot.mjs
//
// Every figure this writes into docs/render-report.json is measured in the
// browser on this machine. The GPU string is captured so the frame times can
// never be quoted without the hardware they were measured on.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { decodePng, imageStats, isRendered } from './lib/png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DOCS = join(ROOT, 'docs');
const BASE = process.env.ORRERY_URL || 'http://localhost:4173';
const PLAYWRIGHT = 'file:///C:/Users/admin/agentjames/node_modules/playwright/index.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Two numbers, because one of them alone would mislead.
 *
 *  presented  the interval between frames the compositor actually showed. This
 *             is what a visitor experiences, and with vsync on it cannot beat
 *             the display refresh however fast the GPU is.
 *  gpuCost    render() followed by gl.finish(), which drains the pipeline
 *             before stopping the clock. This is the real cost of the work and
 *             therefore the real headroom.
 */
async function measure(page, seconds = 4) {
  await page.evaluate(() => {
    window.__orrery.app.frameTimes.length = 0;
    window.__orrery.app._lastFrameTs = undefined;
  });
  await sleep(seconds * 1000);
  const presented = await page.evaluate(() => window.__orrery.stats());
  const gpuCost = await page.evaluate(() => window.__orrery.gpuCost(90));
  return { ...presented, gpuCost };
}

async function shot(page, name, note, extra = {}) {
  mkdirSync(DOCS, { recursive: true });
  const file = join(DOCS, `${name}.png`);
  await page.screenshot({ path: file, type: 'png' });
  const png = decodePng(readFileSync(file));
  const stats = imageStats(png);
  const ok = isRendered(stats);
  console.log(
    `  ${name.padEnd(28)} ${ok ? 'RENDERED' : '*** BLANK ***'}  ` +
      `sd=${stats.stdDevLuma.toFixed(2)} distinct=${stats.distinctLumaValues} mean=${stats.meanLuma.toFixed(1)}`,
  );
  return { name, file: `docs/${name}.png`, note, rendered: ok, pixels: stats, ...extra };
}

export async function shoot() {
  const { chromium } = await import(PLAYWRIGHT);

  // Headed with the discrete GPU. Headless Chromium falls back to SwiftShader,
  // which would produce a frame time that says nothing about real hardware.
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-webgpu',
      '--use-angle=d3d11',
      '--hide-scrollbars',
    ],
  });

  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  const report = { measuredAt: new Date().toISOString(), base: BASE, shots: [], measurements: {}, consoleErrors };

  console.log(`opening ${BASE}`);
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForFunction(() => window.__orrery && window.__orrery.ready, { timeout: 60000 });

  // --- what actually rendered this ----------------------------------------
  report.gpu = await page.evaluate(() => {
    const gl = document.getElementById('stage').getContext('webgl2');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      version: gl.getParameter(gl.VERSION),
      shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      devicePixelRatio: window.devicePixelRatio,
      drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    };
  });
  report.programs = await page.evaluate(() => window.__orrery.programs());
  report.allProgramsLinked = report.programs.every((p) => p.linked);
  console.log(`GPU: ${report.gpu.renderer}`);
  console.log(`programs linked: ${report.allProgramsLinked} (${report.programs.length} programs)`);
  for (const p of report.programs.filter((x) => !x.linked)) console.log(`  !! ${p.name}: ${p.log} ${p.vertexLog} ${p.fragmentLog}`);
  console.log(`     ${report.gpu.version}`);

  await sleep(2500);

  // --- preview tier --------------------------------------------------------
  report.measurements.previewTier = await measure(page, 4);
  console.log(
    `preview tier: ${report.measurements.previewTier.drawnBodies.toLocaleString('en-US')} bodies, ` +
      `presented ${report.measurements.previewTier.medianFrameMs.toFixed(2)} ms ` +
      `(${report.measurements.previewTier.fps.toFixed(0)} fps), ` +
      `gpu work ${report.measurements.previewTier.gpuCost?.medianMs.toFixed(2)} ms`,
  );
  report.shots.push(
    await shot(page, '01-belt-preview', 'Opening view, 120,000-body preview tier, 20 degrees above the ecliptic.', {
      bodies: report.measurements.previewTier.drawnBodies,
    }),
  );

  // --- full catalogue ------------------------------------------------------
  console.log('loading the full catalogue…');
  await page.evaluate(() => window.__orrery.loadFull());
  await page.waitForFunction(() => window.__orrery.tier() === 'full', { timeout: 180000 });
  await sleep(2500);

  report.measurements.fullTier = await measure(page, 5);
  console.log(
    `full tier:    ${report.measurements.fullTier.drawnBodies.toLocaleString('en-US')} bodies, ` +
      `presented ${report.measurements.fullTier.medianFrameMs.toFixed(2)} ms ` +
      `(${report.measurements.fullTier.fps.toFixed(0)} fps), ` +
      `gpu work ${report.measurements.fullTier.gpuCost?.medianMs.toFixed(2)} ms`,
  );
  report.shots.push(
    await shot(page, '02-belt-full', 'The whole catalogue loaded, every body solved on the GPU this frame.', {
      bodies: report.measurements.fullTier.drawnBodies,
    }),
  );

  // --- the money shot: the gaps -------------------------------------------
  await page.evaluate(() => {
    window.__orrery.setRate(0);
    window.__orrery.preset('gaps');
  });
  await sleep(3000);
  report.measurements.gapsView = await measure(page, 4);
  report.shots.push(
    await shot(
      page,
      '03-kirkwood-gaps',
      'Plan view of the main belt, full catalogue, animation paused. The dark lanes are the Kirkwood gaps.',
      { bodies: report.measurements.gapsView.drawnBodies },
    ),
  );

  // A tighter crop of the belt, so the gaps are unambiguous in the figure.
  {
    const file = join(DOCS, '04-kirkwood-gaps-detail.png');
    await page.screenshot({ path: file, clip: { x: 430, y: 60, width: 740, height: 740 }, type: 'png' });
    const stats = imageStats(decodePng(readFileSync(file)));
    console.log(
      `  ${'04-kirkwood-gaps-detail'.padEnd(28)} ${isRendered(stats) ? 'RENDERED' : '*** BLANK ***'}  ` +
        `sd=${stats.stdDevLuma.toFixed(2)} distinct=${stats.distinctLumaValues}`,
    );
    report.shots.push({
      name: '04-kirkwood-gaps-detail',
      file: 'docs/04-kirkwood-gaps-detail.png',
      note: 'Cropped detail of the belt showing the resonance lanes.',
      rendered: isRendered(stats),
      pixels: stats,
    });
  }

  // --- radial brightness profile straight off the framebuffer -------------
  // The claim is that the gaps are VISIBLE, not merely present in a histogram.
  // Sample the rendered pixels along radii and look for the dips.
  report.radialProfile = await page.evaluate(() => {
    const app = window.__orrery.app;
    const { width: w, height: h, pixels: buf } = app.readCompositePixels();

    // Derive the pixel scale by projecting two known scene points, rather than
    // reasoning about the field of view on paper.
    const V = app.camera.position.constructor;
    const project = (v) => {
      const p = v.clone().project(app.camera);
      return [((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h];
    };
    const origin = project(new V(0, 0, 0));
    const oneAu = project(new V(10, 0, 0));
    const pxPerAu = Math.hypot(oneAu[0] - origin[0], oneAu[1] - origin[1]);

    const cx = origin[0];
    const cy = h - origin[1]; // readPixels is bottom-up
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
    return { pxPerAu, bins, profile, width: w, height: h };
  });

  // Do the gaps show up in the RENDERED PIXELS, not merely in the histogram?
  {
    const { pxPerAu, profile } = report.radialProfile;
    const auOf = (b) => (b + 0.5) / pxPerAu;
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
        aAU: Number(auOf(b).toFixed(3)),
        luma: Number(sm[b].toFixed(2)),
        localPeak: Number(peak.toFixed(2)),
        contrast: Number((sm[b] / peak).toFixed(3)),
      };
      const prev = minima[minima.length - 1];
      if (prev && Math.abs(prev.aAU - entry.aAU) < 0.06) {
        if (entry.contrast < prev.contrast) minima[minima.length - 1] = entry;
      } else minima.push(entry);
    }
    const manifest = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'orrery-manifest.json'), 'utf8'));
    report.gapsVisibleInPixels = {
      pxPerAu: Number(pxPerAu.toFixed(2)),
      method:
        'mean luminance of the rendered framebuffer over concentric 1px annuli about the Sun, smoothed over ~0.024 AU, minima at least 20% below the local peak',
      minimaFound: minima,
      matchedToResonance: manifest.receipts.kirkwood.map((g) => {
        let best = null;
        for (const m of minima) {
          const d = Math.abs(m.aAU - g.aAU);
          if (!best || d < best.distanceAU) best = { ...m, distanceAU: Number(d.toFixed(3)) };
        }
        return { resonance: g.resonance, predictedAU: g.aAU, nearestPixelMinimum: best };
      }),
    };
    console.log('gaps detected in rendered pixels at AU:', minima.map((m) => m.aAU).join(', '));
  }

  // --- remaining views -----------------------------------------------------
  const views = [
    ['trojans', '05-trojans', 'The Jupiter Trojans: two swarms locked 60 degrees ahead of and behind Jupiter.'],
    ['inclination', '06-inclination-fan', 'Vertical exaggeration x14. The belt is a torus, not a disc.'],
    ['outer', '07-outer-system', 'Trans-Neptunian objects and Centaurs, two orders of magnitude further out.'],
  ];
  for (const [preset, name, note] of views) {
    await page.evaluate((p) => window.__orrery.preset(p), preset);
    await sleep(2600);
    const m = await measure(page, 2.5);
    report.measurements[preset] = m;
    report.shots.push(await shot(page, name, note, { bodies: m.drawnBodies }));
  }

  // --- daylight plate ------------------------------------------------------
  await page.evaluate(() => window.__orrery.preset('gaps'));
  await sleep(2200);
  await page.click('#stageToggle');
  await sleep(1600);
  report.shots.push(await shot(page, '08-daylight-plate', 'The daylight stage: dark ink on a light ground, density reads as darkness.'));
  await page.click('#stageToggle');
  await sleep(1000);

  // --- receipts sheet ------------------------------------------------------
  await page.click('#openReceipts');
  await sleep(900);
  report.shots.push(await shot(page, '09-receipts', 'The receipts sheet: every headline number, recomputed from the data.'));
  await page.click('#closeReceipts');
  await sleep(600);

  // --- selection -----------------------------------------------------------
  await page.evaluate(() => window.__orrery.preset('belt'));
  await sleep(2400);
  await page.fill('#search', 'Ceres');
  await sleep(1400);
  const gotResult = await page.evaluate(() => !!document.querySelector('#results button'));
  if (gotResult) {
    await page.click('#results button');
    await sleep(2600);
    report.shots.push(await shot(page, '10-selection-ceres', 'A body selected by name, with its own orbit ellipse drawn.'));
    report.selection = await page.evaluate(() => document.getElementById('readoutTitle').textContent);
  } else {
    report.selection = null;
    console.log('  search returned no result for "Ceres"');
  }

  // --- narrow viewport -----------------------------------------------------
  await page.setViewportSize({ width: 420, height: 860 });
  await sleep(2200);
  report.shots.push(await shot(page, '11-narrow', 'At 420 CSS px the panels stack and the stage stays full bleed.'));
  await page.setViewportSize({ width: 1600, height: 1000 });

  // --- no-JavaScript twin --------------------------------------------------
  const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 1400 } });
  const np = await noJs.newPage();
  await np.goto(BASE, { waitUntil: 'load', timeout: 60000 });
  await sleep(900);
  const f = join(DOCS, '12-no-javascript.png');
  await np.screenshot({ path: f, fullPage: false, type: 'png' });
  const nstats = imageStats(decodePng(readFileSync(f)));
  console.log(`  ${'12-no-javascript'.padEnd(28)} ${isRendered(nstats) ? 'RENDERED' : '*** BLANK ***'} sd=${nstats.stdDevLuma.toFixed(2)}`);
  report.shots.push({
    name: '12-no-javascript',
    file: 'docs/12-no-javascript.png',
    note: 'JavaScript disabled: the served HTML carries the decimated plan view, the undecimated histogram and the full tables.',
    rendered: isRendered(nstats),
    pixels: nstats,
  });
  report.noJavaScriptText = (await np.textContent('.fallback__inner')).replace(/\s+/g, ' ').slice(0, 400);
  await noJs.close();

  await browser.close();

  report.allShotsRendered = report.shots.every((s) => s.rendered);
  report.pass = report.allShotsRendered && report.allProgramsLinked && report.consoleErrors.length === 0;
  mkdirSync(DOCS, { recursive: true });
  writeFileSync(join(DOCS, 'render-report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  const r = await shoot();
  console.log('');
  console.log(`all shots rendered: ${r.allShotsRendered}`);
  console.log(`console errors: ${r.consoleErrors.length}`);
  for (const e of r.consoleErrors.slice(0, 10)) console.log(`  ! ${e}`);
  console.log(`programs linked: ${r.allProgramsLinked}`);
  process.exitCode = r.pass ? 0 : 1;
}
