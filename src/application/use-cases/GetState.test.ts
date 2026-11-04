import { describe, expect, it, vi } from 'vitest';
import type { UiApp } from '../../domain/UiApp.js';
import type { LiveStateReader } from '../ports/LiveStateReader.js';
import type { UiAppRepository } from '../ports/UiAppRepository.js';
import type { UiPreviewLog, UiPreviewStatus } from '../ports/UiPreviewLog.js';
import { GetState } from './GetState.js';

const APP_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-01-01T00:00:00Z');
const STORED = Object.freeze({ data: Object.freeze({ title: 'stored' }), app: Object.freeze({}) });
const LIVE = Object.freeze({ data: Object.freeze({ title: 'live' }), app: Object.freeze({}) });
const APP: UiApp = Object.freeze({
    id: APP_ID,
    name: 'form',
    revision: 4,
    document: Object.freeze({ app: Object.freeze({ component: 'page' }) }),
    stateSnapshot: STORED,
    sync: 'full',
    createdAt: NOW,
    updatedAt: NOW
});

function status(attached: boolean): UiPreviewStatus {
    return Object.freeze({ attached, lastSeenAt: attached ? NOW : undefined, revision: attached ? 4 : undefined, errors: Object.freeze([{ code: 'SUI-RUN-BINDING', message: 'boom' }]) });
}

function build(options: { app?: UiApp | undefined; attached: boolean; live: LiveStateReader['read'] }) {
    const repository = Object.freeze({ findById: vi.fn(async () => options.app) }) as unknown as UiAppRepository;
    const previewLog = Object.freeze({ status: vi.fn(async () => status(options.attached)) }) as unknown as UiPreviewLog;
    const liveState = Object.freeze({ read: vi.fn(options.live) });
    const report = Object.freeze({ info: vi.fn() });
    return { useCase: new GetState(repository, previewLog, liveState, () => NOW, report), liveState };
}

describe('GetState', () => {
    it('should return the state of a view that is open, as live, with the preview status', async () => {
        // Arrange
        const { useCase, liveState } = build({ app: APP, attached: true, live: async () => LIVE });

        // Act
        const result = await useCase.execute(APP_ID);

        // Assert
        expect(liveState.read).toHaveBeenCalledWith(APP_ID);
        expect(result).toMatchObject({
            kind: 'state',
            revision: 4,
            source: 'live',
            state: LIVE,
            preview: { attached: true, errors: [{ code: 'SUI-RUN-BINDING', message: 'boom' }] }
        });
    });

    it('should return the stored snapshot, as stored, when no view is open and not ask a view', async () => {
        // Arrange
        const { useCase, liveState } = build({ app: APP, attached: false, live: async () => LIVE });

        // Act
        const result = await useCase.execute(APP_ID);

        // Assert
        expect(liveState.read).not.toHaveBeenCalled();
        expect(result).toMatchObject({ kind: 'state', source: 'stored', state: STORED, preview: { attached: false } });
    });

    it('should fall back to the stored snapshot when the open view gives no state', async () => {
        // Arrange
        const { useCase } = build({ app: APP, attached: true, live: async () => undefined });

        // Act
        const result = await useCase.execute(APP_ID);

        // Assert
        expect(result).toMatchObject({ kind: 'state', source: 'stored', state: STORED, preview: { attached: true } });
    });

    it('should report an app that does not exist', async () => {
        // Arrange
        const { useCase, liveState } = build({ app: undefined, attached: true, live: async () => LIVE });

        // Act
        const result = await useCase.execute(APP_ID);

        // Assert
        expect(result).toEqual({ kind: 'not-found', appId: APP_ID });
        expect(liveState.read).not.toHaveBeenCalled();
    });
});
