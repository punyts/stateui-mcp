import { setCreatingParents } from '../../domain/documentOperations.js';
import { parseDocumentPath } from '../../domain/DocumentPath.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import { isNodeValue } from '../../domain/nodeDepth.js';
import { orderedMapKeyErrors } from '../../domain/orderedMap.js';
import { isRevisionCurrent } from '../../domain/revision.js';
import { parseStatePath } from '../../domain/statePath.js';
import type { UiApp, UiDocument, UiStateSnapshot } from '../../domain/UiApp.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import type { InstanceShape, InstanceStates } from '../ports/InstanceStates.js';
import type { UiAppRepository, UiStateWriteOptions } from '../ports/UiAppRepository.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export interface SetStateInput {
    /** `$.data...` or `$.app...<node path>.<property>` */
    readonly path: string;
    /** The value to write; absent when `remove` is set */
    readonly value?: JsonValue;
    /** Removes the entry at a `$.data` path, such as a record, instead of writing a value */
    readonly remove?: boolean;
    /** Absent: the write is checked against the revision that was read */
    readonly expectedRevision?: number;
    /** False writes the value as it is: the app's guard rules do not ask and its rules do not fire. Default true */
    readonly logic?: boolean;
}

/** Why a path was refused. Each one names what the minion should do instead in `message` */
export type SetStateRefusal =
    | 'invalid-path'
    | 'runtime-path'
    | 'unknown-path'
    | 'linked'
    | 'runtime-property'
    | 'exposed-property'
    | 'content-locale-active'
    | 'persisted-app'
    /** A guard rule of the app's logic refused the value */
    | 'logic-guard';

export type SetStateResult =
    /** `statePath` is where the value was written in the state, such as `$.data.totals` or `$.app.children.name.value` */
    | { readonly kind: 'written'; readonly appId: string; readonly revision: number; readonly path: string; readonly statePath: string }
    | { readonly kind: 'refused'; readonly appId: string; readonly reason: SetStateRefusal; readonly message: string }
    /** The value does not fit the property's shape, or a key in it is integer-like (`SUI-DOC-ORDER`) */
    | { readonly kind: 'invalid'; readonly appId: string; readonly errors: readonly UiBuildError[] }
    | { readonly kind: 'conflict'; readonly appId: string; readonly currentRevision: number }
    | { readonly kind: 'not-found'; readonly appId: string };

interface Target {
    /** Where the value goes in the snapshot, from its root (`data...` or `app...`) */
    readonly snapshotPath: readonly string[];
}

type Resolved =
    | { readonly ok: true; readonly target: Target }
    | { readonly ok: false; readonly result: SetStateResult };

function refuse(appId: string, reason: SetStateRefusal, message: string): { ok: false; result: SetStateResult } {
    return { ok: false, result: { kind: 'refused', appId, reason, message } };
}

/** A value a guard rule of the app's logic refused */
function guardRefusal(appId: string, reason: string): SetStateResult {
    return { kind: 'refused', appId, reason: 'logic-guard', message: `A guard rule of the app's logic refused the value: ${reason}` };
}

/** A node property a path names, or why it cannot be written */
type PropertyFound =
    | { readonly kind: 'ok'; readonly snapshotPath: readonly string[]; readonly content: boolean }
    | { readonly kind: 'refused'; readonly reason: SetStateRefusal; readonly message: string }
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] };

/**
 * Finds the node and the property `path` names below a resolved root, whose state path is `rootPath` (`app`, or
 * `screens` and a screen name), and checks that the property may be written: not linked, not runtime or exposed state,
 * and a value of the property's shape
 */
