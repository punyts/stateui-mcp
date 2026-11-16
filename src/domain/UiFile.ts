/** A file uploaded to a UI app: its metadata. The bytes live in the app's files folder under the file id */
export interface UiFile {
    readonly id: string;
    readonly appId: string;
    /** The display name after normalisation; never part of a storage path */
    readonly name: string;
    /** Size in bytes */
    readonly size: number;
    /** The MIME type sniffed from the bytes, one of `ALLOWED_FILE_TYPES` */
    readonly type: string;
    readonly sha256: string;
    readonly createdAt: Date;
}

/** What a component holds for a file: a reference, never the bytes */
export interface UiFileReference {
    readonly id: string;
    readonly name: string;
    readonly size: number;
    readonly type: string;
}

/** Largest file in bytes (10 MiB). An empty file is refused too */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Most files one app keeps */
export const MAX_FILES_PER_APP = 50;

/** Most bytes all files of one app keep together (100 MiB) */
export const MAX_BYTES_PER_APP = 100 * 1024 * 1024;

/** Longest file name in characters after normalisation */
export const MAX_FILE_NAME_LENGTH = 255;

/** A file no state snapshot or document mentions is removed this long after upload */
export const UNREFERENCED_FILE_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a file is referenced: its id appears anywhere in the given values (the app's document and the state its
 * views hold). The sweep and any release of a file use this one definition
 */
export function isFileReferenced(fileId: string, values: readonly unknown[]): boolean {
    const id = fileId.toLowerCase();
    return values.some((value) => value !== undefined && JSON.stringify(value).toLowerCase().includes(id));
}

/** Name used when a file name is empty after normalisation */
export const DEFAULT_FILE_NAME = 'file';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A binary glTF 2.0 model (GLB). A `.gltf` (JSON with external buffers and images) is never accepted */
export const GLB_TYPE = 'model/gltf-binary';

/**
 * The only types an upload may have. HTML, SVG, XML, other archives, executables, octet-stream and `.gltf` are not
 * here. The live view page's host (`src/browser/host.ts`) imports this list; `@punyts/stateui-components` keeps its
 * own copy in `src/shared/field/files.ts`, and a test in each library pins both to the same literal
 */
export const ALLOWED_FILE_TYPES: readonly string[] = Object.freeze([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'application/pdf',
    DOCX,
    XLSX,
    'text/plain',
    'text/csv',
    'text/markdown',
    'application/json',
    GLB_TYPE
]);

/** The types `ui_file_read` decodes as UTF-8 text */
export const TEXT_READABLE_TYPES: readonly string[] = Object.freeze(['text/plain', 'text/csv', 'text/markdown', 'application/json']);

/** Most bytes of text `ui_file_read` returns (256 KiB) */
export const MAX_READ_TEXT_BYTES = 256 * 1024;

export function isTextReadableType(type: string): boolean {
    return TEXT_READABLE_TYPES.includes(type);
}

export function isAllowedFileType(type: string): boolean {
    return ALLOWED_FILE_TYPES.includes(type);
}

/** Normalises a file name: NFC, control characters removed, at most 255 characters, `file` when nothing is left */
export function normaliseFileName(name: string): string {
    const cleaned = name
        .normalize('NFC')
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
        .trim();
    const characters = Array.from(cleaned);
    const limited = characters.length > MAX_FILE_NAME_LENGTH ? characters.slice(0, MAX_FILE_NAME_LENGTH).join('') : cleaned;
    return limited === '' ? DEFAULT_FILE_NAME : limited;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
    if (bytes.length < offset + signature.length) return false;
    return signature.every((value, index) => bytes[offset + index] === value);
}

/** The four bytes `glTF` a GLB starts with */
const GLB_MAGIC: readonly number[] = [0x67, 0x6c, 0x54, 0x46];

/** Bytes of a GLB header: the magic, the version and the length of the whole file, each four bytes */
const GLB_HEADER_BYTES = 12;

/**
 * Whether the bytes start with a GLB 2 header whose length is the size of the whole file. The head is enough, since
 * the header is its first 12 bytes; `size` is the size of the whole file
 */
function isGlb(head: Uint8Array, size: number): boolean {
    if (!startsWith(head, GLB_MAGIC) || head.length < GLB_HEADER_BYTES) return false;
    const view = new DataView(head.buffer, head.byteOffset, GLB_HEADER_BYTES);
    return view.getUint32(4, true) === 2 && view.getUint32(8, true) === size;
}

