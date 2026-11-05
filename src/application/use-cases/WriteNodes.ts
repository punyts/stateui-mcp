import type { JsonObject } from '../../domain/JsonValue.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import { checkOperationLimit } from '../../domain/limits.js';
import { nearestNames } from '../../domain/nearestNames.js';
import { TREE_ROOT, applyNodeOperation, treeStatePath, withTreeStatePath } from '../../domain/nodeOperations.js';
import type { NodeOperation, TreeTarget } from '../../domain/nodeOperations.js';
import { orderedMapKeyErrors } from '../../domain/orderedMap.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { PART_SHAPE_CODE } from '../../domain/UiPart.js';
import type { UiPart, UiPartBodies } from '../../domain/UiPart.js';
import { checkPartApp } from '../partAppCheck.js';
import type { MissingPart } from '../partAppCheck.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export interface WriteNodesInput {
    readonly app: string;
    readonly target: TreeTarget;
    /** The app's revision: a tree is part of its app */
    readonly expectedRevision: number;
    /** On paths relative to the tree (`root.children.hero`) */
    readonly operations: readonly NodeOperation[];
}

export type WriteNodesResult =
    /** `added`: the path of each node an `add` made, by operation index */
    | { readonly kind: 'written'; readonly revision: number; readonly warnings: readonly UiBuildError[]; readonly added: readonly { readonly index: number; readonly path: string }[] }
    | { readonly kind: 'not-found'; readonly nearest: readonly string[] }
    /** The app has no screen of that name; `nearest` are its screen names */
    | { readonly kind: 'screen-not-found'; readonly nearest: readonly string[] }
    | { readonly kind: 'conflict'; readonly currentRevision: number }
    | { readonly kind: 'invalid-operation'; readonly index: number; readonly error: UiBuildError }
    | { readonly kind: 'missing-parts'; readonly missing: readonly MissingPart[] }
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] };

/** The tree of the target in an app body, or `undefined` for a screen the app does not have */
export function targetTree(body: UiPartBodies['apps'], target: TreeTarget): JsonObject | undefined {
    if (target.kind === 'shell') return body.shell as unknown as JsonObject;
    const screens = body.screens as unknown as JsonObject;
    const screen = Object.hasOwn(screens, target.screen) ? screens[target.screen] : undefined;
    return isJsonObject(screen) ? (screen['root'] as JsonObject) : undefined;
}

/** The app body with the target's tree replaced */
function withTree(body: UiPartBodies['apps'], target: TreeTarget, tree: JsonObject | undefined): UiPartBodies['apps'] {
    if (target.kind === 'shell') return { ...body, shell: tree } as unknown as UiPartBodies['apps'];
    const screen = body.screens[target.screen];
    return { ...body, screens: { ...body.screens, [target.screen]: { ...screen, root: tree } } } as unknown as UiPartBodies['apps'];
}

/**
 * Writes the nodes of one tree of an app, the shell or one screen, with the node language of `ui_app_write` plus
 * `add`: the operations apply in order to a copy of the tree, then the app is checked as a whole (assembled with its
 * parts) and stored only when nothing blocks, as one write of the app that raises its revision once
 */
export class WriteNodes {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly validator: UiAppValidator,
        private readonly report: UseCaseReport
    ) {}

    async execute(input: WriteNodesInput): Promise<WriteNodesResult> {
        const result = await this.write(input);
        this.report.info('Nodes write', {
            target: input.target.kind,
            operationCount: input.operations.length,
            outcome: result.kind,
            ...(result.kind === 'written' && { revision: result.revision })
        });
        return result;
    }

    private async write(input: WriteNodesInput): Promise<WriteNodesResult> {
        const { target, operations } = input;
        if (operations.length === 0) return { kind: 'invalid', errors: [{ code: 'SUI-DOC-OPERATION', message: 'A write needs at least one operation', statePath: '$' }] };
        const overLimit = checkOperationLimit(operations.length);
        if (overLimit !== undefined) return { kind: 'invalid', errors: [overLimit] };

        const app = await this.parts.findByName('apps', input.app);
        if (app === undefined) return { kind: 'not-found', nearest: nearestNames(input.app, (await this.parts.list('apps')).map((summary) => summary.name)) };
        if (app.revision !== input.expectedRevision) return { kind: 'conflict', currentRevision: app.revision };
        const tree = targetTree(app.body, target);
        if (tree === undefined && target.kind === 'screen') return { kind: 'screen-not-found', nearest: nearestNames(target.screen, Object.keys(app.body.screens)) };

        const applied = this.apply({ [TREE_ROOT]: tree ?? null }, operations, target);
        if (applied.kind !== 'applied') return applied;
        const root = applied.holder[TREE_ROOT];
        const keyErrors = orderedMapKeyErrors({ app: root ?? null }).map((error) => ({
            ...error,
            ...(error.statePath !== undefined && { statePath: treeStatePath(target) + error.statePath.slice('$.app'.length) })
        }));
        if (keyErrors.length > 0) return { kind: 'invalid', errors: keyErrors };
        return this.store(app, target, isJsonObject(root) ? root : undefined, input.expectedRevision, applied.added);
    }

    private apply(
        start: JsonObject,
        operations: readonly NodeOperation[],
        target: TreeTarget
    ): { readonly kind: 'applied'; readonly holder: JsonObject; readonly added: { index: number; path: string }[] } | WriteNodesResult {
        let holder = start;
        const added: { index: number; path: string }[] = [];
        for (const [index, operation] of operations.entries()) {
            const result = applyNodeOperation(holder, operation);
            if (!result.ok) return { kind: 'invalid-operation', index, error: withTreeStatePath(result.error, target) };
            holder = result.tree;
            if (result.added !== undefined) added.push({ index, path: result.added });
        }
        return { kind: 'applied', holder, added };
    }

    private async store(
        app: UiPart<'apps'>,
        target: TreeTarget,
        tree: JsonObject | undefined,
        expectedRevision: number,
        added: readonly { index: number; path: string }[]
    ): Promise<WriteNodesResult> {
        const body = withTree(app.body, target, tree);
        const check = await checkPartApp(this.parts, this.validator, app.name, body);
        if (check.kind !== 'checked') return check;
        const written = await this.parts.write('apps', app.name, body, expectedRevision);
        switch (written.kind) {
            case 'written':
                return { kind: 'written', revision: written.revision, warnings: check.warnings, added };
            case 'conflict':
                return written;
            case 'not-found':
                return { kind: 'not-found', nearest: [] };
            case 'invalid':
                return { kind: 'invalid', errors: [{ code: PART_SHAPE_CODE, message: written.reason }] };
        }
    }
}
