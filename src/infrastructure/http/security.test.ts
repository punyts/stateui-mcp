import { describe, expect, it } from 'vitest';
import { APP_PAGE_CSP, hostPageCsp, isPublicHost, runtimeCsp } from './security.js';

/** The sources of one directive of a policy */
function sources(policy: string, directive: string): string[] {
    const entry = policy.split('; ').find((part) => part.startsWith(`${directive} `));
    return entry === undefined ? [] : entry.split(' ').slice(1);
}

describe('runtimeCsp', () => {
    it('should allow data: and https: images, https: media and nothing else of the network', () => {
        // Act
        const policy = runtimeCsp('http://127.0.0.1:4300');

        // Assert
        expect(sources(policy, 'img-src')).toEqual(['data:', 'https:']);
        expect(sources(policy, 'media-src')).toEqual(['https:']);
        expect(sources(policy, 'connect-src')).toEqual(["'none'"]);
        expect(sources(policy, 'font-src')).toEqual(['data:']);
        expect(sources(policy, 'frame-ancestors')).toEqual(['http://127.0.0.1:4300']);
    });
});

describe('APP_PAGE_CSP', () => {
    it('should allow what the runtime frame allows of images and media', () => {
        // Assert
        expect(sources(APP_PAGE_CSP, 'img-src')).toEqual(['data:', 'https:']);
        expect(sources(APP_PAGE_CSP, 'media-src')).toEqual(['https:']);
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

describe('isPublicHost', () => {
    const names = new Set(['magnetic.example', 'run.magnetic.example']);

    it('should answer the public host names, with or without a port, in any case', () => {
        expect(isPublicHost('magnetic.example', names)).toBe(true);
        expect(isPublicHost('Run.Magnetic.Example:443', names)).toBe(true);
    });

    it('should answer loopback, for a health check on the machine', () => {
        expect(isPublicHost('127.0.0.1:4300', names)).toBe(true);
        expect(isPublicHost('localhost', names)).toBe(true);
    });

    it('should refuse any other name, and a request without one', () => {
        expect(isPublicHost('elsewhere.example', names)).toBe(false);
        expect(isPublicHost('magnetic.example.evil.example', names)).toBe(false);
        expect(isPublicHost(undefined, names)).toBe(false);
    });
});
