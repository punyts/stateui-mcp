import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';

/** The most `emit` events kept per app. The oldest drop first */
export const MAX_QUEUED_EVENTS = 500;

/** The most runtime errors the hub keeps per app for `ui_interact` (the stored log is separate and holds 50) */
const MAX_RECENT_ERRORS = 200;

/** What the server tells a view. The host script of the page turns each into protocol messages for the runtime */
export type ViewMessage =
    | {
          readonly type: 'app';
          /** `attach`: the first message of a view; `document`: load or write the changed document */
          readonly reason: 'attach' | 'document';
          readonly revision: number;
          readonly document: JsonObject;
          readonly icons: Readonly<Record<string, string>>;
      }
    | { readonly type: 'command'; readonly id: string; readonly target: string; readonly command: string; readonly value?: JsonValue; readonly expiresAt: string }
    | { readonly type: 'locale'; readonly locale: string }
    | { readonly type: 'theme'; readonly kind: string; readonly name: string }
    | { readonly type: 'deleted' };

/** One open view of an app: a browser tab of the human, or the headless page of Playwright */
export interface ViewConnection {
    readonly id: string;
    readonly kind: 'browser' | 'headless';
    send(message: ViewMessage): void;
}

interface ViewState {
    readonly connection: ViewConnection;
    renderedRevision: number | undefined;
    ready: boolean;
    lastSeenAt: Date;
}

/** An `emit` the app raised, as `ui_events_read` returns it. `cursor` rises by one per event and per app */
export interface UiEvent {
    readonly cursor: number;
    readonly name: string;
    readonly payload: JsonValue | undefined;
    readonly at: string;
    readonly view: 'browser' | 'headless';
}

export interface RecentError {
    readonly cursor: number;
    readonly error: UiBuildError;
}

interface AppChannel {
    readonly views: Map<string, ViewState>;
    events: UiEvent[];
    nextCursor: number;
    errors: RecentError[];
    nextErrorCursor: number;
    waiters: Set<() => void>;
}

/**
 * The in-memory side of the live views: who has an app open, what they rendered, the `emit` events they raised and
 * the messages the server pushes to them. Nothing here is stored: a restart empties it and the views reconnect
 */
export class PreviewHub {
    private readonly channels = new Map<string, AppChannel>();

    constructor(private readonly now: () => Date = () => new Date()) {}

    /**
     * Registers a view and returns the function that removes it. A view that reconnects with its id replaces its old
     * connection, and the old connection's removal then leaves the new one alone
     */
    attach(appId: string, connection: ViewConnection): () => void {
        const channel = this.channel(appId);
        channel.views.set(connection.id, { connection, renderedRevision: undefined, ready: false, lastSeenAt: this.now() });
        this.wake(channel);
        return () => {
            if (channel.views.get(connection.id)?.connection !== connection) return;
            channel.views.delete(connection.id);
            this.wake(channel);
        };
    }

    /** Sends a message to every open view of the app and returns how many were open */
    publish(appId: string, message: ViewMessage, only?: 'browser' | 'headless'): number {
        const channel = this.channels.get(appId);
        if (channel === undefined) return 0;
        let delivered = 0;
        for (const view of channel.views.values()) {
            if (only !== undefined && view.connection.kind !== only) continue;
            view.connection.send(message);
            delivered++;
        }
        return delivered;
    }

    /**
     * Marks the views of a kind as not rendered, before their page loads again: a wait for a rendered revision then
     * ends with the reloaded page and not with the one it replaces
     */
    markStale(appId: string, kind: 'browser' | 'headless'): void {
        const channel = this.channels.get(appId);
        if (channel === undefined) return;
        for (const view of channel.views.values()) {
            if (view.connection.kind !== kind) continue;
            view.ready = false;
            view.renderedRevision = undefined;
        }
    }

    viewCount(appId: string, kind?: 'browser' | 'headless'): number {
        const views = [...(this.channels.get(appId)?.views.values() ?? [])];
        return kind === undefined ? views.length : views.filter((view) => view.connection.kind === kind).length;
    }

