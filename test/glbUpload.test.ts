import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALLOWED_FILE_TYPES, GLB_TYPE } from '../src/domain/UiFile.js';
import { FORM_ROOT, call, createApp, httpHarness, noBrowser, tempData } from './helpers.js';
import type { HttpHarness, TempData } from './helpers.js';

let data: TempData;
let harness: HttpHarness;
let origin = '';
let appId = '';

beforeAll(async () => {
    data = await tempData();
    harness = await httpHarness(data.dir, noBrowser);
    origin = harness.server.origin;
    appId = (await createApp(harness.client, 'models', FORM_ROOT)).id;
});

afterAll(async () => {
    await harness.close();
    await data.cleanup();
});

function upload(bytes: Uint8Array, name: string, claimed = ''): Promise<Response> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: claimed }), name);
    return fetch(`${origin}/apps/${appId}/files`, { method: 'POST', body: form });
}

/** A GLB 2 with one JSON chunk; the header length is the file size unless given */
function glb(options: { version?: number; length?: number } = {}): Uint8Array {
    const json = new TextEncoder().encode('{"asset":{"version":"2.0"}}  ');
    const bytes = new Uint8Array(12 + 8 + json.length);
    const view = new DataView(bytes.buffer);
    bytes.set([0x67, 0x6c, 0x54, 0x46]);
    view.setUint32(4, options.version ?? 2, true);
    view.setUint32(8, options.length ?? bytes.length, true);
    view.setUint32(12, json.length, true);
    view.setUint32(16, 0x4e4f534a, true);
    bytes.set(json, 20);
    return bytes;
}

/** The ids of the files the app keeps on disk */
async function storedIds(): Promise<string[]> {
    try {
        return await readdir(join(data.dir, appId, 'files'));
    } catch {
        return [];
    }
}

describe('GLB files in the file store', () => {
    it('should store a valid GLB as model/gltf-binary and ui_file_read should answer its metadata, not text', async () => {
        const bytes = glb();

        const response = await upload(bytes, 'chair.glb', 'model/gltf-binary');
        const body = (await response.json()) as { id: string; name: string; size: number; type: string };
        const read = await call(harness.client, 'ui_file_read', { app: 'models', fileId: body.id });

        expect(response.status).toBe(201);
        expect(body).toMatchObject({ name: 'chair.glb', size: bytes.length, type: GLB_TYPE });
        expect(read.body).toMatchObject({ file: { id: body.id, name: 'chair.glb', size: bytes.length, type: GLB_TYPE }, text: null });
        expect(await storedIds()).toContain(body.id.toLowerCase());
    });

    it('should refuse a .gltf, a truncated GLB, a wrong version, HTML renamed .glb and an SVG with 415, storing nothing', async () => {
        const encode = (text: string) => new TextEncoder().encode(text);
        const valid = glb();
        const before = await storedIds();

        const refused = [
            await upload(encode('{"asset":{"version":"2.0"},"buffers":[{"uri":"scene.bin","byteLength":4}]}'), 'scene.gltf', 'model/gltf+json'),
            await upload(valid.subarray(0, valid.length - 4), 'cut.glb', 'model/gltf-binary'),
            await upload(glb({ version: 1 }), 'old.glb', 'model/gltf-binary'),
            await upload(encode('<!doctype html><script>alert(1)</script>'), 'page.glb', 'model/gltf-binary'),
            await upload(encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.svg', 'image/svg+xml')
        ];

        for (const response of refused) {
            expect(response.status).toBe(415);
            expect(((await response.json()) as { error: string }).error).toBe('unsupported_type');
        }
        expect((await storedIds()).sort()).toEqual([...before].sort());
    });
});

describe('the host page file-type list', () => {
    it('should be the domain list itself, imported, with no copy of its own', async () => {
        const source = await readFile(new URL('../src/browser/host.ts', import.meta.url), 'utf8');

        expect(source).toMatch(/import \{ ALLOWED_FILE_TYPES \} from '\.\.\/domain\/UiFile\.js';/);
        expect(source).not.toMatch(/const ALLOWED_FILE_TYPES\b/);
        expect(ALLOWED_FILE_TYPES).toContain(GLB_TYPE);
    });
});
