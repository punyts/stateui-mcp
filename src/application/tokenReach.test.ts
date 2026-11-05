import { describe, expect, it } from 'vitest';
import type { ComponentCatalog, ComponentEntry, ThemeToken } from './ports/ComponentCatalog.js';
import { tokenReach } from './tokenReach.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const TOKENS = deepFreeze([
    { path: 'color.accent.base', type: 'color', default: '{palette.blue.600}', group: 'color', description: '' },
    { path: 'color.surface.sunken', type: 'color', default: '{palette.neutral.50}', group: 'color', description: '' }
]) as readonly ThemeToken[];

const COMPONENTS = deepFreeze({
    button: { name: 'button', tokens: [{ path: 'button.fill', type: 'color', default: '{color.accent.base}' }] },
    image: { name: 'image', tokens: [{ path: 'image.fill', type: 'color', default: '{color.surface.sunken}' }] },
    text: { name: 'text', tokens: [] }
}) as unknown as Record<string, ComponentEntry>;

const CATALOG = {
    list: () => Object.values(COMPONENTS),
    get: (name: string) => COMPONENTS[name],
    listTokens: () => TOKENS
} as unknown as ComponentCatalog;

describe('tokenReach', () => {
    it('should reach components by their own tokens, a semantic token and a primitive through one', () => {
        // Act
        const reach = tokenReach(CATALOG, ['color.accent.base', 'palette.blue', 'image.fill', 'motion.duration', 'color.accent.base']);

        // Assert
        expect(reach).toEqual([
            { token: 'color.accent.base', components: ['button'] },
            { token: 'palette.blue', components: ['button'] },
            { token: 'image.fill', components: ['image'] },
            { token: 'motion.duration', components: [] }
        ]);
    });
});
