import { defineConfig } from 'vite';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Injects the build-time static twin and the headline numbers into index.html.
 * Both come from files that scripts/build-fallback.mjs writes out of the real
 * catalogue, so index.html cannot carry a number the data does not support.
 */
function staticTwin() {
  return {
    name: 'orrery-static-twin',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const fbPath = resolve(process.cwd(), 'src/fallback.generated.html');
        const tokPath = resolve(process.cwd(), 'src/fallback.tokens.json');
        if (!existsSync(fbPath) || !existsSync(tokPath)) {
          throw new Error('run `node scripts/build-fallback.mjs` before building: src/fallback.generated.html is missing');
        }
        const fallback = readFileSync(fbPath, 'utf8');
        const tokens = JSON.parse(readFileSync(tokPath, 'utf8'));
        let out = html.replace('<!--ORRERY:FALLBACK-->', fallback);
        for (const [k, v] of Object.entries(tokens)) out = out.split(`{{${k}}}`).join(v);
        return out;
      },
    },
  };
}

export default defineConfig({
  plugins: [staticTwin()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        // One bundle, so the measurement in the README is a single number
        // rather than a sum a reader has to trust.
        manualChunks: undefined,
      },
    },
  },
});
