import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { START_HERE } from '../src/infrastructure/mcp/instructions.js';
import { EXPECTED_TOOLS } from './expectedTools.js';
import { call, inMemoryHarness, tempData } from './helpers.js';
import type { InMemoryHarness, TempData } from './helpers.js';

/** The tools of the old single-document model, which no agent may fall back to */
const REMOVED_TOOLS = Object.freeze(['ui_app_write', 'ui_outline', 'ui_app_list', 'ui_app_get', 'ui_app_delete', 'ui_components_list']);

/** The tools that only read: they change nothing */
const READ_ONLY_TOOLS = Object.freeze([
    'ui_components_search',
    'ui_component_get',
    'ui_icons_list',
    'ui_tokens_list',
    'ui_patterns_search',
    'ui_list',
    'ui_get',
    'ui_validate',
    'ui_data_query',
    'ui_state_get',
    'ui_events_read',
    'ui_logic_trace',
    'ui_file_read',
    'ui_tree'
]);

/** The tools that act on an instance of an app, never on a definition */
const RUN_TIME_TOOLS = Object.freeze([
    'ui_state_get',
    'ui_state_set',
    'ui_state_reset',
    'ui_preview',
    'ui_screenshot',
    'ui_interact',
    'ui_command',
    'ui_events_read',
    'ui_call_answer',
    'ui_logic_trace',
    'ui_file_read',
    'ui_tree'
]);

/** The owner's data tools, which work at build time (seed data) and at run time (corrections) */
const DATA_TOOLS = Object.freeze(['ui_data_write', 'ui_data_query']);

/** The catalog tools, which are neither build time nor run time */
const UNPREFIXED_TOOLS = Object.freeze(['ui_components_search', 'ui_component_get', 'ui_icons_list', 'ui_tokens_list', 'ui_patterns_search']);

let data: TempData;
let harness: InMemoryHarness;

beforeEach(async () => {
    data = await tempData();
    harness = await inMemoryHarness(data.dir);
});

afterEach(async () => {
    await harness.close();
    await data.cleanup();
});

describe('the registered tools', () => {
    it('should be exactly EXPECTED_TOOLS, the 35 tools of the design', async () => {
        // Act
        const { tools } = await harness.client.listTools();

        // Assert
        expect(EXPECTED_TOOLS).toHaveLength(35);
        expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
        expect(EXPECTED_TOOLS).toContain('ui_patterns_search');
        expect(EXPECTED_TOOLS).toContain('ui_pattern_write');
    });

    it('should not register any tool of the removed document model', async () => {
        // Act
        const { tools } = await harness.client.listTools();

        // Assert
        const registered = new Set(tools.map((tool) => tool.name));
        for (const name of REMOVED_TOOLS) expect(registered.has(name), name).toBe(false);
    });

    it('should start the description of every tool with Build time: or Run time:, and of the data tools with Build and run time:', async () => {
        // Act
        const { tools } = await harness.client.listTools();

        // Assert
        for (const tool of tools) {
            if (UNPREFIXED_TOOLS.includes(tool.name)) continue;
            const side = DATA_TOOLS.includes(tool.name) ? 'Build and run time: ' : RUN_TIME_TOOLS.includes(tool.name) ? 'Run time: ' : 'Build time: ';
            expect((tool.description ?? '').startsWith(side), tool.name).toBe(true);
        }
    });

    it('should mark the read tools read-only and only the delete and rename tools destructive, for the client to ask the user', async () => {
        // Act
        const { tools } = await harness.client.listTools();
        const byName = new Map(tools.map((tool) => [tool.name, tool]));

        // Assert
        const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name);
        const destructive = tools.filter((tool) => tool.annotations?.destructiveHint === true).map((tool) => tool.name);
        expect(readOnly.sort()).toEqual([...READ_ONLY_TOOLS].sort());
        expect(destructive.sort()).toEqual(['ui_delete', 'ui_rename']);
        expect(byName.get('ui_rename')?.annotations).toEqual(byName.get('ui_delete')?.annotations);
        expect(byName.get('ui_app_create')?.annotations?.readOnlyHint).toBe(false);
    });

    it('should name the entry tools of the working loop in the descriptions of ui_list, ui_theme_create, ui_app_create and ui_components_search', async () => {
        // Act
        const { tools } = await harness.client.listTools();

        // Assert
        for (const name of ['ui_list', 'ui_theme_create', 'ui_app_create', 'ui_components_search']) {
            expect(tools.find((tool) => tool.name === name)?.description, name).toContain(START_HERE);
        }
        expect(tools.filter((tool) => tool.description?.includes(START_HERE)).map((tool) => tool.name).sort()).toEqual(
            ['ui_app_create', 'ui_components_search', 'ui_list', 'ui_theme_create']
        );
    });
});

describe('the server instructions', () => {
    it('should describe the owner tree, build and run time, paths, modules, revisions and the build steps', async () => {
        // Act
        const instructions = harness.client.getInstructions() ?? '';

        // Assert
        for (const text of ['Build time:', 'Run time:', '$.route', '$.screens', 'Modules and params', 'Revisions and warnings', 'Build steps', 'Icon names come from ui_icons_list', 'no preview is open; the command was not delivered', 'ui_events_read']) {
            expect(instructions, text).toContain(text);
        }
        for (const name of ['ui_theme_create', 'ui_model_write', 'ui_data_write', 'ui_logic_write', 'ui_app_create', 'ui_screen_create', 'ui_nodes_write', 'ui_validate']) {
            expect(instructions, name).toContain(name);
        }
    });

    it('should name no removed tool and only registered tools, and list every category of the catalog', async () => {
        // Arrange
        const instructions = harness.client.getInstructions() ?? '';
        const { tools } = await harness.client.listTools();
        const registered = new Set(tools.map((tool) => tool.name));
        const named = new Set([...(instructions.match(/ui_[a-z_]+/g) ?? []), ...(START_HERE.match(/ui_[a-z_]+/g) ?? [])]);
        const index = harness.services.categoryIndex;

        // Assert
        expect([...named].filter((name) => !registered.has(name))).toEqual([]);
        for (const name of REMOVED_TOOLS) expect(instructions.includes(name), name).toBe(false);
        expect(index.length).toBeGreaterThan(0);
        for (const entry of index) expect(instructions).toContain(`- ${entry.category} (${entry.count}): `);
        // The build steps: shell and screen patterns first, then components for what the patterns do not cover
        const order = ['ui_patterns_search', 'ui_app_create', 'ui_screen_create', 'ui_components_search', 'ui_component_get', 'ui_nodes_write'].map((name) => instructions.indexOf(name));
        expect(order.every((at) => at >= 0)).toBe(true);
        expect(order).toEqual([...order].sort((left, right) => left - right));
    });
});

describe('a call to a removed tool', () => {
    it.each(['ui_app_write', 'ui_outline'])('should fail %s as an unknown tool', async (name) => {
        // Act
        const result = await call(harness.client, name, { appId: '11111111-1111-4111-8111-111111111111' });

        // Assert
        expect(result.isError).toBe(true);
        expect(result.body['error']).toBe('unknown-tool');
    });

    it('should answer any other unknown tool name with the same typed error', async () => {
        const result = await call(harness.client, 'ui_nothing');

        expect(result.isError).toBe(true);
        expect(result.body['error']).toBe('unknown-tool');
    });
});
