import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 5;

function errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

async function renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            await rename(from, to);
            return;
        } catch (error) {
            const code = errorCode(error);
            // Windows refuses a rename onto a file that a reader (or a virus scanner) has open for a moment
            if (attempt >= RENAME_ATTEMPTS || code === undefined || !RETRYABLE.has(code)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
        }
    }
}

/** Writes to a temporary file in the same folder and renames it over `path`, so a reader sees the old or the new content, never half */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, data);
        await renameWithRetry(temporary, path);
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}

/** Writes a value as JSON. The key order of the value is the order on disk */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
    await writeFileAtomic(path, JSON.stringify(value, null, 2));
}

/** Reads a JSON file, or `undefined` when it does not exist. A file that is not valid JSON is an error */
export async function readJson(path: string): Promise<unknown> {
    let text: string;
    try {
        text = await readFile(path, 'utf8');
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
    }
    return JSON.parse(text) as unknown;
}

export function isMissing(error: unknown): boolean {
    return errorCode(error) === 'ENOENT';
}
