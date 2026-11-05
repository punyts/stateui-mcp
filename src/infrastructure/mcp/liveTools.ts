import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import { NO_PREVIEW_MESSAGE } from '../../application/use-cases/RunCommand.js';
import { BrowserUnavailableError, INTERACT_ACTIONS, MAX_FULL_PAGE_HEIGHT, PATHLESS_ACTIONS } from '../preview/BrowserPreview.js';
import type { InteractStep, PreviewBrowser } from '../preview/BrowserPreview.js';
import type { LiveViews } from '../preview/LiveViews.js';
import type { PreviewHub } from '../preview/PreviewHub.js';
import type { LogicAnswer } from '@punyts/stateui-app/core';
import type { AppCalls } from '../sync/AppCalls.js';
import type { AppAuthorities } from '../sync/AppAuthorities.js';
import { defineInput, documentPath, fail, READ_ONLY, SHOWS, succeed, WRITES } from './toolKit.js';
import type { ToolOutcome, UiToolDefinition } from './toolKit.js';

const APP_ID = { type: 'string', uuid: true, required: true, description: 'The application id from ui_app_create or ui_app_list' } as const;

export const MAX_INTERACT_ACTIONS = 20;

const STATE_GET = defineInput({
    appId: APP_ID,
    path: {
        type: 'string',
        description: 'A path to read just that part, such as "$.data.cart" or "$.app.children.main.children.form"; without it the whole state'
    },
    full: { type: 'boolean', description: 'true: return data: URIs and strings over 300 characters whole. By default they are shortened, so an image does not fill the result' }
});

const LOGIC_TRACE = defineInput({
    appId: APP_ID,
    limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many of the latest runs to return (default 10, at most 25)' },
    clear: { type: 'boolean', description: 'true: empty the trace after reading it, so the next read shows only what happens after' }
});

/** Strings longer than this are shortened in ui_state_get unless full is set */
const LONG_STRING = 300;
const KEPT_CHARS = 80;

/** A copy of a value with data: URIs and other long strings shortened to a note of their length */
function elideLong(value: unknown): unknown {
    if (typeof value === 'string') {
        if (value.length <= LONG_STRING) return value;
        if (value.startsWith('data:')) {
            const header = value.slice(0, Math.max(0, value.indexOf(',')) || 40);
            return `${header},… (${value.length} chars; full: true returns it)`;
        }
        return `${value.slice(0, KEPT_CHARS)}… (${value.length} chars; full: true returns it)`;
    }
    if (Array.isArray(value)) return value.map(elideLong);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, elideLong(item)]));
    }
    return value;
}

/** The value at a state path such as `$.data.cart`; the leading `$.` is optional. found is false when a segment is missing */
function valueAt(state: unknown, path: string): { found: boolean; value: unknown; closest: string } {
    const segments = path.replace(/^\$\.?/, '').split('.').filter((segment) => segment !== '');
    let current: unknown = state;
    const walked: string[] = [];
    for (const segment of segments) {
        if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
            return { found: false, value: undefined, closest: walked.length === 0 ? '$' : `$.${walked.join('.')}` };
        }
        current = (current as Record<string, unknown>)[segment];
        walked.push(segment);
    }
    return { found: true, value: current, closest: path };
}

const PREVIEW = defineInput({ appId: APP_ID });

const COMMAND = defineInput({
    appId: APP_ID,
    target: { type: 'string', required: true, description: 'A node under app or a screen, such as "app.children.main.children.toasts" or "screens.home.children.list" (a leading "$." is allowed); for navigate, a screen name' },
    command: { type: 'string', required: true, description: 'A command the target component declares (ui_component_get lists them), or "navigate"' },
    value: { type: 'json', description: 'The payload, for the commands that take one; for navigate, the params of the screen as an object' }
});

