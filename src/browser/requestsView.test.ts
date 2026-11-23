import { describe, expect, it } from 'vitest';
import type { SyncRequest } from '@punyts/state-sync';
import { newRequests, requestEntries } from './requestsView.js';

const request = (id: string, extra: Partial<SyncRequest> = {}): SyncRequest => ({
    id,
    path: '$.data.bookings.b1.day',
    op: 'set',
    value: 'Tuesday',
    base: 12,
    by: 'p:ann',
    mine: true,
    at: 1_000,
    until: 2_000,
    status: 'pending',
    ...extra
});

describe('the requests the view host tells the runtime of', () => {
    it('should key the entries by id and leave out the revision a request was based on', () => {
        // Arrange
        const requests = [request('r-1'), request('r-2', { mine: false, status: 'rejected', decidedAt: 1_500, note: 'Full that day' })];

        // Act
        const entries = requestEntries(requests);

        // Assert
        expect(Object.keys(entries)).toEqual(['r-1', 'r-2']);
        expect(entries['r-1']).toEqual({ id: 'r-1', path: '$.data.bookings.b1.day', op: 'set', value: 'Tuesday', by: 'p:ann', mine: true, at: 1_000, until: 2_000, status: 'pending' });
        expect(entries['r-2']).toMatchObject({ status: 'rejected', decidedAt: 1_500, note: 'Full that day', mine: false });
        expect(JSON.stringify(entries)).not.toContain('base');
    });

    it('should announce each own pending request once, and none of those a welcome brings', () => {
        // Arrange
        const announced = new Set<string>();

        // Act
        const welcomed = newRequests([request('old')], announced, true);
        const first = newRequests([request('old'), request('new'), request('theirs', { mine: false }), request('done', { status: 'approved' })], announced, false);
        const again = newRequests([request('old'), request('new')], announced, false);

        // Assert
        expect(welcomed).toEqual([]);
        expect(first).toEqual([{ id: 'new', path: '$.data.bookings.b1.day' }]);
        expect(again).toEqual([]);
    });
});
