import { createMemoryLocalStore } from '@punyts/state-sync';
import { describe, expect, it } from 'vitest';
import { forgetListed } from '../src/browser/forgetListed.js';

describe('the live view host forgetting the namespaces a page lists', () => {
    it('should delete every part of each listed namespace, and keep the one it opens and any other', () => {
        // Arrange
        const store = createMemoryLocalStore();
        for (const namespace of ['instances.bob.alice.app', 'instances.alice.alice.app', 'instances.bob.alice.other']) {
            store.write(namespace, 'confirmed', { revision: 1 });
            store.write(namespace, 'document', { app: true });
        }

        // Act
        forgetListed(store, 'instances.bob.alice.app instances.alice.alice.app', 'instances.alice.alice.app');

        // Assert
        expect(store.read('instances.bob.alice.app', 'confirmed')).toBeUndefined();
        expect(store.read('instances.bob.alice.app', 'document')).toBeUndefined();
        expect(store.read('instances.alice.alice.app', 'confirmed')).toEqual({ revision: 1 });
        expect(store.read('instances.bob.alice.other', 'document')).toEqual({ app: true });
    });

    it('should do nothing for a page that lists none', () => {
        // Arrange
        const store = createMemoryLocalStore();
        store.write('instances.bob.alice.app', 'confirmed', { revision: 1 });

        // Act
        forgetListed(store, undefined, 'instances.alice.alice.app');

        // Assert
        expect(store.read('instances.bob.alice.app', 'confirmed')).toEqual({ revision: 1 });
    });
});