    /** A view reports that it rendered `revision` (`ready`) or is alive */
    touch(appId: string, viewId: string, update: { revision?: number; ready?: boolean } = {}): void {
        const channel = this.channels.get(appId);
        const view = channel?.views.get(viewId);
        if (channel === undefined || view === undefined) return;
        view.lastSeenAt = this.now();
        if (update.revision !== undefined) view.renderedRevision = update.revision;
        if (update.ready !== undefined) view.ready = update.ready;
        this.wake(channel);
    }

    /** The newest time a view reported, and the highest revision a view rendered */
    presence(appId: string): { readonly attached: boolean; readonly lastSeenAt: Date | undefined; readonly revision: number | undefined } {
        const views = [...(this.channels.get(appId)?.views.values() ?? [])];
        const times = views.map((view) => view.lastSeenAt.getTime());
        const revisions = views.map((view) => view.renderedRevision).filter((revision): revision is number => revision !== undefined);
        return {
            attached: views.length > 0,
            lastSeenAt: times.length > 0 ? new Date(Math.max(...times)) : undefined,
            revision: revisions.length > 0 ? Math.max(...revisions) : undefined
        };
    }

    /** Resolves when a view of the app has rendered at least `revision`, or false after `timeoutMs` */
    async waitRendered(appId: string, revision: number, kind: 'browser' | 'headless' | undefined, timeoutMs: number): Promise<boolean> {
        const channel = this.channel(appId);
        const isRendered = (): boolean =>
            [...channel.views.values()].some(
                (view) => (kind === undefined || view.connection.kind === kind) && view.ready && (view.renderedRevision ?? 0) >= revision
            );
        if (isRendered()) return true;
        return new Promise<boolean>((resolve) => {
            const check = (): void => {
                if (!isRendered()) return;
                done(true);
            };
            const timer = setTimeout(() => done(false), timeoutMs);
            const done = (value: boolean): void => {
                clearTimeout(timer);
                channel.waiters.delete(check);
                resolve(value);
            };
            channel.waiters.add(check);
        });
    }

    recordEvent(appId: string, viewId: string, name: string, payload: JsonValue | undefined): void {
        const channel = this.channel(appId);
        const view = channel.views.get(viewId);
        channel.events.push({
            cursor: channel.nextCursor++,
            name,
            payload,
            at: this.now().toISOString(),
            view: view?.connection.kind ?? 'browser'
        });
        if (channel.events.length > MAX_QUEUED_EVENTS) channel.events = channel.events.slice(-MAX_QUEUED_EVENTS);
    }

    /** Events newer than `since` (all of them when absent), oldest first, and the cursor to pass next time */
    readEvents(appId: string, since: number | undefined): { readonly events: readonly UiEvent[]; readonly cursor: number } {
        const channel = this.channels.get(appId);
        if (channel === undefined) return { events: [], cursor: since ?? 0 };
        const events = since === undefined ? channel.events : channel.events.filter((event) => event.cursor > since);
        return { events: [...events], cursor: channel.nextCursor - 1 };
    }

    recordErrors(appId: string, errors: readonly UiBuildError[]): void {
        const channel = this.channel(appId);
        for (const error of errors) channel.errors.push({ cursor: channel.nextErrorCursor++, error });
        if (channel.errors.length > MAX_RECENT_ERRORS) channel.errors = channel.errors.slice(-MAX_RECENT_ERRORS);
    }

    errorCursor(appId: string): number {
        return (this.channels.get(appId)?.nextErrorCursor ?? 1) - 1;
    }

    errorsSince(appId: string, cursor: number): readonly UiBuildError[] {
        return (this.channels.get(appId)?.errors ?? []).filter((entry) => entry.cursor > cursor).map((entry) => entry.error);
    }

    /** Tells the views the app is gone and forgets everything about it */
    forget(appId: string): void {
        this.publish(appId, { type: 'deleted' });
        this.channels.delete(appId);
    }

    private channel(appId: string): AppChannel {
        let channel = this.channels.get(appId);
        if (channel === undefined) {
            channel = { views: new Map(), events: [], nextCursor: 1, errors: [], nextErrorCursor: 1, waiters: new Set() };
            this.channels.set(appId, channel);
        }
        return channel;
    }

    private wake(channel: AppChannel): void {
        for (const waiter of [...channel.waiters]) waiter();
    }
}
