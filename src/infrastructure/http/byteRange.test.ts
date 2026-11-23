import { byteRange } from './byteRange.js';

describe('byteRange', () => {
    it.each([
        ['bytes=2-5', { start: 2, end: 5 }],
        ['bytes=2-', { start: 2, end: 9 }],
        ['bytes=-3', { start: 7, end: 9 }],
        ['bytes=-30', { start: 0, end: 9 }],
        ['bytes=8-30', { start: 8, end: 9 }]
    ])('should read %s of ten bytes as one range', (header, range) => {
        // Arrange
        const size = 10;

        // Act
        const found = byteRange(header, size);

        // Assert
        expect(found).toEqual(range);
    });

    it.each([[undefined], ['bytes=0-1, 4-5'], ['bytes=5-2'], ['bytes=-'], ['items=0-1'], ['bytes=a-b']])('should answer the whole file for %s', (header) => {
        // Arrange
        const size = 10;

        // Act
        const found = byteRange(header, size);

        // Assert
        expect(found).toBeUndefined();
    });

    it.each([['bytes=10-'], ['bytes=12-20'], ['bytes=-0']])('should answer unsatisfiable for %s of ten bytes', (header) => {
        // Arrange
        const size = 10;

        // Act
        const found = byteRange(header, size);

        // Assert
        expect(found).toBe('unsatisfiable');
    });
});
