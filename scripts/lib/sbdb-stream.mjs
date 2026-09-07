// Streaming row reader for NASA/JPL SBDB Query API JSON.
//
// The API returns one enormous single-line document of the shape
//   {"signature":{...},"fields":[...],"data":[[...],[...],...],"count":N}
// which is far too large to JSON.parse whole (the 1.56M-row full-precision
// asteroid file is ~250 MB of text and would need multiple GB of heap once
// materialised as 1.56M JS arrays of 11 boxed values).
//
// So: scan the byte stream, isolate one `[...]` row at a time, and hand it to
// the caller. The caller keeps only the numbers it wants, in typed arrays.
// Peak heap stays flat regardless of catalogue size.

import { createReadStream } from 'node:fs';

const OPEN = 0x5b; // [
const CLOSE = 0x5d; // ]
const QUOTE = 0x22; // "
const BACKSLASH = 0x5c;

/**
 * Read the SBDB envelope and stream every data row.
 *
 * @param {string} path            file to read
 * @param {(row: unknown[], index: number) => void} onRow
 * @returns {Promise<{fields: string[], count: number|null, rows: number, signature: object|null}>}
 */
export async function streamSbdbRows(path, onRow) {
  const stream = createReadStream(path, { highWaterMark: 1 << 22 });

  let head = ''; // buffered text until we have located "data":[
  let inData = false;
  let done = false;

  let rowStart = -1; // index into `pending` where the current row began
  let depth = 0;
  let inString = false;
  let escaped = false;
  let pending = ''; // text of the current partial row
  let rows = 0;

  let fields = [];
  let signature = null;
  let count = null;
  let tail = ''; // text after the data array closes

  const DATA_KEY = '"data":[';

  for await (const chunk of stream) {
    let text = chunk.toString('latin1');

    if (!inData) {
      head += text;
      const at = head.indexOf(DATA_KEY);
      if (at === -1) continue;

      const envelope = head.slice(0, at);
      const fieldsAt = envelope.indexOf('"fields":');
      if (fieldsAt !== -1) {
        const openAt = envelope.indexOf('[', fieldsAt);
        const closeAt = envelope.indexOf(']', openAt);
        fields = JSON.parse(envelope.slice(openAt, closeAt + 1));
      }
      const sigAt = envelope.indexOf('"signature":');
      if (sigAt !== -1) {
        const openAt = envelope.indexOf('{', sigAt);
        const closeAt = envelope.indexOf('}', openAt);
        try {
          signature = JSON.parse(envelope.slice(openAt, closeAt + 1));
        } catch {
          signature = null;
        }
      }

      text = head.slice(at + DATA_KEY.length);
      head = '';
      inData = true;
    }

    if (done) {
      tail += text;
      continue;
    }

    // Scan this chunk for complete rows.
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (c === BACKSLASH) {
          escaped = true;
        } else if (c === QUOTE) {
          inString = false;
        }
        continue;
      }

      if (c === QUOTE) {
        inString = true;
        continue;
      }

      if (c === OPEN) {
        if (depth === 0) rowStart = i;
        depth++;
        continue;
      }

      if (c === CLOSE) {
        if (depth === 0) {
          // This closes the data array itself.
          done = true;
          tail = text.slice(i + 1);
          break;
        }
        depth--;
        if (depth === 0) {
          const text_ = rowStart === -1 ? pending + text.slice(0, i + 1) : text.slice(rowStart, i + 1);
          onRow(JSON.parse(text_), rows);
          rows++;
          pending = '';
          rowStart = -1;
        }
      }
    }

    if (!done && depth > 0) {
      // A row straddles the chunk boundary; carry its prefix forward.
      pending += rowStart === -1 ? text : text.slice(rowStart);
      rowStart = -1;
    }
  }

  const countAt = tail.indexOf('"count":');
  if (countAt !== -1) {
    const parsed = Number.parseInt(tail.slice(countAt + 8).replace(/[^0-9-]/g, ''), 10);
    if (Number.isFinite(parsed)) count = parsed;
  }

  return { fields, count, rows, signature };
}
