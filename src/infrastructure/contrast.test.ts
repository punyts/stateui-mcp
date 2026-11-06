import { describe, expect, it } from 'vitest';
import type { ThemePart } from '@punyts/stateui-app/core';
import { contrastRatio, themeContrast } from './contrast.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

describe('contrastRatio', () => {
    it('should give 21 for black on white and 1 for equal colours', () => {
        // Act / Assert
        expect(contrastRatio('#000000', '#ffffff')).toBe(21);
        expect(contrastRatio('#204080', '#204080')).toBe(1);
    });
});

describe('themeContrast', () => {
    it('should report each text pair in each shipped mode for a theme with no tokens of its own', () => {
        // Arrange
        const theme = deepFreeze({ tokens: {} }) as ThemePart;

        // Act
        const report = themeContrast(theme);

        // Assert
        expect([...new Set(report.map((pair) => pair.mode))]).toEqual(['light', 'dark', 'contrast']);
        expect(report).toContainEqual(expect.objectContaining({ mode: 'light', text: 'color.text.base', surface: 'color.surface.base', passesAA: true }));
        expect(report).toContainEqual(expect.objectContaining({ mode: 'light', text: 'color.accent.on', surface: 'color.accent.base' }));
    });

    it('should check inverse text on the base text colour it is drawn on, and leave out disabled text', () => {
        // Arrange
        const theme = deepFreeze({ tokens: {} }) as ThemePart;

        // Act
        const report = themeContrast(theme);

        // Assert
        for (const mode of ['light', 'dark', 'contrast']) {
            expect(report).toContainEqual(expect.objectContaining({ mode, text: 'color.text.inverse', surface: 'color.text.base', passesAA: true }));
        }
        expect(report.filter((pair) => pair.text === 'color.text.inverse' && pair.surface === 'color.surface.base')).toEqual([]);
        expect(report.filter((pair) => pair.text === 'color.text.disabled')).toEqual([]);
    });

    it('should use the theme tokens, add its own mode overlays and mark a pair it cannot resolve', () => {
        // Arrange
        const theme = deepFreeze({
            tokens: { color: { text: { base: '#bbbbbb' }, surface: { base: '#ffffff' } } },
            overlays: { dim: { kind: 'mode', tokens: { color: { text: { muted: 'var(--x)' } } } }, acme: { kind: 'brand', tokens: {} } }
        }) as unknown as ThemePart;

        // Act
        const report = themeContrast(theme);
        const light = report.find((pair) => pair.mode === 'light' && pair.text === 'color.text.base');
        const dimMuted = report.find((pair) => pair.mode === 'dim' && pair.text === 'color.text.muted');

        // Assert
        expect(light).toMatchObject({ ratio: 1.91, passesAA: false });
        expect(dimMuted).toEqual({ mode: 'dim', text: 'color.text.muted', surface: 'color.surface.base', ratio: 'unresolved' });
        expect(report.some((pair) => pair.mode === 'acme')).toBe(false);
    });

    it('should check a theme dark overlay merged over the shipped dark, in its place', () => {
        // Arrange
        const theme = deepFreeze({
            tokens: {},
            overlays: { dark: { kind: 'mode', tokens: { color: { accent: { base: '#000000' } } } } }
        }) as unknown as ThemePart;

        // Act
        const report = themeContrast(theme);
        const accent = report.find((pair) => pair.mode === 'dark' && pair.text === 'color.accent.on');
        const text = report.find((pair) => pair.mode === 'dark' && pair.text === 'color.text.base');

        // Assert
        expect([...new Set(report.map((pair) => pair.mode))]).toEqual(['light', 'dark', 'contrast']);
        expect(accent).toMatchObject({ surface: 'color.accent.base', passesAA: false });
        expect(text).toMatchObject({ passesAA: true });
    });
});
