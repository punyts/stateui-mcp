import { describe, expect, it } from 'vitest';
import { PreviewHub } from './PreviewHub.js';
import type { ViewMessage } from './PreviewHub.js';

const APP = '11111111-1111-4111-8111-111111111111';

function connect(hub: PreviewHub, id: string, kind: 'browser' | 'headless' = 'browser'): { messages: ViewMessage[]; detach: () => void } {
    const messages: ViewMessage[] = [];
    const detach = hub.attach(APP, { id, kind, send: (message) => messages.push(message) });
    return { messages, detach };
}

describe('PreviewHub', () => {
    it('should publish to every view, or only to one kind', () => {
        const hub = new PreviewHub();
        const person = connect(hub, 'a');
        const headless = connect(hub, 'b', 'headless');

        const all = hub.publish(APP, { type: 'locale', locale: 'fr' });
        const only = hub.publish(APP, { type: 'theme', kind: 'mode', name: 'dark' }, 'headless');

        expect([all, only]).toEqual([2, 1]);
        expect(person.messages).toHaveLength(1);
        expect(headless.messages).toHaveLength(2);
    });

    it('should stop counting a view after it detaches', () => {
        const hub = new PreviewHub();
        const view = connect(hub, 'a');

        view.detach();

        expect(hub.presence(APP).attached).toBe(false);
        expect(hub.publish(APP, { type: 'deleted' })).toBe(0);
    });

    it('should report the highest rendered revision and wait for it', async () => {
        const hub = new PreviewHub();
        connect(hub, 'a', 'headless');
        const waiting = hub.waitRendered(APP, 3, 'headless', 1000);

        hub.touch(APP, 'a', { ready: true, revision: 2 });
        hub.touch(APP, 'a', { revision: 3 });

        expect(await waiting).toBe(true);
        expect(hub.presence(APP).revision).toBe(3);
    });

    it('should give up waiting for a revision that is never rendered', async () => {
        const hub = new PreviewHub();
        connect(hub, 'a', 'headless');

        expect(await hub.waitRendered(APP, 5, 'headless', 20)).toBe(false);
    });

    it('should number events per app and return only the newer ones', () => {
        const hub = new PreviewHub();
        connect(hub, 'a');
        hub.recordEvent(APP, 'a', 'one', 1);
        hub.recordEvent(APP, 'a', 'two', undefined);

        const all = hub.readEvents(APP, undefined);
        const newer = hub.readEvents(APP, 1);
        const none = hub.readEvents(APP, 2);

        expect(all.events.map((event) => event.cursor)).toEqual([1, 2]);
        expect(newer.events.map((event) => event.name)).toEqual(['two']);
        expect(none).toEqual({ events: [], cursor: 2 });
    });

    it('should keep a view that reconnected with its id when the old connection goes away', () => {
        // Arrange
        const hub = new PreviewHub();
        const old = connect(hub, 'a');
        const again = connect(hub, 'a');

        // Act
        old.detach();
        hub.publish(APP, { type: 'deleted' });

        // Assert
        expect(hub.viewCount(APP)).toBe(1);
        expect(old.messages).toEqual([]);
        expect(again.messages).toEqual([{ type: 'deleted' }]);
    });

    it('should tell the views the app is gone and forget its events', () => {
        const hub = new PreviewHub();
        const view = connect(hub, 'a');
        hub.recordEvent(APP, 'a', 'one', 1);

        hub.forget(APP);

        expect(view.messages).toEqual([{ type: 'deleted' }]);
        expect(hub.readEvents(APP, undefined).events).toEqual([]);
    });

    it('should keep the runtime errors since a cursor', () => {
        const hub = new PreviewHub();
        hub.recordErrors(APP, [{ code: 'A', message: 'a' }]);
        const cursor = hub.errorCursor(APP);
        hub.recordErrors(APP, [{ code: 'B', message: 'b' }]);

        expect(hub.errorsSince(APP, cursor).map((error) => error.code)).toEqual(['B']);
    });
});