const SCREENSHOT = defineInput({
    appId: APP_ID,
    path: { type: 'string', description: 'A node to capture alone, such as "$.app.children.form"; rows and cards have runtime paths (ui_tree with rendered: true). Without it the whole page' },
    width: { type: 'integer', minimum: 200, maximum: 3840, description: 'Viewport width in pixels (default 1280)' },
    height: { type: 'integer', minimum: 200, maximum: 4000, description: 'Viewport height in pixels (default 800)' },
    mode: { type: 'string', description: 'A "mode" overlay name from ui_tokens_list, such as "dark", applied to the headless page before the capture' },
    fullPage: { type: 'boolean', description: `Grow the height to everything the page can scroll to (at most ${MAX_FULL_PAGE_HEIGHT} px) and capture it all; page captures only, height is the starting height` }
});

const INTERACT = defineInput({
    appId: APP_ID,
    actions: {
        type: 'list',
        required: true,
        minItems: 1,
        maxItems: MAX_INTERACT_ACTIONS,
        description: `What to do in the app, in order (at most ${MAX_INTERACT_ACTIONS}). The run stops at the first action that fails`,
        items: {
            action: {
                type: 'string',
                required: true,
                enum: INTERACT_ACTIONS,
                description:
                    'click, hover: the control of the node. fill: type value into a field. press: send the key value to the control of the node. select: pick an option of a select field. choose: pick an option by its value or label (radioField, segmented, select). focus: focus the control inside the node, or else its nearest focusable ancestor (a board card, a list row). key: press the key value on whatever has focus; no path (Space then ArrowRight moves a picked board card). drag: drag the node with the mouse onto the node whose path is value; both must fit on screen together'
            },
            path: { type: 'string', description: 'The node, such as "$.app.children.form.children.email"; every action but key needs one. ui_tree shows the paths, and with rendered: true the paths of rows and cards' },
            value: {
                type: 'string',
                description: 'The text for fill, the key for press and key (Enter, Tab, Space, ArrowDown), the option value or label for select and choose, the path of the drop target for drag'
            }
        }
    }
});

const EVENTS_READ = defineInput({
    appId: APP_ID,
    since: { type: 'integer', minimum: 0, description: 'The cursor a previous call returned: only newer events come back. Without it every queued event comes back' },
    cursor: { type: 'integer', minimum: 0, description: 'The same as since' }
});

const CALL_ANSWER = defineInput({
    appId: APP_ID,
    id: { type: 'string', required: true, description: 'The id of the logic.call event from ui_events_read' },
    status: { type: 'string', required: true, enum: ['accepted', 'rejected'], description: 'accepted gives the machine $result.value; rejected gives it $result.reason' },
    value: { type: 'json', description: 'The answer, for accepted' },
    reason: { type: 'string', description: 'Why, for rejected; shown to the machine as $result.reason' }
});

function notFound(appId: string): ToolOutcome {
    return fail('not-found', 'No application with this id', { appId });
}

function invalidArgument(parsed: { argument: string; message: string }): ToolOutcome {
    return fail('invalid-argument', parsed.message, { argument: parsed.argument });
}

function browserUnavailable(error: BrowserUnavailableError): ToolOutcome {
    return fail('browser-unavailable', error.message);
}

export interface LiveToolDependencies {
    readonly useCases: Pick<UiBuilderUseCases, 'getApp' | 'getState' | 'runCommand'>;
    readonly hub: PreviewHub;
    readonly liveViews: Pick<LiveViews, 'command'>;
    readonly browser: Pick<PreviewBrowser, 'open' | 'screenshot' | 'interact'>;
    readonly calls: Pick<AppCalls, 'answer'>;
    /** The trace of the logic that runs on the server; absent: ui_logic_trace answers that the logic does not run here */
    readonly logic?: Pick<AppAuthorities, 'trace' | 'clearTrace'>;
    /** The URL a person opens for an app, such as `http://127.0.0.1:4100/apps/<id>` */
    readonly viewUrl: (appId: string) => string;
}

