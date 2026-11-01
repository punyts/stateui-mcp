import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The folder of this package (the one with `package.json`), found from this file, so it works from `src` and from `dist` */
export function packageRoot(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
        if (existsSync(join(dir, 'package.json'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) throw new Error('package.json of @punyts/stateui-mcp not found');
        dir = parent;
    }
}
