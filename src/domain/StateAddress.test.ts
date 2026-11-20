import { describe, expect, it } from 'vitest';
import { formatAddress, instanceOfAddress, parseAddress, userStateAddress } from './StateAddress.js';
import type { OwnerNames } from './StateAddress.js';

const APP = '0F8FAD5B-D9CB-469F-A165-70867728950E';
const app = APP.toLowerCase();

/** A workspace `w1` owned by number 7, and a person `u7` who is number 12 */
const NUMBERS: OwnerNames = {
    of: (id) => ({ w1: '7', u7: '12' })[id] ?? id,
    idOf: (owner) => ({ 7: 'w1', 12: 'u7' })[owner]
};

describe('StateAddress', () => {
    it("should put a persona's state of an app under apps in that person's tree", () => {
        // Act
        const address = userStateAddress('w1', 'u7', APP);

        // Assert
        expect(address).toBe(`u7/apps/${app}`);
    });

    it("should put the default persona's state in the tree of the workspace's owner", () => {
        // Act
        const address = userStateAddress('w1', 'default', APP);

        // Assert
        expect(address).toBe(`w1/apps/${app}`);
    });

    it('should name owners by their numbers where they have them, and find the persona and app of an address again', () => {
        // Act
        const mine = userStateAddress('w1', 'default', APP, NUMBERS);
        const theirs = userStateAddress('w1', 'u7', APP, NUMBERS);

        // Assert
        expect([mine, theirs]).toEqual([`7/apps/${app}`, `12/apps/${app}`]);
        expect(instanceOfAddress(mine, 'w1', NUMBERS)).toEqual({ appId: app, persona: 'default' });
        expect(instanceOfAddress(theirs, 'w1', NUMBERS)).toEqual({ appId: app, persona: 'u7' });
        expect(instanceOfAddress(`99/apps/${app}`, 'w1', NUMBERS)).toBeUndefined();
        expect(instanceOfAddress('7/data/orders', 'w1', NUMBERS)).toBeUndefined();
    });

    it('should read back what it writes, and nothing else', () => {
        // Act
        const parsed = parseAddress(formatAddress({ owner: '7', branch: 'data', key: 'Orders' }));

        // Assert
        expect(parsed).toEqual({ owner: '7', branch: 'data', key: 'Orders' });
        for (const text of ['o/apps', 'o/other/a', 'o/apps/a/x', '/apps/a', 'o b/apps/a', 'o/a/user']) expect(parseAddress(text), text).toBeUndefined();
        expect(() => formatAddress({ owner: 'a/b', branch: 'apps', key: 'x' })).toThrow();
    });
});
