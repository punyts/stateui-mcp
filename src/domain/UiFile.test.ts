import { describe, it, expect } from 'vitest';
import {
    ALLOWED_FILE_TYPES,
    detectFileType,
    detectMagicType,
    GLB_TYPE,
    isAllowedFileType,
    isFileReferenced,
    isTextReadableType,
    MAX_FILE_NAME_LENGTH,
    normaliseFileName,
    zipEntryNames
} from './UiFile.js';

const utf8 = (text: string) => new TextEncoder().encode(text);

/** A minimal ZIP: a local header, central directory entries and the end record */
function zip(...names: string[]): Uint8Array {
    const parts: number[] = [0x50, 0x4b, 0x03, 0x04, ...new Array<number>(26).fill(0)];
    const directoryStart = parts.length;
    for (const name of names) {
        const bytes = [...utf8(name)];
        const header = new Array<number>(46).fill(0);
        header.splice(0, 4, 0x50, 0x4b, 0x01, 0x02);
        header[28] = bytes.length;
        parts.push(...header, ...bytes);
    }
    const directorySize = parts.length - directoryStart;
    const end = new Array<number>(22).fill(0);
    end.splice(0, 4, 0x50, 0x4b, 0x05, 0x06);
    end[10] = names.length;
    end[12] = directorySize;
    end[16] = directoryStart;
    return Uint8Array.from([...parts, ...end]);
}

/** The allowed file types every library keeps, in order: the same literal is in stateui-components' `files.test.ts` */
const SHARED_FILE_TYPES = [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/csv',
    'text/markdown',
    'application/json',
    'model/gltf-binary'
];

