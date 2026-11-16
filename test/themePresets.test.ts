import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, inMemoryHarness, tempData } from './helpers.js';
import type { InMemoryHarness, TempData } from './helpers.js';

const PRESETS = ['clean', 'moody', 'playful', 'professional'] as const;

/** The pairs the 4.5 rule is for: body text on the surface and each tone's `on` on its `base` (inverse and disabled text are not body text) */
const BODY_PAIRS = /^color\.(text\.(base|muted)|(neutral|accent|danger|warning|success|info)\.on)$/;

interface Pair {
    mode: string;
    text: string;
    surface: string;
    ratio: number | 'unresolved';
    passesAA?: boolean;
}

interface ThemeValue {
    tokens: Record<string, unknown>;
    overlays: Record<string, { kind: string; tokens: Record<string, unknown> }>;
}

let data: TempData;
let harness: InMemoryHarness;

beforeEach(async () => {
    data = await tempData();
    harness = await inMemoryHarness(data.dir);
});

afterEach(async () => {
    await harness.close();
    await data.cleanup();
});

/** Creates a theme from the preset and reads it back */
async function fromPreset(preset: string): Promise<{ created: Record<string, unknown>; value: ThemeValue }> {
    const created = await call(harness.client, 'ui_theme_create', { name: `my-${preset}`, preset });
    const read = await call(harness.client, 'ui_get', { kind: 'themes', name: `my-${preset}` });
    return { created: created.body, value: read.body['value'] as ThemeValue };
}

function at(tree: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((node, key) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[key] : undefined), tree);
}

describe('the library theme presets', () => {
    it('should offer the four presets in ui_theme_create, moody described as dark first', async () => {
        // Act
        const { tools } = await harness.client.listTools();
        const create = tools.find((tool) => tool.name === 'ui_theme_create');
        const preset = (create?.inputSchema.properties as Record<string, { enum?: string[]; description: string }>)['preset']!;

        // Assert
        expect(preset.enum).toEqual([...PRESETS]);
        expect(preset.description).toMatch(/moody \(Moody: dark first[^)]*set the app mode to dark\)/);
    });

    it.each(PRESETS)('should create a valid theme from %s with its own light and dark modes, body text passing 4.5 in every mode', async (preset) => {
        // Act
        const { created, value } = await fromPreset(preset);
        const contrast = created['contrast'] as Pair[];

        // Assert
        expect(created).toMatchObject({ theme: `my-${preset}`, revision: 1, warnings: [] });
        expect(value.overlays['light']).toMatchObject({ kind: 'mode' });
        expect(value.overlays['dark']).toMatchObject({ kind: 'mode' });
        expect(at(value.tokens, 'color')).toBeUndefined();
        const body = contrast.filter((pair) => BODY_PAIRS.test(pair.text));
        expect([...new Set(body.map((pair) => pair.mode))]).toEqual(['light', 'dark', 'contrast']);
        expect(body.filter((pair) => pair.passesAA !== true)).toEqual([]);
    });

    it('should make any two presets differ in the accent, a surface and a spacing or shape token', async () => {
        // Arrange
        const values = await Promise.all(PRESETS.map(async (preset) => (await fromPreset(preset)).value));
        const light = (value: ThemeValue, path: string): unknown => at(value.overlays['light']?.tokens, path);
        const SURFACES = ['color.surface.base', 'color.surface.raised', 'color.surface.sunken'];
        const SHAPE = ['density.factor', 'radius.sm', 'radius.md', 'radius.lg', 'text.body.size'];

        // Act / Assert
        for (const [i, a] of values.entries()) {
            for (const b of values.slice(i + 1)) {
                expect(light(a, 'color.accent.base')).not.toEqual(light(b, 'color.accent.base'));
                expect(SURFACES.some((path) => light(a, path) !== light(b, path))).toBe(true);
                expect(SHAPE.some((path) => at(a.tokens, path) !== at(b.tokens, path))).toBe(true);
            }
        }
    });
});
