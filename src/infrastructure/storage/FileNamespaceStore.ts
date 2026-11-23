import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StoredNamespace } from '@punyts/state-sync/authority';
import type { InstanceNamespaceStore } from './NamespaceUiInstanceRepository.js';

/**
 * Stored namespaces as files, for a server that keeps its parts in files: `<dataDir>/namespaces/<address>.json`, the
 * address URI-encoded, one whole namespace per file. One process writes them, so epochs are not checked
 */
export class FileNamespaceStore implements InstanceNamespaceStore {
    private readonly dir: string;

    constructor(dataDir: string) {
        this.dir = join(dataDir, 'namespaces');
    }

    async load(address: string): Promise<StoredNamespace | undefined> {
        try {
            return JSON.parse(await readFile(this.file(address), 'utf8')) as StoredNamespace;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
        }
    }

    async save(address: string, stored: StoredNamespace): Promise<void> {
        await mkdir(this.dir, { recursive: true });
        const file = this.file(address);
        await writeFile(`${file}.tmp`, JSON.stringify(stored));
        await rename(`${file}.tmp`, file);
    }

    async remove(address: string): Promise<void> {
        await rm(this.file(address), { force: true });
    }

    private file(address: string): string {
        return join(this.dir, `${encodeURIComponent(address)}.json`);
    }
}
