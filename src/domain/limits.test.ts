import { describe, it, expect } from 'vitest';
import {
    MAX_DOCUMENT_BYTES,
    MAX_NODE_COUNT,
    MAX_OPERATIONS_PER_WRITE,
    checkDocumentLimits,
    checkOperationLimit,
    countNodes,
    documentBytes
} from './limits.js';
import type { UiDocument } from './UiApp.js';

const BASE_BYTES = documentBytes({ app: { component: 'page' }, data: { pad: '' } });

/** A document that serialises to exactly `bytes` bytes */
function documentOfBytes(bytes: number): UiDocument {
    return { app: { component: 'page' }, data: { pad: 'x'.repeat(bytes - BASE_BYTES) } };
}

function documentWithNodes(count: number): UiDocument {
    const children: Record<string, { component: string }> = {};
    for (let index = 1; index < count; index++) children[`n${index}`] = { component: 'text' };
    return { app: { component: 'page', children } };
}

describe('limits', () => {
    it('should name the closed limits', () => {
        expect(MAX_OPERATIONS_PER_WRITE).toBe(50);
        expect(MAX_DOCUMENT_BYTES).toBe(1048576);
        expect(MAX_NODE_COUNT).toBe(2000);
    });

    describe('documentBytes', () => {
        it('should count UTF-8 bytes, not characters', () => {
            expect(documentBytes('é')).toBe(4);
        });
    });

    describe('countNodes', () => {
        it('should count objects with a string component, through arrays and nested maps', () => {
            const value = {
                app: { component: 'page', children: { a: { component: 'text' } } },
                composed: { box: { component: 'panel' } },
                data: { list: [{ component: 'text' }, { component: 5 }, 'x'] }
            };

            expect(countNodes(value)).toBe(4);
        });
    });

    describe('checkDocumentLimits', () => {
        it('should pass a document exactly at the byte limit', () => {
            const document = documentOfBytes(MAX_DOCUMENT_BYTES);

            expect(documentBytes(document)).toBe(MAX_DOCUMENT_BYTES);
            expect(checkDocumentLimits(document)).toEqual([]);
        });

        it('should reject a document one byte over the byte limit', () => {
            const document = documentOfBytes(MAX_DOCUMENT_BYTES + 1);

            const errors = checkDocumentLimits(document);

            expect(errors.map((error) => error.code)).toEqual(['SUI-DOC-LIMIT-BYTES']);
            expect(errors[0]?.statePath).toBe('$');
        });

        it('should pass a document exactly at the node limit', () => {
            expect(checkDocumentLimits(documentWithNodes(MAX_NODE_COUNT))).toEqual([]);
        });

        it('should reject a document one node over the node limit', () => {
            const errors = checkDocumentLimits(documentWithNodes(MAX_NODE_COUNT + 1));

            expect(errors.map((error) => error.code)).toEqual(['SUI-DOC-LIMIT-NODES']);
        });
    });

    describe('checkOperationLimit', () => {
        it('should pass 50 operations', () => {
            expect(checkOperationLimit(50)).toBeUndefined();
        });

        it('should reject 51 operations with a SUI-DOC error', () => {
            const error = checkOperationLimit(51);

            expect(error?.code).toBe('SUI-DOC-LIMIT-OPERATIONS');
            expect(error?.message).toContain('51');
        });
    });
});
