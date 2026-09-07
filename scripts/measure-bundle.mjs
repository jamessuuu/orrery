// measure-bundle.mjs — print what the build actually weighs.
//
// Run after `vite build`. Reports raw / gzip / brotli for the JavaScript, the
// CSS and the served HTML separately, plus the first-paint total, so nobody has
// to guess which of those a headline figure refers to.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(ROOT, 'dist');

function sizes(buf) {
  return {
    raw: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    brotli: brotliCompressSync(buf, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
    }).length,
  };
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export function measureBundle() {
  const files = walk(DIST);
  const groups = { js: [], css: [], html: [], data: [], other: [] };
  for (const f of files) {
    const rel = f.slice(DIST.length + 1).replace(/\\/g, '/');
    const ext = extname(f).toLowerCase();
    const bucket =
      ext === '.js' ? 'js' : ext === '.css' ? 'css' : ext === '.html' ? 'html' : rel.startsWith('data/') ? 'data' : 'other';
    groups[bucket].push({ rel, ...sizes(readFileSync(f)) });
  }

  const sum = (arr) =>
    arr.reduce((acc, x) => ({ raw: acc.raw + x.raw, gzip: acc.gzip + x.gzip, brotli: acc.brotli + x.brotli }), {
      raw: 0,
      gzip: 0,
      brotli: 0,
    });

  const js = sum(groups.js);
  const css = sum(groups.css);
  const html = sum(groups.html);
  const preview = groups.data.find((d) => d.rel.endsWith('orrery-preview.bin')) || { raw: 0, gzip: 0, brotli: 0 };
  const full = groups.data.find((d) => d.rel.endsWith('orrery-full.bin')) || { raw: 0, gzip: 0, brotli: 0 };
  const manifest = groups.data.find((d) => d.rel.endsWith('orrery-manifest.json')) || { raw: 0, gzip: 0, brotli: 0 };
  const planets = groups.data.find((d) => d.rel.endsWith('planets.json')) || { raw: 0, gzip: 0, brotli: 0 };

  const codeShell = {
    raw: js.raw + css.raw + html.raw,
    gzip: js.gzip + css.gzip + html.gzip,
    brotli: js.brotli + css.brotli + html.brotli,
  };
  const firstPaint = {
    raw: codeShell.raw + preview.raw + manifest.raw + planets.raw,
    gzip: codeShell.gzip + preview.gzip + manifest.gzip + planets.gzip,
    brotli: codeShell.brotli + preview.brotli + manifest.brotli + planets.brotli,
  };

  return { files: groups, js, css, html, codeShell, preview, full, manifest, planets, firstPaint };
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  const m = measureBundle();
  const row = (label, s) =>
    `${label.padEnd(34)} ${String(s.raw).padStart(11)} ${String(s.gzip).padStart(11)} ${String(s.brotli).padStart(11)}`;
  console.log('');
  console.log(`${''.padEnd(34)} ${'raw'.padStart(11)} ${'gzip'.padStart(11)} ${'brotli'.padStart(11)}`);
  console.log('-'.repeat(72));
  for (const f of m.files.js) console.log(row(`  js  ${f.rel}`, f));
  for (const f of m.files.css) console.log(row(`  css ${f.rel}`, f));
  for (const f of m.files.html) console.log(row(`  html ${f.rel}`, f));
  console.log('-'.repeat(72));
  console.log(row('CODE SHELL (js + css + html)', m.codeShell));
  console.log(row('  of which JavaScript', m.js));
  console.log(row('preview tier (120k bodies)', m.preview));
  console.log(row('FIRST PAINT TOTAL', m.firstPaint));
  console.log(row('full tier, on demand', m.full));
  console.log('');
  writeFileSync(join(ROOT, 'docs', 'bundle-measurement.json'), JSON.stringify(m, null, 2) + '\n');
  process.exitCode = 0;
}
