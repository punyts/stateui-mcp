import { createAuthority, createMemoryNamespaceStorage } from '@punyts/state-sync/authority';
import type { Authority } from '@punyts/state-sync/authority';
import { describe, expect, it } from 'vitest';
import type { UiDocument } from '../../domain/UiApp.js';
import { PeerShares } from './PeerShares.js';

const DOCUMENT = {
    app: { component: 'panel' },
    share: [{ path: '$.screens.diagram.mousePosition', by: '$.screens.diagram.board' }],
    ephemeral: ['$.screens.diagram.mousePosition', '$.peers']
} as unknown as UiDocument;

const PEERS = '$.peers.screens__diagram__mousePosition';

function instance(person: string, board: string | null): Promise<Authority> {
    return createAuthority({
        namespace: `instances.${person}.owner.board`,
        storage: createMemoryNamespaceStorage(),
        initial: { screens: { diagram: { board, mousePosition: { x: 0, y: 0 } } } },
        createParents: true,
        ephemeral: ['$.screens.diagram.mousePosition', '$.peers']
    });
}

describe('PeerShares', () => {
    it('should show each person the shared branch of the others on the same board, and follow moves, board changes and leaving', async () => {
        // Arrange
        const peers = new PeerShares();
        const [ada, grace, alan] = await Promise.all([instance('ada', 'b1'), instance('grace', 'b1'), instance('alan', 'b2')]);
        peers.join('owner/board', 'ada', 'ada', ada, DOCUMENT);
        const graceLeaves = peers.join('owner/board', 'grace', 'grace', grace, DOCUMENT);
        peers.join('owner/board', 'alan', 'alan', alan, DOCUMENT);
        await peers.settled();

        // Act
        const joined = [ada.get(PEERS), grace.get(PEERS), alan.get(PEERS)];
        grace.write({ path: '$.screens.diagram.mousePosition', op: 'set', value: { x: 4, y: 2 } });
        await peers.settled();
        const moved = ada.get(PEERS);
        alan.write({ path: '$.screens.diagram.board', op: 'set', value: 'b1' });
        await peers.settled();
        const switched = ada.get(PEERS);
        graceLeaves();
        await peers.settled();
        const left = alan.get(PEERS);

        // Assert
        expect(joined).toEqual([{ grace: { x: 0, y: 0 } }, { ada: { x: 0, y: 0 } }, {}]);
        expect(moved).toEqual({ grace: { x: 4, y: 2 } });
        expect(switched).toEqual({ grace: { x: 4, y: 2 }, alan: { x: 0, y: 0 } });
        expect(left).toEqual({ ada: { x: 0, y: 0 } });
    });

    it('should share nothing while no board is open, and refuse a client write to $.peers', async () => {
        // Arrange
        const peers = new PeerShares();
        const [ada, grace] = await Promise.all([instance('ada', null), instance('grace', null)]);
        peers.join('owner/board', 'ada', 'ada', ada, DOCUMENT);
        peers.join('owner/board', 'grace', 'grace', grace, DOCUMENT);
        await peers.settled();

        // Act
        const ack = ada.submit({ id: 'c1', path: PEERS, op: 'set', value: { mallory: { x: 1, y: 1 } }, base: ada.revision() }, { clientId: 'client-1' });

        // Assert
        expect(ada.get(PEERS)).toEqual({});
        expect(ack.result).toBe('rejected');
    });
});
