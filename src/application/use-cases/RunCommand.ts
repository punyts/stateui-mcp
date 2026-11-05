import { parseDocumentPath, resolveDocumentPath } from '../../domain/DocumentPath.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import { documentBytes } from '../../domain/limits.js';
import { isNodeValue } from '../../domain/nodeDepth.js';
import type { ComponentCatalog } from '../ports/ComponentCatalog.js';
import type { UiAppRepository } from '../ports/UiAppRepository.js';
import type { UiPreviewLog } from '../ports/UiPreviewLog.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

/** How long a command stays valid after it was issued: the preview host drops it after `expiresAt` */
export const COMMAND_LIFETIME_MS = 30_000;

/** Largest serialised `value` of a command, in UTF-8 bytes. A command carries a key or a small payload, not data */
export const MAX_COMMAND_VALUE_BYTES = 4096;

/** The exact message when no preview is open to receive the command */
export const NO_PREVIEW_MESSAGE = 'no preview is open; the command was not delivered';

/** The message when a preview reported within the heartbeat window */
export const PREVIEW_OPEN_MESSAGE = 'a preview is open; the preview host forwards the command to it until it expires';

/** The command that moves the app to another screen; its target is a screen name */
export const NAVIGATE_COMMAND = 'navigate';

export interface RunCommandInput {
    /**
     * A dotted state path to a node under `app` (`app.children.main.children.toasts`) or under a screen
     * (`screens.home.children.list`, the screen's root being `screens.home`); for `navigate`, a screen name
     */
    readonly target: string;
    /** A command the target's component declares in the catalog, or `navigate` */
    readonly command: string;
    /** The payload, for the commands that take one */
    readonly value?: JsonValue;
}

/** A command as the tool result carries it. It is not stored; `expiresAt` is an ISO string */
export interface IssuedCommand {
    readonly id: string;
    readonly target: string;
    readonly command: string;
    readonly value?: JsonValue;
    readonly expiresAt: string;
}

export type RunCommandResult =
    | {
          readonly kind: 'issued';
          readonly appId: string;
          readonly revision: number;
          readonly command: IssuedCommand;
          /** True when a preview reported within the heartbeat window and so can receive the command */
          readonly previewAttached: boolean;
          readonly message: string;
      }
    | { readonly kind: 'not-found'; readonly appId: string }
    /** The target is not a path to a node under `app` */
    | { readonly kind: 'invalid-target'; readonly appId: string; readonly reason: string }
    /** `missingAt` is the path up to and including the first segment that does not exist */
    | { readonly kind: 'missing-path'; readonly appId: string; readonly target: string; readonly missingAt: string }
    | { readonly kind: 'not-a-node'; readonly appId: string; readonly target: string }
    | { readonly kind: 'unknown-component'; readonly appId: string; readonly target: string; readonly component: string }
    /** `declared` lists the commands the target's component does declare; it may be empty */
    | {
          readonly kind: 'unknown-command';
          readonly appId: string;
          readonly target: string;
          readonly component: string;
          readonly command: string;
          readonly declared: readonly string[];
      }
    /** The value does not fit what the command takes; nothing was issued */
    | { readonly kind: 'invalid-value'; readonly appId: string; readonly command: string; readonly message: string }
    /** `navigate` names a screen the document does not have; `screens` lists the ones it has, empty without screens */
    | { readonly kind: 'unknown-screen'; readonly appId: string; readonly target: string; readonly screens: readonly string[] };

type ValueCheck = { readonly ok: true } | { readonly ok: false; readonly message: string };

const VALID: ValueCheck = { ok: true };

function invalid(message: string): ValueCheck {
    return { ok: false, message };
}

/**
 * Checks a command's payload against the catalog. A command the shape lists in `commandValues` (`toastRegion.show`)
 * takes one key of a `map` property of the component, read from the node or from the shape default, the same rule
 * the validator applies to `on` (`SUI-ON-VALUE`). The catalog declares no other payloads, so any other command
 * accepts a JSON value up to `MAX_COMMAND_VALUE_BYTES`
 */
function checkValue(shape: JsonObject, node: JsonObject, command: string, value: JsonValue | undefined): ValueCheck {
    if (value !== undefined && documentBytes(value) > MAX_COMMAND_VALUE_BYTES) {
        return invalid(`value is over ${MAX_COMMAND_VALUE_BYTES} bytes: a command carries a key or a small payload`);
    }
    const commandValues = shape['commandValues'];
    const property = isJsonObject(commandValues) ? commandValues[command] : undefined;
    if (typeof property !== 'string') return VALID;

    if (typeof value !== 'string') return invalid(`${command} takes the key of one entry of "${property}" as a string value`);
    let map: JsonValue | undefined = node[property];
    if (map === undefined) {
        const properties = shape['properties'];
        const declared = isJsonObject(properties) ? properties[property] : undefined;
        map = isJsonObject(declared) ? declared['default'] : undefined;
    }
    if (isJsonObject(map) && !Object.hasOwn(map, value)) {
        return invalid(`"${value}" is not an entry of "${property}"; the entries are: ${Object.keys(map).join(', ') || '(none)'}`);
    }
    return VALID;
}

