import { describe, expect, it } from 'vitest';
import { appWithRenamedScreen, bodyWithRenamedPart, hasScreen } from './renameReferences.js';
import type { UiPartBodies } from './UiPart.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const APP = deepFreeze({
    uses: {
        themes: ['base', 'store'],
        data: { stock: { dataset: 'stock' }, wishes: { model: 'product' }, odd: 'not a binding' },
        logic: { tax: {}, cart: { params: { max: 3 } }, ship: {} }
    },
    start: 'home',
    app: { component: 'app', toasts: { component: 'hero' } },
    screens: {
        home: { root: { component: 'stack', children: { top: { component: 'hero' }, go: { component: 'button', on: { click: [{ command: 'navigate', target: 'about' }] } } } } },
        about: { root: { component: 'text', on: { click: [{ command: 'navigate', target: 'home' }, { command: 'emit', target: 'about' }] } } }
    }
}) as unknown as UiPartBodies['apps'];

describe('bodyWithRenamedPart', () => {
    it('should rename a theme in an app theme list in its place', () => {
        // Act
        const renamed = bodyWithRenamedPart('apps', APP, 'themes', 'store', 'brand') as unknown as typeof APP & { uses: { themes: string[] } };

        // Assert
        expect(renamed.uses.themes).toEqual(['base', 'brand']);
        expect(renamed.app).toEqual(APP.app);
    });

    it('should rename a binding dataset or model and leave the other field alone', () => {
        // Act
        const dataset = bodyWithRenamedPart('apps', APP, 'data', 'stock', 'inventory') as unknown as { uses: { data: object } };
        const model = bodyWithRenamedPart('apps', APP, 'models', 'product', 'item') as unknown as { uses: { data: object } };

        // Assert
        expect(dataset.uses.data).toEqual({ stock: { dataset: 'inventory' }, wishes: { model: 'product' }, odd: 'not a binding' });
        expect(model.uses.data).toEqual({ stock: { dataset: 'stock' }, wishes: { model: 'item' }, odd: 'not a binding' });
    });

    it('should rename a logic key in its place with its configuration', () => {
        // Act
        const renamed = bodyWithRenamedPart('apps', APP, 'logic', 'cart', 'basket') as unknown as { uses: { logic: object } };

        // Assert
        expect(Object.entries(renamed.uses.logic)).toEqual([
            ['tax', {}],
            ['basket', { params: { max: 3 } }],
            ['ship', {}]
        ]);
    });

    it('should rename a component in the app node and in every screen of an app', () => {
        // Act
        const renamed = JSON.stringify(bodyWithRenamedPart('apps', APP, 'components', 'hero', 'banner'));

        // Assert
        expect(renamed).not.toContain('"hero"');
        expect(renamed.split('"banner"')).toHaveLength(3);
    });

    it('should rename the models of a module and a dataset, and the components of a component and a pattern', () => {
        // Arrange
        const module = deepFreeze({ needs: { lines: { model: 'product' }, other: { model: 'order' }, odd: 1 } }) as unknown as UiPartBodies['logic'];
        const dataset = deepFreeze({ model: 'product', records: {} }) as unknown as UiPartBodies['data'];
        const card = deepFreeze({ tree: { component: 'stack', children: { a: { component: 'hero' } } }, exposes: [] }) as unknown as UiPartBodies['components'];
        const pattern = deepFreeze({ tree: [{ component: 'hero' }] }) as unknown as UiPartBodies['patterns'];

        // Act, Assert
        expect(bodyWithRenamedPart('logic', module, 'models', 'product', 'item')).toEqual({ needs: { lines: { model: 'item' }, other: { model: 'order' }, odd: 1 } });
        expect(bodyWithRenamedPart('data', dataset, 'models', 'product', 'item')).toEqual({ model: 'item', records: {} });
        expect(bodyWithRenamedPart('components', card, 'components', 'hero', 'banner')).toEqual({ tree: { component: 'stack', children: { a: { component: 'banner' } } }, exposes: [] });
        expect(bodyWithRenamedPart('patterns', pattern, 'components', 'hero', 'banner')).toEqual({ tree: [{ component: 'banner' }] });
    });

    it('should give undefined for a body that does not name the part', () => {
        // Arrange
        const dataset = deepFreeze({ model: 'order', records: {} }) as unknown as UiPartBodies['data'];
        const bare = deepFreeze({ app: { component: 'app' } }) as unknown as UiPartBodies['apps'];
        const module = deepFreeze({ params: {} }) as unknown as UiPartBodies['logic'];

        // Act, Assert
        expect(bodyWithRenamedPart('apps', APP, 'themes', 'night', 'dark')).toBeUndefined();
        expect(bodyWithRenamedPart('apps', APP, 'logic', 'missing', 'other')).toBeUndefined();
        expect(bodyWithRenamedPart('apps', bare, 'themes', 'store', 'brand')).toBeUndefined();
        expect(bodyWithRenamedPart('data', dataset, 'models', 'product', 'item')).toBeUndefined();
        expect(bodyWithRenamedPart('logic', module, 'models', 'product', 'item')).toBeUndefined();
        expect(bodyWithRenamedPart('themes', {} as UiPartBodies['themes'], 'themes', 'store', 'brand')).toBeUndefined();
        expect(bodyWithRenamedPart('data', dataset, 'components', 'order', 'x')).toBeUndefined();
    });
});

describe('appWithRenamedScreen', () => {
    it('should rename the screen key in its place, the start and the navigate targets only', () => {
        // Act
        const renamed = appWithRenamedScreen(APP, 'home', 'welcome') as unknown as typeof APP & { start: string; screens: Record<string, unknown> };

        // Assert
        expect(renamed.start).toBe('welcome');
        expect(Object.keys(renamed.screens)).toEqual(['welcome', 'about']);
        expect(renamed.screens['about']).toEqual({ root: { component: 'text', on: { click: [{ command: 'navigate', target: 'welcome' }, { command: 'emit', target: 'about' }] } } });
    });

    it('should keep the start of another screen and give undefined for a missing screen', () => {
        // Act
        const renamed = appWithRenamedScreen(APP, 'about', 'story') as unknown as { start: string };

        // Assert
        expect(renamed.start).toBe('home');
        expect(JSON.stringify(renamed)).toContain('"target":"story"');
        expect(appWithRenamedScreen(APP, 'nothing', 'x')).toBeUndefined();
        expect(appWithRenamedScreen({} as UiPartBodies['apps'], 'home', 'x')).toBeUndefined();
    });

    it('should tell whether an app has a screen', () => {
        // Act, Assert
        expect([hasScreen(APP, 'home'), hasScreen(APP, 'toString'), hasScreen({} as UiPartBodies['apps'], 'home')]).toEqual([true, false, false]);
    });
});
