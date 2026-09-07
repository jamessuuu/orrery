// shaders.js — the GPU propagator.
//
// One vertex per catalogued body. Nothing about a body's position is ever
// uploaded: the vertex shader receives six quantised orbital elements and a
// time uniform, solves Kepler's equation, and produces the position itself.
// That is the whole point of the project, so it lives in one readable file.

import { K_GAUSS, KEPLER_ITERATIONS } from './kepler.js';

// The dequantise + solve + rotate chain, shared verbatim between the draw
// shader and the verification probe. scripts/accuracy.mjs measures the error of
// THIS code against a float64 CPU reference; if the two ever diverged the
// measurement would be worthless, so there is exactly one copy of it.
export const PROPAGATE_GLSL = /* glsl */ `
const float K_GAUSS = ${K_GAUSS.toPrecision(12)};
const float PI = 3.141592653589793;
const float TAU = 6.283185307179586;
const float U16 = 65535.0;

float solveKepler(float M, float e) {
  // Wrap to [-PI, PI] so the starter sits on the correct branch.
  float m = mod(M + PI, TAU) - PI;
  float sgn = m < 0.0 ? -1.0 : 1.0;
  float am = abs(m);

  // Mikkola's cubic starter, accurate to about 1e-4 for every e < 1. The
  // simpler E = M + e sin M starter was MEASURED to diverge at e = 0.9996,
  // which is the highest eccentricity in this catalogue, so it is not usable
  // with a fixed iteration count. See docs/accuracy-report.json.
  float alpha = (1.0 - e) / (4.0 * e + 0.5);
  float beta = (0.5 * am) / (4.0 * e + 0.5);
  float inner = beta + sqrt(beta * beta + alpha * alpha * alpha);
  float z = pow(max(inner, 1e-30), 1.0 / 3.0);
  float sv = z - alpha / z;
  float sv5 = sv * sv * sv * sv * sv;
  sv = sv - 0.078 * sv5 / (1.0 + e);
  float E = sgn * (am + e * (3.0 * sv - 4.0 * sv * sv * sv));

  // Halley iterations, cubic convergence.
  for (int k = 0; k < ${KEPLER_ITERATIONS}; k++) {
    float s = sin(E);
    float c = cos(E);
    float f = E - e * s - m;
    float fp = 1.0 - e * c;
    float fpp = e * s;
    E -= (2.0 * f * fp) / (2.0 * fp * fp - f * fpp);
  }
  return E;
}

// Heliocentric ecliptic position in AU from the quantised element words.
vec3 propagateBody(
  float aQ, float eQ, float iQ, float omQ, float wQ, float mQ,
  float logAMin, float logASpan, float timeDays, float circularise,
  out float aOut, out float eOut
) {
  float a  = exp((aQ / U16) * logASpan + logAMin);
  float e  = eQ / U16;
  float inc = (iQ / U16) * PI;
  float om = (omQ / U16) * TAU;
  float w  = (wQ / U16) * TAU;
  float M0 = (mQ / U16) * TAU;
  aOut = a;
  eOut = e;

  float eDraw = e * (1.0 - circularise);
  float n = K_GAUSS * pow(a, -1.5);
  float E = solveKepler(M0 + n * timeDays, eDraw);

  float cosE = cos(E);
  float sinE = sin(E);
  float xo = a * (cosE - eDraw);
  float yo = a * sqrt(max(0.0, 1.0 - eDraw * eDraw)) * sinE;

  float cw = cos(w), sw = sin(w);
  float co = cos(om), so = sin(om);
  float ci = cos(inc), si = sin(inc);

  return vec3(
    (cw * co - sw * so * ci) * xo + (-sw * co - cw * so * ci) * yo,
    (cw * so + sw * co * ci) * xo + (-sw * so + cw * co * ci) * yo,
    (sw * si) * xo + (cw * si) * yo
  );
}
`;

