import { randomUUID } from 'node:crypto';
import type { JsonValue as SyncValue } from '@punyts/state-sync';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject } from '../../domain/JsonValue.js';
import type { UiDocument } from '../../domain/UiApp.js';
import { appNamespace } from './FileNamespaceStorage.js';
import { SEALED_KEY } from './StatenetRelayStorage.js';
import { StatenetClient } from './statenetClient.js';

/**
 * The state of each Persisted app, read from the statenet: one statenet client per app, made when its state is first
 * needed, follows the namespace. A namespace with nothing in it yet is seeded with the document's `data` and an empty
 * `app`, so a view that opens next starts from them. The server never changes a Persisted app's state otherwise
 */
export class PersistedStates {
    private readonly clients = new Map<string, Promise<StatenetClient>>();

    constructor(private readonly url: string) {}

    /** A copy of the app's state as the statenet holds it: `{ data, app }`, without the sealed `$.server` */
    async state(appId: string, document: UiDocument): Promise<JsonObject> {
        const client = await this.client(appId, document);
        const { [SEALED_KEY]: _sealed, ...state } = client.current();
        return state as JsonObject;
    }

    /** Stops following the app; for a deleted app */
    async forget(appId: string): Promise<void> {
        const key = appId.toLowerCase();
        const client = this.clients.get(key);
        if (client === undefined) return;
        this.clients.delete(key);
        (await client.catch(() => undefined))?.stop();
    }

    async close(): Promise<void> {
        await Promise.all([...this.clients.keys()].map((appId) => this.forget(appId)));
    }

    private client(appId: string, document: UiDocument): Promise<StatenetClient> {
        const key = appId.toLowerCase();
        let client = this.clients.get(key);
        if (client === undefined) {
            client = this.connect(key, document);
            client.catch(() => this.clients.delete(key));
            this.clients.set(key, client);
        }
        return client;
    }

    private async connect(appId: string, document: UiDocument): Promise<StatenetClient> {
        const client = new StatenetClient(this.url, appNamespace(appId));
        try {
            await client.ready();
        } catch (error) {
            client.stop();
            throw error;
        }
        if (client.revision() === 0 && Object.keys(client.current()).length === 0) {
            const data = document['data'];
            client.send([
                { id: randomUUID(), path: '$.data', op: 'set', value: (isJsonObject(data) ? data : {}) as SyncValue },
                { id: randomUUID(), path: '$.app', op: 'set', value: {} }
            ]);
            await client.drain(3000);
        }
        return client;
    }
}
