/**
 * The channel of a live view whose state lives in a statenet (`@punyts/statenet`): the page's sync client connects to
 * the statenet's WebSocket with the app's namespace, and the server (stateui-mcp) is another client of that namespace.
 * Everything that is not state rides the protocol's `emit`, which the statenet relays between the pages and the
 * server (`src/domain/viewRelay.ts`): the server's view messages come as `stateui.server`, and the view's hello,
 * reports, app events and file requests go as `stateui.view`. Messages to send while the socket is down wait (at
 * most `MAX_QUEUED`) and go once it is back, after the hello.
 */

import { randomId } from '@punyts/state-sync';
import type { SyncClient } from '@punyts/state-sync';
import { fromBase64, isRelayEnvelope, RelayAssembler, SERVER_EMIT, toBase64, toEnvelopes, VIEW_EMIT } from '../domain/viewRelay.js';
import type { Json } from './documentUpdate.js';
import { readStoredFile } from './fileRead.js';
import type { FileFetch } from './fileRead.js';
import { releaseStoredFile } from './fileRelease.js';
import { exportRecordsFile } from './fileExport.js';
import { uploadOutcome } from './viewChannel.js';
import type { ServerMessage, UploadOutcome, ViewChannel } from './viewChannel.js';

const MAX_QUEUED = 200;
/** How long a file request waits for the server's answer */
const REQUEST_TIMEOUT_MS = 30_000;

/** The server's answer to a file request */
interface RelayResponse {
    status: number;
    headers?: Record<string, string>;
    /** A JSON body */
    json?: unknown;
    /** A binary body, base64 */
    bytes?: string;
}

export interface StatenetChannelOptions {
    readonly statenetUrl: string;
    readonly appId: string;
    readonly viewId: string;
    readonly viewKind: 'browser' | 'headless';
}

export function statenetChannel(options: StatenetChannelOptions): ViewChannel {
    const { appId, viewId } = options;
    const assembler = new RelayAssembler();
    const queued: unknown[] = [];
    const requests = new Map<string, (response: RelayResponse | undefined) => void>();
    const cancelled = new Set<number>();
    let client: SyncClient | undefined;
    let online = false;
    let deliver: ((message: ServerMessage) => void) | undefined;
    let sequence = 0;

    const sendNow = (message: unknown): boolean => {
        if (client === undefined || !online) return false;
        for (const envelope of toEnvelopes(message, `${viewId}:${++sequence}`, { from: viewId })) {
            if (!client.emit(VIEW_EMIT, envelope as unknown as Json)) return false;
        }
        return true;
    };
    const send = (message: unknown): void => {
        if (sendNow(message)) return;
        queued.push(message);
        if (queued.length > MAX_QUEUED) queued.shift();
    };
    const hello = (): void => {
        if (!sendNow({ type: 'hello', kind: options.viewKind })) return;
        for (const message of queued.splice(0)) send(message);
    };
    const request = (method: string, path: string, extra: Record<string, unknown> = {}): Promise<RelayResponse | undefined> =>
        new Promise((resolve) => {
            if (!online) {
                resolve(undefined);
                return;
            }
            const id = randomId();
            const timer = setTimeout(() => {
                requests.delete(id);
                resolve(undefined);
            }, REQUEST_TIMEOUT_MS);
            requests.set(id, (response) => {
                clearTimeout(timer);
                requests.delete(id);
                resolve(response);
            });
            send({ type: 'request', id, method, path, ...extra });
        });
    /** A fetch for the file helpers, answered by the server over the relay; a request that gets no answer is a failed fetch */
    const fetcher: FileFetch = async (url, init) => {
        const response = await request(init.method ?? 'GET', url, typeof init.body === 'string' ? { body: init.body } : {});
        if (response === undefined) throw new TypeError('The server could not be reached');
        const status = response.status;
        const body = status === 204 ? null : response.bytes !== undefined ? fromBase64(response.bytes) : JSON.stringify(response.json ?? null);
        return new Response(body as BodyInit | null, { status, ...(response.headers !== undefined && { headers: response.headers }) });
    };
    const onServer = (value: Json | undefined): void => {
        if (!isRelayEnvelope(value)) return;
        if (value.to !== undefined && value.to !== viewId) return;
        const assembled = assembler.add(value);
        const message = assembled?.message;
        if (typeof message !== 'object' || message === null) return;
        const record = message as Record<string, unknown>;
        switch (record['type']) {
            case 'view':
                if (typeof record['message'] === 'object' && record['message'] !== null) deliver?.(record['message'] as ServerMessage);
                return;
            case 'response':
                if (typeof record['id'] === 'string' && typeof record['status'] === 'number') requests.get(record['id'])?.(record as unknown as RelayResponse);
                return;
            case 'ready':
                // The server joined (again): it learns of this view from its hello
                hello();
                return;
        }
    };

    window.addEventListener('pagehide', () => {
        sendNow({ type: 'bye' });
    });

    return {
        transport: (onMessage) => {
            deliver = onMessage;
            return {
                connect: (handlers) => {
                    const socket = new WebSocket(options.statenetUrl);
                    let closed = false;
                    socket.addEventListener('open', () => handlers.onOpen());
                    socket.addEventListener('message', (event: MessageEvent<unknown>) => {
                        if (typeof event.data === 'string') handlers.onMessage(event.data);
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
            };
        },
        started: (made) => {
            client = made;
        },
        receive: (name, value) => {
            if (name === SERVER_EMIT) {
                onServer(value);
                return true;
            }
            // The statenet's own notices (a client left) are not the app's
            return name.startsWith('statenet.');
        },
        status: (status) => {
            const wasOnline = online;
            online = status === 'online';
            if (online && !wasOnline) hello();
            if (!online) for (const resolve of [...requests.values()]) resolve(undefined);
        },
        report: (body) => send({ type: 'report', report: body }),
        event: (name, value) => send({ type: 'event', name, ...(value !== undefined && { value }) }),
        upload: async (requestId, file, onProgress): Promise<UploadOutcome> => {
            const total = file.data.byteLength;
            const response = await request('POST', `/apps/${appId}/files`, { name: file.name, mediaType: file.type, body: toBase64(new Uint8Array(file.data)) });
            if (cancelled.delete(requestId)) return undefined;
            if (response === undefined) return { ok: false, code: 'offline', message: 'The server could not be reached' };
            onProgress(total, total);
            return uploadOutcome(response.status, response.json);
        },
        cancelUpload: (requestId) => {
            cancelled.add(requestId);
        },
        readFile: (id) => readStoredFile(appId, id, fetcher),
        releaseFile: (id) => releaseStoredFile(appId, id, fetcher),
        exportFile: (message) => exportRecordsFile(appId, message, fetcher)
    };
}
