// Bundles the live view page's host script with @punyts/state-sync into one file the server serves as /assets/host.js
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await build({
    entryPoints: [resolve(root, 'src/browser/host.ts')],
    outfile: resolve(root, 'dist/browser/host.js'),
    bundle: true,
    format: 'iife',
    target: 'es2022',
    platform: 'browser',
    legalComments: 'none',
    logLevel: 'warning'
});
