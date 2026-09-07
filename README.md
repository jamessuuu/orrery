# orrery

**1,562,531 catalogued small bodies of the solar system, positioned every frame by solving
Kepler's equation on the GPU from their own published orbital elements.**

No position is ever shipped. The browser receives six 16-bit orbital elements per body and a
time uniform; the vertex shader produces every coordinate itself, 1.5 million times a frame.
Because the bodies are propagated rather than drawn as a fixed cloud, the resonance structure of
the asteroid belt is a property of the render rather than a picture of one, and the Kirkwood gaps
show up as dark lanes you can fly through.

Everything below is measured. `scripts/check.mjs` recomputes every headline figure from the
vendored catalogue and fails if any of them has drifted.

---

## Dataset provenance

| | |
|---|---|
| **Source** | NASA/JPL Small-Body Database Query API |
| **URL** | `https://ssd-api.jpl.nasa.gov/sbdb_query.api?fields=spkid,full_name,a,e,i,om,w,ma,epoch,H,class&sb-kind=a&full-prec=true` |
| **Licence** | Not a named licence. JPL's stated position: the data are **not subject to copyright** and may be used **for any purpose without prior permission**. |
| **Fetched** | **2026-09-07** (UTC), in 22.8 s |
| **Measured size** | **275,991,442 B** of JSON |
| **SHA-256** | `27d07090a60a650c0b3f588e43081ffc19b1f4e056e8617c095b84fd12d86d33` |
| **Rows parsed** | **1,562,537** (the API's own `count` field agrees) |
| **Renderable** | **1,562,531** |

Comets are queried separately (`sb-kind=c`): **4,075** objects, **586,308 B**, same date. They are
reported but not drawn — see *What this deliberately does not do*.

Planet orbits come from JPL Solar System Dynamics, *Approximate Positions of the Major Planets*,
Table 1 (1800–2050 AD), `https://ssd.jpl.nasa.gov/planets/approx_pos.html`, fetched 2026-09-07,
**29,585 B**. `scripts/extract-planets.mjs` parses the published table rather than hard-coding it,
and Jupiter's semi-major axis from that table (5.202887 AU) is what locates the resonances below.

> The brief this was built from quoted 1,562,532 asteroids. The catalogue on 2026-09-07 holds
> **1,562,537**. The real number is the one used everywhere here.

### What is excluded, and why

| | Bodies |
|---|---|
| Parsed from the API response | 1,562,537 |
| Missing one or more of the six elements | **1** |
| Hyperbolic or `e ≥ 1` (no elliptical orbit to draw) | **5** |
| **Rendered** | **1,562,531** |

---

## The finding the page is built around

The Kirkwood gaps are **located blind**. `scripts/audit.mjs` histograms the semi-major axis of
every renderable body in 0.005 AU bins, smooths over 0.025 AU, and reports every local minimum
between 2.0 and 3.5 AU that falls below half its own local baseline. It is told nothing about
resonances. It returns five:

**2.0775, 2.4975, 2.8275, 2.9475, 3.2925 AU.**

Those are then compared against resonance positions computed independently from Jupiter's
semi-major axis as `a = a_J · (q/p)^(2/3)`. The worst disagreement is **0.0149 AU, which is three
histogram bins**.

| Resonance | Predicted a (AU) | Smoothed count in the gap | 0.1 AU inner | 0.1 AU outer | Depletion |
|---|---|---|---|---|---|
| 3:1 | 2.5013 | 613 | 7,676 | 10,982 | **×15.21** |
| 5:2 | 2.8246 | 1,616 | 8,600 | 2,532 | **×3.45** |
| 7:3 | 2.9575 | 2,465 | 3,675 | 8,665 | **×2.50** |
| 2:1 | 3.2776 | 117 | 9,545 | 223 | **×41.60** |

The blind search also finds the **4:1 at ~2.078 AU**, which is the inner edge of the belt.

### The gaps are visible in the rendered image, not just in the histogram

`scripts/shoot.mjs` reads the framebuffer back, averages luminance over concentric one-pixel annuli
about the Sun, and looks for minima. On the plan view it finds dark lanes at **2.061, 2.507, 2.943 AU** — the 4:1, 3:1 and 7:3, within 0.015 AU of their predicted positions. The 5:2 and 2:1
do not clear the 20 % contrast threshold in pixel space; the 2:1 sits at the belt's outer edge
where there is no outer shoulder to measure against.

### Why the default view does not show sharp gaps, and what the "circularise" control is for

**The Kirkwood gaps are gaps in semi-major axis, not in distance from the Sun.** A body's actual
distance swings between perihelion and aphelion, and the median eccentricity in this catalogue is
**0.1473** — so a body at a = 2.5 AU ranges over roughly 2.13 to 2.87 AU, about five times wider
than the gap itself. A true-position plot therefore smears every lane, and any page that shows
crisp gaps while claiming to show real positions is showing you something else.

So the page ships both, and says which is on screen at all times:

- **circularise = 0 %** (default): every body at its true position for the displayed date.
- **circularise = 100 %**: eccentricity scaled to zero while `a`, `i` and the orientation angles
  are kept, parking every body at its own semi-major axis. The gaps become sharp. The readout
  panel changes to *"Eccentricity set to zero: every body is drawn at its semi-major axis, NOT
  where it is."*

Sliding between them is the explanation.

---

## Measured performance

Measured on this machine, in Chromium, at 1600 × 1000 CSS px, devicePixelRatio 1.

| | |
|---|---|
| GPU | `ANGLE (AMD, AMD Radeon RX 9060 XT (0x00007590) Direct3D11 vs_5_0 ps_5_0, D3D11)` |
| Display | 2560 × 1440 at **200 Hz** |
| Context | WebGL 2.0 (OpenGL ES 3.0 Chromium) |

| View | Bodies drawn | GPU time / frame | Presented frame interval |
|---|---|---|---|
| Preview tier | 120,000 | **0.50 ms** | 5.00 ms (200 fps, vsync ceiling) |
| Full catalogue, default view | **1,562,531** | **5.00 ms** | 5.00 ms (200 fps) |
| Full catalogue, plan view (circularised) | 1,562,531 | 3.35 ms | 5.00 ms (200 fps) |
| Full catalogue, vertical exaggeration ×14 | 1,562,531 | 3.09 ms | 5.00 ms (200 fps) |
| Full catalogue, class-filtered views | 1,562,531 | 1.06 – 1.11 ms | 5.00 ms (200 fps) |

An earlier framing that put the belt across the full viewport at a closer camera measured
**11.18 ms** (100 fps presented) — the cost is fill rate, not the Kepler solve, since every one of
the 1,562,531 vertices is propagated in all of these.

**No subsampling is required to hold framerate on this hardware.** The whole catalogue renders.
The preview tier exists to keep first paint small, not to keep the frame rate up, and the interface
says which tier is loaded on the face of the page.

Two numbers are reported because either alone would mislead. *Presented frame interval* is what a
visitor experiences and cannot beat the display's refresh; *GPU time* comes from
`EXT_disjoint_timer_query_webgl2` (`TIME_ELAPSED` around the render pass) and is what says whether
there is headroom. An earlier version of this harness timed the render callback instead and
reported 10,000 fps for a scene that was drawing nothing at all.

---

## The colour pipeline, and what it cost

The belt is drawn additively into a half-float buffer and resolved in a second pass. That
second pass is a `RawShaderMaterial`, which means three.js injects nothing into it: if that
one shader does not tone-map and does not apply the display transfer function, nobody does.
Until 2026-09-07 it did neither. It wrote linear radiance straight into a framebuffer the
browser reads as sRGB.

Fixing that in isolation made the page **worse**, and the harness caught it. With the sRGB
transfer function restored and nothing else changed, the rendered contrast of the 4:1 lane
went from 0.122 to 0.357 and the blind detector in `scripts/shoot.mjs` stopped finding the
3:1 gap at all. The reason is structural: this buffer does not hold radiance, it holds
accumulated per-body alpha — a density map — and a transfer function designed for
photographs lifts exactly the low-density wings that the Kirkwood gaps are made of.

So the contrast the encode removes is put back deliberately, as a named density gamma, and
then chosen by measurement rather than by eye. `npm run build && node
scripts/render-ablation.mjs` writes `docs/render-ablation.json`; 1440x900, DPR 1, GPU time
from `EXT_disjoint_timer_query_webgl2`, and the run refuses to report at all if the browser
fell back to a software rasteriser.

Gap depth is the mean rendered luminance in the lane divided by the mean 0.12 AU either
side, straight off the framebuffer. **Lower is a deeper, more legible gap.**

| Configuration | 4:1 (2.06 AU) | 3:1 (2.50 AU) | 7:3 (2.96 AU) | Lanes the blind detector finds | GPU ms |
|---|---:|---:|---:|---:|---:|
| Before this change | 0.1224 | 0.7474 | 0.8398 | 3 | 1.486 |
| sRGB transfer function only | 0.3565 | 0.8769 | 0.9239 | 2 | 1.489 |
| **Shipped: Neutral, exposure 0.62, gamma 1.8** | **0.0086** | **0.7229** | **0.7928** | **3** | **1.495** |
| AgX instead of Neutral | 0.0425 | 0.8162 | 0.8810 | 2 | 1.506 |
| Shipped, density gamma removed | 0.1657 | 0.8381 | 0.8853 | 2 | 1.498 |
| No tone curve at all | 0.3349 | 0.8400 | 0.9026 | 2 | 1.501 |
| Exposure 1.2 instead of 0.62 | 0.0226 | 0.9129 | 0.9213 | **1** | 1.499 |

Every visible lane is deeper than it was, the frame has a true black point (0.1st percentile
luminance 0, previously 1), and the whole thing costs **0.0095 ms of GPU time and 2,525 B
gzip**. Khronos PBR Neutral beats AgX on every lane, which is what you would expect on a
page where colour is the data channel rather than a look.

The last row is the failure this report exists to prevent. One exposure stop too hot and two
of the three lanes stop being detectable in the pixels, with nothing else changed and no
error anywhere.

### What was built, measured, and thrown away

- **Thresholded bloom on the brightest bodies.** Implemented properly — `luminanceThreshold`
  1.0, so only the Sun and the planet marks, the only things in the frame above diffuse
  white, could bloom at all. At strength 0.9 the 3:1 lane went from 0.723 to 0.857 and the
  blind detector lost it. Brightness here **is** the density measurement, so an operator
  that spreads light spatially erases the subject. Merely leaving the 24-tap loop compiled
  into the composite with its strength at zero cost 0.108 ms.
- **A depth cue.** Rejected on the same evidence without a second build: every candidate
  works by modulating brightness or spreading it, and brightness is the measurement. The page
  already has two depth cues that touch neither — orbital parallax, and the vertical
  exaggeration slider.
- **A key light with a shadow map, an ambient fill, and IBL from a 1k CC0 HDRI.** Built and
  run. It changed the mean frame luminance from 17.576 to 17.575, which is inside the noise
  of the measurement. Nothing here is a material three.js can light: every object is a
  `RawShaderMaterial` `Points` or `LineLoop`, or a `Sprite`. Cost had it shipped: **6,348 B
  gzip and a 1.6 MB HDRI download for zero pixels.**

The Sun and the planet marks are now written above 1.0 in the HDR buffer (×7.0 and ×1.7) so
the tone curve has a highlight to roll off instead of a flat disc to clip.

---

## Measured bundle size

`npm run build && node scripts/measure-bundle.mjs`, written to `docs/bundle-measurement.json`.

| | Raw | Gzip | Brotli |
|---|---|---|---|
| JavaScript | 598,346 B | **155,879 B** | 128,891 B |
| CSS | 11,786 B | 3,281 B | 2,847 B |
| HTML (including the whole static fallback) | 123,266 B | 24,203 B | 18,060 B |
| **Code shell total** | **733,398 B** | **183,363 B** | 149,798 B |
| Preview tier (120,000 bodies) | 1,680,000 B | 1,269,911 B | 1,224,122 B |
| **First paint total** | **2,423,542 B** | **1,456,468 B** | 1,376,669 B |
| Full catalogue, on explicit request | 21,875,434 B | 16,341,027 B | 15,777,145 B |

For comparison, the reference this was benchmarked against (`human-atlas-seven.vercel.app`) ships
**916,370 B raw / 260,791 B gzip**. This ships **733,398 B raw / 183,363 B gzip** of code — 20 %
smaller raw, 30 % smaller gzipped — and that figure carries a 120 KB build-time static fallback
the reference does not have.

The colour pipeline described below costs **+2,525 B gzip** of that total (153,354 B to
155,879 B). Everything it buys is in `docs/render-ablation.json`.

---

## The wire format

Fourteen bytes per body, seven `Uint16` columns, column-major so the browser makes one zero-copy
`Uint16Array` view per column and hands each straight to a vertex attribute. No parse step.

| Column | Encoding |
|---|---|
| `a` | 16-bit, logarithmic, 0.3 – 20,000 AU |
| `e` | 16-bit linear, 0 – 1 |
| `i` | 16-bit linear, 0 – 180° |
| `Ω`, `ω`, `M` | 16-bit linear, 0 – 360° |
| class + `H` | `(classIndex << 8) | magnitudeByte` |

Three decisions worth stating:

**The catalogue is stored sorted by semi-major axis.** That makes the radial-shell brush a single
`setDrawRange` instead of a per-body test, and it makes the `a` column monotonic so it delta-codes
into something compressible. The brief predicted compression would buy about one percent, because
three of the six fields are near-uniform angles. Sorting plus delta-coding measured **28 %**:
21,875,434 B raw → 15,777,145 B brotli.

**There is no epoch column.** The catalogue does not share one epoch: **6,334 distinct epochs**
appear in it and **95,356 renderable bodies** are solved for a different date than the rest.
Propagating everything from one assumed epoch would misplace six percent of the belt while looking
perfectly smooth. Instead every body is advanced from its own published epoch to a common reference
epoch **at build time, in float64, by exact two-body mean motion**. Mean anomaly is linear in time,
so that advance introduces no error of its own, and the epoch column then costs zero bytes.

| Epoch age at build | Bodies |
|---|---|
| Already on the reference epoch (JD 2461200.5 = 2026-06-09) | 1,467,175 |
| Advanced up to 1 year | 27,469 |
| Advanced 1 to 10 years | 31,705 |
| Advanced more than 10 years | 36,182 |

Two-body propagation ignores planetary perturbations, so a body advanced ten years carries real
accumulated error. That is a property of working from published elements rather than an integrated
ephemeris, and it is why this page draws no close-approach or hazard conclusions of any kind.

**The preview tier is a seeded uniform random sample, not the brightest bodies.** The obvious way
to build a small first-paint tier is a magnitude cut. It is measurably wrong here, because at fixed
size an outer-belt body is fainter than an inner-belt one:

| Tier | Belt bodies inside 2.825 AU | Outside | Share outside |
|---|---|---|---|
| Full catalogue | 956,187 | 503,910 | **34.5 %** |
| Brightness cut, H < 15 | 30,603 | 32,167 | **51.3 %** |
| Uniform random sample | 51,492 | 26,798 | **34.2 %** |

A brightness-limited tier reports the outer belt as half the population when it is really a third
— a 16.7 percentage-point distortion of exactly the structure this page exists to show. The
uniform sample lands within 0.28 points. Seed **20260907**.

---

## Numerical accuracy

`scripts/accuracy.mjs` runs the **production vertex shader** over 2,000 bodies stratified across
eccentricity deciles, reads the positions back from a float render target, and compares them
against a float64 CPU solve. The GLSL and the JS reference share one copy of the propagation code
(`PROPAGATE_GLSL` in `src/shaders.js`), so the probe cannot silently test a different solver.

Positional error, in AU:

| | Median | p99 | Max |
|---|---|---|---|
| **At the reference epoch** | | | |
| 16-bit element quantisation | 1.246e-4 | 2.936e-3 | 1.613e-2 |
| Shader solver, float32 | 6.28e-7 | 1.435e-5 | 1.413e-4 |
| **Total** | **1.244e-4** | 2.936e-3 | 1.599e-2 |
| **Ten years from the epoch** | | | |
| 16-bit element quantisation | 2.375e-3 | 9.883e-3 | 2.422e-2 |
| Shader solver, float32 | 5.738e-6 | 2.785e-5 | 7.295e-5 |
| **Total** | **2.378e-3** | 9.877e-3 | 2.426e-2 |

**The file format costs about 400× more accuracy than doing the maths on the GPU.** The growth
between the two blocks is the semi-major-axis quantisation being multiplied by the mean motion:
a small error in `a` becomes along-track drift over a decade.

### The solver, and a defect the harness found

The shader uses a **Mikkola cubic starter followed by three Halley iterations** in float32. The
first implementation used the more common Danby starter. Measured against a bisection reference
across 4,001 mean anomalies (`scripts/kepler-probe.mjs`):

| e | Danby + 3 Halley | Mikkola + 3 Halley |
|---|---|---|
| 0.5 | 4.44e-16 rad | 4.44e-16 rad |
| 0.9 | 8.88e-16 | 5.55e-16 |
| 0.95 | 3.36e-11 | 7.77e-16 |
| 0.99 | 4.38e-5 | 1.11e-15 |
| 0.999 | 3.09e-2 | 1.50e-15 |
| **0.9996** | **7.63e-2** | **1.28e-15** |

The maximum eccentricity in this catalogue is **0.9996**, so the original starter was degrading to
0.076 rad of eccentric-anomaly error on real records. The shipped solver holds machine precision at
every eccentricity present.

> Worth recording: the first version of that comparison used Newton from `E = M` as its
> "reference". Newton from that start is itself unstable at high eccentricity, so the reference was
> the thing diverging, and it briefly made a working solver look catastrophically broken.
> `f(E) = E − e·sin E − M` is strictly increasing for `e < 1` and `|E − M| ≤ e < 1`, so bisection
> on `[M−1, M+1]` cannot fail. That is the reference now.

---

## Rendering

Density is the message: a pixel is bright because many bodies land on it. That only works if the
exposure is right, so two things are handled explicitly.

**Per-point opacity scales with the number of bodies loaded.** A fixed alpha tuned for 120,000
points saturates to flat white at 1.5 million and erases every gap. Opacity is scaled by
`referenceCount / bodyCount`, so switching tiers changes the resolution of the picture, not its
exposure.

**Accumulation happens in a half-float buffer and is tone-mapped in a second pass.** Additive
blending straight to an 8-bit canvas clips each channel independently, so a dense blue region hits
1.0 in blue long before red and the belt turns electric primary. The composite pass applies
`1 − exp(−hdr · exposure)`, which saturates all three channels together: dense cores go white-hot,
hue survives in the wings where it is actually informative.

The daylight stage runs the same pipeline inverted — density absorbs rather than emits, giving a
printed-plate look — rather than being the dark theme with its tokens flipped.

**Size-by-magnitude is off by default.** When point size varies, brightness stops being a pure
density map and the gaps get confounded with the size of the bodies around them. The control
exists and says so.

---

## Fallbacks

- **No JavaScript:** the served HTML already contains a plan view of a stated 2,400-body uniform
  sample (with the decimation ratio, 1 in 651, printed inside the figure), the semi-major-axis
  histogram computed over **all** renderable bodies between 1.7 and 3.6 AU with no decimation at
  all, and the complete class and provenance tables. Built by `scripts/build-fallback.mjs` and
  injected at build time, not by script at run time.
- **No WebGL2:** same fallback, no console errors.
- **`prefers-reduced-motion: reduce`:** the orbital animation does not autostart. The time control,
  the scrubber and every view remain operable, so no state is unreachable.

---

## Reproducing every number

```bash
npm install

# 1. fetch the catalogue (about 276 MB; the exact commands are in scripts/fetch.sh)
bash scripts/fetch.sh

# 2. recompute every figure from the JSON on disk -> data/audit.json
npm run audit

# 3. pack the wire format and the manifest -> public/data/
npm run pack
node scripts/extract-planets.mjs
node scripts/build-fallback.mjs

# 4. build and measure
npm run build

# 5. drive the real thing in a real browser and prove it rendered
npx vite preview --port 4173 --strictPort   # in another shell
npm run shoot        # -> docs/*.png + docs/render-report.json
npm run accuracy     # -> docs/accuracy-report.json

# 6. verify nothing has drifted
npm run check
```

`npm run check` runs 43 assertions, every one of which re-derives its expected value from the data
rather than hard-coding it. It checks, among other things, that the packed byte count equals
`bodies × 14`, that the semi-major-axis column really is sorted, that the packed class indices fit
the manifest's class table, that the built HTML contains the real body count and no unreplaced
build tokens, that every screenshot has genuine image content, and that the gaps are still
detectable in the rendered pixels.

### Screenshots

`docs/` holds the captured evidence. Every PNG is decoded and checked for pixel variance before it
is accepted — a blank canvas that saved successfully is a failure, not a pass.

| File | What it shows |
|---|---|
| `01-belt-preview.png` | Opening view, 120,000-body preview tier |
| `02-belt-full.png` | The whole catalogue, true positions |
| `03-kirkwood-gaps.png` | Plan view, circularised: **the gaps** |
| `04-kirkwood-gaps-detail.png` | Cropped detail of the lanes |
| `05-trojans.png` | The Jupiter Trojans as two swarms |
| `06-inclination-fan.png` | Vertical exaggeration ×14 |
| `07-outer-system.png` | Trans-Neptunian objects and Centaurs |
| `08-daylight-plate.png` | The daylight stage |
| `09-receipts.png` | The in-page receipts sheet |
| `10-selection-ceres.png` | A body selected by name with its orbit drawn |
| `11-narrow.png` | 420 CSS px |
| `12-no-javascript.png` | JavaScript disabled |
| `13-reduced-motion.png` | `prefers-reduced-motion: reduce` — the animation does not autostart |

`docs/a11y-report.json` records a keyboard traversal of the live page: **39 reachable controls**, a
painted focus ring, Escape closing the receipts sheet, the time control driven entirely from the
keyboard, and reduced motion leaving the rate at 0 while every view stays reachable. The only
controls under 32 px are three inline links inside sentences, which WCAG 2.5.8 exempts.

---

## What this deliberately does not do

- **No n-body integration and no perturbations.** Two-body Keplerian propagation from published
  elements only.
- **No planets as textured worlds.** Planets are their orbit ellipses and a mark. This is not a
  solar system simulator and must not invite the comparison.
- **No close-approach, hazard or impact framing.** That is JPL CNEOS's job, and getting it subtly
  wrong would be the worst possible outcome for a page like this.
- **No comets in the animated field.** All 4,075 are counted and reported; their eccentricities do
  not fit the quantisation ranges chosen for the belt, so they are not drawn.
- **No count-up animations on any measured number.** 1,562,531 renders as 1,562,531 on the first
  frame. The geometry settles; the numeral does not.

---

## Portfolio card

**Teaser:** Solved every frame

**Tagline:** Every catalogued small body in the solar system, positioned each frame by solving
Kepler's equation on the GPU from its own published orbital elements.

---

## Licence

Code: MIT. See `LICENSE`.

Data: NASA/JPL Small-Body Database and JPL Solar System Dynamics. Not subject to copyright;
credited on the face of the page and above.

---

<p>
Built by <a href="https://agentjames.vercel.app">James Lorenz Santos</a> ·
<a href="https://www.linkedin.com/in/james-lorenz-santos-720776251/">LinkedIn</a>
</p>
