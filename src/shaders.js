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

// Tone curves and the display transfer function.
//
// AgXToneMapping and NeutralToneMapping are transcribed from three r185's own
// ShaderChunk/tonemapping_pars_fragment.glsl.js so that "AgX" here means exactly
// what renderer.toneMapping = AgXToneMapping means everywhere else. The composite
// pass is a RawShaderMaterial, so three injects nothing into it: if this file does
// not do the tone map and the sRGB encode, nobody does.
//
// sRGBTransferOETF is likewise three's own colorspace_pars_fragment. Its absence
// was a real defect: the pass was writing LINEAR radiance into a framebuffer the
// browser reads as sRGB, so every mid-tone was displayed about a stop and a half
// too dark and the belt's low-density wings — which is where the Kirkwood gaps
// live — were crushed toward black.
export const TONEMAP_GLSL = /* glsl */ `
const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
  vec3( 1.6605, - 0.1246, - 0.0182 ),
  vec3( - 0.5876, 1.1329, - 0.1006 ),
  vec3( - 0.0728, - 0.0083, 1.1187 )
);
const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
  vec3( 0.6274, 0.0691, 0.0164 ),
  vec3( 0.3293, 0.9195, 0.0880 ),
  vec3( 0.0433, 0.0113, 0.8956 )
);

vec3 agxDefaultContrastApprox(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return + 15.5 * x4 * x2
    - 40.14 * x4 * x
    + 31.96 * x4
    - 6.868 * x2 * x
    + 0.4298 * x2
    + 0.1191 * x
    - 0.00232;
}

vec3 agxToneMap(vec3 color, float exposure) {
  const mat3 AgXInsetMatrix = mat3(
    vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
    vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
    vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 )
  );
  const mat3 AgXOutsetMatrix = mat3(
    vec3( 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ),
    vec3( - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ),
    vec3( - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 )
  );
  const float AgxMinEv = - 12.47393;
  const float AgxMaxEv = 4.026069;

  color *= exposure;
  color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
  color = AgXInsetMatrix * color;
  color = max(color, 1e-10);
  color = log2(color);
  color = (color - AgxMinEv) / (AgxMaxEv - AgxMinEv);
  color = clamp(color, 0.0, 1.0);
  color = agxDefaultContrastApprox(color);
  color = AgXOutsetMatrix * color;
  color = pow(max(vec3(0.0), color), vec3(2.2));
  color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
  return clamp(color, 0.0, 1.0);
}

vec3 neutralToneMap(vec3 color, float exposure) {
  const float StartCompression = 0.8 - 0.04;
  const float Desaturation = 0.15;
  color *= exposure;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < StartCompression) return max(color, vec3(0.0));
  float d = 1.0 - StartCompression;
  float newPeak = 1.0 - d * d / (peak + d - StartCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (Desaturation * (peak - newPeak) + 1.0);
  return clamp(mix(color, vec3(newPeak), g), 0.0, 1.0);
}

// The pre-r185 curve this project shipped, kept so the change is switchable and
// therefore measurable rather than merely asserted.
vec3 exponentialToneMap(vec3 color, float exposure) {
  return vec3(1.0) - exp(-color * exposure);
}

vec3 sRGBTransferOETF(vec3 value) {
  return mix(
    pow(value, vec3(0.41666)) * 1.055 - vec3(0.055),
    value * 12.92,
    vec3(lessThanEqual(value, vec3(0.0031308)))
  );
}
`;

// Bloom is deliberately absent, and that is a measured decision rather than an
// omission. A thresholded bloom (threshold 1.0, so only the Sun and the planet
// marks are above it) was implemented and ablated: at strength 0.9 the rendered
// contrast of the 3:1 Kirkwood lane fell from 0.723 to 0.857 and the blind pixel
// detector in scripts/shoot.mjs stopped finding it at all. The mechanism is that
// this frame's brightness IS a density measurement, so any operator that spreads
// light spatially erases the very lanes the page exists to show. Same argument
// disqualifies depth of field and every distance-attenuated depth cue.
// Numbers: docs/render-ablation.json, cases b-off / b-035 / b-090.