function findProperty(validator: UiAppValidator, root: JsonObject, rootPath: readonly string[], path: readonly string[], value: JsonValue): PropertyFound {
    let node: JsonObject = root;
    let nodeDepth = 0;
    let current: JsonValue = root;
    for (const [index, segment] of path.entries()) {
        if (!isJsonObject(current) || !Object.hasOwn(current, segment)) break;
        current = current[segment] as JsonValue;
        if (isNodeValue(current)) {
            node = current;
            nodeDepth = index + 1;
        }
    }
    const remainder = path.slice(nodeDepth);
    const nodeSegments = path.slice(0, nodeDepth);
    const nodeStatePath = `$.${[...rootPath, ...nodeSegments].join('.')}`;
    if (remainder.length !== 1) {
        return { kind: 'refused', reason: 'unknown-path', message: `No node and property at the path; the closest node is ${nodeStatePath}` };
    }
    const property = remainder[0] as string;
    if (Object.hasOwn(node, `<-${property}`)) {
        return { kind: 'refused', reason: 'linked', message: `${nodeStatePath}.${property} is linked to data: set the data it links to` };
    }
    const component = node['component'] as string;
    const check = validator.checkProperty(component, property, value, nodeStatePath);
    switch (check.kind) {
        case 'unknown-component':
        case 'unknown-property':
            return { kind: 'refused', reason: 'unknown-path', message: `${component} has no property "${property}" that can be set` };
        case 'runtime':
            return { kind: 'refused', reason: 'runtime-property', message: `${nodeStatePath}.${property} is runtime state that only the component writes` };
        case 'exposed':
            return { kind: 'refused', reason: 'exposed-property', message: `${nodeStatePath}.${property} is exposed runtime state that only the component writes` };
        case 'invalid':
            return { kind: 'invalid', errors: check.errors };
        case 'ok':
            return { kind: 'ok', snapshotPath: [...rootPath, ...nodeSegments, property], content: check.content };
    }
}

/**
 * Writes one value into the app's synced state: a `$.data` path, or an articulation property of a node. It refuses
 * links, runtime and exposed properties, `$.runtime`, unknown paths and, while a language is active, `_` content,
 * and checks the value against the component's shape. The write is checked against the revision (it does not raise it)
 * and reaches every open view at once
 */
export class SetState {
    constructor(
        private readonly repository: UiAppRepository,
        private readonly validator: UiAppValidator,
        private readonly report: UseCaseReport
    ) {}

    async execute(appId: string, input: SetStateInput): Promise<SetStateResult> {
        const parsed = parseStatePath(input.path);
        if (parsed.kind === 'invalid') return this.finish(appId, refuse(appId, 'invalid-path', parsed.reason).result);
        if (parsed.kind === 'runtime') {
            return this.finish(appId, refuse(appId, 'runtime-path', 'Tools cannot write $.runtime: controllers create it while the app runs').result);
        }
        if (parsed.kind === 'unknown') {
            return this.finish(appId, refuse(appId, 'unknown-path', 'Only $.data paths and node properties under $.app can be set').result);
        }

        const app = await this.repository.findById(appId);
        if (app === undefined) return this.finish(appId, { kind: 'not-found', appId });
        if (app.sync === 'persisted') {
            return this.finish(appId, refuse(appId, 'persisted-app', 'The app is Persisted: its state lives in the statenet and only its views change it').result);
        }
        if (!isRevisionCurrent(app.revision, input.expectedRevision)) {
            return this.finish(appId, { kind: 'conflict', appId, currentRevision: app.revision });
        }

        const options = input.logic === false ? { logic: false } : {};
        if (input.remove === true) return this.finish(appId, await this.remove(app, parsed, options));

        const value = input.value ?? null;
        let resolved: Resolved;
        let snapshot: UiStateSnapshot = app.stateSnapshot;
        if (parsed.kind === 'data') {
            resolved = { ok: true, target: { snapshotPath: ['data', ...parsed.path] } };
            snapshot = this.withData(app);
        } else {
            resolved = this.resolveProperty(app, appId, parsed.path, value);
        }
        if (!resolved.ok) return this.finish(appId, resolved.result);

        const { snapshotPath } = resolved.target;
        if (snapshotPath.length === 1 && !isJsonObject(value)) {
            return this.finish(appId, {
                kind: 'invalid',
                appId,
                errors: [{ code: 'SUI-DOC-OPERATION', message: '$.data must be an object', statePath: '$.data' }]
            });
        }
        const applied = setCreatingParents(snapshot, snapshotPath, value);
        if (!applied.ok) {
            return this.finish(appId, refuse(appId, 'unknown-path', applied.error.message).result);
        }

        const statePath = `$.${snapshotPath.join('.')}`;
        const orderErrors = orderedMapKeyErrors(applied.document).filter(
            (error) => error.statePath === statePath || error.statePath?.startsWith(`${statePath}.`) === true
        );
        if (orderErrors.length > 0) return this.finish(appId, { kind: 'invalid', appId, errors: orderErrors });

        const written = await this.repository.writeState(appId, snapshotPath, value, app.revision, options);
        if (written.kind === 'conflict') {
            return this.finish(appId, { kind: 'conflict', appId, currentRevision: written.currentRevision });
        }
        if (written.kind === 'not-found') return this.finish(appId, { kind: 'not-found', appId });
        if (written.kind === 'refused') return this.finish(appId, guardRefusal(appId, written.reason));
        return this.finish(appId, { kind: 'written', appId, revision: written.revision, path: input.path, statePath });
    }

