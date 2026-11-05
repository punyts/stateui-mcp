import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import { LOGIC_GROUPS } from '../../application/use-cases/WriteLogic.js';
import type { LogicGroup, LogicOperation, LogicTarget } from '../../application/use-cases/WriteLogic.js';
import type { JsonObject } from '../../domain/JsonValue.js';
import { MAX_OPERATIONS_PER_WRITE } from '../../domain/limits.js';
import { WRITES, defineInput, fail, succeed } from './toolKit.js';
import type { ParsedArguments, ToolOutcome, UiToolDefinition } from './toolKit.js';

const UNIT = /^(machines|rules|tables)\.([A-Za-z_][A-Za-z0-9_-]*)$/;

const LOGIC_ITEMS = {
    op: { type: 'string', required: true, enum: ['set', 'remove'], description: 'set adds a unit or replaces it whole; remove takes it out' },
    unit: { type: 'string', required: true, description: 'The unit: "machines.<name>", "rules.<name>" or "tables.<name>"' },
    value: { type: 'json', description: 'set only: the whole machine, rule or table' }
} as const;

const LOGIC_WRITE = defineInput({
    app: { type: 'string', description: 'The app whose own logic to write (ui_list kind "apps"). Give app or module, not both' },
    module: { type: 'string', description: 'The logic module to write (ui_list kind "logic"); a new name creates the module. Give app or module, not both' },
    expectedRevision: {
        type: 'integer',
        minimum: 1,
        description: 'The revision you last read; required for an app. For a module, leave it out to create the module. When the part has changed since, nothing is written'
    },
    operations: {
        type: 'list',
        maxItems: MAX_OPERATIONS_PER_WRITE,
        description: `The unit changes, applied in order as one checked write (at most ${MAX_OPERATIONS_PER_WRITE})`,
        items: LOGIC_ITEMS
    },
    needs: { type: 'object', description: 'Module only: the data it works on, binding name to { model }; replaces the needs. An app binds them with ui_app_configure' },
    params: { type: 'object', description: 'Module only: param name to { type, default?, required? }, read as $params.<name>; replaces the params' }
});

type LogicItem = ParsedArguments<typeof LOGIC_ITEMS>;

function toOperation(item: LogicItem, index: number): LogicOperation | ToolOutcome {
    const match = UNIT.exec(item.unit);
    if (match === null) {
        return fail('invalid-argument', `operations[${index}].unit must be "machines.<name>", "rules.<name>" or "tables.<name>"; got "${item.unit}"`, {
            argument: `operations[${index}].unit`,
            allowed: LOGIC_GROUPS
        });
    }
    const group = match[1] as LogicGroup;
    const name = match[2] as string;
    if (item.op === 'remove') {
        if (item.value !== undefined) return fail('invalid-argument', `operations[${index}].value is not allowed for remove`, { argument: `operations[${index}].value` });
        return { op: 'remove', group, name };
    }
    if (item.value === undefined) return fail('invalid-argument', `operations[${index}].value is required for set: the whole unit`, { argument: `operations[${index}].value` });
    return { op: 'set', group, name, value: item.value };
}

const DESCRIPTION = [
    'Build time: write machines, rules and tables by name in an app\'s own logic (app) or in a logic module (module), set whole or removed.',
    'Triggers: "when" is a state path ("$.data.bag.{id}.qty"; * and {name} match one segment) or the "result" of a save-data or delete-data command, narrowed by "is", "was" (the value the change replaced, $previous) and "if" (an expression).',
    'Commands ("do"): set, merge, copy, toggle, increment, reset, save-data, delete-data, pull-data, query, notify, emit, navigate, reject; a rule whose only command is reject is a guard that refuses the change.',
    'Machines: { state, initial, transitions: [{ from?, when, do?, to? }] }. Tables: { when, inputs, rows: [{ match?, if?, do }] } run the first matching row; the last row with neither match nor if is the default.',
    'Timers: "debounce": ms waits for a path to be quiet; "after": ms on a machine transition with "from" fires that long after the machine entered the state.',
    'call (machines only) asks a server procedure and the machine gets the answer as its "as" result.',
    'A module names no node or screen and touches only the data in its needs (SUI-MODULE-NODE, SUI-MODULE-NEEDS); it reads its params as $params.<name>. Create it with needs and params on its first write (no expectedRevision); an app uses it through ui_app_configure.',
    'The app is checked as a whole, the module by the module rules; nothing is written when anything blocks.',
    'Returns { app | module, revision, created, units: [{ group, kind, name, position, reads, writes }], warnings }: position is the unit\'s place in the run order (a unit runs after the units that write under its trigger path; an app\'s order includes its modules), absent for a guard.'
].join(' ');

