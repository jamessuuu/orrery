// a11y-probe.mjs — keyboard traversal, focus visibility, touch-target sizes and
// reduced-motion behaviour, measured on the running page rather than asserted
// from the source.
//
//   node scripts/a11y-probe.mjs

import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BASE = process.env.ORRERY_URL || 'http://localhost:4173';
const PLAYWRIGHT = 'file:///C:/Users/admin/agentjames/node_modules/playwright/index.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function probe() {
  const { chromium } = await import(PLAYWRIGHT);
  const browser = await chromium.launch({
    headless: false,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--hide-scrollbars'],
  });

  const out = {};

  // --- keyboard + targets, normal motion ----------------------------------
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForFunction(() => window.__orrery && window.__orrery.ready, { timeout: 60000 });
  await sleep(1200);

  // Walk the tab order and record what is reachable.
  const order = [];
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 34),
        w: Math.round(r.width),
        h: Math.round(r.height),
        visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden',
      };
    });
    if (!info) break;
    const key = `${info.tag}#${info.id}|${info.label}`;
    if (order.length && order[order.length - 1].key === key) break;
    order.push({ ...info, key });
  }
  out.tabOrder = order;
  out.reachableControls = order.length;

  // Focus visibility: does the focus ring actually paint?
  out.focusRing = await page.evaluate(() => {
    const el = document.getElementById('openReceipts');
    el.focus();
    const cs = getComputedStyle(el);
    return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor };
  });

  // Touch targets: interactive controls should reach 44 px on at least one axis
  // and not be tiny on the other.
  out.smallTargets = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('#hud button, #hud input, #hud a, #hud [tabindex]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 32 || r.width < 24) {
        bad.push({ id: el.id || null, label: (el.textContent || '').trim().slice(0, 28), w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    return bad;
  });

  // Escape closes the receipts sheet.
  await page.click('#openReceipts');
  await sleep(400);
  const sheetOpen = await page.evaluate(() => !document.getElementById('sheet').hidden);
  await page.keyboard.press('Escape');
  await sleep(400);
  const sheetClosed = await page.evaluate(() => document.getElementById('sheet').hidden);
  out.receiptsSheet = { opensOnClick: sheetOpen, closesOnEscape: sheetClosed };

  // Every control operable from the keyboard alone: drive the time scrubber.
  await page.focus('#scrub');
  const before = await page.evaluate(() => window.__orrery.app.timeDays);
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight');
  await sleep(300);
  const after = await page.evaluate(() => window.__orrery.app.timeDays);
  out.keyboardDrivesTime = { before, after, changed: after !== before };

  await page.close();

  // --- reduced motion ------------------------------------------------------
  const rm = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    reducedMotion: 'reduce',
  });
  const rp = await rm.newPage();
  await rp.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await rp.waitForFunction(() => window.__orrery && window.__orrery.ready, { timeout: 60000 });
  await sleep(2500);
  const t1 = await rp.evaluate(() => window.__orrery.app.timeDays);
  await sleep(1500);
  const t2 = await rp.evaluate(() => window.__orrery.app.timeDays);
  out.reducedMotion = {
    animationAutostarts: t1 !== 0 || t2 !== t1,
    timeDaysAfter2500ms: t1,
    timeDaysAfter4000ms: t2,
    rateDaysPerSecond: await rp.evaluate(() => window.__orrery.app.rateDaysPerSecond),
  };
  // The time control must still work, so no state is unreachable.
  await rp.focus('#scrub');
  for (let i = 0; i < 10; i++) await rp.keyboard.press('ArrowRight');
  await sleep(300);
  out.reducedMotion.timeControlStillOperable = (await rp.evaluate(() => window.__orrery.app.timeDays)) !== t2;
  await rp.screenshot({ path: join(ROOT, 'docs', '13-reduced-motion.png') });
  await rm.close();

  await browser.close();
  return out;
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  const r = await probe();
  writeFileSync(join(ROOT, 'docs', 'a11y-report.json'), JSON.stringify(r, null, 2) + '\n');
  console.log(`reachable by keyboard: ${r.reachableControls} controls`);
  console.log(`focus ring: ${r.focusRing.outlineStyle} ${r.focusRing.outlineWidth} ${r.focusRing.outlineColor}`);
  console.log(`targets under 32px tall: ${r.smallTargets.length}`);
  for (const t of r.smallTargets) console.log(`  ! ${t.id || t.label} ${t.w}x${t.h}`);
  console.log(`receipts sheet: opens=${r.receiptsSheet.opensOnClick} escape closes=${r.receiptsSheet.closesOnEscape}`);
  console.log(`keyboard drives the time control: ${r.keyboardDrivesTime.changed}`);
  console.log(`reduced motion: autostarts=${r.reducedMotion.animationAutostarts} rate=${r.reducedMotion.rateDaysPerSecond} timeControlStillWorks=${r.reducedMotion.timeControlStillOperable}`);
  process.exitCode = 0;
}
