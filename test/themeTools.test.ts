import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UiPartBodies } from '../src/domain/UiPart.js';
import { call, inMemoryHarness, tempData } from './helpers.js';
import type { InMemoryHarness, TempData } from './helpers.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const STORE = deepFreeze({
    tokens: { color: { accent: { base: '#204080' } } },
    overlays: { night: { kind: 'mode', tokens: { color: { surface: { base: '#101010' }, text: { base: '#f0f0f0' } } } } }
}) as unknown as UiPartBodies['themes'];

let data: TempData;
let harness: InMemoryHarness;

async function themePart(name: string): Promise<Record<string, unknown>> {
    const read = await call(harness.client, 'ui_get', { kind: 'themes', name });
    return read.body;
}

beforeEach(async () => {
    data = await tempData();
    harness = await inMemoryHarness(data.dir);
    const written = await harness.services.useCases.writePart!.execute({ kind: 'themes', name: 'store', body: STORE });
    if (written.kind !== 'written') throw new Error(JSON.stringify(written));
});

afterEach(async () => {
    await harness.close();
    await data.cleanup();
});

describe('ui_theme_create', () => {
    it('should copy a theme with its tokens and overlays, its own id and revision 1', async () => {
        // Act
        const created = await call(harness.client, 'ui_theme_create', { name: 'store-copy', from: 'store' });
        const source = await themePart('store');
        const copy = await themePart('store-copy');

        // Assert
        expect(created.body).toMatchObject({ theme: 'store-copy', revision: 1, warnings: [], reaches: [] });
        expect(copy['value']).toEqual(source['value']);
        expect(copy['id']).not.toBe(source['id']);
        expect(copy['revision']).toBe(1);
        expect((created.body['contrast'] as { mode: string }[]).map((pair) => pair.mode)).toContain('night');
    });

    it('should refuse an unknown preset with the four names, and need exactly one source', async () => {
        // Act
        const preset = await call(harness.client, 'ui_theme_create', { name: 'calm', preset: 'calm' });
        const neither = await call(harness.client, 'ui_theme_create', { name: 'calm' });
        const both = await call(harness.client, 'ui_theme_create', { name: 'calm', from: 'store', preset: 'calm' });
        const missing = await call(harness.client, 'ui_theme_create', { name: 'calm', from: 'stor' });
        const duplicate = await call(harness.client, 'ui_theme_create', { name: 'store', from: 'store' });

        // Assert
        expect(preset.body).toMatchObject({ error: 'invalid-argument', argument: 'preset' });
        expect(preset.body['message']).toContain('one of: clean, moody, playful, professional');
        expect(neither.body).toMatchObject({ error: 'invalid-argument' });
        expect(both.body).toMatchObject({ error: 'invalid-argument' });
        expect(missing.body).toMatchObject({ error: 'not-found', nearest: ['store'] });
        expect(duplicate.body['error']).toBe('duplicate-name');
    });
});

describe('ui_theme_write', () => {
    it('should create a theme from no tokens when expectedRevision is left out, and not twice', async () => {
        // Act
        const created = await call(harness.client, 'ui_theme_write', { theme: 'harbor', operations: [{ op: 'set', path: 'color.accent.base', value: '#204080' }] });
        const again = await call(harness.client, 'ui_theme_write', { theme: 'harbor', operations: [{ op: 'set', path: 'color.accent.base', value: '#802040' }] });
        const badName = await call(harness.client, 'ui_theme_write', { theme: 'Harbor Blue', operations: [{ op: 'set', path: 'color.accent.base', value: '#204080' }] });
        const stored = await call(harness.client, 'ui_get', { kind: 'themes', name: 'harbor' });

        // Assert
        expect(created.body).toMatchObject({ theme: 'harbor', revision: 1, created: true });
        expect(again.body).toMatchObject({ error: 'conflict', currentRevision: 1 });
        expect(badName.body).toMatchObject({ error: 'invalid-name', argument: 'theme' });
        expect(stored.body['value']).toEqual({ tokens: { color: { accent: { base: '#204080' } } } });
    });

    it('should set tokens at the base and in an overlay and report contrast and reach', async () => {
        // Act
        const result = await call(harness.client, 'ui_theme_write', {
            theme: 'store',
            expectedRevision: 1,
            operations: [
                { op: 'set', path: 'color.text.base', value: '#bbbbbb' },
                { op: 'add-overlay', overlay: 'acme', kind: 'brand' },
                { op: 'set', overlay: 'acme', path: 'radius.md', value: '2px' }
            ]
        });
        const part = await themePart('store');

        // Assert
        expect(result.isError).toBe(false);
        expect(result.body).toMatchObject({ theme: 'store', revision: 2, warnings: [] });
        expect(result.body['contrast']).toContainEqual({ mode: 'light', text: 'color.text.base', surface: 'color.surface.base', ratio: 1.91, passesAA: false });
        const reaches = result.body['reaches'] as { token: string; components: string[] }[];
        expect(reaches.map((reach) => reach.token)).toEqual(['color.text.base', 'radius.md']);
        expect(reaches[1]!.components.length).toBeGreaterThan(0);
        expect((part['value'] as Record<string, unknown>)['overlays']).toEqual({ ...STORE.overlays, acme: { kind: 'brand', tokens: { radius: { md: '2px' } } } });
    });

    it('should refuse an unknown token, a token outside its overlay kind and a bad value, writing nothing', async () => {
        // Act
        const unknown = await call(harness.client, 'ui_theme_write', { theme: 'store', expectedRevision: 1, operations: [{ op: 'set', path: 'color.custom.x', value: '#fff' }] });
        const group = await call(harness.client, 'ui_theme_write', { theme: 'store', expectedRevision: 1, operations: [{ op: 'set', overlay: 'night', path: 'radius.md', value: '2px' }] });
        const value = await call(harness.client, 'ui_theme_write', { theme: 'store', expectedRevision: 1, operations: [{ op: 'set', path: 'color.text.base', value: 'not a colour' }] });

        // Assert
        for (const result of [unknown, group, value]) expect(result.body['error']).toBe('invalid-theme');
        expect(JSON.stringify(unknown.body['errors'])).toContain('SUI-THEME-TOKEN');
        expect((await themePart('store'))['revision']).toBe(1);
    });

    it('should refuse misplaced fields, a missing overlay and a stale revision', async () => {
        // Act
        const kind = await call(harness.client, 'ui_theme_write', { theme: 'store', expectedRevision: 1, operations: [{ op: 'set', path: 'color.text.base', value: '#000', kind: 'mode' }] });
        const noKind = await call(harness.client, 'ui_theme_write', { theme: 'store', expectedRevision: 1, operations: [{ op: 'add-overlay', overlay: 'acme' }] });
        const overlay = await call(harness.client, 'ui_theme_write', { theme: 'store', expectedRevision: 1, operations: [{ op: 'remove-overlay', overlay: 'nite' }] });
        const stale = await call(harness.client, 'ui_theme_write', { theme: 'store', expectedRevision: 2, operations: [{ op: 'remove-overlay', overlay: 'night' }] });

        // Assert
        expect(kind.body).toMatchObject({ error: 'invalid-argument', argument: 'operations[0].kind' });
        expect(noKind.body).toMatchObject({ error: 'invalid-argument', argument: 'operations[0].kind' });
        expect(overlay.body).toMatchObject({ error: 'invalid-operation', index: 0 });
        expect(stale.body).toMatchObject({ error: 'conflict', currentRevision: 1 });
    });
});
