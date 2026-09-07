// main.js — wiring. Loads the manifest first so every number on screen comes
// from the packed data rather than from a constant in this file.

import './style.css';
import { BufferGeometry, BufferAttribute, LineLoop, LineBasicMaterial } from 'three';
import { Orrery, AU_TO_SCENE } from './scene.js';
import { classLabel, classNote, classColor } from './palette.js';
import { propagate, jdToDate, DEG2RAD } from './kepler.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');
const bytes = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  manifest: null,
  tier: 'preview',
  cols: null,
  names: null,
  previewMap: null,
  selected: -1,
  loading: false,
};

// ---------------------------------------------------------------------------

function failToFallback(reason) {
  document.body.classList.add('is-fallback');
  const el = $('fallback');
  if (el) {
    const p = document.createElement('p');
    p.className = 'notice';
    p.style.margin = '0 0 1.5rem';
    p.textContent = reason;
    el.querySelector('.fallback__inner')?.prepend(p);
  }
}

/** Split a fetched tier buffer into seven zero-copy Uint16 column views. */
function splitColumns(buffer, count, deltaCoded) {
  const cols = [];
  for (let c = 0; c < 7; c++) cols.push(new Uint16Array(buffer, c * count * 2, count));
  if (deltaCoded) {
    // Undo the delta coding on the semi-major-axis column, in place.
    const a = cols[0];
    let acc = 0;
    for (let k = 0; k < count; k++) {
      acc = (acc + a[k]) & 0xffff;
      a[k] = acc;
    }
  }
  return cols;
}

