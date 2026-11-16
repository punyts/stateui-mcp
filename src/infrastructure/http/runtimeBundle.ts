import { existsSync, readFileSync } from 'node:fs';
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

/**
 * Reads the manifest and the script, or throws a message that says how to build the bundle. With `components` (the
 * names in the component catalog the server serves), it also throws when the bundle was built without some of them:
 * a bundle older than the library would draw those components as unknown nodes. A manifest without a component list
 * (from an older build) is not checked
 */
export function loadRuntimeBundle(dir: string | undefined, components?: readonly string[]): RuntimeBundle {
    const resolved = resolveRuntimeDir(dir);
    if (resolved === undefined) {
        throw new Error('The StateUI runtime bundle was not found. Build it with "npm run build:runtime-bundle" in @punyts/stateui-app, or pass --runtime-dir');
    }
    const manifest: unknown = JSON.parse(readFileSync(join(resolved, 'manifest.json'), 'utf8'));
    if (typeof manifest !== 'object' || manifest === null || !('hash' in manifest) || typeof manifest.hash !== 'string' || !HASH_PATTERN.test(manifest.hash)) {
        throw new Error(`manifest.json in ${resolved} has no valid hash`);
    }
    if (components !== undefined && 'components' in manifest && Array.isArray(manifest.components)) {
        const built = new Set<unknown>(manifest.components);
        const missing = components.filter((name) => !built.has(name));
        if (missing.length > 0) {
            throw new Error(
                `The StateUI runtime bundle in ${resolved} is older than the component library: it has no ${missing.map((name) => `"${name}"`).join(', ')}. ` +
                    'Rebuild it with "npm run build:runtime-bundle" in @punyts/stateui-app'
            );
        }
    }
    return { hash: manifest.hash, script: readFileSync(join(resolved, `${manifest.hash}.js`)) };
}

/** The built 3D renderer chunk of `@punyts/stateui-3d`: one content-hashed classic script the runtime loads on demand */
export type RuntimeChunk = RuntimeBundle;

/**
 * The folder of the built 3D chunk: `dir` when given, else `dist/runtime-chunk` of `@punyts/stateui-3d` through its
 * package exports. Undefined when the package (an optional dependency) is not installed or not built
 */
export function resolveChunk3dDir(dir: string | undefined): string | undefined {
    if (dir !== undefined) return dir;
    try {
        return dirname(createRequire(import.meta.url).resolve('@punyts/stateui-3d/runtime-chunk/manifest.json'));
    } catch {
        return undefined;
    }
}

/**
 * Reads the 3D chunk's manifest and script, or gives undefined when there is no chunk (no package, or a folder with no
 * `manifest.json`): the server then starts normally and names no chunk to the runtime, so a scene shows its fallback.
 * A manifest without a valid hash, or a missing script, throws
 */
export function loadChunk3d(dir: string | undefined): RuntimeChunk | undefined {
    const resolved = resolveChunk3dDir(dir);
    if (resolved === undefined || !existsSync(join(resolved, 'manifest.json'))) return undefined;
    const manifest: unknown = JSON.parse(readFileSync(join(resolved, 'manifest.json'), 'utf8'));
    if (typeof manifest !== 'object' || manifest === null || !('hash' in manifest) || typeof manifest.hash !== 'string' || !HASH_PATTERN.test(manifest.hash)) {
        throw new Error(`manifest.json in ${resolved} has no valid hash`);
    }
    return { hash: manifest.hash, script: readFileSync(join(resolved, `${manifest.hash}.js`)) };
}

/**
 * The stylesheet of the runtime page. Without it the browser's 8 px body margin frames the app in white (in a dark
 * theme too) and the root component has no height to fill, so a table or record list sized to its container shrinks
 * to its minimum
 */
export const RUNTIME_CSS = `html { height: 100%; }
/* a grid stretches the root component (inside display: contents wrappers) to at least the frame height */
body { margin: 0; min-height: 100%; display: grid; }
`;

/** The page the sandboxed frame loads: no inline script and no inline style, which the policy blocks */
export function runtimePage(hash: string): string {
    return [
        '<!doctype html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>Runtime</title>',
        '<link rel="stylesheet" href="./runtime.css">',
        '</head>',
        '<body>',
        `<script src="./${hash}.js"></script>`,
        '</body>',
        '</html>',
        ''
    ].join('\n');
}
