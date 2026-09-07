// png.mjs — just enough PNG to prove a screenshot is not blank.
//
// A saved file is not evidence. This decodes the PNG Playwright wrote and
// reports real pixel statistics, so "the screenshot exists" can never be
// mistaken for "the scene rendered".

import { inflateSync } from 'node:zlib';

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }

  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('interlaced PNG not supported');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  let ip = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[ip++];
    const line = raw.subarray(ip, ip + stride);
    ip += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = v + a; break;
        case 2: v = v + b; break;
        case 3: v = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad filter ${filter}`);
      }
      cur[x] = v & 0xff;
    }
  }

  return { width, height, channels, data: out };
}

/**
 * Statistics that distinguish a rendered scene from a flat fill.
 * `distinctLuma` is the one that matters: a blank canvas has 1.
 */
export function imageStats(png) {
  const { width, height, channels, data } = png;
  const n = width * height;
  const hist = new Uint32Array(256);
  let sum = 0;
  let sumSq = 0;
  let min = 255;
  let max = 0;

  for (let i = 0; i < n; i++) {
    const o = i * channels;
    const luma = channels === 1 ? data[o] : Math.round(0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]);
    hist[luma]++;
    sum += luma;
    sumSq += luma * luma;
    if (luma < min) min = luma;
    if (luma > max) max = luma;
  }

  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  let distinct = 0;
  let modeCount = 0;
  for (let v = 0; v < 256; v++) {
    if (hist[v] > 0) distinct++;
    if (hist[v] > modeCount) modeCount = hist[v];
  }

  return {
    width,
    height,
    meanLuma: Number(mean.toFixed(3)),
    stdDevLuma: Number(Math.sqrt(Math.max(0, variance)).toFixed(3)),
    minLuma: min,
    maxLuma: max,
    distinctLumaValues: distinct,
    dominantLumaShare: Number((modeCount / n).toFixed(4)),
  };
}

/** A screenshot is only evidence if it has real structure in it. */
export function isRendered(stats) {
  return stats.distinctLumaValues >= 12 && stats.stdDevLuma >= 1.5 && stats.dominantLumaShare < 0.999;
}
