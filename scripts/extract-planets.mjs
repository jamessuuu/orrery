// extract-planets.mjs — pull Table 1 of JPL SSD "Approximate Positions of the
// Major Planets" out of the fetched HTML into a JSON the app imports.
//
// Table 1 is the 1800 AD - 2050 AD fit, which is the correct one for this
// project's time range. Table 2 (3000 BC - 3000 AD) needs extra correction
// terms and is deliberately not used.
//
//   node scripts/extract-planets.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const NAMES = ['Mercury', 'Venus', 'EM Bary', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'];
const LABEL = { 'EM Bary': 'Earth' };

export function extractPlanets() {
  const src = join(ROOT, 'data', 'planets-approx-pos.html');
  const html = readFileSync(src, 'utf8');
  const pre = /<pre>([\s\S]*?)<\/pre>/g;
  const blocks = [];
  let m;
  while ((m = pre.exec(html)) !== null) blocks.push(m[1].replace(/<[^>]+>/g, ''));
  if (blocks.length === 0) throw new Error('no <pre> table found in planets-approx-pos.html');

  const table1 = blocks[0];
  const lines = table1.split('\n');
  const planets = [];

  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    const name = NAMES.find((nm) => line.startsWith(nm));
    if (!name) continue;
    const values = line
      .slice(name.length)
      .trim()
      .split(/\s+/)
      .map(Number);
    const rates = (lines[k + 1] || '').trim().split(/\s+/).map(Number);
    // The page also carries prose footnotes that begin with a planet name
    // ("EM Bary = Earth/Moon Barycenter"). Anything that is not six numbers
    // followed by six numbers is not a data row.
    if (values.length !== 6 || rates.length !== 6 || values.some(Number.isNaN) || rates.some(Number.isNaN)) {
      continue;
    }
    planets.push({
      name: LABEL[name] || name,
      sourceRow: name,
      // a (au), e, I (deg), L (deg), longPeri (deg), longNode (deg)
      elements: values,
      // per Julian century
      rates,
    });
  }

  if (planets.length < 8) throw new Error(`expected at least 8 planets, parsed ${planets.length}`);

  return {
    source: 'JPL Solar System Dynamics, Approximate Positions of the Major Planets, Table 1 (1800 AD - 2050 AD)',
    url: 'https://ssd.jpl.nasa.gov/planets/approx_pos.html',
    fetchedUTC: '2026-09-07',
    htmlBytes: Buffer.byteLength(html),
    htmlSha256: createHash('sha256').update(readFileSync(src)).digest('hex'),
    epoch: 'J2000 (JD 2451545.0)',
    columns: ['a_au', 'e', 'I_deg', 'L_deg', 'longPeri_deg', 'longNode_deg'],
    rateUnits: 'per Julian century',
    planets,
  };
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  const out = extractPlanets();
  const dest = join(ROOT, 'public', 'data', 'planets.json');
  writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${dest}`);
  for (const p of out.planets) console.log(`  ${p.name.padEnd(8)} a=${p.elements[0]} e=${p.elements[1]} I=${p.elements[2]}`);
  process.exitCode = 0;
}