export const COMPOSITE_FRAGMENT = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform vec3 uBackground;
uniform float uExposure;
uniform float uDarkOnLight;
uniform float uTone;      // 0 exponential (legacy), 1 AgX, 2 Khronos Neutral, 3 none
uniform float uBlack;     // black point, subtracted after the curve
uniform float uEncode;    // 1 = apply the sRGB OETF (correct), 0 = the old raw write
uniform float uGamma;     // density contrast, applied BEFORE the display encode
out vec4 fragColor;

${TONEMAP_GLSL}

vec3 toneMap(vec3 c) {
  if (uTone < 0.5) return exponentialToneMap(c, uExposure);
  if (uTone < 1.5) return agxToneMap(c, uExposure);
  if (uTone < 2.5) return neutralToneMap(c, uExposure);
  return clamp(c * uExposure, 0.0, 1.0);
}

void main() {
  vec3 hdr = max(vec3(0.0), texture(uScene, vUv).rgb);

  vec3 outRgb;
  if (uDarkOnLight > 0.5) {
    // Printed plate: density absorbs light instead of emitting it.
    //
    // The mix happens in DISPLAY space, not in linear light, and that is
    // deliberate. Ink coverage on paper is a halftone fraction — the eye reads
    // it as a proportion of covered area, which is a perceptual quantity, not a
    // radiometric one. Mixing paper toward ink in linear light and then encoding
    // was measured (docs/render-ablation.json, and by looking) to bleach the
    // plate into a grey ghost with the Kirkwood lanes barely present.
    vec3 mapped = toneMap(hdr);
    // No density gamma here: the plate already mixes in display space, so it
    // never lost the contrast the dusk stage has to put back.
    float amount = clamp(max(mapped.r, max(mapped.g, mapped.b)), 0.0, 1.0);
    float peak = max(hdr.r, max(hdr.g, hdr.b));
    vec3 hue = peak > 1e-5 ? hdr / peak : vec3(1.0);
    // 0.30 is a DISPLAY-space density — 30 % of full scale, the reflectance of a
    // heavy ink — not a linear radiance. It is the number the plate shipped with
    // and it was always being written straight to the framebuffer, so encoding
    // it a second time is what bleached the plate. The paper, by contrast, comes
    // from a hex colour that three has already decoded to linear, so it DOES
    // need re-encoding to land on the 0xf7f6f2 it names.
    vec3 inkDisp = hue * 0.30;
    vec3 paperDisp = uEncode > 0.5 ? sRGBTransferOETF(clamp(uBackground, 0.0, 1.0)) : uBackground;
    fragColor = vec4(mix(paperDisp, inkDisp, amount), 1.0);
    return;
  } else {
    // The background is a radiance floor, not a screen-blend afterthought: the
    // bodies ADD to it and the whole sum goes through one curve. That is what
    // gives the frame a single, real black point instead of a lifted grey one.
    outRgb = toneMap(hdr + uBackground);

    // Density contrast. This buffer does not hold radiance, it holds accumulated
    // per-body alpha — a density map. A display transfer function designed for
    // photographs lifts the low-density wings of the belt, and the low-density
    // wings ARE the Kirkwood gaps. So the contrast the encode removes is put back
    // here as a named, measured control rather than left to be an accident of
    // whichever curve happens to be last. Measured: docs/render-ablation.json.
    outRgb = pow(max(vec3(0.0), outRgb), vec3(uGamma));

    outRgb = max(vec3(0.0), outRgb - vec3(uBlack)) / max(1e-4, 1.0 - uBlack);
  }

  if (uEncode > 0.5) outRgb = sRGBTransferOETF(clamp(outRgb, 0.0, 1.0));
  fragColor = vec4(outRgb, 1.0);
}
`;