    /** Removes an existing entry under `$.data`; `$.data` itself and node properties are refused */
    private async remove(app: UiApp, parsed: ReturnType<typeof parseStatePath>, options: UiStateWriteOptions): Promise<SetStateResult> {
        const appId = app.id;
        if (parsed.kind !== 'data' || parsed.path.length === 0) {
            return refuse(appId, 'unknown-path', 'remove takes a path under $.data, such as $.data.tasks.t2; set node properties with a value').result;
        }
        let current: JsonValue | undefined = this.withData(app)['data'];
        for (const segment of parsed.path) {
            current = isJsonObject(current) && Object.hasOwn(current, segment) ? current[segment] : undefined;
        }
        const statePath = `$.data.${parsed.path.join('.')}`;
        if (current === undefined) return refuse(appId, 'unknown-path', `Nothing is at ${statePath} to remove`).result;

        const written = await this.repository.writeState(appId, ['data', ...parsed.path], undefined, app.revision, options);
        if (written.kind === 'conflict') return { kind: 'conflict', appId, currentRevision: written.currentRevision };
        if (written.kind === 'not-found') return { kind: 'not-found', appId };
        if (written.kind === 'refused') return guardRefusal(appId, written.reason);
        return { kind: 'written', appId, revision: written.revision, path: statePath, statePath };
    }

    /** A snapshot with no data yet starts from the document's data, so the first write does not drop the rest of it */
    private withData(app: UiApp): UiStateSnapshot {
        if (Object.hasOwn(app.stateSnapshot, 'data') || app.document['data'] === undefined) return app.stateSnapshot;
        return { ...app.stateSnapshot, data: app.document['data'] };
    }

    private languageActive(app: UiApp): boolean {
        const locale = app.document['locale'];
        return typeof locale === 'string' && locale !== '' && this.validator.localeOverlay(app.document, locale) !== undefined;
    }

    /** Finds the node and the property a `$.app` path names, and checks that the property may be written */
    private resolveProperty(app: UiApp, appId: string, path: readonly string[], value: JsonValue): Resolved {
        const root = this.validator.resolveNode(app.document, ['app']);
        if (root === undefined) return refuse(appId, 'unknown-path', 'The app has no node to write to');
        const found = findProperty(this.validator, root, ['app'], path, value);
        switch (found.kind) {
            case 'refused':
                return refuse(appId, found.reason, found.message);
            case 'invalid':
                return { ok: false, result: { kind: 'invalid', appId, errors: found.errors } };
            case 'ok':
                if (found.content && this.languageActive(app)) {
                    return refuse(appId, 'content-locale-active', 'Content is text for the active language: change it with ui_app_write on the document or its locale overlay');
                }
                return { ok: true, target: { snapshotPath: found.snapshotPath } };
        }
    }

    private finish(appId: string, result: SetStateResult): SetStateResult {
        this.report.info('App state write', {
            appId,
            outcome: result.kind,
            ...(result.kind === 'refused' ? { reason: result.reason } : {}),
            ...(result.kind === 'written' ? { revision: result.revision } : {})
        });
        return result;
    }
}

