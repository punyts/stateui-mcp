import { GRANT_LIFETIME_MS, PathGrants, pathGrantKey } from './PathGrants.js';

const APP = '5f0c2b8e-1d4a-4c3b-9e2f-0a1b2c3d4e5f';
const OTHER_APP = '0b6e8c1a-3f1e-4a52-9a43-2f4f1c8f2d10';

describe('PathGrants', () => {
    it('should allow the files of the granted app of the owner until the grant expires, and nothing else', () => {
        // Arrange
        let now = 1_000_000;
        const grants = new PathGrants(pathGrantKey('secret'), () => now);
        const grant = grants.issue('42', APP.toUpperCase());

        // Act
        const fresh = grants.allows(grant, '42', APP);
        const otherApp = grants.allows(grant, '42', OTHER_APP);
        const otherOwner = grants.allows(grant, '43', APP);
        now += GRANT_LIFETIME_MS;
        const expired = grants.allows(grant, '42', APP);

        // Assert
        expect([fresh, otherApp, otherOwner, expired]).toEqual([true, false, false, false]);
    });

    it('should accept a grant on another server with the same secret, and refuse one of another key or altered', () => {
        // Arrange
        const issued = new PathGrants(pathGrantKey('secret')).issue('42', APP);
        const [body, mac] = issued.split('.') as [string, string];
        const longer = Buffer.from(`4.${APP}.${Date.now() + 60_000}`).toString('base64url');

        // Act
        const sameSecret = new PathGrants(pathGrantKey('secret')).allows(issued, '42', APP);
        const otherSecret = new PathGrants(pathGrantKey('other')).allows(issued, '42', APP);
        const randomKey = new PathGrants().allows(issued, '42', APP);
        const swappedBody = new PathGrants(pathGrantKey('secret')).allows(`${longer}.${mac}`, '4', APP);
        const noMac = new PathGrants(pathGrantKey('secret')).allows(body, '42', APP);

        // Assert
        expect([sameSecret, otherSecret, randomKey, swappedBody, noMac]).toEqual([true, false, false, false, false]);
    });
});
