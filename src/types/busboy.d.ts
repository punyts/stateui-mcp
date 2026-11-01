declare module 'busboy' {
    import type { IncomingHttpHeaders } from 'node:http';
    import type { Readable, Writable } from 'node:stream';

    export interface FileInfo {
        filename: string;
        encoding: string;
        mimeType: string;
    }

    export interface Limits {
        fieldSize?: number;
        fields?: number;
        fileSize?: number;
        files?: number;
        parts?: number;
    }

    export interface Busboy extends Writable {
        on(event: 'file', listener: (name: string, stream: Readable, info: FileInfo) => void): this;
        on(event: 'field', listener: (name: string, value: string) => void): this;
        on(event: 'close' | 'finish' | 'filesLimit' | 'partsLimit' | 'fieldsLimit', listener: () => void): this;
        on(event: 'error', listener: (error: Error) => void): this;
    }

    export default function busboy(config: { headers: IncomingHttpHeaders; limits?: Limits }): Busboy;
}
