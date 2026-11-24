import { describe, expect, it } from 'vitest';
import { instanceKeyText, isPersonId } from './InstanceKey.js';

describe('instanceKeyText', () => {
    it('should join the person, the owner and the app in lower case', () => {
        // Arrange
        const key = Object.freeze({ person: '00000000-0000-4000-8000-0000000000CC', ownerId: '00000000-0000-4000-8000-0000000000AA', appId: '00000000-0000-4000-8000-00000000000B' });

        // Act
        const text = instanceKeyText(key);

        // Assert
        expect(text).toBe('00000000-0000-4000-8000-0000000000cc.00000000-0000-4000-8000-0000000000aa.00000000-0000-4000-8000-00000000000b');
    });
});

describe('isPersonId', () => {
    it('should take a lower-case id and refuse a path or an upper-case id', () => {
        // Arrange
        const ids = ['00000000-0000-4000-8000-0000000000aa', 'u7', '../u7', 'U7', ''];

        // Act
        const taken = ids.map(isPersonId);

        // Assert
        expect(taken).toEqual([true, true, false, false, false]);
    });
});
