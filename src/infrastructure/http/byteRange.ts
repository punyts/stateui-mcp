import type { ByteRange } from '../../application/ports/UiFileStore.js';

const ONE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * The one range of a `Range` header within a file of `size` bytes: `bytes=a-b`, `bytes=a-` or `bytes=-n`. Undefined (the
 * whole file) without a header, for several ranges or a header it cannot read; `unsatisfiable` when the range starts
 * past the end or asks for no bytes
 */
export function byteRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | undefined {
    const found = header === undefined ? null : ONE_RANGE.exec(header.trim());
    if (found === null) return undefined;
    const [, first = '', last = ''] = found;
    if (first === '' && last === '') return undefined;
    if (first === '') {
        const length = Number(last);
        if (length === 0 || size === 0) return 'unsatisfiable';
        return { start: Math.max(0, size - length), end: size - 1 };
    }
    const start = Number(first);
    const end = last === '' ? size - 1 : Number(last);
    if (start >= size) return 'unsatisfiable';
    if (end < start) return undefined;
    return { start, end: Math.min(end, size - 1) };
}
