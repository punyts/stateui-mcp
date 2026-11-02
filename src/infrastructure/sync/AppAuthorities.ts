import type { JsonValue as SyncValue } from '@punyts/state-sync';
import { createAuthority } from '@punyts/state-sync/authority';
import type { Authority, NamespaceStorage } from '@punyts/state-sync/authority';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import type { UiDocument } from '../../domain/UiApp.js';
import { appNamespace } from './FileNamespaceStorage.js';

/** A client emit, with the app and the id of the view that raised it */
export type AppEmitHandler = (appId: string, name: string, value: JsonValue | undefined, viewId: string) => void;

/**
 * One state-sync authority per app, made when the app's state is first needed (Full mode). It owns the order of the
 * app's state changes: the views' changes over their sockets and the tools' writes. The state starts as the document's
 * `data` and an empty `app`; `$.app` stays sparse (only the articulation a user or a tool changed), so changes create
 * missing parents
 */
export class AppAuthorities {
    private readonly authorities = new Map<string, Promise<Authority>>();

    constructor(
        private readonly storage: NamespaceStorage,
        private readonly onEmit: AppEmitHandler
    ) {}

    /** The authority of an app; `document` gives the state at revision 0 when nothing is stored */
    authority(appId: string, document: UiDocument): Promise<Authority> {
        const key = appId.toLowerCase();
        let authority = this.authorities.get(key);
        if (authority === undefined) {
            const data = document['data'];
            authority = createAuthority({
                namespace: appNamespace(key),
                storage: this.storage,
                initial: { data: (isJsonObject(data) ? data : {}) as SyncValue, app: {} },
                createParents: true
            }).then((created) => {
                created.onEmit((name, value, clientId) => this.onEmit(key, name, value as JsonValue | undefined, clientId));
                return created;
            });
            authority.catch(() => this.authorities.delete(key));
            this.authorities.set(key, authority);
        }
        return authority;
    }

    /** A copy of the app's state: `{ data, app }` */
    async state(appId: string, document: UiDocument): Promise<JsonObject> {
        return (await this.authority(appId, document)).state() as JsonObject;
    }

    /** Closes the app's connections, waits for its saves and forgets it; for a deleted app */
    async forget(appId: string): Promise<void> {
        const key = appId.toLowerCase();
        const authority = this.authorities.get(key);
        if (authority === undefined) return;
        this.authorities.delete(key);
        const created = await authority.catch(() => undefined);
        if (created === undefined) return;
        created.close();
        await created.flush();
    }

    /** Closes every connection and waits for every save */
    async close(): Promise<void> {
        await Promise.all([...this.authorities.keys()].map((appId) => this.forget(appId)));
    }
}
