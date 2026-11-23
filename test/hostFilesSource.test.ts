import { describe, expect, it } from 'vitest';
import { filesSource } from '../src/browser/filesSource.js';

describe('the live view host naming where the frame reads files', () => {
    it('should give the absolute files URL of the page and its grant', () => {
        // Arrange
        const page = 'https://magnetic.example/apps/5d1c2b3a-0e9f-4a8b-9c7d-6e5f4a3b2c1d?screen=home#top';

        // Act
        const source = filesSource('/paths/7/apps/5d1c2b3a-0e9f-4a8b-9c7d-6e5f4a3b2c1d/', 'Zmlyc3Q.bWFjMQ', page);

        // Assert
        expect(source).toEqual({ url: 'https://magnetic.example/paths/7/apps/5d1c2b3a-0e9f-4a8b-9c7d-6e5f4a3b2c1d/files', grant: 'Zmlyc3Q.bWFjMQ' });
    });

    it('should leave out an empty grant, and give nothing for a page with no paths URL', () => {
        // Arrange
        const page = 'http://localhost:3000/apps/a';

        // Act
        const plain = filesSource('/paths/7/apps/a', '', page);
        const none = filesSource(undefined, 'Zmlyc3Q.bWFjMQ', page);

        // Assert
        expect(plain).toEqual({ url: 'http://localhost:3000/paths/7/apps/a/files' });
        expect(none).toBeUndefined();
    });
});
