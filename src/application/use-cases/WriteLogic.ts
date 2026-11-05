import { logicRunOrder } from '@punyts/stateui-app/core';
import type { LogicDocument, LogicUnitPlace } from '@punyts/stateui-app/core';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import { checkOperationLimit } from '../../domain/limits.js';
import { nearestNames } from '../../domain/nearestNames.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { PART_SHAPE_CODE, partNameProblem } from '../../domain/UiPart.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import { checkPartApp } from '../partAppCheck.js';
import type { MissingPart } from '../partAppCheck.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';
import type { AppWarning, WritePart } from './WritePart.js';

/** The groups of a logic document that hold units by name */
export const LOGIC_GROUPS = ['machines', 'rules', 'tables'] as const;
export type LogicGroup = (typeof LOGIC_GROUPS)[number];

/** A unit of a group set (added or replaced whole) or removed */
export type LogicOperation =
    | { readonly op: 'set'; readonly group: LogicGroup; readonly name: string; readonly value: JsonValue }
    | { readonly op: 'remove'; readonly group: LogicGroup; readonly name: string };

/** The app whose own logic is written, or the logic module */
export type LogicTarget = { readonly kind: 'app'; readonly name: string } | { readonly kind: 'module'; readonly name: string };

export interface WriteLogicInput {
    readonly target: LogicTarget;
    /** Required for an app. For a module, absent creates it (the first write) */
    readonly expectedRevision?: number;
    readonly operations: readonly LogicOperation[];
    /** A module's needs and params, each replaced whole when given; a new module starts with none */
    readonly needs?: JsonObject;
    readonly params?: JsonObject;
}

/** A written unit's place in the run order of its app (assembled with its modules) or module, with what it reads and writes */
export type WrittenUnit = LogicUnitPlace & { readonly group: LogicGroup };

export type WriteLogicResult =
    | {
          readonly kind: 'written';
          readonly created: boolean;
          readonly revision: number;
          /** The units the write set, in the order of the operations */
          readonly units: readonly WrittenUnit[];
          /** Warnings of the app, or the apps a module write breaks */
          readonly warnings: readonly UiBuildError[];
          readonly appWarnings: readonly AppWarning[];
          readonly moreApps: number;
      }
    | { readonly kind: 'invalid-name'; readonly reason: string }
    | { readonly kind: 'duplicate-name' }
    | { readonly kind: 'not-found'; readonly nearest: readonly string[] }
    | { readonly kind: 'conflict'; readonly currentRevision: number }
    | { readonly kind: 'invalid-operation'; readonly index: number; readonly error: UiBuildError }
    | { readonly kind: 'missing-parts'; readonly missing: readonly MissingPart[] }
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] };

function groupOf(logic: JsonObject, group: LogicGroup): JsonObject {
    const units = logic[group];
    return isJsonObject(units) ? units : {};
}

/** The logic with the operations applied in order, or the failing operation */
function applyOperations(logic: JsonObject, operations: readonly LogicOperation[]): { ok: true; logic: JsonObject } | { ok: false; index: number; error: UiBuildError } {
    let next = logic;
    for (const [index, operation] of operations.entries()) {
        const units = groupOf(next, operation.group);
        if (operation.op === 'set') {
            next = { ...next, [operation.group]: { ...units, [operation.name]: operation.value } };
            continue;
        }
        if (!Object.hasOwn(units, operation.name)) {
            const nearest = nearestNames(operation.name, Object.keys(units));
            return {
                ok: false,
                index,
                error: {
                    code: 'SUI-DOC-PATH',
                    message: `There is no ${operation.group}.${operation.name}${nearest.length > 0 ? `; nearest: ${nearest.join(', ')}` : ''}`,
                    statePath: `$.logic.${operation.group}.${operation.name}`
                }
            };
        }
        const { [operation.name]: _removed, ...rest } = units;
        next = Object.keys(rest).length > 0 ? { ...next, [operation.group]: rest } : Object.fromEntries(Object.entries(next).filter(([key]) => key !== operation.group));
    }
    return { ok: true, logic: next };
}

/** The places of the units the write leaves set (whose last operation is a set), in the order they were first written */
function writtenUnits(order: readonly LogicUnitPlace[], operations: readonly LogicOperation[]): WrittenUnit[] {
    const kinds: Record<LogicGroup, LogicUnitPlace['kind']> = { machines: 'machine', rules: 'rule', tables: 'table' };
    const last = new Map<string, LogicOperation>();
    for (const operation of operations) last.set(`${operation.group}.${operation.name}`, operation);
    const units: WrittenUnit[] = [];
    for (const operation of last.values()) {
        if (operation.op !== 'set') continue;
        const { group, name } = operation;
        // A rule whose only command is reject is a guard
        const place = order.find((unit) => unit.name === name && (unit.kind === kinds[group] || (group === 'rules' && unit.kind === 'guard')));
        if (place !== undefined) units.push({ ...place, group });
    }
    return units;
}

