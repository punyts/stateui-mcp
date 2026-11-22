/**
 * How a live view reaches its server. The view (`host.ts`) is the same either way; a channel carries the sync
 * protocol, the server's view messages, the view's reports and app events, and the file uploads, reads and releases:
 *
 * - `directChannel`: the page's own server (an embedding server such as Magnetic, `startHttpServer`): one WebSocket
 *   `/apps/:appId/sync` with the sync protocol and `{ type: 'view' }` frames, `POST /report`, and the file routes.
 * - `statenetChannel` (`statenetChannel.ts`): a statenet; the server is a client of the same namespace and the
 *   messages ride the protocol's `emit` (`src/domain/viewRelay.ts`).
 */

import type { RejectionCode, SyncClient, SyncStatus, SyncTransport } from '@punyts/state-sync';
import { readStoredFile } from './fileRead.js';
import type { FileFetch, FileReadOutcome } from './fileRead.js';
import { releaseStoredFile } from './fileRelease.js';
import { exportRecordsFile } from './fileExport.js';
import type { FileExportOutcome } from './fileExport.js';
import type { FileReleaseOutcome } from './fileRelease.js';
import type { Json, JsonRecord } from './documentUpdate.js';

/** What the server tells a view; the host turns each into protocol messages for the runtime */
export type ServerMessage =
    | { type: 'app'; reason: 'attach' | 'document'; revision: number; document: JsonRecord; icons: Record<string, string> }
    | { type: 'command'; id: string; target: string; command: string; value?: Json; expiresAt: string }
    | { type: 'locale'; locale: string }
    | { type: 'theme'; kind: string; name: string }
    | { type: 'deleted' }
    /** A change of this view the server's authority refused after the statenet had applied it: the app gets `sync.rejected` */
    | { type: 'rejected'; path: string; reason: string; code?: RejectionCode };

/** A file the runtime asks the host to upload */
export interface UploadInput {
    readonly name: string;
    readonly type: string;
    readonly data: ArrayBuffer;
}

/** The answer to an upload, as the host posts it in `fileResult`; undefined when the upload was cancelled */
export type UploadOutcome =
    | { ok: true; file: { id: unknown; name: unknown; size: unknown; type: unknown } }
    | { ok: false; code: string; message: string }
    | undefined;

export interface ViewChannel {
    /** The sync client's transport; the server's view messages go to `onMessage` */
    transport(onMessage: (message: ServerMessage) => void): SyncTransport;
    /** The sync client is made and about to start */
    started?(client: SyncClient): void;
    /** An emit of the sync client's server; true when the channel took it (it is not an app event) */
    receive?(name: string, value: Json | undefined): boolean;
    /** The sync client's status changed */
    status?(status: SyncStatus): void;
    /** Ready, rendered and errors of the view (`viewId` included) */
    report(body: Record<string, unknown>): void;
    /** An `emit` the app raised */
    event(name: string, value: Json | undefined): void;
    upload(requestId: number, file: UploadInput, onProgress: (loaded: number, total: number) => void): Promise<UploadOutcome>;
    cancelUpload(requestId: number): void;
    readFile(id: unknown): Promise<FileReadOutcome>;
    releaseFile(id: unknown): Promise<FileReleaseOutcome>;
    /** Has the server build the CSV of a `fileExport` (`source`, `name`, `request`) and saves it */
    exportFile(message: { source: unknown; name: unknown; request: unknown }): Promise<FileExportOutcome>;
}

/** The upload refusals by status, as the file route answers them */
export const UPLOAD_CODES: Readonly<Record<number, string>> = Object.freeze({ 404: 'not_found', 409: 'quota', 413: 'too_large', 415: 'unsupported_type' });

/** The outcome of an upload's answer: `201` with the stored file, else the code of its status */
export function uploadOutcome(status: number, body: unknown): UploadOutcome {
    if (status === 201) {
        if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
            const file = body as Record<string, unknown>;
            return { ok: true, file: { id: file['id'], name: file['name'], size: file['size'], type: file['type'] } };
        }
        return { ok: false, code: 'internal', message: 'The server answered something unreadable' };
    }
    return { ok: false, code: UPLOAD_CODES[status] ?? 'internal', message: `The upload was refused (${status})` };
}

const VIEW_FRAME = '{"type":"view"';

/** The channel to the page's own server: the WebSocket, report and file routes of `startHttpServer` */
export function directChannel(appId: string, viewId: string, viewKind: string): ViewChannel {
    const uploads = new Map<number, XMLHttpRequest>();
    let client: SyncClient | undefined;
    const fetcher: FileFetch = (url, init) => fetch(url, init);
    const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/apps/${appId}/sync?view=${viewId}&kind=${viewKind}`;
    return {
        transport: (onMessage) => ({
            connect: (handlers) => {
                const socket = new WebSocket(url);
                let closed = false;
                socket.addEventListener('open', () => handlers.onOpen());
                socket.addEventListener('message', (event: MessageEvent<unknown>) => {
                    if (typeof event.data !== 'string') return;
                    if (!event.data.startsWith(VIEW_FRAME)) {
                        handlers.onMessage(event.data);
                        return;
                    }
                    try {
                        const frame = JSON.parse(event.data) as { message?: ServerMessage };
                        if (frame.message !== undefined) onMessage(frame.message);
                    } catch {
                        // not a frame of this server
                    }
                });
                socket.addEventListener('close', () => {
                    if (closed) return;
                    closed = true;
                    handlers.onClose();
                });
                return {
                    send: (text) => {
                        if (socket.readyState === WebSocket.OPEN) socket.send(text);
                    },
                    close: () => socket.close()
                };
            }
        }),
        started: (made) => {
            client = made;
        },
        // `keepalive` bodies are limited to 64 KiB, so a report of many errors goes without it
        report: (body) => {
            const text = JSON.stringify(body);
            void fetch(`/apps/${appId}/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text, keepalive: text.length < 60_000 }).catch(() => undefined);
        },
        event: (name, value) => {
            client?.emit(name, value);
        },
        upload: (requestId, file, onProgress) =>
            new Promise<UploadOutcome>((resolve) => {
                const form = new FormData();
                form.append('file', new Blob([file.data], { type: file.type }), file.name);
                const request = new XMLHttpRequest();
                uploads.set(requestId, request);
                request.open('POST', `/apps/${appId}/files`);
                request.upload.addEventListener('progress', (event) => {
                    if (event.lengthComputable) onProgress(event.loaded, event.total);
                });
                request.addEventListener('load', () => {
                    uploads.delete(requestId);
                    let body: unknown;
                    try {
                        body = JSON.parse(request.responseText) as unknown;
                    } catch {
                        body = undefined;
                    }
                    resolve(uploadOutcome(request.status, body));
                });
                request.addEventListener('error', () => {
                    uploads.delete(requestId);
                    resolve({ ok: false, code: 'offline', message: 'The server could not be reached' });
                });
                request.addEventListener('abort', () => {
                    uploads.delete(requestId);
                    resolve(undefined);
                });
                request.send(form);
            }),
        cancelUpload: (requestId) => uploads.get(requestId)?.abort(),
        readFile: (id) => readStoredFile(appId, id, fetcher),
        releaseFile: (id) => releaseStoredFile(appId, id, fetcher),
        exportFile: (message) => exportRecordsFile(appId, message, fetcher)
    };
}
