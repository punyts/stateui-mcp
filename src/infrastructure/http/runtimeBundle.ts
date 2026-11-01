import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const HASH_PATTERN = /^[0-9a-f]{16}$/;

/** The built runtime bundle of `@punyts/stateui-app`: one content-hashed classic script, read once at start-up */
export interface RuntimeBundle {
    readonly hash: string;
    readonly script: Buffer;
}

/** The folder of the built bundle: `dir` when given, else `dist/runtime-bundle` of `@punyts/stateui-app` through its package exports */
export function resolveRuntimeDir(dir: string | undefined): string | undefined {
    if (dir !== undefined) return dir;
    try {
        return dirname(createRequire(import.meta.url).resolve('@punyts/stateui-app/runtime-bundle/manifest.json'));
    } catch {
        return undefined;
    }
}

/** Reads the manifest and the script, or throws a message that says how to build the bundle */
export function loadRuntimeBundle(dir: string | undefined): RuntimeBundle {
    const resolved = resolveRuntimeDir(dir);
    if (resolved === undefined) {
        throw new Error('The StateUI runtime bundle was not found. Build it with "npm run build:runtime-bundle" in @punyts/stateui-app, or pass --runtime-dir');
    }
    const manifest: unknown = JSON.parse(readFileSync(join(resolved, 'manifest.json'), 'utf8'));
    if (typeof manifest !== 'object' || manifest === null || !('hash' in manifest) || typeof manifest.hash !== 'string' || !HASH_PATTERN.test(manifest.hash)) {
        throw new Error(`manifest.json in ${resolved} has no valid hash`);
    }
    return { hash: manifest.hash, script: readFileSync(join(resolved, `${manifest.hash}.js`)) };
}

/** The page the sandboxed frame loads: no inline script and no inline style, which the policy blocks */
export function runtimePage(hash: string): string {
    return [
        '<!doctype html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>Runtime</title>',
        '</head>',
        '<body>',
        `<script src="./${hash}.js"></script>`,
        '</body>',
        '</html>',
        ''
    ].join('\n');
}
