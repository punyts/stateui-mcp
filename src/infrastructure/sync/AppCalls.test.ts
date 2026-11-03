import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../domain/JsonValue.js';
import { AppCalls, CALL_EVENT, MAX_PENDING_CALLS } from './AppCalls.js';

function setup(procedures = {}) {
    const queued: [string, string, JsonValue][] = [];
    let next = 0;
    const calls = new AppCalls((appId, name, payload) => queued.push([appId, name, payload]), procedures, () => `k${(next += 1)}`);
    return { calls, queued };
}

describe('AppCalls', () => {
    it('should run a registered procedure with the payload and the app', async () => {
        const { calls, queued } = setup({ double: (payload: JsonValue, context: { appId: string }) => ({ status: 'accepted', value: { n: (payload as number) * 2, app: context.appId } }) });

        const answer = await calls.ask('A1', 'double', 4);

        expect(answer).toEqual({ status: 'accepted', value: { n: 8, app: 'A1' } });
        expect(queued).toEqual([]);
    });

    it('should queue any other call for the agent and resolve it with the answer', async () => {
        // Arrange
        const { calls, queued } = setup();
        const pending = calls.ask('A1', 'findCompany', { name: 'Acme' });

        // Act
        const wrongApp = calls.answer('A2', 'k1', { status: 'accepted' });
        const answered = calls.answer('a1', 'k1', { status: 'accepted', value: 'c7' });
        const again = calls.answer('a1', 'k1', { status: 'accepted' });

        // Assert
        expect(queued).toEqual([['A1', CALL_EVENT, { id: 'k1', name: 'findCompany', payload: { name: 'Acme' } }]]);
        expect([wrongApp, answered, again]).toEqual([false, true, false]);
        await expect(pending).resolves.toEqual({ status: 'accepted', value: 'c7' });
    });

    it('should reject a call past the waiting limit and drop the waiting calls of a forgotten app', async () => {
        const { calls } = setup();
        for (let index = 0; index < MAX_PENDING_CALLS; index += 1) void calls.ask('a1', 'p', null);

        const over = await calls.ask('a1', 'p', null);
        calls.forget('A1');

        expect(over.status).toBe('rejected');
        expect(calls.answer('a1', 'k1', { status: 'accepted' })).toBe(false);
    });
});
