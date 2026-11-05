import { describe, it, expect } from 'vitest';
import { createStateUiAdapters } from '../config/createStateUiAdapters.js';
import type { UiDocument } from '../domain/UiApp.js';
import { SAMPLE_FORM_AND_LIST_APP } from '../testing/sampleFormAndListApp.fixture.js';

const { validator } = createStateUiAdapters();

describe('StateUiAppValidator', () => {
    describe('resolveNode', () => {
        it('should return the node merged with its component defaults', () => {
            const node = validator.resolveNode(SAMPLE_FORM_AND_LIST_APP, ['app', 'footer', 'children', 'save']);

            expect(node?.['component']).toBe('button');
            expect(node?.['_title']).toBe('Save');
            expect(node?.['variant']).toBe('solid');
        });

        it('should return undefined for a missing path, a non-node and an unknown component', () => {
            const document: UiDocument = { app: { component: 'page', children: { ghost: { component: 'nothing' } } } };

            expect(validator.resolveNode(document, ['app', 'nope'])).toBeUndefined();
            expect(validator.resolveNode(document, ['app', 'children'])).toBeUndefined();
            expect(validator.resolveNode(document, ['app', 'children', 'ghost'])).toBeUndefined();
        });
    });

    describe('no DOM', () => {
        it('should leave the process without a DOM after resolving a node', () => {
            validator.resolveNode(SAMPLE_FORM_AND_LIST_APP, ['app']);

            expect((globalThis as { customElements?: unknown }).customElements).toBeUndefined();
            expect((globalThis as { document?: unknown }).document).toBeUndefined();
        });
    });
});
