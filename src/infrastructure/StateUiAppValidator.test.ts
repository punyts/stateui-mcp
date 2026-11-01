import { describe, it, expect } from 'vitest';
import { createStateUiAdapters } from '../config/createStateUiAdapters.js';
import { MAX_DOCUMENT_BYTES, documentBytes } from '../domain/limits.js';
import type { UiDocument } from '../domain/UiApp.js';
import { isValid } from '../domain/UiBuildError.js';
import { SAMPLE_FORM_AND_LIST_APP } from '../testing/sampleFormAndListApp.fixture.js';

const { validator } = createStateUiAdapters();

function titled(length: number): UiDocument {
    return { app: { component: 'page', _title: 'x'.repeat(length) } };
}

function pair(error: { code: string; statePath?: string }): [string, string | undefined] {
    return [error.code, error.statePath];
}

describe('StateUiAppValidator', () => {
    describe('sample form-and-list app', () => {
        it('should pass with no errors and no warnings', () => {
            const errors = validator.validate(SAMPLE_FORM_AND_LIST_APP);

            expect(errors).toEqual([]);
        });
    });

    describe('error families', () => {
        it('should return one error per code family, each with its state path', () => {
            const app = SAMPLE_FORM_AND_LIST_APP['app'] as { children: object };
            const document: UiDocument = {
                ...SAMPLE_FORM_AND_LIST_APP,
                unknownKey: 1,
                app: {
                    ...app,
                    children: {
                        ...app.children,
                        ghost: { component: 'nothing' },
                        extra: { component: 'text', nonsense: true },
                        linked: { component: 'text', '<-_text': '$.data.nobody' }
                    }
                }
            };

            const errors = validator.validate(document);

            expect(errors.map(pair)).toEqual(
                expect.arrayContaining([
                    ['SUI-DOC-KEY', '$.unknownKey'],
                    ['SUI-NODE-UNKNOWN', '$.app.children.ghost'],
                    ['SUI-STATE-UNKNOWN', '$.app.children.extra.nonsense'],
                    ['SUI-LINK-MISSING', '$.app.children.linked']
                ])
            );
            expect(errors.every((error) => error.statePath !== undefined)).toBe(true);
            expect(isValid(errors)).toBe(false);
        });

        it('should report an unknown icon name on an icon-typed property', () => {
            const document: UiDocument = {
                app: { component: 'page', children: { go: { component: 'button', icon: 'not-an-icon-at-all' } } }
            };

            const errors = validator.validate(document);

            expect(errors.map(pair)).toEqual([['SUI-STATE-INVALID', '$.app.children.go.icon']]);
        });

        it('should accept a known icon name and an alias', () => {
            const document: UiDocument = {
                app: {
                    component: 'page',
                    children: { a: { component: 'button', icon: 'trash' }, b: { component: 'button', icon: 'delete' } }
                }
            };

            expect(validator.validate(document)).toEqual([]);
        });
    });

    describe('unknown component', () => {
        it('should list the nearest component names in the message', () => {
            const document: UiDocument = { app: { component: 'page', children: { f: { component: 'textFeild' } } } };

            const [error] = validator.validate(document);

            expect(error?.code).toBe('SUI-NODE-UNKNOWN');
            expect(error?.message).toContain('Nearest names: textField');
        });

        it('should include names from the document composed entries', () => {
            const document: UiDocument = {
                composed: { customerCard: { component: 'panel' } },
                app: { component: 'page', children: { c: { component: 'customerCrad' } } }
            };

            const [error] = validator.validate(document);

            expect(error?.message).toContain('customerCard');
        });

        it('should add no hint when nothing is near', () => {
            const document: UiDocument = { app: { component: 'page', children: { f: { component: 'qqqqqqqqqqqq' } } } };

            const [error] = validator.validate(document);

            expect(error?.message).not.toContain('Nearest');
        });
    });

    describe('<- targets', () => {
        it('should report $row outside a row template', () => {
            const document: UiDocument = {
                app: { component: 'page', children: { t: { component: 'text', '<-_text': '$row.name' } } }
            };

            expect(validator.validate(document).map((error) => error.code)).toContain('SUI-LINK-ROW');
        });

        it('should accept a node reference to an exposed property and reject one to a property that is not', () => {
            const document = (target: string): UiDocument => ({
                app: {
                    component: 'page',
                    children: {
                        customers: { component: 'list' },
                        detail: { component: 'text', '<-_text': target }
                    }
                }
            });

            expect(validator.validate(document('^app.children.customers.current.name'))).toEqual([]);
            expect(validator.validate(document('^app.children.customers.divided')).map((error) => error.code)).toEqual([
                'SUI-LINK-MISSING'
            ]);
        });

        it('should report a target that is not $.data, $row or a node reference', () => {
            const document: UiDocument = {
                app: { component: 'page', children: { t: { component: 'text', '<-_text': '$.app.title' } } }
            };

            expect(validator.validate(document).map((error) => error.code)).toContain('SUI-LINK-TARGET');
        });
    });

    describe('size limit', () => {
        const base = documentBytes(titled(0));

        it('should pass a document exactly at the limit', () => {
            const document = titled(MAX_DOCUMENT_BYTES - base);

            expect(documentBytes(document)).toBe(MAX_DOCUMENT_BYTES);
            expect(validator.validate(document)).toEqual([]);
        });

        it('should reject a document one byte over the limit before validating it', () => {
            const document: UiDocument = { app: { component: 'nothing', _title: 'x'.repeat(MAX_DOCUMENT_BYTES) } };

            const errors = validator.validate(document);

            expect(errors.map(pair)).toEqual([['SUI-DOC-LIMIT-BYTES', '$']]);
        });

        it('should reject a document exactly one byte over', () => {
            const document = titled(MAX_DOCUMENT_BYTES - base + 1);

            expect(documentBytes(document)).toBe(MAX_DOCUMENT_BYTES + 1);
            expect(validator.validate(document).map((error) => error.code)).toEqual(['SUI-DOC-LIMIT-BYTES']);
        });
    });

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
        it('should leave the process without a DOM after validating', () => {
            validator.validate(SAMPLE_FORM_AND_LIST_APP);

            expect((globalThis as { customElements?: unknown }).customElements).toBeUndefined();
            expect((globalThis as { document?: unknown }).document).toBeUndefined();
        });
    });
});