/** A GLB: the `glTF` magic, the version and the length in the header (the file's own size unless given), then a JSON chunk */
function glb(options: { version?: number; length?: number } = {}): Uint8Array {
    const json = utf8('{"asset":{"version":"2.0"}}  ');
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

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

describe('detectFileType', () => {
    it('should recognise the images and the PDF by their magic numbers', () => {
        expect(detectFileType('a.bin', PNG)).toBe('image/png');
        expect(detectFileType('a.bin', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
        expect(detectFileType('a.bin', utf8('GIF89a....'))).toBe('image/gif');
        expect(detectFileType('a.bin', utf8('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
        expect(detectFileType('a.bin', utf8('%PDF-1.7\n'))).toBe('application/pdf');
    });

    it('should ignore the name: a PNG named .txt is a PNG', () => {
        expect(detectFileType('notes.txt', PNG)).toBe('image/png');
    });

    it('should accept Word and Excel files by ZIP content types and extension', () => {
        expect(detectFileType('a.docx', zip('[Content_Types].xml', 'word/document.xml'))).toBe(
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        );
        expect(detectFileType('a.xlsx', zip('[Content_Types].xml'))).toBe(
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
    });

    it('should refuse a ZIP without [Content_Types].xml, with another extension, or cut short', () => {
        expect(detectFileType('a.docx', zip('word/document.xml'))).toBeUndefined();
        expect(detectFileType('a.zip', zip('[Content_Types].xml'))).toBeUndefined();
        expect(detectFileType('a.docx', zip('[Content_Types].xml').subarray(0, 40))).toBeUndefined();
    });

    it('should type text by extension and call other text plain', () => {
        expect(detectFileType('a.txt', utf8('hello'))).toBe('text/plain');
        expect(detectFileType('a.csv', utf8('a,b\n1,2'))).toBe('text/csv');
        expect(detectFileType('a.md', utf8('# Title'))).toBe('text/markdown');
        expect(detectFileType('a.json', utf8('{"a":1}'))).toBe('application/json');
        expect(detectFileType('a.log', utf8('line'))).toBe('text/plain');
        expect(detectFileType('noextension', utf8('line'))).toBe('text/plain');
    });

    it('should refuse JSON that does not parse', () => {
        expect(detectFileType('a.json', utf8('{nope'))).toBeUndefined();
    });

    it('should refuse HTML and SVG by extension and by content', () => {
        expect(detectFileType('a.html', utf8('<p>x</p>'))).toBeUndefined();
        expect(detectFileType('a.svg', utf8('<svg/>'))).toBeUndefined();
        expect(detectFileType('a.txt', utf8('  <!DOCTYPE html><html></html>'))).toBeUndefined();
        expect(detectFileType('a.txt', utf8('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeUndefined();
        expect(detectFileType('a.txt', utf8('<?xml version="1.0"?><a/>'))).toBeUndefined();
    });

    it('should refuse an executable renamed to a text or image name', () => {
        const exe = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
        expect(detectFileType('a.txt', exe)).toBeUndefined();
        expect(detectFileType('a.png', exe)).toBeUndefined();
    });

    it('should refuse text with a NUL byte or invalid UTF-8', () => {
        expect(detectFileType('a.txt', Uint8Array.from([0x61, 0x00, 0x62]))).toBeUndefined();
        expect(detectFileType('a.txt', Uint8Array.from([0xc3, 0x28]))).toBeUndefined();
    });
});

describe('GLB detection', () => {
    it('should recognise a GLB 2 whose header length is the file size, whatever its name', () => {
        expect(detectFileType('chair.glb', glb())).toBe(GLB_TYPE);
        expect(detectFileType('chair.bin', glb())).toBe(GLB_TYPE);
        expect(GLB_TYPE).toBe('model/gltf-binary');
    });

    it('should take the whole size apart from the head, as an upload passes only the head', () => {
        const file = glb();
        const head = file.subarray(0, 12);

        expect(detectMagicType(head, file.length)).toBe(GLB_TYPE);
        expect(detectMagicType(head)).toBeUndefined();
    });

    it('should refuse a GLB cut below its header length or longer than it', () => {
        const file = glb();

        expect(detectFileType('a.glb', file.subarray(0, file.length - 1))).toBeUndefined();
        expect(detectFileType('a.glb', file.subarray(0, 8))).toBeUndefined();
        expect(detectFileType('a.glb', Uint8Array.from([...file, 0]))).toBeUndefined();
    });

    it('should refuse a wrong version or a wrong length in the header', () => {
        expect(detectFileType('a.glb', glb({ version: 1 }))).toBeUndefined();
        expect(detectFileType('a.glb', glb({ length: 0 }))).toBeUndefined();
        expect(detectFileType('a.glb', glb({ length: 1000 }))).toBeUndefined();
    });

    it('should refuse a .gltf, and HTML, SVG or text named .glb', () => {
        expect(detectFileType('scene.gltf', utf8('{"asset":{"version":"2.0"},"buffers":[{"uri":"scene.bin"}]}'))).toBeUndefined();
        expect(detectFileType('a.glb', utf8('<!doctype html><script>1</script>'))).toBeUndefined();
        expect(detectFileType('a.glb', utf8('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
        expect(detectFileType('a.glb', utf8('just text'))).toBeUndefined();
        expect(detectFileType('a.txt', utf8('glTF text that starts like a model'))).toBeUndefined();
    });

    it('should leave the other types as they were', () => {
        expect(detectFileType('a.png', PNG)).toBe('image/png');
        expect(detectFileType('a.json', utf8('{"a":1}'))).toBe('application/json');
        expect(detectFileType('a.svg', utf8('<svg/>'))).toBeUndefined();
        expect(isTextReadableType(GLB_TYPE)).toBe(false);
    });
});

describe('zipEntryNames', () => {
    it('should list entries and return undefined for non-ZIP bytes', () => {
        expect(zipEntryNames(zip('a', 'b/c'))).toEqual(['a', 'b/c']);
        expect(zipEntryNames(utf8('plain'))).toBeUndefined();
    });
});

describe('normaliseFileName', () => {
    it('should apply NFC and remove control characters', () => {
        expect(normaliseFileName('é\u0000x\n.txt')).toBe('éx.txt');
    });

    it('should cut to 255 characters by code point', () => {
        expect(Array.from(normaliseFileName('😀'.repeat(300))).length).toBe(MAX_FILE_NAME_LENGTH);
    });

    it('should name an empty result file', () => {
        expect(normaliseFileName('')).toBe('file');
        expect(normaliseFileName(' \u0007 ')).toBe('file');
    });
});

describe('allowed types', () => {
    it('should not allow HTML, SVG or octet-stream', () => {
        for (const type of ['text/html', 'image/svg+xml', 'application/octet-stream']) expect(isAllowedFileType(type)).toBe(false);
        expect(ALLOWED_FILE_TYPES).toHaveLength(12);
    });

    it('should be the one list the components library keeps too', () => {
        // `@punyts/stateui-components` exports no file-type list and the server's domain cannot import it, so both
        // libraries pin their list to this literal (its `files.test.ts` has the same one)
        expect(ALLOWED_FILE_TYPES).toEqual(SHARED_FILE_TYPES);
    });

});

describe('isTextReadableType', () => {
    it('should accept the four text types only', () => {
        for (const type of ['text/plain', 'text/csv', 'text/markdown', 'application/json']) expect(isTextReadableType(type)).toBe(true);
        for (const type of ['image/png', 'application/pdf']) expect(isTextReadableType(type)).toBe(false);
    });
});

describe('isFileReferenced', () => {
    const id = '77777777-7777-4777-8777-777777777777';

    it('should find an id at any depth of the document or the state', () => {
        expect(isFileReferenced(id, [{ app: {} }, { data: { photo: { id, name: 'a.png' } } }])).toBe(true);
        expect(isFileReferenced(id, [{ data: { list: [{ file: { id } }] } }])).toBe(true);
    });

    it('should ignore case and undefined values', () => {
        expect(isFileReferenced(id.toUpperCase(), [undefined, { data: { id } }])).toBe(true);
    });

    it('should not find an id that appears nowhere', () => {
        expect(isFileReferenced(id, [{ app: {} }, { data: { other: '88888888-8888-4888-8888-888888888888' } }, undefined])).toBe(false);
    });
});
