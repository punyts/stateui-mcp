import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The browser host script is bundled with its sync client by esbuild; build it before the tests serve it */
export default function setup(): void {
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/build-host.mjs')], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) throw new Error('The browser host script did not build');
}
