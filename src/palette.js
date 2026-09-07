// palette.js — one colour decision per dynamical class, and the two stages.
//
// Two stages, not one theme flipped:
//   dusk     additive light on a near-black ground. Density reads as brightness.
//   daylight dark ink on a near-white ground, like a printed plate. Density
//            reads as darkness. Same data, inverted optics.
//
// In both, the main belt is deliberately the quietest colour in the set. It is
// 88% of the catalogue, so if it were saturated it would flatten every other
// population and, worse, it would hide the gaps. The gaps are the subject.

/** Human labels and one-line descriptions for the SBDB class codes. */
export const CLASS_META = {
  MBA: ['Main belt', 'Between Mars and Jupiter, 2.0 to 3.2 AU'],
  OMB: ['Outer main belt', 'Beyond the 5:2 resonance, a > 3.28 AU'],
  IMB: ['Inner main belt', 'Inside the 4:1 resonance, a < 2.0 AU'],
  MCA: ['Mars-crossing', 'Perihelion inside the orbit of Mars'],
  APO: ['Apollo', 'Earth-crossing, a > 1 AU'],
  TJN: ['Jupiter Trojan', 'Locked 60 degrees ahead of and behind Jupiter'],
  AMO: ['Amor', 'Approaches Earth from outside, does not cross'],
  TNO: ['Trans-Neptunian', 'Beyond Neptune, a > 30.1 AU'],
  ATE: ['Aten', 'Earth-crossing, a < 1 AU'],
  CEN: ['Centaur', 'Between Jupiter and Neptune, unstable'],
  AST: ['Asteroid, other', 'Does not fit the standard classes'],
  IEO: ['Interior-Earth', 'Orbit entirely inside Earth’s'],
  HYA: ['Hyperbolic', 'Unbound; excluded from the render, see README'],
  PAA: ['Parabolic', 'Unbound; excluded from the render'],
  UNK: ['Unclassified', 'No dynamical class in the source record'],
};

/** [dusk rgb, daylight rgb], linear 0..1. */
const CLASS_RGB = {
  MBA: [[0.38, 0.55, 0.86], [0.16, 0.22, 0.36]],
  OMB: [[0.28, 0.68, 0.82], [0.09, 0.28, 0.36]],
  IMB: [[0.76, 0.63, 0.46], [0.34, 0.26, 0.14]],
  MCA: [[0.95, 0.60, 0.36], [0.46, 0.24, 0.08]],
  APO: [[1.0, 0.36, 0.32], [0.52, 0.10, 0.10]],
  TJN: [[1.0, 0.72, 0.24], [0.44, 0.29, 0.02]],
  AMO: [[1.0, 0.50, 0.28], [0.48, 0.18, 0.06]],
  TNO: [[0.68, 0.50, 1.0], [0.26, 0.14, 0.48]],
  ATE: [[1.0, 0.40, 0.58], [0.48, 0.10, 0.24]],
  CEN: [[0.34, 0.88, 0.76], [0.06, 0.34, 0.30]],
  AST: [[0.72, 0.74, 0.80], [0.30, 0.31, 0.34]],
  IEO: [[1.0, 0.48, 0.80], [0.46, 0.12, 0.32]],
  HYA: [[0.94, 0.94, 0.96], [0.20, 0.20, 0.22]],
  PAA: [[0.90, 0.90, 0.94], [0.22, 0.22, 0.24]],
  UNK: [[0.60, 0.62, 0.66], [0.30, 0.30, 0.32]],
};

const FALLBACK = [[0.60, 0.62, 0.66], [0.30, 0.30, 0.32]];

export function classColor(code, stage) {
  const pair = CLASS_RGB[code] || FALLBACK;
  return stage === 'daylight' ? pair[1] : pair[0];
}

export function classLabel(code) {
  return (CLASS_META[code] || [code, ''])[0];
}

export function classNote(code) {
  return (CLASS_META[code] || [code, ''])[1];
}

// `bodyOpacity` is the per-point alpha AT THE REFERENCE BODY COUNT below.
// It has to scale with population: brightness here is a density map, and a
// fixed alpha that looks right for 120,000 points saturates to flat white at
// 1.5 million, which erases exactly the structure this page exists to show.
export const EXPOSURE_REFERENCE_BODIES = 120000;

export const STAGE = {
  dusk: {
    clear: 0x05070d,
    orbit: [0.42, 0.48, 0.62],
    orbitOpacity: 0.30,
    sun: [1.0, 0.86, 0.52],
    bodyOpacity: 0.085,
    additive: true,
  },
  daylight: {
    clear: 0xf7f6f2,
    orbit: [0.40, 0.42, 0.48],
    orbitOpacity: 0.45,
    sun: [0.85, 0.52, 0.05],
    bodyOpacity: 0.075,
    additive: false,
  },
};