/** The tools that need a running view: the state a view holds, commands, the preview, screenshots, interaction and `emit` events */
export function createLiveTools(dependencies: LiveToolDependencies): readonly UiToolDefinition[] {
    const { useCases, hub, liveViews, browser, viewUrl, calls, logic } = dependencies;

    async function revisionOf(appId: string): Promise<number | undefined> {
        const result = await useCases.getApp.execute(appId, { depth: 0 });
        return result.kind === 'found' ? result.revision : undefined;
    }

    return [
        {
            name: 'ui_state_get',
            description:
                'Read the app state as { data, app }: the data, and what users typed, picked or opened. With a preview view open (the headless page or a tab a person opened) it asks that view and returns source "live"; with none open, or none answering within 2 seconds, it returns the stored copy with source "stored". path reads one part. Long strings are shortened unless full is true. Returns { appId, revision, source, state, preview }, or with path { appId, revision, source, path, value, preview }; preview says whether a view is open and lists its runtime errors.',
            inputSchema: STATE_GET.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = STATE_GET.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { appId, path, full } = parsed.value;
                const result = await useCases.getState.execute(appId);
                if (result.kind === 'not-found') return notFound(result.appId);
                const shown = (value: unknown): unknown => (full === true ? value : elideLong(value));
                if (path === undefined) return succeed({ appId: result.appId, revision: result.revision, source: result.source, state: shown(result.state), preview: result.preview });
                const at = valueAt(result.state, path);
                if (!at.found) return fail('unknown-path', `Nothing is at ${path}; the closest part that exists is ${at.closest}`, { appId, path, closest: at.closest });
                return succeed({ appId: result.appId, revision: result.revision, source: result.source, path, value: shown(at.value), preview: result.preview });
            }
        },
        {
            name: 'ui_preview',
            description:
                'Open the headless browser page of the application, or reload it when it is already open, and wait until it has rendered the current revision. Returns { appId, revision, url, rendered, errors }: url is the address a person opens in a browser to watch the same live app (it follows every later write), rendered says whether the headless page showed this revision within 10 seconds, and errors are the runtime errors the views reported. Validate first with ui_validate. If Chromium is not installed the url still works for a person and rendered is false with a note.',
            inputSchema: PREVIEW.schema,
            annotations: SHOWS,
            run: async (args) => {
                const parsed = PREVIEW.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { appId } = parsed.value;
                const revision = await revisionOf(appId);
                if (revision === undefined) return notFound(appId);
                let rendered = false;
                let note: string | undefined;
                try {
                    rendered = (await browser.open(appId, revision)).rendered;
                } catch (error) {
                    if (!(error instanceof BrowserUnavailableError)) throw error;
                    note = error.message;
                }
                const state = await useCases.getState.execute(appId);
                return succeed({
                    appId,
                    revision,
                    url: viewUrl(appId),
                    rendered,
                    errors: state.kind === 'state' ? state.preview.errors : [],
                    ...(note !== undefined && { note })
                });
            }
        },
        {
            name: 'ui_screenshot',
            description:
                'Take a PNG screenshot of the application in the headless browser: the whole page, or one node when path is given. Optional width and height set the viewport, fullPage: true captures the whole scrolling height, mode switches the theme overlay (such as "dark") first. Returns the image and a short summary { appId, revision, target, width, height, mode? }. Use it to check what the user will see after a write.',
            inputSchema: SCREENSHOT.schema,
            annotations: SHOWS,
            run: async (args) => {
                const parsed = SCREENSHOT.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { appId, path, width, height, mode, fullPage } = parsed.value;
                if (fullPage === true && path !== undefined) return fail('invalid-argument', 'fullPage captures the page; leave path out, or capture the node without fullPage', { argument: 'fullPage' });
                const revision = await revisionOf(appId);
                if (revision === undefined) return notFound(appId);
                try {
                    const shot = await browser.screenshot(appId, revision, {
                        ...(path !== undefined && { path }),
                        ...(width !== undefined && { width }),
                        ...(height !== undefined && { height }),
                        ...(mode !== undefined && { mode }),
                        ...(fullPage === true && { fullPage })
                    });
                    return succeed(
                        { appId, revision, target: shot.target, width: shot.width, height: shot.height, ...(mode !== undefined && { mode }) },
                        [{ data: shot.png.toString('base64'), mimeType: 'image/png' }]
                    );
                } catch (error) {
                    if (error instanceof BrowserUnavailableError) return browserUnavailable(error);
                    if (error instanceof Error && error.name === 'InteractionError') return fail('not-rendered', error.message, { appId, ...(path !== undefined && { path }) });
                    throw error;
                }
            }
        },
        {
            name: 'ui_interact',
            description:
                'Act on the running app in the headless page like a user: click, hover, fill, press, select, choose (by option value or label), focus and drag on nodes by path, and key on whatever has focus. An action on a node behind an open modal fails. Actions run in order and stop at the first failure; an action whose element was re-rendered meanwhile is tried again. Returns { appId, revision, results, errors, emits, cursor }: one result per action, the runtime errors raised meanwhile, and the emit events the app raised (also readable with ui_events_read). The call is an error when an action failed.',
            inputSchema: INTERACT.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = INTERACT.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { appId } = parsed.value;
                const pathless = parsed.value.actions.findIndex((item) => item.path === undefined && !PATHLESS_ACTIONS.includes(item.action));
                if (pathless >= 0) return fail('invalid-argument', `Action ${pathless} (${parsed.value.actions[pathless]?.action}) needs a path`, { argument: `actions.${pathless}.path` });
                const revision = await revisionOf(appId);
                if (revision === undefined) return notFound(appId);
                const steps: InteractStep[] = parsed.value.actions.map((item) => ({
                    action: item.action,
                    ...(item.path !== undefined && { path: item.path }),
                    ...(item.value !== undefined && { value: item.value })
                }));
                try {
                    const result = await browser.interact(appId, revision, steps);
                    const failed = result.results.some((step) => !step.ok);
                    const body = { appId, revision, results: result.results, errors: result.errors, emits: result.events, cursor: result.cursor };
                    return failed ? { isError: true, body: { error: 'action-failed', message: 'An action failed; the later actions did not run', ...body } } : succeed(body);
                } catch (error) {
                    if (error instanceof BrowserUnavailableError) return browserUnavailable(error);
                    throw error;
                }
            }
        },
        {
            name: 'ui_events_read',
            description:
                'Read the events the running app raised, oldest first: emit events (a button with an emit action, a form submit), logic.failed, and logic.call (payload { id, name, payload }; answer it with ui_call_answer). No chat turn carries them: read them after the user may have acted, and pass the returned cursor as since next time. At most 500 are kept per app; a restart empties the queue. Returns { appId, events: [{ cursor, name, payload, at, view }], cursor }.',
            inputSchema: EVENTS_READ.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = EVENTS_READ.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { appId } = parsed.value;
                const since = parsed.value.since ?? parsed.value.cursor;
                if ((await revisionOf(appId)) === undefined) return notFound(appId);
                const { events, cursor } = hub.readEvents(appId, since);
                return succeed({ appId, events, cursor });
            }
        },
        {
            name: 'ui_logic_trace',
            description:
                'Read the latest runs of the app logic, newest last. A run has its cause (change, result, timer, answer, start, guard), the paths that changed, and one event per machine, rule, table or guard whose trigger matched, with its chain step (depth) and outcome: fired (with the transition, table row and writes), failed (with the reason), refused (a guard), condition (is, was or if was false, or no table row matched), other-state (the machine was in another state), unchanged (the value did not change), parent-removed (removed with its record), already-fired (once per chain) or debounced. Use it when a rule did not fire or fired twice. Full-mode apps only. Returns { appId, runs }.',
            inputSchema: LOGIC_TRACE.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = LOGIC_TRACE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { appId, limit, clear } = parsed.value;
                if ((await revisionOf(appId)) === undefined) return notFound(appId);
                const runs = logic?.trace(appId);
                if (runs === undefined) {
                    return fail('no-logic', 'The logic of this app does not run on the server: it has no logic, its logic did not start (see ui_validate), or the app is Persisted', { appId });
                }
                if (clear === true) logic?.clearTrace(appId);
                return succeed({ appId, runs: runs.slice(-(limit ?? 10)) });
            }
        },
        {
            name: 'ui_call_answer',
            description:
                'Answer a "call" command of the app\'s logic (Full mode): the logic.call event from ui_events_read carries its id, the procedure name and the payload. The machine that called gets accepted with $result.value, or rejected with $result.reason, and moves on. Returns { appId, id, answered }; an id that is not waiting (answered already, or lost on a restart) is the error not-waiting.',
            inputSchema: CALL_ANSWER.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = CALL_ANSWER.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { appId, id, status, value, reason } = parsed.value;
                if ((await revisionOf(appId)) === undefined) return notFound(appId);
                const answer =
                    status === 'accepted'
                        ? { status: 'accepted' as const, ...(value !== undefined && { value: value as LogicAnswer['value'] }) }
                        : { status: 'rejected' as const, ...(reason !== undefined && { reason }) };
                if (!calls.answer(appId, id, answer)) return fail('not-waiting', 'No call with this id is waiting for an answer', { appId, id });
                return succeed({ appId, id, answered: true });
            }
        },
        {
            name: 'ui_command',
            description:
                'Run a component command in the open views, the headless page included: show a toast, focus a field, scroll to a record. In an app with screens, command "navigate" with a screen name as target and the params as value shows that screen. Runtime only; nothing is stored. Returns { appId, revision, command, previewAttached, message }; with no view open the message says the command was not delivered (open one with ui_preview).',
            inputSchema: COMMAND.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = COMMAND.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { appId, target, command, value } = parsed.value;
                const result = await useCases.runCommand.execute(appId, { target: documentPath(target), command, ...(value !== undefined && { value }) });
                switch (result.kind) {
                    case 'issued': {
                        const delivered = liveViews.command(result.appId, result.command);
                        return succeed({
                            appId: result.appId,
                            revision: result.revision,
                            command: result.command,
                            previewAttached: delivered > 0,
                            message: delivered > 0 ? `delivered to ${delivered} open view${delivered === 1 ? '' : 's'}` : NO_PREVIEW_MESSAGE
                        });
                    }
                    case 'not-found':
                        return notFound(result.appId);
                    case 'invalid-target':
                        return fail('invalid-target', result.reason, { appId: result.appId });
                    case 'missing-path':
                        return fail('missing-path', `Nothing exists at ${result.missingAt}`, { appId: result.appId, target: result.target, missingAt: result.missingAt });
                    case 'not-a-node':
                        return fail('not-a-node', `${result.target} is not a node, so it has no commands`, { appId: result.appId, target: result.target });
                    case 'unknown-component':
                        return fail('unknown-component', `The component "${result.component}" at ${result.target} is not in the catalog`, {
                            appId: result.appId,
                            target: result.target,
                            component: result.component
                        });
                    case 'unknown-command':
                        return fail('unknown-command', `${result.component} does not declare the command "${result.command}"`, {
                            appId: result.appId,
                            target: result.target,
                            component: result.component,
                            command: result.command,
                            declared: result.declared
                        });
                    case 'invalid-value':
                        return fail('invalid-value', result.message, { appId: result.appId, command: result.command });
                    case 'unknown-screen':
                        return fail(
                            'unknown-screen',
                            result.screens.length === 0 ? `The app has no screens, so it cannot navigate to "${result.target}"` : `No screen is named "${result.target}"`,
                            { appId: result.appId, target: result.target, screens: result.screens }
                        );
                }
            }
        }
    ];
}
