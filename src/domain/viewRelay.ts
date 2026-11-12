/**
 * The messages between the live views and the server when both talk through a statenet (`@punyts/statenet`): they ride
 * the state-sync protocol's `emit`, which the statenet relays between the clients of an app's namespace (from an app
 * server to every page, from a page to the app servers). Pure: the browser host and the Node server both use it.
 *
 * Each message is JSON text in one or more envelopes (`RelayEnvelope`) so a large one (a 1 MiB document, a 10 MiB
 * file) stays under the protocol's message limit of 1,000,000 characters.
 */

/** The emit a page sends the server */
export const VIEW_EMIT = 'stateui.view';
/** The emit the server sends the pages */
export const SERVER_EMIT = 'stateui.server';
/** The emit a page sends in the directory namespace to have the server open an app's namespace: `{ appId }` */
export const OPEN_EMIT = 'stateui.open';
/** The statenet namespace where the server lists the apps (`$.apps.<appId>`) and pages ask it to open one */
export const DIRECTORY_NAMESPACE = 'stateui.apps';

/** The characters of message text one envelope carries; with the envelope's own keys it stays well under the limit */
export const RELAY_PART_CHARS = 600_000;

/** One part of a message: `parts` envelopes with one `id` make the message, their `text` joined in `part` order */
export interface RelayEnvelope {
    readonly v: 1;
    readonly id: string;
    readonly part: number;
    readonly parts: number;
    readonly text: string;
    /** The view that sent it (from a page) */
    readonly from?: string;
    /** The one view it is for (from the server); absent: every view */
    readonly to?: string;
}

/** An entry of the directory: what a page needs to open an app */
export interface DirectoryEntry {
    readonly name: string;
    /** The sync namespace of the instance the views show */
    readonly namespace: string;
    readonly revision: number;
    readonly updatedAt: string;
}

/** Splits a message into envelopes */
export function toEnvelopes(message: unknown, id: string, address: { from?: string; to?: string } = {}): RelayEnvelope[] {
    const text = JSON.stringify(message);
    const parts = Math.max(1, Math.ceil(text.length / RELAY_PART_CHARS));
    const envelopes: RelayEnvelope[] = [];
    for (let part = 0; part < parts; part++) {
        envelopes.push({
            v: 1,
            id,
            part,
            parts,
            text: text.slice(part * RELAY_PART_CHARS, (part + 1) * RELAY_PART_CHARS),
            ...(address.from !== undefined && { from: address.from }),
            ...(address.to !== undefined && { to: address.to })
        });
    }
    return envelopes;
}

export function isRelayEnvelope(value: unknown): value is RelayEnvelope {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const envelope = value as Record<string, unknown>;
    return (
        envelope['v'] === 1 &&
        typeof envelope['id'] === 'string' &&
        typeof envelope['text'] === 'string' &&
        Number.isSafeInteger(envelope['part']) &&
        Number.isSafeInteger(envelope['parts']) &&
        (envelope['parts'] as number) >= 1 &&
        (envelope['parts'] as number) <= 64 &&
        (envelope['part'] as number) >= 0 &&
        (envelope['part'] as number) < (envelope['parts'] as number) &&
        (envelope['from'] === undefined || typeof envelope['from'] === 'string') &&
        (envelope['to'] === undefined || typeof envelope['to'] === 'string')
    );
}

/**
 * Puts envelopes back together: `add` gives the parsed message once its last part arrived, else undefined. Parts of a
 * message that never completes are dropped after `maxPending` other messages started
 */
export class RelayAssembler {
    private readonly pending = new Map<string, { parts: string[]; received: number }>();

    constructor(private readonly maxPending = 16) {}

    add(envelope: RelayEnvelope): { readonly message: unknown; readonly from?: string; readonly to?: string } | undefined {
        const address = { ...(envelope.from !== undefined && { from: envelope.from }), ...(envelope.to !== undefined && { to: envelope.to }) };
        if (envelope.parts === 1) return { message: parse(envelope.text), ...address };
        const key = `${envelope.from ?? ''}/${envelope.id}`;
        let entry = this.pending.get(key);
        if (entry === undefined) {
            entry = { parts: new Array<string>(envelope.parts), received: 0 };
            this.pending.set(key, entry);
            if (this.pending.size > this.maxPending) this.pending.delete(this.pending.keys().next().value as string);
        }
        if (entry.parts.length !== envelope.parts || entry.parts[envelope.part] !== undefined) return undefined;
        entry.parts[envelope.part] = envelope.text;
        entry.received++;
        if (entry.received < envelope.parts) return undefined;
        this.pending.delete(key);
        return { message: parse(entry.parts.join('')), ...address };
    }
}

function parse(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

/** Base64 of bytes, in pieces so a large file does not overflow the call stack */
export function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}
