import { MAX_READ_TEXT_BYTES, isTextReadableType } from '../../domain/UiFile.js';
import type { UiFileReference } from '../../domain/UiFile.js';
import type { ReadFile } from './ReadFile.js';

export const NOT_TEXT_NOTE = 'This file type cannot be read as text; only the reference is returned.';

export type ReadFileTextResult =
    | { readonly kind: 'found'; readonly file: UiFileReference; readonly text: string | null; readonly truncated: boolean; readonly note?: string }
    | { readonly kind: 'not-found' };

/** Index to cut `bytes` at so that no UTF-8 character is split: backs up over continuation bytes to the lead byte */
function characterBoundary(bytes: Uint8Array, limit: number): number {
    let cut = limit;
    while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut--;
    return cut;
}

/**
 * Reads an uploaded file for a minion. The text types come back as UTF-8 text of at most `MAX_READ_TEXT_BYTES`,
 * cut at a character boundary; other types come back as the reference with `text: null`. Only the first
 * 256 KiB of a file are read from the store
 */
export class ReadFileText {
    constructor(private readonly readFile: ReadFile) {}

    async execute(appId: string, fileId: string): Promise<ReadFileTextResult> {
        const result = await this.readFile.execute(appId, fileId);
        if (result.kind === 'not-found') return result;
        const { file, content } = result;
        const reference: UiFileReference = { id: file.id, name: file.name, size: file.size, type: file.type };
        if (!isTextReadableType(file.type)) {
            content.destroy();
            return { kind: 'found', file: reference, text: null, truncated: false, note: NOT_TEXT_NOTE };
        }
        const chunks: Buffer[] = [];
        let length = 0;
        try {
            for await (const chunk of content) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
                chunks.push(buffer);
                length += buffer.length;
                if (length > MAX_READ_TEXT_BYTES) break;
            }
        } finally {
            content.destroy();
        }
        const bytes = Buffer.concat(chunks, length);
        if (bytes.length <= MAX_READ_TEXT_BYTES) {
            return { kind: 'found', file: reference, text: new TextDecoder('utf-8').decode(bytes), truncated: false };
        }
        const cut = characterBoundary(bytes, MAX_READ_TEXT_BYTES);
        return { kind: 'found', file: reference, text: new TextDecoder('utf-8').decode(bytes.subarray(0, cut)), truncated: true };
    }
}