/** Why a write to an instance was refused: the reasons of `SetState`, a path of the definition, or a shared dataset */
export type SetPartStateRefusal = Exclude<SetStateRefusal, 'persisted-app' | 'content-locale-active'> | 'definition-path' | 'shared-dataset';

export type SetPartStateResult =
    /** `revision` is the app part's: a state write does not raise it */
    | { readonly kind: 'written'; readonly app: string; readonly revision: number; readonly path: string; readonly statePath: string }
    | { readonly kind: 'refused'; readonly app: string; readonly reason: SetPartStateRefusal; readonly message: string }
    | { readonly kind: 'invalid'; readonly app: string; readonly errors: readonly UiBuildError[] }
    | { readonly kind: 'conflict'; readonly app: string; readonly currentRevision: number }
    | { readonly kind: 'not-found'; readonly app: string };

type PartTarget = { readonly ok: true; readonly snapshotPath: readonly string[] } | { readonly ok: false; readonly result: SetPartStateResult };

function partRefusal(app: string, reason: SetPartStateRefusal, message: string): { ok: false; result: SetPartStateResult } {
    return { ok: false, result: { kind: 'refused', app, reason, message } };
}

function valueAt(state: JsonObject, path: readonly string[]): JsonValue | undefined {
    let current: JsonValue | undefined = state;
    for (const segment of path) current = isJsonObject(current) && Object.hasOwn(current, segment) ? current[segment] : undefined;
    return current;
}

/**
 * Writes one value into the default persona's running instance of an owner app, never into its definition:
 *
 * - `$.app...` and `$.screens.{screen}...` name an articulation property of a node of the shell or a screen, checked as
 *   `SetState` checks one; content (`_` properties) belongs to the definition and is refused;
 * - `$.data.{binding}...` writes the persona's own records of a persona binding; a shared dataset's records are the
 *   dataset's, written with `ui_data_write`;
 * - `$.theme` and the other roots of the document are the definition's, and `$.route` moves with `navigate`.
 *
 * The write is checked against the app part's revision (it does not raise it), asked of the guards and seen by the
 * instance's logic
 */
