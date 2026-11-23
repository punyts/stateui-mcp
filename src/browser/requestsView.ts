/**
 * What the view host tells the runtime of the requests that wait for the owner (docs/design/statenet-requests.md):
 * the entries of `$.runtime.requests`, and which of the view's own requests raise `sync.requested`.
 */

import type { SyncRequest } from '@punyts/state-sync';
import type { Json, JsonRecord } from './documentUpdate.js';

/** A request as an entry of `$.runtime.requests`: everything the client knows of it but the revision it was based on */
export function requestEntry(request: SyncRequest): JsonRecord {
    const { base: _, ...entry } = request;
    return JSON.parse(JSON.stringify(entry)) as JsonRecord;
}

/** The entries of `$.runtime.requests`, by id */
export function requestEntries(requests: readonly SyncRequest[]): JsonRecord {
    return Object.fromEntries(requests.map((request): [string, Json] => [request.id, requestEntry(request)]));
}

/**
 * The view's own pending requests it has not told the app of, added to `announced`. A list that comes before the
 * client is online (`welcome`) is a welcome's: those were made in an earlier session, so they are only added
 */
export function newRequests(requests: readonly SyncRequest[], announced: Set<string>, welcome: boolean): { id: string; path: string }[] {
    const fresh: { id: string; path: string }[] = [];
    for (const request of requests) {
        if (!request.mine || request.status !== 'pending' || announced.has(request.id)) continue;
        announced.add(request.id);
        if (!welcome) fresh.push({ id: request.id, path: request.path });
    }
    return fresh;
}
