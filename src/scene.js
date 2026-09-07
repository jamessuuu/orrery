// scene.js — the WebGL2 stage.
//
// Imports from three are named and narrow on purpose: a namespace import costs
// 189 KB gzip, most of it geometry and material classes this project never
// touches. scripts/measure-bundle.mjs prints what the real cost turned out to be.

import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  BufferGeometry,
  BufferAttribute,
  Points,
  Line,
  LineLoop,
  RawShaderMaterial,
  Color,
  Vector3,
  AdditiveBlending,
  NormalBlending,
  Sprite,
  SpriteMaterial,
  CanvasTexture,
  WebGLRenderTarget,
  NearestFilter,
  LinearFilter,
  HalfFloatType,
  FloatType,
  UnsignedByteType,
  RGBAFormat,
  OrthographicCamera,
  Mesh,
  Sphere,
  GLSL3,
  MathUtils,
  SRGBColorSpace,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  BODY_VERTEX,
  BODY_FRAGMENT,
  ORBIT_VERTEX,
  ORBIT_FRAGMENT,
  COMPOSITE_VERTEX,
  COMPOSITE_FRAGMENT,
  PROBE_VERTEX,
  PROBE_FRAGMENT,
} from './shaders.js';
import { STAGE, classColor, EXPOSURE_REFERENCE_BODIES } from './palette.js';
import { K_GAUSS, DEG2RAD, solveKepler } from './kepler.js';

export const AU_TO_SCENE = 10; // 1 AU = 10 scene units

function summarise(ms, method, drawnBodies) {
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    samples: sorted.length,
    medianMs: Number(at(0.5).toFixed(4)),
    p95Ms: Number(at(0.95).toFixed(4)),
    minMs: Number(sorted[0].toFixed(4)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(4)),
    impliedFps: Number((1000 / at(0.5)).toFixed(1)),
    method,
    drawnBodies,
  };
}

const MAX_CLASSES = 16;

// Scene-referred gains for the two things in this frame that are genuinely
// brighter than diffuse white: the Sun, and the planet marks. Measured, not
// guessed — see docs/render-ablation.json.
const SUN_HDR_GAIN = 7.0;
const MARK_HDR_GAIN = 1.7;

/** Tone curve ids, mirrored in COMPOSITE_FRAGMENT's uTone branch. */
export const TONE_ID = { exp: 0, agx: 1, neutral: 2, none: 3 };

export class Orrery {
  constructor(canvas, opts = {}) {
    // Render pipeline options. Defaults are the shipped configuration; the
    // ablation harness overrides them from the URL so every claim about them is
    // a measurement of this exact code rather than a second implementation.
    this.tone = opts.tone ?? 'neutral';
    this.encodeSRGB = opts.encode !== false;
    this.blackPoint = opts.black ?? 0;
    // Density contrast. 1.8 measured, not chosen: at 1.8 the rendered 4:1, 3:1
    // and 7:3 lanes are all DEEPER than the pipeline this replaced, while the
    // frame keeps a true black point. See docs/render-ablation.json.
    this.gamma = opts.gamma ?? 1.8;
    this.exposureOverride = opts.exposure ?? null;
    this.canvas = canvas;
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new Scene();
    this.camera = new PerspectiveCamera(48, 1, 0.4, 40000);
    this.camera.position.set(0, 26, 46);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 12000;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.9;

    this.stageName = 'dusk';
    this.timeDays = 0;
    this.rateDaysPerSecond = 0;
    this.zExaggeration = 1;
    this.selected = -1;
    this.bodies = null;
    this.classCodes = [];
    this.classOn = new Float32Array(MAX_CLASSES).fill(1);
    this.classColors = new Float32Array(MAX_CLASSES * 3);
    this.brush = [0, 1e9];
    this.exposureMult = 1;
    this.circularise = 0;
    this.planetLines = [];
    this.planetMarks = [];
    this.frameTimes = [];
    this.cpuTimes = [];
    this._syncPixel = new Uint8Array(4);
    this._pendingQueries = [];
    this._collectTimings = false;
    this._lastFrameTs = undefined;
    this._lastRenderMs = 0;
    this._raf = 0;
    this._onFrame = null;

    this.setupComposite();
    this.resize();
  }