/**
 * Writes machines, rules and tables by name in an app's own logic or in a logic module. The units are set whole or
 * removed; an app is then checked as a whole (assembled with its parts, `checkPartApp`) and a module by the module
 * reader through `WritePart` (`SUI-MODULE-*`), and stored only when nothing blocks. The result places each written unit
 * in the engine's run order (`logicRunOrder`): an app's assembled logic, modules included, or the module's own
 */
export class WriteLogic {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly validator: UiAppValidator,
        private readonly writePart: WritePart,
        private readonly report: UseCaseReport
    ) {}

    async execute(input: WriteLogicInput): Promise<WriteLogicResult> {
        const result = await this.write(input);
        this.report.info('Logic write', {
            target: input.target.kind,
            operationCount: input.operations.length,
            outcome: result.kind,
            ...(result.kind === 'written' && { revision: result.revision, created: result.created })
        });
        return result;
    }

    private async write(input: WriteLogicInput): Promise<WriteLogicResult> {
        const overLimit = checkOperationLimit(input.operations.length);
        if (overLimit !== undefined) return { kind: 'invalid', errors: [overLimit] };
        if (input.operations.length === 0 && input.needs === undefined && input.params === undefined) {
            return { kind: 'invalid', errors: [{ code: 'SUI-DOC-OPERATION', message: 'A write needs at least one operation, or needs or params for a module', statePath: '$' }] };
        }
        return input.target.kind === 'app' ? this.writeApp(input.target.name, input) : this.writeModule(input.target.name, input);
    }

    private async writeApp(name: string, input: WriteLogicInput): Promise<WriteLogicResult> {
        const app = await this.parts.findByName('apps', name);
        if (app === undefined) return { kind: 'not-found', nearest: nearestNames(name, (await this.parts.list('apps')).map((summary) => summary.name)) };
        if (input.expectedRevision === undefined || app.revision !== input.expectedRevision) return { kind: 'conflict', currentRevision: app.revision };
        const applied = applyOperations((app.body.logic ?? {}) as unknown as JsonObject, input.operations);
        if (!applied.ok) return { kind: 'invalid-operation', index: applied.index, error: applied.error };
        const { logic: _old, ...rest } = app.body;
        const body = (Object.keys(applied.logic).length > 0 ? { ...rest, logic: applied.logic } : rest) as unknown as UiPartBodies['apps'];
        const check = await checkPartApp(this.parts, this.validator, name, body);
        if (check.kind !== 'checked') return check;
        const written = await this.parts.write('apps', name, body, input.expectedRevision);
        switch (written.kind) {
            case 'written': {
                const assembled = this.validator.assembleApp(body, check.source) as unknown as { logic?: LogicDocument };
                return {
                    kind: 'written',
                    created: false,
                    revision: written.revision,
                    units: writtenUnits(logicRunOrder(assembled.logic ?? {}), input.operations),
                    warnings: check.warnings,
                    appWarnings: [],
                    moreApps: 0
                };
            }
            case 'conflict':
                return written;
            case 'not-found':
                return { kind: 'not-found', nearest: [] };
            case 'invalid':
                return { kind: 'invalid', errors: [{ code: PART_SHAPE_CODE, message: written.reason }] };
        }
    }

    private async writeModule(name: string, input: WriteLogicInput): Promise<WriteLogicResult> {
        let base: JsonObject;
        if (input.expectedRevision === undefined) {
            const problem = partNameProblem(name);
            if (problem !== undefined) return { kind: 'invalid-name', reason: problem };
            if ((await this.parts.findByName('logic', name)) !== undefined) return { kind: 'duplicate-name' };
            base = { needs: {}, params: {} };
        } else {
            const part = await this.parts.findByName('logic', name);
            if (part === undefined) return { kind: 'not-found', nearest: nearestNames(name, (await this.parts.list('logic')).map((summary) => summary.name)) };
            if (part.revision !== input.expectedRevision) return { kind: 'conflict', currentRevision: part.revision };
            base = part.body as unknown as JsonObject;
        }
        const applied = applyOperations(base, input.operations);
        if (!applied.ok) return { kind: 'invalid-operation', index: applied.index, error: { ...applied.error, statePath: applied.error.statePath?.replace('$.logic.', '$.') } };
        const body = {
            ...applied.logic,
            ...(input.needs !== undefined && { needs: input.needs }),
            ...(input.params !== undefined && { params: input.params })
        } as unknown as UiPartBodies['logic'];
        const stored = await this.writePart.execute({ kind: 'logic', name, body, ...(input.expectedRevision !== undefined && { expectedRevision: input.expectedRevision }) });
        switch (stored.kind) {
            case 'written':
                return {
                    kind: 'written',
                    created: input.expectedRevision === undefined,
                    revision: stored.revision,
                    units: writtenUnits(logicRunOrder(body as unknown as LogicDocument), input.operations),
                    warnings: [],
                    appWarnings: stored.warnings,
                    moreApps: stored.moreApps
                };
            case 'not-found':
                return { kind: 'not-found', nearest: [] };
            default:
                return stored;
        }
    }
}
