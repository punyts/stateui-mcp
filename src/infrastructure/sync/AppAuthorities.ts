import type { Report } from '@punyts/core';
import type { ComponentLibrary } from '@punyts/stateui-app/core';
import type { JsonValue as SyncValue } from '@punyts/state-sync';
import { createAuthority } from '@punyts/state-sync/authority';
import type { Authority, NamespaceStorage } from '@punyts/state-sync/authority';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import type { UiDocument } from '../../domain/UiApp.js';
import { AppLogic } from './AppLogic.js';
import { appNamespace } from './FileNamespaceStorage.js';

/** A client emit, with the app and the id of the view that raised it */
export type AppEmitHandler = (appId: string, name: string, value: JsonValue | undefined, viewId: string) => void;

/** The view id the events of an app's own logic (`emit`, `logic.failed`) are recorded under */
export const LOGIC_VIEW_ID = 'logic';

/** What Full-mode apps need to run their `logic` on the server */
export interface AppLogicOptions {
    library: ComponentLibrary;
    report: Pick<Report, 'info'>;
}

/**
 * One state-sync authority per app, made when the app's state is first needed (Full mode). It owns the order of the
 * app's state changes: the views' changes over their sockets and the tools' writes. The state starts as the document's
 * `data` and an empty `app`; `$.app` stays sparse (only the articulation a user or a tool changed), so changes create
 * missing parents. With `logic` options each app's `logic` runs on its authority (`AppLogic`)
 */
export class AppAuthorities {
    private readonly authorities = new Map<string, Promise<Authority>>();
    private readonly logics = new Map<string, AppLogic>();

    constructor(
        private readonly storage: NamespaceStorage,
        private readonly onEmit: AppEmitHandler,
        /** The key that encrypts `$.server` at rest; without it an app whose state has `$.server` is refused */
        private readonly serverKey?: Uint8Array,
        private readonly logic?: AppLogicOptions
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
                createParents: true,
                ...(this.serverKey !== undefined && { serverKey: this.serverKey })
            }).then((created) => {
                created.onEmit((name, value, clientId) => this.onEmit(key, name, value as JsonValue | undefined, clientId));
                this.startLogic(key, created, document);
                return created;
            }, (error: unknown) => {
                throw this.explain(key, error);
            });
            authority.catch(() => this.authorities.delete(key));
            this.authorities.set(key, authority);
        }
        return authority;
    }

    private startLogic(appId: string, authority: Authority, document: UiDocument): void {
        if (this.logic === undefined) return;
        const { library, report } = this.logic;
        const logic = new AppLogic(
            authority,
            library,
            (name, payload) => this.onEmit(appId, name, payload, LOGIC_VIEW_ID),
            (message, failure) => report.info(message, { app: appId, machine: failure.machine, from: failure.from, command: failure.command, reason: failure.reason })
        );
        this.logics.set(appId, logic);
        try {
            logic.setDocument(document);
        } catch (error) {
            report.info('App logic did not start', { app: appId, reason: error instanceof Error ? error.message : String(error) });
        }
    }

    /** The app's document changed: its logic is rebuilt when its authority runs */
    documentChanged(appId: string, document: UiDocument): void {
        const logic = this.logics.get(appId.toLowerCase());
        if (logic === undefined) return;
        try {
            logic.setDocument(document);
        } catch (error) {
            this.logic?.report.info('App logic did not start', { app: appId, reason: error instanceof Error ? error.message : String(error) });
        }
    }

    /**
     * A tool's write to an app's state: asked of the guards, written, and looked up by the logic. Returns the reason
     * when a guard refused it
     */
    async write(appId: string, document: UiDocument, path: string, value: JsonValue | undefined): Promise<string | undefined> {
        const authority = await this.authority(appId, document);
        const logic = this.logics.get(appId.toLowerCase());
        if (logic !== undefined) return logic.write(path, value);
        authority.write(value === undefined ? { path, op: 'delete' } : { path, op: 'set', value: value as SyncValue });
        return undefined;
    }

    /** A stored `$.server` without a key is the one failure the operator can fix; it gets a message that says how */
    private explain(appId: string, error: unknown): Error {
        const message = error instanceof Error ? error.message : String(error);
        if (this.serverKey === undefined && message.includes('$.server')) {
            return new Error(`App ${appId} keeps $.server state, which is encrypted: start the server with --secret-key-file or STATEUI_MCP_SECRET_KEY`, { cause: error });
        }
        return error instanceof Error ? error : new Error(message);
    }

    /** A copy of the app's state: `{ data, app }` */
    async state(appId: string, document: UiDocument): Promise<JsonObject> {
        const { server: _server, ...state } = (await this.authority(appId, document)).state() as JsonObject;
        return state;
    }

    /** Closes the app's connections, waits for its saves and forgets it; for a deleted app */
    async forget(appId: string): Promise<void> {
        const key = appId.toLowerCase();
        const authority = this.authorities.get(key);
        if (authority === undefined) return;
        this.authorities.delete(key);
        this.logics.get(key)?.dispose();
        this.logics.delete(key);
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
