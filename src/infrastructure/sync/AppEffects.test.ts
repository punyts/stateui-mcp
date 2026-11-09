import { describe, expect, it } from 'vitest';
import type { LogicEffectRequest } from '@punyts/stateui-app/core';
import type { JsonValue } from '../../domain/JsonValue.js';
import { AppEffects, EFFECT_EVENT, MAX_PENDING_EFFECTS } from './AppEffects.js';

function setup() {
    const queued: [string, string, JsonValue][] = [];
    let next = 0;
    const effects = new AppEffects((appId, name, payload) => queued.push([appId, name, payload]), () => `e${(next += 1)}`);
    return { effects, queued };
}

const REQUEST: LogicEffectRequest = { name: 'fetchOrders', run: 'orders.fetch', token: 't1', request: { page: 1 } };

describe('AppEffects', () => {
    it('should queue an effect for the agent and resolve it with the answer', async () => {
        // Arrange
        const { effects, queued } = setup();
        const pending = effects.ask('A1', REQUEST, new AbortController().signal);

        // Act
        const wrongApp = effects.answer('A2', 'e1', { answer: {} });
        const answered = effects.answer('a1', 'e1', { answer: { records: [{ id: 'o1' }], total: 1 } });
        const again = effects.answer('a1', 'e1', { answer: {} });

        // Assert
        expect(queued).toEqual([['A1', EFFECT_EVENT, { id: 'e1', name: 'fetchOrders', token: 't1', request: { page: 1 } }]]);
        expect([wrongApp, answered, again]).toEqual([false, true, false]);
        await expect(pending).resolves.toEqual({ records: [{ id: 'o1' }], total: 1 });
    });

    it('should reject the effect with the error the agent gives', async () => {
        const { effects } = setup();
        const pending = effects.ask('a1', REQUEST, new AbortController().signal);

        effects.answer('a1', 'e1', { error: 'the orders service is down' });

        await expect(pending).rejects.toThrow('the orders service is down');
    });

    it('should drop an aborted effect, so its id is no longer waiting', async () => {
        // Arrange
        const { effects } = setup();
        const controller = new AbortController();
        const pending = effects.ask('a1', REQUEST, controller.signal);

        // Act
        controller.abort();

        // Assert
        await expect(pending).rejects.toThrow('a newer request replaced it');
        expect(effects.answer('a1', 'e1', { answer: {} })).toBe(false);
    });

    it('should reject an effect past the waiting limit and drop the waiting effects of a forgotten app', async () => {
        // Arrange
        const { effects } = setup();
        const signal = new AbortController().signal;
        for (let index = 0; index < MAX_PENDING_EFFECTS; index += 1) void effects.ask('a1', REQUEST, signal);

        // Act
        const over = effects.ask('a1', REQUEST, signal);
        effects.forget('A1');

        // Assert
        await expect(over).rejects.toThrow(`more than ${MAX_PENDING_EFFECTS} effects`);
        expect(effects.answer('a1', 'e1', { answer: {} })).toBe(false);
    });
});