/**
 * Checks a component command from the minion and issues it. Nothing is stored: the result is the delivery path, and
 * the preview host forwards it to the open previews of the app until `expiresAt`. A command changes runtime state
 * only (a toast, focus, scroll); anything that should last is a document or state write
 */
export class RunCommand {
    constructor(
        private readonly repository: UiAppRepository,
        private readonly catalog: ComponentCatalog,
        private readonly previewLog: UiPreviewLog,
        private readonly now: () => Date,
        private readonly newId: () => string,
        private readonly report: UseCaseReport
    ) {}

    async execute(appId: string, input: RunCommandInput): Promise<RunCommandResult> {
        const app = await this.repository.findById(appId);
        if (app === undefined) return this.finish(appId, { kind: 'not-found', appId });

        if (input.command === NAVIGATE_COMMAND) return this.finish(appId, await this.navigate(appId, app.document, app.revision, input));

        const parsed = parseDocumentPath(input.target);
        if (!parsed.ok) return this.finish(appId, { kind: 'invalid-target', appId, reason: parsed.reason });
        const inScreen = parsed.path[0] === 'screens' && parsed.path.length >= 2;
        if (parsed.path[0] !== 'app' && !inScreen) {
            return this.finish(appId, {
                kind: 'invalid-target',
                appId,
                reason: 'A command target is a node path under "app", such as app.children.main, or under a screen, such as screens.home.children.list'
            });
        }

        // A screen's state root `screens.home` is the document's `screens.home.root`
        const documentPath = inScreen ? [...parsed.path.slice(0, 2), 'root', ...parsed.path.slice(2)] : parsed.path;
        const found = resolveDocumentPath(app.document, documentPath);
        if (!found.found) {
            const missing = documentPath.slice(0, found.missingAt + 1);
            return this.finish(appId, {
                kind: 'missing-path',
                appId,
                target: input.target,
                missingAt: (inScreen && missing.length > 2 ? [...missing.slice(0, 2), ...missing.slice(3)] : missing).join('.')
            });
        }
        const node = found.value;
        if (!isNodeValue(node)) return this.finish(appId, { kind: 'not-a-node', appId, target: input.target });

        const entry = this.catalog.get(node.component);
        if (entry === undefined) {
            return this.finish(appId, { kind: 'unknown-component', appId, target: input.target, component: node.component });
        }
        const declared = entry.tier === 'root' ? entry.commands : [];
        if (entry.tier !== 'root' || !declared.includes(input.command)) {
            return this.finish(appId, {
                kind: 'unknown-command',
                appId,
                target: input.target,
                component: node.component,
                command: input.command,
                declared
            });
        }

        const check = checkValue(entry.shape, node, input.command, input.value);
        if (!check.ok) {
            return this.finish(appId, { kind: 'invalid-value', appId, command: input.command, message: check.message });
        }

        return this.finish(appId, await this.issue(appId, app.revision, input));
    }

    /**
     * Checks a `navigate`: the target names a screen of the document and the params are an object. The open views
     * check the params against the screen's declarations when they run it
     */
    private async navigate(appId: string, document: JsonObject, revision: number, input: RunCommandInput): Promise<RunCommandResult> {
        const screens = isJsonObject(document['screens']) ? document['screens'] : {};
        if (!Object.hasOwn(screens, input.target)) {
            return { kind: 'unknown-screen', appId, target: input.target, screens: Object.keys(screens) };
        }
        if (input.value !== undefined && !isJsonObject(input.value)) {
            return { kind: 'invalid-value', appId, command: input.command, message: 'navigate takes the params of the screen as an object value' };
        }
        if (input.value !== undefined && documentBytes(input.value) > MAX_COMMAND_VALUE_BYTES) {
            return { kind: 'invalid-value', appId, command: input.command, message: `value is over ${MAX_COMMAND_VALUE_BYTES} bytes: a command carries a key or a small payload` };
        }
        return this.issue(appId, revision, input);
    }

    private async issue(appId: string, revision: number, input: RunCommandInput): Promise<RunCommandResult> {
        const issuedAt = this.now();
        const previewAttached = (await this.previewLog.status(appId, issuedAt)).attached;
        return {
            kind: 'issued',
            appId,
            revision,
            command: {
                id: this.newId(),
                target: input.target,
                command: input.command,
                ...(input.value === undefined ? {} : { value: input.value }),
                expiresAt: new Date(issuedAt.getTime() + COMMAND_LIFETIME_MS).toISOString()
            },
            previewAttached,
            message: previewAttached ? PREVIEW_OPEN_MESSAGE : NO_PREVIEW_MESSAGE
        };
    }

    private finish(appId: string, result: RunCommandResult): RunCommandResult {
        this.report.info('App command', {
            appId,
            outcome: result.kind,
            ...(result.kind === 'issued' ? { previewAttached: result.previewAttached } : {})
        });
        return result;
    }
}
