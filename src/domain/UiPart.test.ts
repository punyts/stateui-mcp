import { describe, expect, it } from 'vitest';
import { isPartName, slugifyName } from './partName.js';
import { INITIAL_REVISION } from './revision.js';
import { createUiPart, isPartKind, partNameProblem, renameUiPart, reviseUiPart } from './UiPart.js';
import type { UiPartBodies } from './UiPart.js';

const CREATED = new Date('2026-11-04T10:00:00Z');
const LATER = new Date('2026-11-04T11:00:00Z');

const THEME: UiPartBodies['themes'] = Object.freeze({ tokens: Object.freeze({ color: Object.freeze({ brand: '#204080' }) }) }) as UiPartBodies['themes'];

function themePart() {
    return createUiPart({ id: 'b2f4c1de-0000-4000-8000-000000000001', kind: 'themes', name: 'store', body: THEME, now: CREATED });
}

describe('UiPart', () => {
    describe('createUiPart', () => {
        it('should start at the initial revision with both timestamps at creation', () => {
            // Act
            const part = themePart();

            // Assert
            expect(part).toEqual({ id: 'b2f4c1de-0000-4000-8000-000000000001', kind: 'themes', name: 'store', revision: INITIAL_REVISION, body: THEME, createdAt: CREATED, updatedAt: CREATED });
        });

        it('should refuse a name that is not a slug', () => {
            // Act, Assert
            for (const name of ['Store', 'my store', '1store', '42', '', 'a'.repeat(64)]) {
                expect(() => createUiPart({ id: 'x', kind: 'themes', name, body: THEME, now: CREATED })).toThrow(RangeError);
            }
        });

        it('should refuse an unknown kind', () => {
            // Act, Assert
            expect(() => createUiPart({ id: 'x', kind: 'personas' as 'themes', name: 'store', body: THEME, now: CREATED })).toThrow('Invalid part kind: personas');
        });
    });

    describe('reviseUiPart', () => {
        it('should raise the revision by one and keep the id, name and creation time', () => {
            // Arrange
            const body = { tokens: { color: { brand: '#000000' } } } as UiPartBodies['themes'];

            // Act
            const revised = reviseUiPart(themePart(), body, LATER);

            // Assert
            expect(revised.revision).toBe(INITIAL_REVISION + 1);
            expect(revised.body).toBe(body);
            expect([revised.id, revised.name, revised.createdAt, revised.updatedAt]).toEqual(['b2f4c1de-0000-4000-8000-000000000001', 'store', CREATED, LATER]);
        });
    });

    describe('renameUiPart', () => {
        it('should change the name, keep the id and raise the revision', () => {
            // Act
            const renamed = renameUiPart(themePart(), 'shop', LATER);

            // Assert
            expect([renamed.id, renamed.name, renamed.revision, renamed.body]).toEqual(['b2f4c1de-0000-4000-8000-000000000001', 'shop', INITIAL_REVISION + 1, THEME]);
        });

        it('should refuse a new name that is not a slug', () => {
            // Act, Assert
            expect(() => renameUiPart(themePart(), 'Shop', LATER)).toThrow(RangeError);
        });
    });

    describe('names and kinds', () => {
        it('should check names with the stateui-app rule and say why one is refused', () => {
            // Act, Assert
            expect(isPartName('store-2')).toBe(true);
            expect(slugifyName('My Store', ['my-store'])).toBe('my-store-2');
            expect(partNameProblem('store')).toBeUndefined();
            expect(partNameProblem('My Store')).toBe('"My Store" is not a part name: lower-case letters, digits and dashes, starting with a letter, at most 63 characters');
        });

        it('should know the owner roots that hold parts and nothing else', () => {
            // Act, Assert
            expect(['apps', 'themes', 'logic', 'models', 'data', 'components', 'patterns'].every(isPartKind)).toBe(true);
            expect(isPartKind('personas')).toBe(false);
        });
    });
});
