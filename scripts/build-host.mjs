// Bundles the embedded live view page's host script (src/browser/hostPage.ts) with @punyts/state-sync into one file the server serves as /assets/host.js
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await build({
    entryPoints: [resolve(root, 'src/browser/hostPage.ts')],
    outfile: resolve(root, 'dist/browser/host.js'),
    bundle: true,
    format: 'iife',
    target: 'es2022',
    platform: 'browser',
    legalComments: 'none',
    logLevel: 'warning'
});
