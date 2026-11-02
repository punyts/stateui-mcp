import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempData } from '../../../test/helpers.js';
import { loadSecretKey, parseSecretKey } from './secretKey.js';

const KEY = Buffer.from(randomBytes(32));

describe('parseSecretKey', () => {
    it('should read 64 hex characters, base64 and 32 raw bytes', () => {
        expect(Buffer.from(parseSecretKey(KEY.toString('hex')))).toEqual(KEY);
        expect(Buffer.from(parseSecretKey(` ${KEY.toString('base64')}\n`))).toEqual(KEY);
        expect(Buffer.from(parseSecretKey(new Uint8Array(KEY)))).toEqual(KEY);
    });

    it('should refuse a key of the wrong length or form', () => {
        expect(() => parseSecretKey('abc')).toThrow('must be 32 bytes');
        expect(() => parseSecretKey(KEY.toString('hex').slice(2))).toThrow('must be 32 bytes');
        expect(() => parseSecretKey(new Uint8Array(16))).toThrow('must be 32 bytes');
    });
});

describe('loadSecretKey', () => {
    it('should prefer the file, then the text, and give no key without either', async () => {
        // Arrange
        const data = await tempData();
        const file = join(data.dir, 'key.txt');
        await writeFile(file, KEY.toString('hex'));
        const other = Buffer.from(randomBytes(32)).toString('base64');

        try {
            // Act / Assert
            expect(Buffer.from((await loadSecretKey(file, other)) ?? [])).toEqual(KEY);
            expect(Buffer.from((await loadSecretKey(undefined, other)) ?? [])).toEqual(Buffer.from(other, 'base64'));
            expect(await loadSecretKey(undefined, '')).toBeUndefined();
            expect(await loadSecretKey(undefined, undefined)).toBeUndefined();
        } finally {
            await data.cleanup();
        }
    });
});