export class SetPartState {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly states: InstanceStates,
        private readonly validator: UiAppValidator,
        private readonly report: UseCaseReport
    ) {}

    async execute(app: string, input: SetStateInput): Promise<SetPartStateResult> {
        if (!input.path.startsWith('$.')) return this.finish(partRefusal(app, 'invalid-path', 'A state path starts with $.').result);
        const parsed = parseDocumentPath(input.path.slice(2));
        if (!parsed.ok) return this.finish(partRefusal(app, 'invalid-path', parsed.reason).result);
        const [root, ...rest] = parsed.path;
        const early = this.refuseRoot(app, root);
        if (early !== undefined) return this.finish(early);

        const part = await this.parts.findByName('apps', app);
        if (part === undefined) return this.finish({ kind: 'not-found', app });
        if (!isRevisionCurrent(part.revision, input.expectedRevision)) return this.finish({ kind: 'conflict', app, currentRevision: part.revision });

        const shape = await this.states.shape(part);
        const value = input.remove === true ? undefined : (input.value ?? null);
        const target = root === 'data' ? this.dataTarget(app, rest, shape.bindings) : this.nodeTarget(app, root as 'app' | 'screens', rest, value ?? null, shape.document);
        if (!target.ok) return this.finish(target.result);
        const statePath = `$.${target.snapshotPath.join('.')}`;

        if (input.remove === true) {
            if (root !== 'data' || target.snapshotPath.length < 3) {
                return this.finish(partRefusal(app, 'unknown-path', 'remove takes a path inside a persona binding, such as $.data.bag.l1; set node properties with a value').result);
            }
            if (valueAt(await this.states.state(part), target.snapshotPath) === undefined) {
                return this.finish(partRefusal(app, 'unknown-path', `Nothing is at ${statePath} to remove`).result);
            }
        } else {
            const placed = setCreatingParents({}, target.snapshotPath, value ?? null);
            const orderErrors = placed.ok
                ? orderedMapKeyErrors(placed.document).filter((error) => error.statePath === statePath || error.statePath?.startsWith(`${statePath}.`) === true)
                : [];
            if (orderErrors.length > 0) return this.finish({ kind: 'invalid', app, errors: orderErrors });
        }

        const refused = await this.states.write(part, statePath, value, input.logic === false ? { logic: false } : {});
        if (refused !== undefined) {
            return this.finish({ kind: 'refused', app, reason: 'logic-guard', message: `A guard rule of the app's logic refused the value: ${refused}` });
        }
        return this.finish({ kind: 'written', app, revision: part.revision, path: input.path, statePath });
    }

    /** A root no tool writes in an instance, or undefined for `app`, `screens` and `data` */
    private refuseRoot(app: string, root: string | undefined): SetPartStateResult | undefined {
        switch (root) {
            case 'app':
            case 'screens':
            case 'data':
                return undefined;
            case 'runtime':
                return partRefusal(app, 'runtime-path', 'Tools cannot write $.runtime: controllers create it while the app runs').result;
            case 'route':
                return partRefusal(app, 'unknown-path', '$.route changes by navigating: use ui_command with navigate and a screen name').result;
            case 'theme':
                return partRefusal(app, 'definition-path', "$.theme is the app's definition: change the theme part, or switch an overlay with ui_command").result;
            case undefined:
                return partRefusal(app, 'unknown-path', 'Only $.data, $.app and $.screens paths can be set').result;
            default:
                return partRefusal(app, 'definition-path', `$.${root} is the app's definition, not the state of using it: change the app part`).result;
        }
    }

    private dataTarget(app: string, path: readonly string[], bindings: InstanceShape['bindings']): PartTarget {
        const names = Object.keys(bindings);
        const known = names.length > 0 ? names.join(', ') : '(none)';
        const [binding] = path;
        if (binding === undefined) return partRefusal(app, 'unknown-path', `$.data is written one binding at a time, $.data.{binding}; the app binds: ${known}`);
        const scope = Object.hasOwn(bindings, binding) ? bindings[binding] : undefined;
        if (scope === undefined) return partRefusal(app, 'unknown-path', `The app binds no data named "${binding}"; it binds: ${known}`);
        if (scope === 'shared') {
            return partRefusal(app, 'shared-dataset', `$.data.${binding} is a shared dataset, the same records in every app that binds it: change them with ui_data_write`);
        }
        return { ok: true, snapshotPath: ['data', ...path] };
    }

    private nodeTarget(app: string, root: 'app' | 'screens', path: readonly string[], value: JsonValue, document: UiDocument): PartTarget {
        let rootPath: readonly string[] = ['app'];
        let documentPath: readonly string[] = ['app'];
        let below = path;
        if (root === 'screens') {
            const screens = isJsonObject(document['screens']) ? document['screens'] : {};
            const [screen] = path;
            if (screen === undefined || !Object.hasOwn(screens, screen)) {
                return partRefusal(app, 'unknown-path', `The app has no screen "${screen ?? ''}"; its screens: ${Object.keys(screens).join(', ') || '(none)'}`);
            }
            rootPath = ['screens', screen];
            documentPath = ['screens', screen, 'root'];
            below = path.slice(1);
        }
        const node = this.validator.resolveNode(document, documentPath);
        if (node === undefined) return partRefusal(app, 'unknown-path', `$.${rootPath.join('.')} has no node to write to`);
        const found = findProperty(this.validator, node, rootPath, below, value);
        switch (found.kind) {
            case 'refused':
                return partRefusal(app, found.reason as SetPartStateRefusal, found.message);
            case 'invalid':
                return { ok: false, result: { kind: 'invalid', app, errors: found.errors } };
            case 'ok':
                if (found.content) {
                    const at = `$.${found.snapshotPath.join('.')}`;
                    return partRefusal(app, 'definition-path', `${at} is content, part of the app's definition: change it in the app part`);
                }
                return { ok: true, snapshotPath: found.snapshotPath };
        }
    }

    private finish(result: SetPartStateResult): SetPartStateResult {
        this.report.info('Instance state write', {
            app: result.app,
            outcome: result.kind,
            ...(result.kind === 'refused' ? { reason: result.reason } : {})
        });
        return result;
    }
}
