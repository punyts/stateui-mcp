import { describe, expect, it } from 'vitest';
import { DEFAULT_PERSONA, instanceKeyText } from './InstanceKey.js';

describe('instanceKeyText', () => {
    it('should join the persona, the owner and the app in lower case', () => {
        // Arrange
        const key = Object.freeze({ persona: DEFAULT_PERSONA, ownerId: '00000000-0000-4000-8000-0000000000AA', appId: '00000000-0000-4000-8000-00000000000B' });

        // Act
        const text = instanceKeyText(key);

        // Assert
        expect(text).toBe('default.00000000-0000-4000-8000-0000000000aa.00000000-0000-4000-8000-00000000000b');
    });
});
