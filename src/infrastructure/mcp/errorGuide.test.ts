import { describe, expect, it } from 'vitest';
import { ERROR_CATALOG, ERROR_PREFIXES } from '@punyts/stateui-app/core';
import { GUIDE_TOPIC_NAMES, TOOL_CODE_TOPICS, VALIDATION_PREFIX_TOPICS, guideFor } from './guide.js';
import { fail, withGuides } from './toolKit.js';

const CATALOG_CODES = Object.keys(ERROR_CATALOG);

describe('the map from error code to guide topic', () => {
    it('should point every mapped code and prefix at a topic of the table', () => {
        // Assert
        for (const [code, topic] of [...Object.entries(TOOL_CODE_TOPICS), ...Object.entries(VALIDATION_PREFIX_TOPICS)]) {
            expect(GUIDE_TOPIC_NAMES, `${code} -> ${topic}`).toContain(topic);
        }
    });

    it('should map only validation prefixes that lie in a family of the catalog and cover at least one catalog code', () => {
        // Assert
        for (const prefix of Object.keys(VALIDATION_PREFIX_TOPICS)) {
            expect(ERROR_PREFIXES.some((family) => prefix === family || prefix.startsWith(`${family}-`)), prefix).toBe(true);
            expect(CATALOG_CODES.some((code) => code === prefix || code.startsWith(`${prefix}-`)), prefix).toBe(true);
        }
    });

    it('should map the tool codes by name', () => {
        // Assert
        expect(guideFor('conflict')).toBe('revisions');
        expect(guideFor('missing-path')).toBe('paths');
        expect(guideFor('invalid-argument')).toBeUndefined();
        expect(guideFor('not-found')).toBeUndefined();
    });

    it('should map a validation code by the longest prefix it starts with', () => {
        // Assert
        expect(guideFor('SUI-LOGIC-PATH')).toBe('logic');
        expect(guideFor('SUI-LOGIC')).toBe('logic');
        expect(guideFor('SUI-STATE-PAINT')).toBe('drawing');
        expect(guideFor('SUI-USES-MISSING')).toBe('parts');
        expect(guideFor('SUI-USES-NEEDS')).toBe('modules');
        expect(guideFor('SUI-DOC-LIMIT-SCENES')).toBe('scene3d');
        expect(guideFor('SUI-RUN-3D')).toBe('scene3d-models');
    });

    it('should not map a code of a family with no topic, or a code that only shares the letters of a prefix', () => {
        // Assert
        expect(guideFor('SUI-LAYOUT-TYPE')).toBeUndefined();
        expect(guideFor('SUI-STATE-INVALID')).toBeUndefined();
        expect(guideFor('SUI-LOGICAL')).toBeUndefined();
    });
});

describe('fail with a guide topic', () => {
    it('should add guide to the body of a mapped failure and keep the message and details', () => {
        // Act
        const outcome = fail('conflict', 'The part is at revision 4', { currentRevision: 4 });

        // Assert
        expect(outcome).toEqual({ isError: true, body: { error: 'conflict', message: 'The part is at revision 4', currentRevision: 4, guide: 'revisions' } });
    });

    it('should leave the body of an unmapped failure as it was', () => {
        // Act
        const outcome = fail('invalid-argument', 'path is required', { argument: 'path' });

        // Assert
        expect(outcome.body).toEqual({ error: 'invalid-argument', message: 'path is required', argument: 'path' });
        expect(outcome.body).not.toHaveProperty('guide');
    });

    it('should add guide to each mapped entry of errors and warnings in the details', () => {
        // Act
        const outcome = fail('invalid-app', 'The app would have blocking errors', {
            errors: [
                { code: 'SUI-LOGIC-PATH', message: 'Path $.x' },
                { code: 'SUI-LAYOUT-TYPE', message: 'Layout' }
            ],
            warnings: [{ code: 'SUI-STATE-PAINT', message: 'Paint', severity: 'warning' }]
        });

        // Assert
        expect(outcome.body).toEqual({
            error: 'invalid-app',
            message: 'The app would have blocking errors',
            errors: [
                { code: 'SUI-LOGIC-PATH', message: 'Path $.x', guide: 'logic' },
                { code: 'SUI-LAYOUT-TYPE', message: 'Layout' }
            ],
            warnings: [{ code: 'SUI-STATE-PAINT', message: 'Paint', severity: 'warning', guide: 'drawing' }]
        });
    });
});

describe('withGuides', () => {
    it('should add guide to the mapped entries only, and to the errors of an app a part write reaches', () => {
        // Act
        const entries = withGuides<object>([
            { code: 'SUI-DOC-ORDER', message: 'Key "42"' },
            { code: 'SUI-ON-EVENT', message: 'No event' },
            { app: 'shop', errors: [{ code: 'SUI-MODULE-NEEDS', message: 'Needs' }] }
        ]);

        // Assert
        expect(entries).toEqual([
            { code: 'SUI-DOC-ORDER', message: 'Key "42"', guide: 'keys' },
            { code: 'SUI-ON-EVENT', message: 'No event' },
            { app: 'shop', errors: [{ code: 'SUI-MODULE-NEEDS', message: 'Needs', guide: 'modules' }] }
        ]);
    });
});
