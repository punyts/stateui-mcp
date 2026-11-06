import { describe, expect, it } from 'vitest';
import { hostPageCsp, runtimeCsp } from './security.js';

/** The sources of one directive of a policy */
function sources(policy: string, directive: string): string[] {
    const entry = policy.split('; ').find((part) => part.startsWith(`${directive} `));
    return entry === undefined ? [] : entry.split(' ').slice(1);
}

describe('runtimeCsp', () => {
    it('should allow data: and https: images and nothing else of the network', () => {
        // Act
        const policy = runtimeCsp('http://127.0.0.1:4300');

        // Assert
        expect(sources(policy, 'img-src')).toEqual(['data:', 'https:']);
        expect(sources(policy, 'connect-src')).toEqual(["'none'"]);
        expect(sources(policy, 'font-src')).toEqual(['data:']);
        expect(sources(policy, 'frame-ancestors')).toEqual(['http://127.0.0.1:4300']);
    });
});

describe('hostPageCsp', () => {
    it('should keep the host page to data: images', () => {
        // Act
        const policy = hostPageCsp('http://127.0.0.1:4301');

        // Assert
        expect(sources(policy, 'img-src')).toEqual(['data:']);
    });
});
