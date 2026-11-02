import { readFile } from 'node:fs/promises';

/** The length of the key that encrypts `$.server` (AES-256-GCM) */
export const SECRET_KEY_BYTES = 32;

/**
 * Reads the key that encrypts `$.server` at rest: 64 hexadecimal characters, the base64 of 32 bytes, or (from a file)
 * 32 raw bytes. Surrounding whitespace is ignored. Throws when the text is none of these
 */
export function parseSecretKey(content: Uint8Array | string): Uint8Array {
    const raw = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const text = raw.toString('utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(text)) return new Uint8Array(Buffer.from(text, 'hex'));
    if (/^[A-Za-z0-9+/]{43}=?$/.test(text)) {
        const decoded = Buffer.from(text, 'base64');
        if (decoded.length === SECRET_KEY_BYTES) return new Uint8Array(decoded);
    }
    if (typeof content !== 'string' && raw.length === SECRET_KEY_BYTES) return new Uint8Array(raw);
    throw new Error(`The secret key must be ${SECRET_KEY_BYTES} bytes: 64 hex characters, base64, or a file of raw bytes`);
}

/** The key from `--secret-key-file`, else from the key text in the environment, else none */
export async function loadSecretKey(file: string | undefined, text: string | undefined): Promise<Uint8Array | undefined> {
    if (file !== undefined) return parseSecretKey(await readFile(file));
    if (text !== undefined && text !== '') return parseSecretKey(text);
    return undefined;
}
