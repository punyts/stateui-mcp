import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The browser host script is compiled by its own tsconfig; build it when it is missing or older than its source */
export default function setup(): void {
    const source = resolve(root, 'src/browser/host.ts');
    const built = resolve(root, 'dist/browser/host.js');
    if (!existsSync(source)) return;
    if (existsSync(built) && statSync(built).mtimeMs >= statSync(source).mtimeMs) return;
    const result = spawnSync(process.execPath, [resolveTsc(), '-p', 'tsconfig.browser.json'], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) throw new Error('The browser host script did not compile');
}

function resolveTsc(): string {
    let dir = root;
    for (;;) {
        const candidate = resolve(dir, 'node_modules/typescript/bin/tsc');
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) throw new Error('typescript is not installed');
        dir = parent;
    }
}
