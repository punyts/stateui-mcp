import { describe, expect, it } from 'vitest';
import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import { createThemeTools } from './themeTools.js';

const PRESETS = Object.freeze([Object.freeze({ name: 'plain', summary: 'light and airy, one blue accent' })]);

/** Use cases whose create answers every preset as unknown, which is all the tool text needs */
const USE_CASES = {
    createTheme: { execute: async (input: { preset?: string }) => ({ kind: 'unknown-preset', preset: input.preset ?? '' }) },
    writeTheme: { execute: async () => ({ kind: 'not-found', nearest: [] }) }
} as unknown as Pick<UiBuilderUseCases, 'createTheme' | 'writeTheme'>;

function themeCreate(presets: readonly { name: string; summary: string }[]) {
    const tool = createThemeTools(USE_CASES, presets).find((candidate) => candidate.name === 'ui_theme_create');
    if (tool === undefined) throw new Error('ui_theme_create is not registered');
    return { tool, preset: (tool.inputSchema as unknown as { properties: Record<string, { enum?: string[]; description: string }> }).properties['preset']! };
}

describe('ui_theme_create and the library presets', () => {
    it('should make preset an enum of the preset names, each described in the tool text', () => {
        // Act
        const { preset } = themeCreate(PRESETS);

        // Assert
        expect(preset.enum).toEqual(['plain']);
        expect(preset.description).toContain('plain (light and airy, one blue accent)');
    });

    it('should leave preset a free string, saying there are none, while the library has no presets', () => {
        // Act
        const { preset } = themeCreate([]);

        // Assert
        expect(preset.enum).toBeUndefined();
        expect(preset.description).toContain('has none');
    });

    it('should answer an unknown preset with the names there are', async () => {
        // Arrange
        const { tool } = themeCreate(PRESETS);

        // Act
        const outcome = await tool.run({ name: 'shop', preset: 'loud' });

        // Assert
        expect(outcome.isError).toBe(true);
        expect(outcome.body).toMatchObject({ error: 'invalid-argument', argument: 'preset' });
        expect((outcome.body as { message: string }).message).toMatch(/one of: plain\b/);
    });
});