export const BODY_VERTEX = /* glsl */ `
precision highp float;

// RawShaderMaterial receives none of three's automatic prelude, so the two
// matrices it does supply have to be declared here or the program will not
// link (and a program that does not link draws nothing while the frame timer
// happily reports thousands of frames a second).
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

// Quantised elements, one Uint16 attribute per element (column-major upload).
in float aQ;   // semi-major axis, log-quantised
in float eQ;   // eccentricity
in float iQ;   // inclination
in float omQ;  // longitude of ascending node
in float wQ;   // argument of periapsis
in float mQ;   // mean anomaly AT THE COMMON REFERENCE EPOCH
in float hcQ;  // (classIndex << 8) | magnitudeByte

uniform float uTimeDays;      // days from the reference epoch
uniform float uLogAMin;
uniform float uLogASpan;
uniform float uAuToScene;
uniform float uPointScale;    // px per scene unit at unit distance
uniform float uSizeBase;
uniform float uSizeByH;       // 0 or 1
uniform float uZExaggeration;
uniform float uOpacity;
uniform float uClassOn[16];
uniform vec3  uClassColor[16];
uniform float uBrushLo;       // semi-major axis brush, AU
uniform float uBrushHi;
uniform float uSelected;      // vertex id of the selected body, or -1
uniform float uHiPass;        // 0 = normal, 1 = dim everything but selection
uniform float uPicking;       // 1 during the offscreen id pass
uniform float uCircularise;   // 0 = true positions, 1 = eccentricity set to zero

out vec4 vColor;
flat out int vDropped;
flat out int vId;

${PROPAGATE_GLSL}

void main() {
  vId = gl_VertexID;

  // --- dequantise the parts the appearance needs --------------------------
  float cls = floor(hcQ / 256.0);
  float hByte = hcQ - cls * 256.0;
  int classIndex = int(cls + 0.5);
  float aPreview = exp((aQ / U16) * uLogASpan + uLogAMin);

  // --- cull ---------------------------------------------------------------
  bool on = uClassOn[classIndex] > 0.5 && aPreview >= uBrushLo && aPreview <= uBrushHi;
  if (!on) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside clip space
    gl_PointSize = 0.0;
    vColor = vec4(0.0);
    vDropped = 1;
    return;
  }
  vDropped = 0;

  // --- propagate ----------------------------------------------------------
  // The Kirkwood gaps are gaps in SEMI-MAJOR AXIS. Instantaneous distance from
  // the Sun is not semi-major axis: with a median eccentricity of 0.147 a body
  // at a = 2.5 AU ranges over 2.13 to 2.87 AU, which is five times wider than
  // the gap itself, so a true-position plot smears the lanes. uCircularise
  // scales eccentricity toward zero, which puts every body at its own
  // semi-major axis. That is deliberately NOT where the bodies are, and the
  // interface says so whenever it is non-zero.
  float aVal, eVal;
  vec3 helio = propagateBody(aQ, eQ, iQ, omQ, wQ, mQ, uLogAMin, uLogASpan, uTimeDays, uCircularise, aVal, eVal);

  // Ecliptic z becomes scene y. Vertical exaggeration is a stated view control,
  // never on by default.
  vec3 scenePos = vec3(helio.x, helio.z * uZExaggeration, -helio.y) * uAuToScene;

  vec4 mv = modelViewMatrix * vec4(scenePos, 1.0);
  gl_Position = projectionMatrix * mv;

  // --- appearance ---------------------------------------------------------
  // H is available but size-by-magnitude is OFF by default, because when point
  // size varies, brightness stops being a pure density map and the belt's
  // structure gets confounded with the size of its members.
  float hNorm = hByte >= 255.0 ? 0.5 : hByte / 254.0;
  float sizeH = mix(1.0, clamp(2.4 - 2.6 * hNorm, 0.45, 3.2), uSizeByH);

  float dist = max(0.0001, -mv.z);
  gl_PointSize = clamp(uSizeBase * sizeH * (uPointScale / dist), 0.6, 24.0);
  if (uPicking > 0.5) gl_PointSize = max(gl_PointSize, 5.0);

  vec3 col = uClassColor[classIndex];
  float alpha = uOpacity;

  bool isSel = uSelected >= 0.0 && abs(float(gl_VertexID) - uSelected) < 0.5;
  if (isSel) {
    col = vec3(1.0, 0.86, 0.42);
    alpha = 1.0;
    gl_PointSize = max(gl_PointSize, 9.0);
  } else if (uHiPass > 0.5) {
    alpha *= 0.16;
  }

  vColor = vec4(col, alpha);
}
`;