  /**
   * Density is accumulated into a float buffer and tone-mapped in a second
   * pass. Without this the belt clips to a primary colour and the gaps
   * disappear into a flat wash.
   */
  setupComposite() {
    const gl = this.renderer.getContext();
    const floatOk = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    this.hdrAvailable = floatOk;

    this.hdrTarget = new WebGLRenderTarget(2, 2, {
      type: floatOk ? HalfFloatType : UnsignedByteType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });

    const geom = new BufferGeometry();
    geom.setAttribute('aPos', new BufferAttribute(new Float32Array([-1, -1, 3, -1, -1, 3]), 2));
    // Without a `position` attribute three has nothing to infer a draw count
    // from, and geometry.drawRange.count defaults to Infinity, so the draw is
    // skipped entirely and the pass renders black. Say the count explicitly.
    geom.setDrawRange(0, 3);
    geom.boundingSphere = new Sphere(new Vector3(0, 0, 0), Infinity);
    geom.computeBoundingSphere = () => {};

    this.compositeMaterial = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: COMPOSITE_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uScene: { value: this.hdrTarget.texture },
        uBackground: { value: new Vector3(0, 0, 0) },
        uExposure: { value: 1 },
        uDarkOnLight: { value: 0 },
        uTone: { value: TONE_ID[this.tone] ?? TONE_ID.neutral },
        uBlack: { value: 0 },
        uEncode: { value: this.encodeSRGB ? 1 : 0 },
        uGamma: { value: this.gamma },
      },
    });
    this.compositeScene = new Scene();
    const quad = new Mesh(geom, this.compositeMaterial);
    quad.frustumCulled = false;
    this.compositeScene.add(quad);
    this.compositeCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  static hasWebGL2() {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') && window.WebGL2RenderingContext);
    } catch {
      return false;
    }
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    if (this.hdrTarget) {
      const dpr = this.renderer.getPixelRatio();
      this.hdrTarget.setSize(Math.max(2, Math.round(w * dpr)), Math.max(2, Math.round(h * dpr)));
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._pointScale = h * 0.5 / Math.tan(MathUtils.degToRad(this.camera.fov) * 0.5);
    if (this.material) this.material.uniforms.uPointScale.value = this._pointScale;
  }

  setStage(name) {
    this.stageName = name;
    const s = STAGE[name];
    // The stage colour is applied in the composite pass; the HDR buffer itself
    // always starts from zero light.
    this.renderer.setClearColor(0x000000, 1);
    if (this.compositeMaterial) {
      const c = new Color(s.clear);
      this.compositeMaterial.uniforms.uBackground.value.set(c.r, c.g, c.b);
      this.compositeMaterial.uniforms.uDarkOnLight.value = s.additive ? 0 : 1;
      // Exposure is a per-stage, per-curve decision, not a constant. The legacy
      // exponential curve was tuned against a pass that skipped the sRGB encode,
      // so it needs its old numbers; AgX and Neutral are tuned against the
      // corrected pass and sit lower because the encode lifts the mid-tones.
      const legacy = this.tone === 'exp' || this.tone === 'none';
      const exposure = this.exposureOverride ?? (legacy
        ? (s.additive ? 1.0 : 1.35)
        : (s.additive ? s.exposure : s.exposureDark));
      this.compositeMaterial.uniforms.uExposure.value = exposure;
      this.compositeMaterial.uniforms.uBlack.value = legacy ? 0 : this.blackPoint;
      this.compositeMaterial.uniforms.uTone.value = TONE_ID[this.tone] ?? TONE_ID.neutral;
      this.compositeMaterial.uniforms.uEncode.value = this.encodeSRGB ? 1 : 0;
      this.compositeMaterial.uniforms.uGamma.value = legacy ? 1.0 : this.gamma;
    }
    if (this.sun) this.sun.intensity = s.additive ? 1 : 0.85;
    if (this.material) {
      this.material.blending = s.additive ? AdditiveBlending : NormalBlending;
      this.material.uniforms.uDarkOnLight.value = s.additive ? 0 : 1;
      this.material.needsUpdate = true;
      this.applyExposure();
      this.applyClassColors();
    }
    for (const l of this.planetLines) {
      l.material.uniforms.uColor.value.set(...s.orbit);
      l.material.uniforms.uOpacity.value = s.orbitOpacity;
    }
    if (this.sunSprite) this.sunSprite.material.color.setRGB(...s.sun).multiplyScalar(SUN_HDR_GAIN);
  }

  /**
   * Per-point alpha, scaled so that peak density lands near saturation at any
   * tier size. Without this the full catalogue renders as a featureless white
   * annulus and every gap disappears.
   */
  applyExposure() {
    if (!this.material) return;
    const s = STAGE[this.stageName];
    const scaled = s.bodyOpacity * (EXPOSURE_REFERENCE_BODIES / Math.max(1, this.bodyCount));
    this.material.uniforms.uOpacity.value = Math.min(0.9, Math.max(0.0012, scaled * this.exposureMult));
  }

  setExposure(mult) {
    this.exposureMult = mult;
    this.applyExposure();
  }

  applyClassColors() {
    this.classCodes.forEach((code, idx) => {
      if (idx >= MAX_CLASSES) return;
      const [r, g, b] = classColor(code, this.stageName);
      this.classColors[idx * 3] = r;
      this.classColors[idx * 3 + 1] = g;
      this.classColors[idx * 3 + 2] = b;
    });
    if (this.material) this.material.uniformsNeedUpdate = true;
  }

  /**
   * Install a tier. `cols` are zero-copy Uint16Array views over the fetched
   * buffer, in the order written by scripts/pack.mjs.
   */
  setBodies({ count, cols, classCodes, quantisation }) {
    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
    }
    this.classCodes = classCodes;
    this.applyClassColors();

    const geom = new BufferGeometry();
    const names = ['aQ', 'eQ', 'iQ', 'omQ', 'wQ', 'mQ', 'hcQ'];
    names.forEach((name, k) => {
      const attr = new BufferAttribute(cols[k], 1);
      attr.gpuType = undefined;
      geom.setAttribute(name, attr);
    });
    geom.setDrawRange(0, count);
    // These geometries have no `position` attribute at all: positions are
    // produced in the vertex shader. three's render-list sort still reads
    // geometry.boundingSphere.center, so hand it an explicit unbounded sphere
    // rather than null, and stop it trying to derive one from attributes that
    // are not coordinates.
    geom.boundingSphere = new Sphere(new Vector3(0, 0, 0), Infinity);
    geom.computeBoundingSphere = () => {};

    const s = STAGE[this.stageName];
    const q = quantisation;
    const logAMin = Math.log(q.semiMajorAxis.minAU);
    const logASpan = Math.log(q.semiMajorAxis.maxAU) - logAMin;

    this.material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: BODY_VERTEX,
      fragmentShader: BODY_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: s.additive ? AdditiveBlending : NormalBlending,
      uniforms: {
        uTimeDays: { value: 0 },
        uLogAMin: { value: logAMin },
        uLogASpan: { value: logASpan },
        uAuToScene: { value: AU_TO_SCENE },
        uPointScale: { value: this._pointScale },
        uSizeBase: { value: 1.0 },
        uSizeByH: { value: 0 },
        uZExaggeration: { value: this.zExaggeration },
        uOpacity: { value: s.bodyOpacity },
        uClassOn: { value: this.classOn },
        uClassColor: { value: this.classColors },
        uBrushLo: { value: this.brush[0] },
        uBrushHi: { value: this.brush[1] },
        uSelected: { value: -1 },
        uHiPass: { value: 0 },
        uPicking: { value: 0 },
        uCircularise: { value: this.circularise },
        uDarkOnLight: { value: s.additive ? 0 : 1 },
      },
    });

    this.points = new Points(geom, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this.bodies = { count, cols };
    this.bodyCount = count;
    this.applyExposure();
  }

  setClassEnabled(index, on) {
    this.classOn[index] = on ? 1 : 0;
    if (this.material) this.material.uniformsNeedUpdate = true;
  }

  setBrush(lo, hi) {
    this.brush = [lo, hi];
    if (this.material) {
      this.material.uniforms.uBrushLo.value = lo;
      this.material.uniforms.uBrushHi.value = hi;
    }
  }

  setZExaggeration(v) {
    this.zExaggeration = v;
    if (this.material) this.material.uniforms.uZExaggeration.value = v;
    for (const l of this.planetLines) l.material.uniforms.uZExaggeration.value = v;
    for (const m of this.planetMarks) m.userData.zExaggeration = v;
  }

  setSizeByH(on) {
    if (this.material) this.material.uniforms.uSizeByH.value = on ? 1 : 0;
  }

  setCircularise(v) {
    this.circularise = v;
    if (this.material) this.material.uniforms.uCircularise.value = v;
  }

  setPointSize(v) {
    if (this.material) this.material.uniforms.uSizeBase.value = v;
  }

  setSelected(index) {
    this.selected = index;
    if (this.material) {
      this.material.uniforms.uSelected.value = index;
      this.material.uniforms.uHiPass.value = index >= 0 ? 1 : 0;
    }
  }

  // --- planets -------------------------------------------------------------

  addPlanets(planetData, refEpochJD) {
    this.planetData = planetData;
    const s = STAGE[this.stageName];
    for (const p of planetData.planets) {
      const el = this.elementsAt(p, refEpochJD);
      const N = 512;
      const angles = new Float32Array(N);
      for (let k = 0; k < N; k++) angles[k] = k / N;
      const geom = new BufferGeometry();
      geom.setAttribute('vAngle', new BufferAttribute(angles, 1));
      geom.setDrawRange(0, N); // same reason as the composite quad above
      geom.boundingSphere = new Sphere(new Vector3(0, 0, 0), Infinity);
      geom.computeBoundingSphere = () => {};

      const mat = new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: ORBIT_VERTEX,
        fragmentShader: ORBIT_FRAGMENT,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          uA: { value: el.a },
          uE: { value: el.e },
          uI: { value: el.i },
          uOm: { value: el.om },
          uW: { value: el.w },
          uAuToScene: { value: AU_TO_SCENE },
          uZExaggeration: { value: this.zExaggeration },
          uColor: { value: new Vector3(...s.orbit) },
          uOpacity: { value: s.orbitOpacity },
        },
      });
      const line = new LineLoop(geom, mat);
      line.frustumCulled = false;
      line.userData.planet = p.name;
      this.scene.add(line);
      this.planetLines.push(line);

      const mark = this.makeMark(p.name);
      mark.userData.planet = p;
      this.scene.add(mark);
      this.planetMarks.push(mark);
    }
    this.sunSprite = this.makeMark('Sun', 26);
    this.sunSprite.material.color.setRGB(...s.sun).multiplyScalar(SUN_HDR_GAIN);
    this.scene.add(this.sunSprite);
    this.refEpochJD = refEpochJD;
  }

  makeMark(label, size = 12) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new CanvasTexture(c);
    // A colour map, so it is sRGB-encoded data and must say so. (The ramp here is
    // neutral white, so this particular texture decodes to the same numbers — it
    // is declared anyway because the next colour texture added to this file will
    // not be neutral, and an undeclared colour map is invisible until it isn't.)
    tex.colorSpace = SRGBColorSpace;
    const mat = new SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    // Above 1.0 on purpose. The composite tone curve can only roll a highlight
    // off if the highlight is actually brighter than white in the HDR buffer;
    // a mark pinned at 1.0 has nothing to roll off and clips to a flat disc.
    mat.color.multiplyScalar(MARK_HDR_GAIN);
    const sp = new Sprite(mat);
    sp.scale.setScalar(size * 0.06);
    sp.userData.label = label;
    sp.userData.pxSize = size;
    return sp;
  }

  /** Planet elements at a Julian Date, from the JPL linear-rate table. */
  elementsAt(p, jd) {
    const T = (jd - 2451545.0) / 36525; // Julian centuries past J2000
    const v = p.elements.map((x, k) => x + p.rates[k] * T);
    const [a, e, Ideg, Ldeg, periDeg, nodeDeg] = v;
    const w = (periDeg - nodeDeg) * DEG2RAD;
    const M = (Ldeg - periDeg) * DEG2RAD;
    return { a, e, i: Ideg * DEG2RAD, om: nodeDeg * DEG2RAD, w, M };
  }

  updatePlanetMarks() {
    if (!this.planetData) return;
    const jd = this.refEpochJD + this.timeDays;
    for (const mark of this.planetMarks) {
      const p = mark.userData.planet;
      const el = this.elementsAt(p, jd);
      const E = solveKepler(el.M, el.e, 5);
      const xo = el.a * (Math.cos(E) - el.e);
      const yo = el.a * Math.sqrt(Math.max(0, 1 - el.e * el.e)) * Math.sin(E);
      const cw = Math.cos(el.w), sw = Math.sin(el.w);
      const co = Math.cos(el.om), so = Math.sin(el.om);
      const ci = Math.cos(el.i), si = Math.sin(el.i);
      const x = (cw * co - sw * so * ci) * xo + (-sw * co - cw * so * ci) * yo;
      const y = (cw * so + sw * co * ci) * xo + (-sw * so + cw * co * ci) * yo;
      const z = (sw * si) * xo + (cw * si) * yo;
      mark.position.set(x * AU_TO_SCENE, z * this.zExaggeration * AU_TO_SCENE, -y * AU_TO_SCENE);
      mark.userData.helio = [x, y, z];
      // Keep marks a roughly constant apparent size.
      const d = mark.position.distanceTo(this.camera.position);
      mark.scale.setScalar(Math.max(0.05, d * 0.012));
    }
    if (this.sunSprite) {
      const d = this.camera.position.length();
      this.sunSprite.scale.setScalar(Math.max(0.12, d * 0.022));
    }
  }

  /** Recompute a body's true position on the CPU, for the selection readout. */
  bodyStateAt(index, tDays, quantisation) {
    const cols = this.bodies.cols;
    const U16 = 65535;
    const q = quantisation;
    const logAMin = Math.log(q.semiMajorAxis.minAU);
    const logASpan = Math.log(q.semiMajorAxis.maxAU) - logAMin;
    const a = Math.exp((cols[0][index] / U16) * logASpan + logAMin);
    const e = cols[1][index] / U16;
    const i = (cols[2][index] / U16) * 180;
    const om = (cols[3][index] / U16) * 360;
    const w = (cols[4][index] / U16) * 360;
    const M0 = (cols[5][index] / U16) * 360;
    const hc = cols[6][index];
    const classIndex = hc >> 8;
    const hByte = hc & 0xff;
    const H = hByte === q.absoluteMagnitude.missingSentinel
      ? null
      : (hByte / 254) * (q.absoluteMagnitude.max - q.absoluteMagnitude.min) + q.absoluteMagnitude.min;
    const n = (K_GAUSS / Math.pow(a, 1.5)) * (180 / Math.PI);
    return {
      a, e, i, om, w, M0, H,
      classCode: this.classCodes[classIndex],
      periodYears: Math.pow(a, 1.5),
      perihelion: a * (1 - e),
      aphelion: a * (1 + e),
      meanAnomalyNow: ((M0 + n * tDays) % 360 + 360) % 360,
    };
  }

  /** Binary search the a-sorted buffer: first index with a >= au. */
  indexForSemiMajorAxis(au, quantisation) {
    const U16 = 65535;
    const q = quantisation;
    const logAMin = Math.log(q.semiMajorAxis.minAU);
    const logASpan = Math.log(q.semiMajorAxis.maxAU) - logAMin;
    const target = ((Math.log(au) - logAMin) / logASpan) * U16;
    const col = this.bodies.cols[0];
    let lo = 0;
    let hi = this.bodyCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (col[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Pass 1 into the HDR buffer, pass 2 tone-maps it onto the canvas. */
  renderFrame() {
    this.renderer.setRenderTarget(this.hdrTarget);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear(true, true, false);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.compositeScene, this.compositeCamera);
  }

  /**
   * Re-run both passes into an 8-bit target and read it back. Reading the
   * default drawing buffer after presentation returns undefined contents
   * (it came back all zeros), so the verification harness reads a target it
   * owns. The pixels are produced by the same two passes the visitor sees.
   */
  readCompositePixels() {
    const dpr = this.renderer.getPixelRatio();
    const w = Math.max(2, Math.round((this.canvas.clientWidth || window.innerWidth) * dpr));
    const h = Math.max(2, Math.round((this.canvas.clientHeight || window.innerHeight) * dpr));
    if (!this.readTarget || this.readTarget.width !== w || this.readTarget.height !== h) {
      if (this.readTarget) this.readTarget.dispose();
      this.readTarget = new WebGLRenderTarget(w, h, {
        type: UnsignedByteType,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        depthBuffer: false,
      });
    }
    this.renderer.setRenderTarget(this.hdrTarget);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear(true, true, false);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(this.readTarget);
    this.renderer.render(this.compositeScene, this.compositeCamera);
    const buf = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(this.readTarget, 0, 0, w, h, buf);
    this.renderer.setRenderTarget(null);
    return { width: w, height: h, pixels: buf };
  }

  /**
   * Run the PRODUCTION propagation shader over a chosen set of bodies and read
   * the positions it produces back as float32. scripts/accuracy.mjs compares
   * these against a float64 CPU solve, which is the only way to state the
   * numerical error of a GPU solver rather than assume it.
   */
  probePositions(indices, timeDays, quantisation) {
    const n = indices.length;
    const cols = this.bodies.cols;
    const geom = new BufferGeometry();
    const names = ['aQ', 'eQ', 'iQ', 'omQ', 'wQ', 'mQ'];
    for (let c = 0; c < 6; c++) {
      const arr = new Uint16Array(n);
      for (let k = 0; k < n; k++) arr[k] = cols[c][indices[k]];
      geom.setAttribute(names[c], new BufferAttribute(arr, 1));
    }
    geom.setDrawRange(0, n);
    geom.boundingSphere = new Sphere(new Vector3(0, 0, 0), Infinity);
    geom.computeBoundingSphere = () => {};

    const q = quantisation;
    const logAMin = Math.log(q.semiMajorAxis.minAU);
    const logASpan = Math.log(q.semiMajorAxis.maxAU) - logAMin;

    const mat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: PROBE_VERTEX,
      fragmentShader: PROBE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uLogAMin: { value: logAMin },
        uLogASpan: { value: logASpan },
        uTimeDays: { value: timeDays },
        uCount: { value: n },
      },
    });

    const target = new WebGLRenderTarget(n, 1, {
      type: FloatType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
    });

    const scene = new Scene();
    const pts = new Points(geom, mat);
    pts.frustumCulled = false;
    scene.add(pts);
    const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.renderer.setRenderTarget(target);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, true, false);
    this.renderer.render(scene, cam);
    const out = new Float32Array(n * 4);
    this.renderer.readRenderTargetPixels(target, 0, 0, n, 1, out);
    this.renderer.setRenderTarget(null);

    geom.dispose();
    mat.dispose();
    target.dispose();
    this.setStage(this.stageName);

    const positions = [];
    for (let k = 0; k < n; k++) positions.push([out[k * 4], out[k * 4 + 1], out[k * 4 + 2]]);
    return positions;
  }

  // --- picking -------------------------------------------------------------
  //
  // Positions live only on the GPU, so a CPU raycast is not available. Render
  // one extra pass in which every body writes its own vertex id as a colour,
  // read back a small window around the pointer, and take the nearest hit.

  pick(clientX, clientY, radiusPx = 6) {
    if (!this.points) return -1;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.renderer.getPixelRatio();
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);

    if (!this.pickTarget || this.pickTarget.width !== w || this.pickTarget.height !== h) {
      if (this.pickTarget) this.pickTarget.dispose();
      this.pickTarget = new WebGLRenderTarget(w, h, {
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        depthBuffer: true,
      });
    }

    const mat = this.material;
    const prevBlend = mat.blending;
    const prevDepthTest = mat.depthTest;
    const prevDepthWrite = mat.depthWrite;
    const prevTransparent = mat.transparent;

    mat.uniforms.uPicking.value = 1;
    mat.blending = NormalBlending;
    mat.transparent = false;
    mat.depthTest = true;
    mat.depthWrite = true;
    mat.needsUpdate = true;

    const hidden = [];
    for (const o of [...this.planetLines, ...this.planetMarks, this.sunSprite]) {
      if (o && o.visible) { o.visible = false; hidden.push(o); }
    }

    this.renderer.setRenderTarget(this.pickTarget);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear(true, true, false);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);

    const px = Math.round((clientX - rect.left) * dpr);
    const py = Math.round((rect.height - (clientY - rect.top)) * dpr);
    const r = Math.max(1, Math.round(radiusPx * dpr));
    const x0 = Math.max(0, px - r);
    const y0 = Math.max(0, py - r);
    const bw = Math.min(w - x0, r * 2 + 1);
    const bh = Math.min(h - y0, r * 2 + 1);

    let found = -1;
    if (bw > 0 && bh > 0) {
      const buf = new Uint8Array(bw * bh * 4);
      this.renderer.readRenderTargetPixels(this.pickTarget, x0, y0, bw, bh, buf);
      let best = Infinity;
      for (let yy = 0; yy < bh; yy++) {
        for (let xx = 0; xx < bw; xx++) {
          const o = (yy * bw + xx) * 4;
          const id = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
          if (id === 0) continue;
          const dx = x0 + xx - px;
          const dy = y0 + yy - py;
          const d2 = dx * dx + dy * dy;
          if (d2 < best) { best = d2; found = id - 1; }
        }
      }
    }

    for (const o of hidden) o.visible = true;
    mat.uniforms.uPicking.value = 0;
    mat.blending = prevBlend;
    mat.transparent = prevTransparent;
    mat.depthTest = prevDepthTest;
    mat.depthWrite = prevDepthWrite;
    mat.needsUpdate = true;
    this.setStage(this.stageName);

    return found;
  }

  // --- loop ----------------------------------------------------------------

  start(onFrame) {
    this._onFrame = onFrame;
    let last = performance.now();
    const tick = (now) => {
      this._raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      if (this.rateDaysPerSecond !== 0) this.timeDays += this.rateDaysPerSecond * dt;

      this.controls.update();
      if (this.material) this.material.uniforms.uTimeDays.value = this.timeDays;
      this.updatePlanetMarks();

      const t0 = performance.now();
      let timerQuery = null;
      if (this._collectTimings && this._timerExt) {
        const gl2 = this.renderer.getContext();
        timerQuery = gl2.createQuery();
        gl2.beginQuery(this._timerExt.TIME_ELAPSED_EXT, timerQuery);
      }
      this.renderFrame();
      if (timerQuery) {
        const gl2 = this.renderer.getContext();
        gl2.endQuery(this._timerExt.TIME_ELAPSED_EXT);
        this._pendingQueries.push(timerQuery);
      }
      if (this.forceSync) {
        // Submitting a draw call is nearly free; the GPU finishes it later.
        // gl.finish() is advisory under ANGLE and returned in 0.1 ms here even
        // for 1.5M points, so drain the pipeline with a read instead, which
        // cannot complete until the frame has actually been produced.
        const gl2 = this.renderer.getContext();
        gl2.readPixels(0, 0, 1, 1, gl2.RGBA, gl2.UNSIGNED_BYTE, this._syncPixel);
      }
      const t1 = performance.now();

      // The FRAME INTERVAL is the honest number: time between one presented
      // frame and the next. Time spent inside this callback is a different
      // (much smaller) quantity and quoting it as the frame time would be a
      // lie by a factor of fifty.
      if (this._lastFrameTs !== undefined) {
        this.frameTimes.push(now - this._lastFrameTs);
        if (this.frameTimes.length > 480) this.frameTimes.shift();
      }
      this._lastFrameTs = now;
      this.cpuTimes.push(t1 - t0);
      if (this.cpuTimes.length > 480) this.cpuTimes.shift();
      this._lastRenderMs = t1 - t0;

      if (this._onFrame) this._onFrame(this);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this._raf);
  }

  /**
   * Real GPU time per frame.
   *
   * With vsync on, the presented frame interval is pinned to the display and
   * says only "it kept up". EXT_disjoint_timer_query_webgl2 asks the GPU how
   * long it actually spent, which is the number that says whether there is
   * headroom. If the extension is missing, fall back to draining the pipeline
   * with a 1-pixel readPixels, which is slower but honest, and say which was
   * used.
   */
  async measureGpuFrameCost(frames = 90) {
    const gl = this.renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');

    if (ext) {
      this._timerExt = ext;
      this._pendingQueries = [];
      this._collectTimings = true;
      await new Promise((resolve) => {
        let n = 0;
        const wait = () => (++n >= frames + 6 ? resolve() : requestAnimationFrame(wait));
        requestAnimationFrame(wait);
      });
      this._collectTimings = false;

      // Drain the results.
      const deadline = performance.now() + 4000;
      const ns = [];
      while (this._pendingQueries.length && performance.now() < deadline) {
        const q = this._pendingQueries[0];
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
          const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
          if (!disjoint) ns.push(gl.getQueryParameter(q, gl.QUERY_RESULT));
          gl.deleteQuery(q);
          this._pendingQueries.shift();
        } else {
          await new Promise((r) => setTimeout(r, 4));
        }
      }
      for (const q of this._pendingQueries) gl.deleteQuery(q);
      this._pendingQueries = [];

      const ms = ns.slice(5).map((v) => v / 1e6);
      if (ms.length >= 8) return summarise(ms, 'EXT_disjoint_timer_query_webgl2 (TIME_ELAPSED on the render pass)', this.bodyCount);
    }

    // Fallback: force a full pipeline drain and time the wall clock.
    const prev = this.forceSync;
    this.forceSync = true;
    this.cpuTimes.length = 0;
    await new Promise((resolve) => {
      let n = 0;
      const wait = () => (++n >= frames + 10 ? resolve() : requestAnimationFrame(wait));
      requestAnimationFrame(wait);
    });
    this.forceSync = prev;
    const samples = this.cpuTimes.slice(10);
    if (samples.length < 8) return null;
    return summarise(samples, 'render() followed by a 1-pixel readPixels pipeline drain', this.bodyCount);
  }

  stats() {
    const f = this.frameTimes.slice(-240);
    if (f.length < 8) return null;
    const q = (arr, p) => {
      const s2 = [...arr].sort((a, b) => a - b);
      return s2[Math.min(s2.length - 1, Math.floor(s2.length * p))];
    };
    const median = q(f, 0.5);
    return {
      samples: f.length,
      medianFrameMs: median,
      p95FrameMs: q(f, 0.95),
      worstFrameMs: Math.max(...f),
      fps: 1000 / median,
      medianCpuMs: q(this.cpuTimes.slice(-240), 0.5),
      gpuFrameMs: this.gpuFrameMs ?? null,
      drawnBodies: this.bodyCount,
      drawCalls: this.renderer.info.render.calls,
      pointsSubmitted: this.renderer.info.render.points,
    };
  }

  /**
   * Assert that the body program actually linked. A WebGL program that fails
   * to link is silently skipped by the driver, which produces an empty canvas
   * and a spectacular frame rate. Ask the question explicitly.
   */
  programStatus() {
    const gl = this.renderer.getContext();
    this.renderer.compile(this.scene, this.camera);
    const progs = this.renderer.info.programs || [];
    const out = [];
    for (const p of progs) {
      const linked = gl.getProgramParameter(p.program, gl.LINK_STATUS);
      out.push({
        name: p.name,
        linked: !!linked,
        log: linked ? '' : gl.getProgramInfoLog(p.program) || '',
        vertexLog: linked ? '' : gl.getShaderInfoLog(p.vertexShader) || '',
        fragmentLog: linked ? '' : gl.getShaderInfoLog(p.fragmentShader) || '',
      });
    }
    return out;
  }
}
