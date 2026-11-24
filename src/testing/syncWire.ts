import { createSyncWire } from '@punyts/state-sync';
import type { SyncMessage } from '@punyts/state-sync';
import type { AuthoritySession } from '@punyts/state-sync/authority';
import type { RawData } from 'ws';

type Frame = Record<string, unknown>;

/**
 * A test's side of one sync connection over protocol 4: `write` turns a message object into the frame a client sends
 * (`hello` as text, the rest as bytes; an object that is no sync message, as JSON text), and `read` turns what came
 * back into an object: bytes through the wire, text (`hello`, `error`, the server's `view` frames) as JSON
 */
export function testWire(): { write(message: object): string | Uint8Array; read(data: string | Uint8Array): Frame; readSocket(data: RawData, isBinary: boolean): Frame } {
    const wire = createSyncWire();
    const read = (data: string | Uint8Array): Frame => {
        if (typeof data === 'string') return JSON.parse(data) as Frame;
        const parsed = wire.read(data);
        if (!parsed.ok) throw new Error(`the server sent what the wire cannot read: ${parsed.error.message}`);
        return parsed.message as unknown as Frame;
    };
    return {
        write: (message) => {
            try {
                return wire.write(message as SyncMessage);
            } catch {
                return JSON.stringify(message);
            }
        },
        read,
        readSocket: (data, isBinary) => {
            const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
            return read(isBinary ? new Uint8Array(buffer) : buffer.toString('utf8'));
        }
    };
}

/** An authority session a test drives with message objects, its answers read into `received` */
export function wiredSession(connect: (send: (data: string | Uint8Array) => void) => AuthoritySession, received: unknown[]): { send(message: object): void; session: AuthoritySession } {
    const wire = testWire();
    const session = connect((data) => received.push(wire.read(data)));
    return { session, send: (message) => session.receive(wire.write(message)) };
}