export const BODY_FRAGMENT = /* glsl */ `
precision highp float;

in vec4 vColor;
flat in int vDropped;
flat in int vId;
uniform float uDarkOnLight;  // 1 in the daylight plate view
uniform float uPicking;
out vec4 fragColor;

void main() {
  if (vDropped == 1) discard;
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;

  if (uPicking > 0.5) {
    // Vertex id + 1 packed little-endian across RGB. 0,0,0 means background,
    // which is why the +1 is there.
    int id = vId + 1;
    fragColor = vec4(
      float(id & 255) / 255.0,
      float((id >> 8) & 255) / 255.0,
      float((id >> 16) & 255) / 255.0,
      1.0
    );
    return;
  }

  // Very nearly a hard disc. The narrowest gap here is about ten pixels wide at
  // the default framing, so a feathered sprite would blur away the subject.
  float falloff = smoothstep(0.25, 0.213, r2);
  fragColor = vec4(vColor.rgb, vColor.a * falloff);
}
`;

// --- planets: same solver, a handful of vertices, drawn as rings and marks ---

export const ORBIT_VERTEX = /* glsl */ `
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in float vAngle;          // 0..1 around the ellipse
uniform float uA, uE, uI, uOm, uW;
uniform float uAuToScene;
uniform float uZExaggeration;
out float vFade;

const float TAU = 6.283185307179586;

void main() {
  float E = vAngle * TAU;
  float xo = uA * (cos(E) - uE);
  float yo = uA * sqrt(max(0.0, 1.0 - uE * uE)) * sin(E);

  float cw = cos(uW), sw = sin(uW);
  float co = cos(uOm), so = sin(uOm);
  float ci = cos(uI), si = sin(uI);

  vec3 helio = vec3(
    (cw * co - sw * so * ci) * xo + (-sw * co - cw * so * ci) * yo,
    (cw * so + sw * co * ci) * xo + (-sw * so + cw * co * ci) * yo,
    (sw * si) * xo + (cw * si) * yo
  );
  vec3 scenePos = vec3(helio.x, helio.z * uZExaggeration, -helio.y) * uAuToScene;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(scenePos, 1.0);
  vFade = 1.0;
}
`;

export const ORBIT_FRAGMENT = /* glsl */ `
precision highp float;
in float vFade;
uniform vec3 uColor;
uniform float uOpacity;
out vec4 fragColor;
void main() { fragColor = vec4(uColor, uOpacity * vFade); }
`;


// --- position probe: the same maths, written out for measurement -----------
export const PROBE_VERTEX = /* glsl */ `
precision highp float;
in float aQ; in float eQ; in float iQ; in float omQ; in float wQ; in float mQ;
uniform float uLogAMin, uLogASpan, uTimeDays, uCount;
out vec3 vPos;
${PROPAGATE_GLSL}
void main() {
  float aOut, eOut;
  vPos = propagateBody(aQ, eQ, iQ, omQ, wQ, mQ, uLogAMin, uLogASpan, uTimeDays, 0.0, aOut, eOut);
  float x = (float(gl_VertexID) + 0.5) / uCount * 2.0 - 1.0;
  gl_Position = vec4(x, 0.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

export const PROBE_FRAGMENT = /* glsl */ `
precision highp float;
in vec3 vPos;
out vec4 fragColor;
void main() { fragColor = vec4(vPos, 1.0); }
`;

// --- composite: HDR density buffer -> screen --------------------------------
//
// Additive blending straight to an 8-bit canvas clips each channel on its own,
// so a dense blue region hits 1.0 in blue long before red and the belt turns
// electric primary instead of white-hot. Accumulating in a float buffer and
// applying an exponential exposure curve here fixes that at the root: all three
// channels approach 1 together, so density reads as brightness and hue survives
// in the wings where it is actually informative.

export const COMPOSITE_VERTEX = /* glsl */ `
precision highp float;
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const COMPOSITE_FRAGMENT = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform vec3 uBackground;
uniform float uExposure;
uniform float uDarkOnLight;
out vec4 fragColor;

void main() {
  vec3 hdr = max(vec3(0.0), texture(uScene, vUv).rgb);

  // Film response. Monotonic, saturates to 1 without ever clipping a channel
  // against the others.
  vec3 mapped = vec3(1.0) - exp(-hdr * uExposure);

  vec3 outRgb;
  if (uDarkOnLight > 0.5) {
    // Printed plate: density absorbs light instead of emitting it.
    float amount = max(mapped.r, max(mapped.g, mapped.b));
    float peak = max(hdr.r, max(hdr.g, hdr.b));
    vec3 hue = peak > 1e-5 ? hdr / peak : vec3(1.0);
    vec3 ink = hue * 0.30;
    outRgb = mix(uBackground, ink, amount);
  } else {
    outRgb = uBackground + mapped * (1.0 - uBackground);
  }
  fragColor = vec4(outRgb, 1.0);
}
`;
