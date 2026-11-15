import { describe, expect, it } from 'vitest';
import { appStateAddress, formatAddress, parseAddress, userStateAddress } from './StateAddress.js';

const APP = '0F8FAD5B-D9CB-469F-A165-70867728950E';

describe('StateAddress', () => {
    it('should give the user state and the app state of an app their own addresses', () => {
        expect(userStateAddress('w1', 'u7', APP)).toBe('u7/0f8fad5b-d9cb-469f-a165-70867728950e/user');
        expect(appStateAddress('w1', APP)).toBe('w1/0f8fad5b-d9cb-469f-a165-70867728950e/app');
    });

    it("should put the default persona's state at the workspace", () => {
        expect(userStateAddress('w1', 'default', APP)).toBe('w1/0f8fad5b-d9cb-469f-a165-70867728950e/user');
    });

    it('should read back what it writes, and nothing else', () => {
        expect(parseAddress(formatAddress({ ownerId: 'o', appId: 'a', scope: 'app' }))).toEqual({ ownerId: 'o', appId: 'a', scope: 'app' });
        for (const text of ['o/a', 'o/a/other', 'o/a/user/x', '/a/user', 'o b/a/user']) expect(parseAddress(text), text).toBeUndefined();
        expect(() => formatAddress({ ownerId: 'a/b', appId: 'x', scope: 'user' })).toThrow();
    });
});