/**
 * The type of an image, a PDF or a GLB recognised by its magic number, otherwise `undefined`. `head` is the start
 * of the file and `size` the size of the whole file (the head's length when left out): a GLB's header names its
 * length, which must be the file's
 */
export function detectMagicType(head: Uint8Array, size: number = head.length): string | undefined {
    if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (startsWith(head, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(head, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
        return 'image/gif';
    }
    if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
    if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
    if (isGlb(head, size)) return GLB_TYPE;
    return undefined;
}

function extensionOf(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

const MARKUP_EXTENSIONS: readonly string[] = ['html', 'htm', 'xhtml', 'svg', 'xml'];
/** Model names that are only ever a GLB by its magic number: never text, so a `.gltf` or a renamed file is refused */
const MODEL_EXTENSIONS: readonly string[] = ['glb', 'gltf'];
const TEXT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
    txt: 'text/plain',
    csv: 'text/csv',
    md: 'text/markdown',
    json: 'application/json'
});

/** The entry names of a ZIP archive, read from its central directory; `undefined` when it is not a plain ZIP */
export function zipEntryNames(bytes: Uint8Array): string[] | undefined {
    if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const earliest = Math.max(0, bytes.length - 22 - 0xffff);
    let end = -1;
    for (let offset = bytes.length - 22; offset >= earliest; offset--) {
        if (view.getUint32(offset, true) === 0x06054b50) {
            end = offset;
            break;
        }
    }
    if (end < 0) return undefined;
    const entryCount = view.getUint16(end + 10, true);
    let cursor = view.getUint32(end + 16, true);
    const decoder = new TextDecoder('utf-8');
    const names: string[] = [];
    for (let index = 0; index < entryCount; index++) {
        if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) return undefined;
        const nameLength = view.getUint16(cursor + 28, true);
        const extraLength = view.getUint16(cursor + 30, true);
        const commentLength = view.getUint16(cursor + 32, true);
        if (cursor + 46 + nameLength > bytes.length) return undefined;
        names.push(decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)));
        cursor += 46 + nameLength + extraLength + commentLength;
    }
    return names;
}

function decodeText(bytes: Uint8Array): string | undefined {
    if (bytes.includes(0)) return undefined;
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return undefined;
    }
}

function looksLikeMarkup(text: string): boolean {
    const start = text.replace(/^﻿/, '').trimStart().slice(0, 16).toLowerCase();
    return start.startsWith('<!doctype') || start.startsWith('<html') || start.startsWith('<svg') || start.startsWith('<?xml');
}

/**
 * The type of a file that is not an image or PDF: a Word or Excel file (a ZIP with a `[Content_Types].xml` entry
 * and the matching extension) or text (valid UTF-8, no NUL byte; the extension picks the type, `.json` must parse).
 * HTML, SVG and XML are refused, by extension and by the way the text starts; so are `.glb` and `.gltf` names and
 * bytes that start like a GLB (a model that failed the GLB check). Anything else is `undefined`
 */
export function detectBodyType(name: string, bytes: Uint8Array): string | undefined {
    const extension = extensionOf(name);
    if (MARKUP_EXTENSIONS.includes(extension) || MODEL_EXTENSIONS.includes(extension)) return undefined;
    if (startsWith(bytes, GLB_MAGIC)) return undefined;
    const entries = zipEntryNames(bytes);
    if (entries !== undefined) {
        if (!entries.includes('[Content_Types].xml')) return undefined;
        if (extension === 'docx') return DOCX;
        if (extension === 'xlsx') return XLSX;
        return undefined;
    }
    const text = decodeText(bytes);
    if (text === undefined || looksLikeMarkup(text)) return undefined;
    const type = TEXT_TYPE_BY_EXTENSION[extension] ?? 'text/plain';
    if (type === 'application/json') {
        try {
            JSON.parse(text);
        } catch {
            return undefined;
        }
    }
    return type;
}

/** The type of a whole file from its bytes alone (the claimed type is never an input), or `undefined` when not allowed */
export function detectFileType(name: string, bytes: Uint8Array): string | undefined {
    return detectMagicType(bytes) ?? detectBodyType(name, bytes);
}