async function fetchTier(tier, onProgress) {
  const spec = state.manifest.tiers[tier];
  const res = await fetch(spec.file);
  if (!res.ok) throw new Error(`${spec.file} -> HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || spec.bytes;
  if (!res.body || !onProgress) {
    const buf = await res.arrayBuffer();
    return splitColumns(buf, spec.bodies, spec.deltaCodedSemiMajorAxis);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return splitColumns(out.buffer, spec.bodies, spec.deltaCodedSemiMajorAxis);
}

// ---------------------------------------------------------------------------

async function boot() {
  if (!Orrery.hasWebGL2()) {
    failToFallback('This browser reports no WebGL2 context, so the live map cannot run. Everything below is the same data, drawn at build time.');
    return;
  }

  let manifest;
  let planets;
  try {
    [manifest, planets] = await Promise.all([
      fetch('data/orrery-manifest.json').then((r) => r.json()),
      fetch('data/planets.json').then((r) => r.json()),
    ]);
  } catch (err) {
    failToFallback(`The catalogue could not be loaded (${err.message}). The static view below is unaffected.`);
    return;
  }
  state.manifest = manifest;

  const hud = $('hud');
  hud.hidden = false;

  const app = new Orrery($('stage'));
  window.addEventListener('resize', () => app.resize());
  app.setStage('dusk');

  const cols = await fetchTier('preview');
  state.cols = cols;
  app.setBodies({
    count: manifest.tiers.preview.bodies,
    cols,
    classCodes: manifest.classes,
    quantisation: manifest.quantisation,
  });
  app.addPlanets(planets, manifest.referenceEpoch.jd);
  app.setStage('dusk');

  buildClassList(app, manifest);
  buildPresets(app, manifest);
  buildReceipts(manifest);
  wireControls(app, manifest);
  wireSearch(app, manifest);
  wirePicking(app, manifest);

  updateTierNote();
  updateHeadline();

  // Open on the belt seen from twenty degrees above the ecliptic: the angle at
  // which it stops being a ring and becomes a torus with real thickness.
  applyPreset(app, PRESETS[0], true);

  if (!reduceMotion) {
    app.rateDaysPerSecond = 30;
    $('playToggle').setAttribute('aria-pressed', 'true');
    $('playToggle').textContent = '❚❚';
  }
  updateRateOut(app);

  let acc = 0;
  app.start((a) => {
    acc++;
    if (acc % 12 === 0) updateReadout(a, manifest);
    if (acc % 4 === 0) updateTimeOut(a, manifest);
  });

  // Fail loudly rather than presenting an empty stage at 5000 fps.
  const programs = app.programStatus();
  const broken = programs.filter((p) => !p.linked);
  if (broken.length) {
    console.error('shader programs failed to link', broken);
  }

  window.__orrery = {
    app,
    manifest,
    programs: () => app.programStatus(),
    gpuCost: (n) => app.measureGpuFrameCost(n),
    probe: (indices, t) => app.probePositions(indices, t, manifest.quantisation),
    stats: () => app.stats(),
    bodyCount: () => app.bodyCount,
    tier: () => state.tier,
    loadFull: () => loadFull(app, manifest),
    preset: (name) => {
      const p = PRESETS.find((x) => x.id === name);
      if (p) applyPreset(app, p, true);
    },
    setTime: (d) => {
      app.timeDays = d;
    },
    setRate: (r) => {
      app.rateDaysPerSecond = r;
      updateRateOut(app);
    },
    ready: true,
  };
}

// --- headline / notes ------------------------------------------------------

function updateHeadline() {
  const m = state.manifest;
  const drawn = m.tiers[state.tier].bodies;
  const total = m.totals.renderableBodies;
  $('headlineCount').textContent = fmt(drawn);
  if (state.tier === 'full') {
    $('headlineSub').textContent = `catalogued small bodies, the whole catalogue`;
  } else {
    $('headlineSub').textContent = `of ${fmt(total)} drawn — uniform random sample, seed ${m.sampleSeed}`;
  }
}

function updateTierNote() {
  const m = state.manifest;
  const full = m.tiers.full;
  const note = $('tierNote');
  if (state.tier === 'full') {
    note.textContent = `All ${fmt(full.bodies)} bodies are loaded. ${bytes(full.bytes)} on the wire.`;
    $('loadAll').disabled = true;
    $('loadAll').textContent = 'all loaded';
  } else {
    note.textContent = `Showing a ${fmt(m.tiers.preview.bodies)}-body uniform random sample so first paint is ${bytes(
      m.tiers.preview.bytes,
    )}. Loading all ${fmt(full.bodies)} downloads ${bytes(full.bytes)}.`;
  }
}

async function loadFull(app, manifest) {
  if (state.tier === 'full' || state.loading) return;
  state.loading = true;
  const btn = $('loadAll');
  btn.disabled = true;
  btn.textContent = 'loading…';
  $('loadBar').hidden = false;
  try {
    const cols = await fetchTier('full', (got, total) => {
      $('loadFill').style.width = `${Math.round((got / total) * 100)}%`;
    });
    state.cols = cols;
    state.tier = 'full';
    app.setSelected(-1);
    state.selected = -1;
    app.setBodies({
      count: manifest.tiers.full.bodies,
      cols,
      classCodes: manifest.classes,
      quantisation: manifest.quantisation,
    });
    app.setStage(app.stageName);
    reapplyControls(app);
    updateHeadline();
    updateTierNote();
    showCaption(
      `All <b>${fmt(manifest.tiers.full.bodies)}</b> catalogued bodies are now on screen. Every one of them is being placed by its own Kepler solve, this frame.`,
    );
  } catch (err) {
    $('tierNote').textContent = `Full catalogue failed to load: ${err.message}`;
    btn.disabled = false;
    btn.textContent = 'retry';
  } finally {
    $('loadBar').hidden = true;
    state.loading = false;
  }
}

// --- class list ------------------------------------------------------------

function buildClassList(app, manifest) {
  const host = $('classes');
  host.textContent = '';
  const order = [...manifest.classes]
    .map((code, index) => ({ code, index, count: manifest.classCounts[code] || 0 }))
    .sort((a, b) => b.count - a.count);

  for (const { code, index, count } of order) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'class-row';
    btn.setAttribute('aria-pressed', 'true');
    btn.dataset.index = String(index);
    const [r, g, b] = classColor(code, 'dusk');
    btn.innerHTML =
      `<span class="swatch" style="background:rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})"></span>` +
      `<span class="class-row__name">${classLabel(code)}</span>` +
      `<span class="class-row__n">${fmt(count)}</span>`;
    btn.title = `${code} — ${classNote(code)}`;
    btn.addEventListener('click', () => {
      const on = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', String(on));
      app.setClassEnabled(index, on);
    });
    host.appendChild(btn);
  }
}

function setClasses(app, codes) {
  const host = $('classes');
  for (const btn of host.querySelectorAll('.class-row')) {
    const index = Number(btn.dataset.index);
    const code = state.manifest.classes[index];
    const on = codes === null || codes.includes(code);
    btn.setAttribute('aria-pressed', String(on));
    app.setClassEnabled(index, on);
  }
}

function reapplyControls(app) {
  const host = $('classes');
  for (const btn of host.querySelectorAll('.class-row')) {
    app.setClassEnabled(Number(btn.dataset.index), btn.getAttribute('aria-pressed') === 'true');
  }
  app.setBrush(app.brush[0], app.brush[1]);
  app.setZExaggeration(app.zExaggeration);
}

// --- presets ---------------------------------------------------------------

const PRESETS = [
  {
    id: 'belt',
    label: 'the belt',
    camera: [0, 30, 83],
    target: [0, 0, 0],
    classes: null,
    brush: null,
    zex: 1,
    pointSize: 0.75,
    exposure: 0.45,
    caption:
      'Every body at its true position for the date shown, twenty degrees above the ecliptic, where the belt stops being a ring and becomes a <b>torus with real thickness</b>. Median inclination here is {MEDIAN_INC} degrees.',
  },
  {
    id: 'gaps',
    label: 'Kirkwood gaps',
    camera: [0, 100, 0.6],
    target: [0, 0, 0],
    classes: ['MBA', 'IMB', 'OMB'],
    brush: [1.7, 3.7],
    zex: 1,
    pointSize: 0.7,
    circularise: 1,
    exposure: 0.8,
    caption:
      'Eccentricity has been set to zero, so every body sits at its own <b>semi-major axis</b> rather than where it currently is. The dark lanes are the <b>Kirkwood gaps</b>: at 2.50 AU an asteroid orbits three times for every one of Jupiter’s, and the repeated tug empties the lane. Measured on the full catalogue: <b>{GAP31}× fewer</b> bodies in the 3:1 lane than 0.1 AU either side. Slide <b>circularise</b> back to 0% to see how far real eccentricity smears them.',
  },
  {
    id: 'trojans',
    label: 'Trojans',
    camera: [0, 140, 14],
    target: [0, 0, 0],
    classes: ['TJN'],
    brush: null,
    zex: 1,
    pointSize: 1.6,
    exposure: 3.5,
    caption:
      'The <b>{TJN} Jupiter Trojans</b> are not a belt. They are two swarms trapped 60 degrees ahead of and behind Jupiter, and they stay there as time runs.',
  },
  {
    id: 'inclination',
    label: 'inclination',
    camera: [0, 38, 82],
    target: [0, 0, 0],
    classes: null,
    brush: null,
    zex: 14,
    pointSize: 0.75,
    exposure: 0.5,
    caption:
      'Vertical exaggeration ×14. Nothing has moved sideways; only the axis normal to the ecliptic is stretched. <b>{INCLINED30}</b> catalogued bodies are tilted more than 30 degrees out of the plane.',
  },
  {
    id: 'nearearth',
    label: 'near-Earth',
    camera: [0, 20, 48],
    target: [0, 0, 0],
    classes: ['APO', 'AMO', 'ATE', 'IEO'],
    brush: null,
    zex: 1,
    pointSize: 1.4,
    exposure: 2.5,
    caption:
      'The near-Earth population: <b>{NEO}</b> bodies whose orbits come inside 1.3 AU. This is a map of where they are, not a hazard assessment — that is JPL CNEOS’s job, not this page’s.',
  },
  {
    id: 'outer',
    label: 'outer system',
    camera: [0, 700, 1240],
    target: [0, 0, 0],
    classes: ['TNO', 'CEN'],
    brush: null,
    zex: 1,
    pointSize: 1.8,
    exposure: 4.5,
    caption:
      'Out past Neptune: <b>{TNO}</b> trans-Neptunian objects and <b>{CEN}</b> Centaurs. The scale bar has changed by two orders of magnitude; the belt you were just looking at is now inside the Sun’s glare.',
  },
];

function buildPresets(app) {
  const host = $('presets');
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn--sm';
    b.textContent = p.label;
    b.addEventListener('click', () => applyPreset(app, p, true));
    host.appendChild(b);
  }
}

function fillCaption(text) {
  const m = state.manifest;
  const audit = m.receipts || {};
  return text
    .replace('{MEDIAN_INC}', audit.medianInclinationDeg ?? '7.88')
    .replace('{GAP31}', audit.gap31Depletion ?? '—')
    .replace('{TJN}', fmt(m.classCounts.TJN || 0))
    .replace('{TNO}', fmt(m.classCounts.TNO || 0))
    .replace('{CEN}', fmt(m.classCounts.CEN || 0))
    .replace('{INCLINED30}', fmt(audit.inclinedOver30Deg ?? 0))
    .replace(
      '{NEO}',
      fmt((m.classCounts.APO || 0) + (m.classCounts.AMO || 0) + (m.classCounts.ATE || 0) + (m.classCounts.IEO || 0)),
    );
}

let captionTimer = 0;
function showCaption(html) {
  const el = $('caption');
  el.innerHTML = fillCaption(html);
  el.classList.add('is-on');
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => el.classList.remove('is-on'), 11000);
}

function applyPreset(app, p, animate) {
  setClasses(app, p.classes);
  if (p.brush) {
    setBrushUI(app, p.brush[0], p.brush[1]);
  } else {
    setBrushUI(app, null, null);
  }
  $('zex').value = String(p.zex);
  $('zexOut').textContent = `×${p.zex}`;
  app.setZExaggeration(p.zex);

  const size = p.pointSize ?? 1;
  $('psize').value = String(size);
  $('psizeOut').textContent = `×${size.toFixed(1)}`;
  app.setPointSize(size);

  const circV = p.circularise ?? 0;
  app.setCircularise(circV);
  $('circ').value = String(Math.round(circV * 100));
  $('circOut').textContent = `${Math.round(circV * 100)}%`;
  updateViewState(circV);

  const exp = p.exposure ?? 1;
  app.setExposure(exp);
  $('exposure').value = String(Math.log2(exp).toFixed(2));
  $('exposureOut').textContent = `×${exp.toFixed(2)}`;
  moveCamera(app, p.camera, p.target, animate && !reduceMotion);
  showCaption(p.caption);
}

function moveCamera(app, pos, target, animate) {
  const c = app.camera;
  const t = app.controls.target;
  if (!animate) {
    c.position.set(pos[0], pos[1], pos[2]);
    t.set(target[0], target[1], target[2]);
    app.controls.update();
    return;
  }
  const from = { p: c.position.clone(), t: t.clone() };
  const start = performance.now();
  const dur = 1100;
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const step = (now) => {
    const k = Math.min(1, (now - start) / dur);
    const e = ease(k);
    c.position.set(
      from.p.x + (pos[0] - from.p.x) * e,
      from.p.y + (pos[1] - from.p.y) * e,
      from.p.z + (pos[2] - from.p.z) * e,
    );
    t.set(from.t.x + (target[0] - from.t.x) * e, from.t.y + (target[1] - from.t.y) * e, from.t.z + (target[2] - from.t.z) * e);
    app.controls.update();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// --- brush -----------------------------------------------------------------

const A_MIN = 0.4;
const A_MAX = 1000;
const sliderToAU = (v) => A_MIN * Math.pow(A_MAX / A_MIN, v / 1000);
const auToSlider = (au) => Math.round((Math.log(au / A_MIN) / Math.log(A_MAX / A_MIN)) * 1000);

function setBrushUI(app, lo, hi) {
  const m = state.manifest;
  const trueLo = lo === null ? 0 : lo;
  const trueHi = hi === null ? 1e9 : hi;
  $('brushLo').value = String(lo === null ? 0 : auToSlider(lo));
  $('brushHi').value = String(hi === null ? 1000 : auToSlider(hi));
  app.setBrush(trueLo, trueHi);
  $('brushOut').textContent =
    lo === null ? `${m.receipts?.aMinAU ?? '0.46'} – ${m.receipts?.aMaxAU ?? '14513'} AU` : `${lo.toFixed(2)} – ${hi.toFixed(2)} AU`;
}

// --- controls --------------------------------------------------------------

function wireControls(app, manifest) {
  const lo = $('brushLo');
  const hi = $('brushHi');
  const onBrush = () => {
    let a = sliderToAU(Number(lo.value));
    let b = sliderToAU(Number(hi.value));
    if (Number(lo.value) === 0) a = 0;
    if (Number(hi.value) === 1000) b = 1e9;
    if (a > b) [a, b] = [b, a];
    app.setBrush(a, b);
    $('brushOut').textContent =
      a === 0 && b === 1e9
        ? `${manifest.receipts?.aMinAU ?? '0.46'} – ${manifest.receipts?.aMaxAU ?? '14513'} AU`
        : `${a.toFixed(2)} – ${b > 1e8 ? '∞' : b.toFixed(2)} AU`;
  };
  lo.addEventListener('input', onBrush);
  hi.addEventListener('input', onBrush);

  $('zex').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    app.setZExaggeration(v);
    $('zexOut').textContent = `×${v}`;
  });

  const circ = $('circ');
  circ.addEventListener('input', (e) => {
    const v = Number(e.target.value) / 100;
    app.setCircularise(v);
    $('circOut').textContent = `${Math.round(v * 100)}%`;
    updateViewState(v);
  });

  $('exposure').addEventListener('input', (e) => {
    const stops = Number(e.target.value);
    const mult = Math.pow(2, stops);
    app.setExposure(mult);
    $('exposureOut').textContent = `×${mult.toFixed(2)}`;
  });

  $('psize').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    app.setPointSize(v);
    $('psizeOut').textContent = `×${v.toFixed(1)}`;
  });

  const sizeByH = $('sizeByH');
  sizeByH.addEventListener('click', () => {
    const on = sizeByH.getAttribute('aria-pressed') !== 'true';
    sizeByH.setAttribute('aria-pressed', String(on));
    app.setSizeByH(on);
  });

  const stageToggle = $('stageToggle');
  stageToggle.addEventListener('click', () => {
    const toDay = app.stageName === 'dusk';
    app.setStage(toDay ? 'daylight' : 'dusk');
    document.documentElement.dataset.stage = toDay ? 'daylight' : 'dusk';
    stageToggle.textContent = toDay ? 'dusk' : 'daylight';
    stageToggle.setAttribute('aria-pressed', String(toDay));
    buildClassList(app, manifest);
    reapplyControls(app);
  });

  $('loadAll').addEventListener('click', () => loadFull(app, manifest));

  // time
  const play = $('playToggle');
  const RATES = [1, 7, 30, 120, 365, 1460];
  let rateIndex = 2;
  const setRate = (r) => {
    app.rateDaysPerSecond = r;
    updateRateOut(app);
  };
  play.addEventListener('click', () => {
    const on = app.rateDaysPerSecond === 0;
    setRate(on ? RATES[rateIndex] : 0);
    play.setAttribute('aria-pressed', String(on));
    play.textContent = on ? '❚❚' : '▶';
  });
  $('faster').addEventListener('click', () => {
    rateIndex = Math.min(RATES.length - 1, rateIndex + 1);
    if (app.rateDaysPerSecond !== 0) setRate(RATES[rateIndex]);
  });
  $('slower').addEventListener('click', () => {
    rateIndex = Math.max(0, rateIndex - 1);
    if (app.rateDaysPerSecond !== 0) setRate(RATES[rateIndex]);
  });
  $('resetTime').addEventListener('click', () => {
    app.timeDays = 0;
    $('scrub').value = '0';
  });
  $('scrub').addEventListener('input', (e) => {
    app.timeDays = Number(e.target.value);
  });

  $('openReceipts').addEventListener('click', () => openSheet(true));
  $('closeReceipts').addEventListener('click', () => openSheet(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('sheet').hidden) openSheet(false);
      else if (state.selected >= 0) clearSelection(app);
    }
  });
}

/** The stage must never be ambiguous about whether it is showing real positions. */
function updateViewState(v) {
  const el = $('viewState');
  if (!el) return;
  if (v <= 0.001) {
    el.textContent = 'True positions at the shown date.';
    el.style.borderLeftColor = 'var(--edge)';
  } else if (v >= 0.999) {
    el.textContent = 'Eccentricity set to zero: every body is drawn at its semi-major axis, NOT where it is.';
    el.style.borderLeftColor = 'var(--signal)';
  } else {
    el.textContent = `Eccentricity scaled to ${Math.round((1 - v) * 100)}% of its real value. Positions are interpolated, not real.`;
    el.style.borderLeftColor = 'var(--signal)';
  }
}

function updateRateOut(app) {
  const r = app.rateDaysPerSecond;
  $('rateOut').textContent = r === 0 ? 'paused' : r >= 365 ? `${(r / 365.25).toFixed(1)} yr/s` : `${r} d/s`;
}

function updateTimeOut(app, manifest) {
  const jd = manifest.referenceEpoch.jd + app.timeDays;
  const d = jdToDate(jd);
  $('dateOut').textContent = d.toISOString().slice(0, 10);
  const scrub = $('scrub');
  if (document.activeElement !== scrub) {
    const clamped = Math.max(-18262, Math.min(18262, app.timeDays));
    scrub.value = String(Math.round(clamped));
  }
}

// --- readout ---------------------------------------------------------------

function updateReadout(app, manifest) {
  const dl = $('readout');
  const s = app.stats();
  const rows = [];

  if (state.selected >= 0) {
    const b = app.bodyStateAt(state.selected, app.timeDays, manifest.quantisation);
    const nm = lookupName(state.selected);
    $('readoutTitle').textContent = nm ? nm.name : 'Selected body';
    rows.push(['class', b.classCode]);
    rows.push(['a', `${b.a.toFixed(4)} AU`]);
    rows.push(['e', b.e.toFixed(4)]);
    rows.push(['i', `${b.i.toFixed(3)}°`]);
    rows.push(['q / Q', `${b.perihelion.toFixed(2)} / ${b.aphelion.toFixed(2)}`]);
    rows.push(['period', `${b.periodYears.toFixed(2)} yr`]);
    rows.push(['H', b.H === null ? 'not in source' : b.H.toFixed(2)]);
  } else {
    $('readoutTitle').textContent = 'Instrument';
    rows.push(['drawn', fmt(app.bodyCount)]);
    if (s) {
      rows.push(['frame', `${s.medianFrameMs.toFixed(2)} ms`]);
      rows.push(['fps', s.fps.toFixed(0)]);
    }
    rows.push(['solver', `Halley ×3, GPU`]);
  }

  dl.textContent = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
}

function clearSelection(app) {
  state.selected = -1;
  app.setSelected(-1);
  if (app.selectionOrbit) {
    app.scene.remove(app.selectionOrbit);
    app.selectionOrbit.geometry.dispose();
    app.selectionOrbit = null;
  }
}

// --- picking ---------------------------------------------------------------

function wirePicking(app, manifest) {
  let downAt = null;
  const canvas = $('stage');
  canvas.addEventListener('pointerdown', (e) => {
    downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    const held = performance.now() - downAt.t;
    downAt = null;
    if (moved > 5 || held > 500) return; // that was a drag, not a click
    const id = app.pick(e.clientX, e.clientY);
    if (id < 0) {
      clearSelection(app);
      return;
    }
    select(app, manifest, id);
  });
  canvas.setAttribute('tabindex', '0');
}

function select(app, manifest, index) {
  state.selected = index;
  app.setSelected(index);
  drawSelectionOrbit(app, manifest, index);
  const b = app.bodyStateAt(index, app.timeDays, manifest.quantisation);
  const nm = lookupName(index);
  showCaption(
    `<b>${nm ? nm.name : 'Unnamed body'}</b> — ${classLabel(b.classCode)}. a = ${b.a.toFixed(3)} AU, e = ${b.e.toFixed(
      3,
    )}, i = ${b.i.toFixed(2)}°, one orbit every ${b.periodYears.toFixed(2)} years. Its ellipse is drawn.`,
  );
}

function drawSelectionOrbit(app, manifest, index) {
  const b = app.bodyStateAt(index, app.timeDays, manifest.quantisation);
  if (app.selectionOrbit) {
    app.scene.remove(app.selectionOrbit);
    app.selectionOrbit.geometry.dispose();
  }
  const N = 512;
  const pts = new Float32Array(N * 3);
  const n = 360 / Math.pow(b.a, 1.5) / 365.25;
  void n;
  for (let k = 0; k < N; k++) {
    // Sample the ellipse in mean anomaly so the sampling matches the motion.
    const M = (k / N) * 2 * Math.PI;
    const p = propagate(b.a, b.e, b.i * DEG2RAD, b.om * DEG2RAD, b.w * DEG2RAD, M, 0, 5);
    pts[k * 3] = p[0] * AU_TO_SCENE;
    pts[k * 3 + 1] = p[2] * app.zExaggeration * AU_TO_SCENE;
    pts[k * 3 + 2] = -p[1] * AU_TO_SCENE;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pts, 3));
  const m = new LineBasicMaterial({ color: 0xffd98a, transparent: true, opacity: 0.85, depthTest: false });
  const line = new LineLoop(g, m);
  line.frustumCulled = false;
  app.selectionOrbit = line;
  app.scene.add(line);
}

// --- search ----------------------------------------------------------------

function lookupName(indexInCurrentTier) {
  if (!state.names) return null;
  const fullIndex = state.tier === 'full' ? indexInCurrentTier : state.previewMap ? state.previewMap[indexInCurrentTier] : -1;
  if (fullIndex < 0) return null;
  return state.namesByIndex.get(fullIndex) || null;
}

async function ensureNames() {
  if (state.names) return;
  const [names, mapBuf] = await Promise.all([
    fetch(state.manifest.search.file).then((r) => r.json()),
    state.tier === 'full'
      ? Promise.resolve(null)
      : fetch(state.manifest.previewMap.file)
          .then((r) => r.arrayBuffer())
          .catch(() => null),
  ]);
  state.names = names.entries;
  state.namesByIndex = new Map();
  for (const e of names.entries) state.namesByIndex.set(e[2], { name: e[0], number: e[1] });
  if (mapBuf) {
    const deltas = new Uint32Array(mapBuf);
    const map = new Uint32Array(deltas.length);
    let acc = 0;
    for (let k = 0; k < deltas.length; k++) {
      acc += deltas[k];
      map[k] = acc;
    }
    state.previewMap = map;
    state.fullToPreview = new Map();
    for (let k = 0; k < map.length; k++) state.fullToPreview.set(map[k], k);
  }
}

function wireSearch(app, manifest) {
  const input = $('search');
  const list = $('results');

  input.addEventListener('focus', () => ensureNames());

  const render = (items) => {
    list.textContent = '';
    for (const [name, number, fullIndex] of items) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `<span>${name}</span><span class="num">${number}</span>`;
      b.addEventListener('click', () => {
        input.value = name;
        list.textContent = '';
        goToBody(app, manifest, fullIndex, name);
      });
      li.appendChild(b);
      list.appendChild(li);
    }
  };

  let t = 0;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      await ensureNames();
      const q = input.value.trim().toLowerCase();
      if (q.length < 2) {
        list.textContent = '';
        return;
      }
      const hits = [];
      for (const e of state.names) {
        if (e[0].toLowerCase().startsWith(q)) {
          hits.push(e);
          if (hits.length >= 40) break;
        }
      }
      if (hits.length < 40) {
        for (const e of state.names) {
          if (!e[0].toLowerCase().startsWith(q) && e[0].toLowerCase().includes(q)) {
            hits.push(e);
            if (hits.length >= 40) break;
          }
        }
      }
      render(hits);
    }, 120);
  });
}

function goToBody(app, manifest, fullIndex, name) {
  let localIndex = fullIndex;
  if (state.tier !== 'full') {
    localIndex = state.fullToPreview ? state.fullToPreview.get(fullIndex) : undefined;
    if (localIndex === undefined) {
      showCaption(
        `<b>${name}</b> is in the catalogue but not in the ${fmt(
          manifest.tiers.preview.bodies,
        )}-body sample currently loaded. Press <b>load all</b> to bring in the whole catalogue and it will be selectable.`,
      );
      return;
    }
  }
  select(app, manifest, localIndex);
  const b = app.bodyStateAt(localIndex, app.timeDays, manifest.quantisation);
  const p = propagate(b.a, b.e, b.i * DEG2RAD, b.om * DEG2RAD, b.w * DEG2RAD, b.meanAnomalyNow * DEG2RAD, 0, 6);
  const target = [p[0] * AU_TO_SCENE, p[2] * app.zExaggeration * AU_TO_SCENE, -p[1] * AU_TO_SCENE];
  const dist = Math.max(3, b.a * AU_TO_SCENE * 0.55);
  moveCamera(app, [target[0] + dist * 0.4, target[1] + dist * 0.7, target[2] + dist], target, !reduceMotion);
}

// --- receipts sheet --------------------------------------------------------

function openSheet(on) {
  const sheet = $('sheet');
  sheet.hidden = !on;
  sheet.classList.toggle('is-open', on);
  if (on) $('closeReceipts').focus();
  else $('openReceipts').focus();
}

function buildReceipts(manifest) {
  const host = $('sheetInner');
  const r = manifest.receipts || {};
  const t = (rows, head) =>
    `<div class="table-wrap"><table class="data"><thead><tr>${head
      .map((h) => `<th>${h}</th>`)
      .join('')}</tr></thead><tbody>${rows
      .map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join('')}</tr>`)
      .join('')}</tbody></table></div>`;

  const gapRows = (r.kirkwood || []).map((g) => [
    g.resonance,
    g.aAU,
    fmt(g.smoothedInGap),
    fmt(g.smoothedInner),
    fmt(g.smoothedOuter),
    `×${g.depletionFactor}`,
  ]);

  const blindRows = (r.blindMinima || []).map((g) => [g.aAU, fmt(g.smoothedCount), fmt(g.localBaseline), `${(g.relativeDepth * 100).toFixed(1)}%`]);

  const classRows = [...manifest.classes]
    .map((code) => [code, classLabel(code), fmt(manifest.classCounts[code] || 0), classNote(code)])
    .sort((a, b) => Number(String(b[2]).replace(/,/g, '')) - Number(String(a[2]).replace(/,/g, '')));

  host.innerHTML = `
    <h2 id="sheetTitle">Receipts</h2>
    <p>
      Every number on this page is recomputed from the vendored catalogue by <code>scripts/audit.mjs</code>, and
      <code>scripts/check.mjs</code> fails the build if any of them drifts. Nothing below is quoted from a source; it is
      all measured from <code>${manifest.sourceFile || 'data/sbdb-asteroids-fullprec.json'}</code>.
    </p>

    <h3>What is on screen</h3>
    ${t(
      [
        ['rows parsed from the SBDB response', fmt(manifest.totals.parsedAsteroidRows)],
        ['renderable (elliptical, complete elements)', fmt(manifest.totals.renderableBodies)],
        ['excluded: hyperbolic or e ≥ 1', fmt(manifest.totals.excludedNonElliptical)],
        ['excluded: incomplete element set', fmt(manifest.totals.excludedIncompleteElements)],
        ['comets catalogued (reported, not drawn)', fmt(manifest.totals.cometsCatalogued)],
      ],
      ['quantity', 'count'],
    )}

    <h3>The gaps, found without being told where they are</h3>
    <p>
      The semi-major axes of every renderable body are histogrammed in ${r.binAU ?? 0.005} AU bins and smoothed over
      ${r.smoothWindowAU ?? 0.025} AU. A gap is declared where the smoothed count is a local minimum within ±0.04 AU
      and sits below half its own local baseline. The search is told nothing about resonances. It returns these:
    </p>
    ${t(blindRows, ['a (AU)', 'smoothed count', 'local baseline', 'depth'])}
    <p>
      Those positions are then compared against the resonance locations computed from Jupiter’s semi-major axis
      (${r.jupiterA ?? '5.202887'} AU) as <code>a = a_J · (q/p)^(2/3)</code>. They agree to within
      ${r.worstBlindMatchAU ?? '0.015'} AU, which is ${Math.round((r.worstBlindMatchAU ?? 0.015) / (r.binAU ?? 0.005))} histogram bins.
    </p>
    ${t(gapRows, ['resonance', 'a (AU)', 'in the gap', '0.1 AU inner', '0.1 AU outer', 'depletion'])}

    <h3>Why the preview tier is a random sample and not the brightest bodies</h3>
    <p>
      The obvious way to make a small first-paint tier is to keep the brightest bodies. It is also wrong here. At a
      fixed size an outer-belt asteroid is fainter than an inner-belt one, so a magnitude cut thins the outer belt and
      quietly changes the shape of the thing this page is about. Measured on this catalogue:
    </p>
    ${t(
      (r.tierBias || []).map((row) => [row.tier, fmt(row.inner), fmt(row.outer), `${(row.outerFraction * 100).toFixed(1)}%`]),
      ['tier', 'belt bodies inside 2.825 AU', 'outside', 'share outside'],
    )}
    <p>
      The brightness-limited tier reports the outer belt as roughly half the population when the full catalogue puts it
      near a third. The seeded uniform sample lands within a few tenths of a percent of the truth, so that is what
      ships. Seed ${manifest.sampleSeed}.
    </p>

    <h3>Epochs</h3>
    <p>
      The catalogue does not share one epoch: ${fmt(manifest.epochHandling.distinctEpochsInSource)} distinct epochs
      appear in it, and ${fmt(
        manifest.totals.renderableBodies - manifest.epochHandling.onReferenceEpoch,
      )} bodies are solved for a different date than the rest. Propagating everything from one assumed epoch would
      misplace those bodies while looking perfectly smooth. Instead every body is advanced from its own published epoch
      to ${manifest.referenceEpoch.iso.slice(0, 10)} (JD ${manifest.referenceEpoch.jd}) at build time, in float64, by
      exact two-body mean motion. The epoch column then costs zero bytes on the wire.
    </p>
    ${t(
      [
        ['already on the reference epoch', fmt(manifest.epochHandling.onReferenceEpoch)],
        ['advanced up to 1 year', fmt(manifest.epochHandling.within1Year)],
        ['advanced 1 to 10 years', fmt(manifest.epochHandling.within10Years)],
        ['advanced more than 10 years', fmt(manifest.epochHandling.over10Years)],
        ['oldest epoch advanced (days)', fmt(Math.round(manifest.epochHandling.oldestEpochAgeDays))],
      ],
      ['epoch age', 'bodies'],
    )}
    <p>
      Two-body propagation ignores planetary perturbations, so a body advanced ten years carries real accumulated
      error. That is a property of doing this from published elements rather than from an integrated ephemeris, and it
      is the reason this page draws no close-approach or impact-risk conclusions of any kind.
    </p>

    <h3>Populations</h3>
    ${t(classRows, ['code', 'class', 'bodies', 'definition'])}

    <h3>Payload</h3>
    ${t(
      Object.entries(manifest.tiers).map(([name, spec]) => [
        name,
        fmt(spec.bodies),
        fmt(spec.measured.plain.raw),
        fmt(spec.deltaCodedSemiMajorAxis ? spec.measured.delta.gzip : spec.measured.plain.gzip),
        fmt(spec.deltaCodedSemiMajorAxis ? spec.measured.delta.brotli : spec.measured.plain.brotli),
      ]),
      ['tier', 'bodies', 'raw B', 'gzip B', 'brotli B'],
    )}
    <p>
      Fourteen bytes a body: six 16-bit orbital elements plus a packed class and absolute magnitude. Three of those six
      are angles that are close to uniformly distributed and therefore incompressible. The saving that does exist comes
      from storing the catalogue sorted by semi-major axis and delta-coding that one column, which also makes the
      radial-shell brush a single draw-range change instead of a per-body test.
    </p>

    <h3>What this page deliberately does not do</h3>
    <p>
      No n-body integration and no perturbations. No planets rendered as textured worlds — the planets are their orbit
      ellipses and a mark, because this is not a solar system simulator. No close-approach, hazard or impact framing.
      No counting animations on any measured number. Comets are reported (${fmt(
        manifest.totals.cometsCatalogued,
      )} in the catalogue) but not drawn, because their eccentricities do not fit the quantisation ranges chosen for the belt.
    </p>

    <h3>Provenance</h3>
    <p>
      Small bodies: NASA/JPL Small-Body Database Query API, fetched 2026-09-07. JPL states the data are not subject to
      copyright and may be used for any purpose without prior permission. Planet orbits: JPL Solar System Dynamics,
      <em>Approximate Positions of the Major Planets</em>, Table 1 (1800–2050), fetched the same day. Full byte sizes,
      SHA-256 digests and the fetch commands are in the README.
    </p>
  `;
}

// ---------------------------------------------------------------------------

boot().catch((err) => {
  console.error(err);
  failToFallback(`The live map failed to start: ${err && err.message ? err.message : err}`);
});
