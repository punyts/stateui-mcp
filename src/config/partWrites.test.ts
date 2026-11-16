import { beforeEach, describe, expect, it } from 'vitest';
import { IndexedUiPartRepository } from '../application/IndexedUiPartRepository.js';
import { ValidatePartApp } from '../application/use-cases/ValidateApp.js';
import { WritePart } from '../application/use-cases/WritePart.js';
import type { UiPartBodies } from '../domain/UiPart.js';
import { InMemoryUiPartRepository } from '../testing/InMemoryUiPartRepository.js';
import { createStateUiAdapters } from './createStateUiAdapters.js';

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const { validator } = createStateUiAdapters();
const REPORT = Object.freeze({ info: (): void => undefined });

const STORE_THEME = deepFreeze({ tokens: { color: { accent: { base: '#204080' } } } }) as unknown as UiPartBodies['themes'];
const PRODUCT = deepFreeze({ fields: { name: { type: 'string', required: true } } }) as UiPartBodies['models'];
const CATALOG = deepFreeze({ model: 'product', records: { p1: { name: 'Lamp' }, p2: { name: 'Chair' }, p3: { name: 'Desk' } } }) as unknown as UiPartBodies['data'];
const TAX = deepFreeze({ needs: {}, params: { taxRate: { type: 'number', default: 0 } } }) as unknown as UiPartBodies['logic'];
const HERO = deepFreeze({ tree: { component: 'text', _text: 'Welcome' }, exposes: [] }) as unknown as UiPartBodies['components'];

function app(logic: Record<string, unknown>): UiPartBodies['apps'] {
    return deepFreeze({
        uses: { themes: ['store'], data: { products: { dataset: 'catalog' } }, logic },
        start: 'main',
        app: { component: 'app' },
        screens: { main: { root: { component: 'hero' } } }
    }) as unknown as UiPartBodies['apps'];
}

let parts: IndexedUiPartRepository;
let writePart: WritePart;

beforeEach(async () => {
    parts = new IndexedUiPartRepository(new InMemoryUiPartRepository());
    writePart = new WritePart(parts, parts, validator, REPORT);
    for (const [kind, name, body] of [
        ['themes', 'store', STORE_THEME],
        ['models', 'product', PRODUCT],
        ['data', 'catalog', CATALOG],
        ['logic', 'tax', TAX],
        ['components', 'hero', HERO]
    ] as const) {
        const written = await writePart.execute({ kind, name, body } as never);
        if (written.kind !== 'written') throw new Error(`${name}: ${JSON.stringify(written)}`);
    }
    for (const [name, body] of [['priced', app({ tax: { params: { taxRate: 0.2 } } })], ['plain', app({ tax: {} })]] as const) {
        const written = await writePart.execute({ kind: 'apps', name, body });
        if (written.kind !== 'written') throw new Error(`${name}: ${JSON.stringify(written)}`);
    }
});

describe('part writes with the StateUI validator', () => {
    it('should write a module change that breaks one of two apps and name that app', async () => {
        // Arrange
        const withoutParam = deepFreeze({ needs: {}, params: {} }) as unknown as UiPartBodies['logic'];

        // Act
        const result = await writePart.execute({ kind: 'logic', name: 'tax', body: withoutParam, expectedRevision: 1 });

        // Assert
        if (result.kind !== 'written') throw new Error(JSON.stringify(result));
        expect(result.warnings.map((warning) => warning.app)).toEqual(['priced']);
        expect(result.warnings[0]?.errors.map((error) => error.code)).toEqual(['SUI-MODULE-PARAM']);
        expect(result.moreApps).toBe(0);
        expect((await parts.findByName('logic', 'tax'))?.revision).toBe(2);
    });

    it('should warn about the records a model write leaves invalid, naming the first keys', async () => {
        // Arrange
        const priced = deepFreeze({ fields: { name: { type: 'string', required: true }, price: { type: 'number', required: true } } }) as UiPartBodies['models'];

        // Act
        const result = await writePart.execute({ kind: 'models', name: 'product', body: priced, expectedRevision: 1 });

        // Assert
        if (result.kind !== 'written') throw new Error(JSON.stringify(result));
        expect(result.datasetWarnings).toEqual([{ dataset: 'catalog', keys: ['p1', 'p2', 'p3'], invalidCount: 3 }]);
    });

    it('should refuse each kind of part with errors of its own', async () => {
        // Act
        const results = await Promise.all([
            writePart.execute({ kind: 'apps', name: 'lost', body: { ...app({}), uses: { themes: ['nowhere'] } } }),
            writePart.execute({ kind: 'themes', name: 'odd', body: { tokens: { color: { nope: { base: '#000000' } } } } as unknown as UiPartBodies['themes'] }),
            writePart.execute({ kind: 'logic', name: 'odd', body: { needs: {} } as unknown as UiPartBodies['logic'] }),
            writePart.execute({ kind: 'models', name: 'odd', body: { fields: { a: { type: 'colour' } } } as unknown as UiPartBodies['models'] }),
            writePart.execute({ kind: 'data', name: 'odd', body: { model: 'product', records: { r1: { name: 3 } } } as unknown as UiPartBodies['data'] }),
            writePart.execute({ kind: 'data', name: 'orphan', body: { model: 'prodct', records: {} } as unknown as UiPartBodies['data'] }),
            writePart.execute({ kind: 'components', name: 'odd', body: { tree: { component: 'nothing-like-it' }, exposes: [] } as unknown as UiPartBodies['components'] }),
            writePart.execute({ kind: 'patterns', name: 'odd', body: { kind: 'page' } as unknown as UiPartBodies['patterns'] })
        ]);

        // Assert
        expect(results.map((result) => result.kind)).toEqual(Array(8).fill('invalid'));
        const codes = results.map((result) => (result.kind === 'invalid' ? result.errors[0]?.code : undefined));
        expect(codes).toEqual(['SUI-USES-MISSING', 'SUI-THEME-TOKEN', 'SUI-LOGIC-SHAPE', 'SUI-MODEL-SHAPE', 'SUI-MODEL-FIELD', 'SUI-PART-SHAPE', 'SUI-USES-MISSING', 'SUI-PATTERN-SHAPE']);
        const orphan = results[5];
        expect(orphan?.kind === 'invalid' && orphan.errors[0]?.message).toBe('The dataset "orphan" at $.model is not valid: the owner has no model "prodct"; nearest names: product');
        expect((await parts.list('data')).map((part) => part.name)).toEqual(['catalog']);
    });

    it('should validate one app with everything it uses and name the part of each error', async () => {
        // Arrange
        const validatePartApp = new ValidatePartApp(parts, parts, validator, REPORT);
        await writePart.execute({ kind: 'logic', name: 'tax', body: { needs: {}, params: {} } as unknown as UiPartBodies['logic'], expectedRevision: 1 });

        // Act
        const priced = await validatePartApp.execute('priced');
        const plain = await validatePartApp.execute('plain');
        const missing = await validatePartApp.execute('nothing');

        // Assert
        if (priced.kind !== 'validated' || plain.kind !== 'validated') throw new Error('not validated');
        expect(priced.valid).toBe(false);
        expect(priced.errors.map((error) => [error.code, error.part])).toEqual([['SUI-MODULE-PARAM', { kind: 'logic', name: 'tax' }]]);
        expect(plain).toMatchObject({ valid: true, errors: [], revision: 1 });
        expect(plain.uses.map((ref) => `${ref.kind}/${ref.name}`)).toEqual(['themes/store', 'data/catalog', 'logic/tax', 'components/hero']);
        expect(missing).toEqual({ kind: 'not-found', app: 'nothing' });
    });
});
