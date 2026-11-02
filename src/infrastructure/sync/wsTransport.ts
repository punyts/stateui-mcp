import type { SyncTransport } from '@punyts/state-sync';
import { WebSocket } from 'ws';

/** The sync client's transport in Node: a `ws` WebSocket to `url`, text frames only */
export function createWsTransport(url: string): SyncTransport {
    return {
        connect: (handlers) => {
            const socket = new WebSocket(url);
            let closed = false;
            const close = (): void => {
                if (closed) return;
                closed = true;
                handlers.onClose();
            };
            socket.on('open', () => handlers.onOpen());
            socket.on('message', (data, isBinary) => {
                if (!isBinary) handlers.onMessage(String(data));
            });
            socket.on('close', close);
            // An error is followed by close; without a listener it would be thrown
            socket.on('error', () => undefined);
            return {
                send: (text) => {
                    if (socket.readyState === WebSocket.OPEN) socket.send(text);
                },
                close: () => socket.close()
            };
        }
    };
}