/** `ui_logic_write`, when the server has parts */
export function createLogicTools(useCases: Pick<UiBuilderUseCases, 'writeLogic'>): readonly UiToolDefinition[] {
    const { writeLogic } = useCases;
    if (writeLogic === undefined) return [];
    return [
        {
            name: 'ui_logic_write',
            description: DESCRIPTION,
            inputSchema: LOGIC_WRITE.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = LOGIC_WRITE.parse(args);
                if (!parsed.ok) return fail('invalid-argument', parsed.message, { argument: parsed.argument });
                const { app, module, expectedRevision, needs, params } = parsed.value;
                if ((app === undefined) === (module === undefined)) return fail('invalid-argument', 'Give app or module, exactly one', { argument: 'app' });
                if (app !== undefined) {
                    if (expectedRevision === undefined) return fail('invalid-argument', 'expectedRevision is required for an app: read it with ui_get', { argument: 'expectedRevision' });
                    const misplaced = needs !== undefined ? 'needs' : params !== undefined ? 'params' : undefined;
                    if (misplaced !== undefined) return fail('invalid-argument', `${misplaced} is for a module; an app binds a module's needs and params with ui_app_configure`, { argument: misplaced });
                }
                const operations: LogicOperation[] = [];
                for (const [index, item] of (parsed.value.operations ?? []).entries()) {
                    const converted = toOperation(item, index);
                    if (!('op' in converted)) return converted;
                    operations.push(converted);
                }
                const target: LogicTarget = app !== undefined ? { kind: 'app', name: app } : { kind: 'module', name: module as string };
                const named = app !== undefined ? { app } : { module };
                const result = await writeLogic.execute({
                    target,
                    operations,
                    ...(expectedRevision !== undefined && { expectedRevision }),
                    ...(needs !== undefined && { needs: needs as JsonObject }),
                    ...(params !== undefined && { params: params as JsonObject })
                });
                const word = target.kind === 'app' ? 'app' : 'logic module';
                switch (result.kind) {
                    case 'written':
                        return succeed({
                            ...named,
                            revision: result.revision,
                            created: result.created,
                            units: result.units,
                            warnings: target.kind === 'app' ? result.warnings : result.appWarnings,
                            ...(result.moreApps > 0 && { moreApps: result.moreApps })
                        });
                    case 'invalid-name':
                        return fail('invalid-name', result.reason, { argument: 'module' });
                    case 'duplicate-name':
                        return fail('duplicate-name', `A logic module named "${module ?? ''}" already exists; read it with ui_get and pass expectedRevision to change it`, { argument: 'module' });
                    case 'not-found':
                        return fail('not-found', `No ${word} named "${target.name}"${result.nearest.length > 0 ? `; nearest: ${result.nearest.join(', ')}` : ''}`, {
                            argument: target.kind,
                            nearest: result.nearest
                        });
                    case 'conflict':
                        return fail('conflict', `The ${word} is at revision ${result.currentRevision}, not the revision expected. Read it again with ui_get; nothing was written`, {
                            currentRevision: result.currentRevision
                        });
                    case 'invalid-operation':
                        return fail('invalid-operation', `Operation ${result.index} could not be applied: ${result.error.message}`, { index: result.index, errors: [result.error] });
                    case 'missing-parts':
                        return fail('missing-parts', `The app names parts that do not exist: ${result.missing.map((part) => `${part.kind} "${part.name}"`).join(', ')}`, { missing: result.missing });
                    case 'invalid':
                        return fail(target.kind === 'app' ? 'invalid-app' : 'invalid-module', `The ${word} has blocking errors; nothing was written. Each error names its path`, { errors: result.errors });
                }
            }
        }
    ];
}
