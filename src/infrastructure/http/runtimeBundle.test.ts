import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRuntimeBundle } from './runtimeBundle.js';

const HASH = '0123456789abcdef';

describe('loadRuntimeBundle', () => {
    let dir = '';
    const write = (manifest: object): string => {
        dir = mkdtempSync(join(tmpdir(), 'runtime-bundle-'));
        writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
        writeFileSync(join(dir, `${HASH}.js`), 'window.name = "bundle";');
        return dir;
    };

    afterEach(() => {
        if (dir !== '') rmSync(dir, { recursive: true, force: true });
        dir = '';
    });

    it('should read the script named by the manifest hash', () => {
        // Arrange
        const folder = write({ hash: HASH, script: `${HASH}.js`, components: ['button'] });

        // Act
        const bundle = loadRuntimeBundle(folder, ['button']);

        // Assert
        expect(bundle.hash).toBe(HASH);
        expect(bundle.script.toString()).toBe('window.name = "bundle";');
    });

    it('should name the components a bundle older than the catalog lacks, and say how to rebuild it', () => {
        // Arrange
        const folder = write({ hash: HASH, script: `${HASH}.js`, components: ['button'] });

        // Act and assert
        expect(() => loadRuntimeBundle(folder, ['button', 'tree', 'window'])).toThrow(/older than the component library: it has no "tree", "window"\..*npm run build:runtime-bundle/);
    });

    it('should not check a manifest without a component list, or a load without catalog names', () => {
        // Arrange
        const old = write({ hash: HASH, script: `${HASH}.js` });

        // Act and assert
        expect(loadRuntimeBundle(old, ['button']).hash).toBe(HASH);
        expect(loadRuntimeBundle(old).hash).toBe(HASH);
    });
});
