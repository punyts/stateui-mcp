import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import { NO_PREVIEW_MESSAGE } from '../../application/use-cases/RunCommand.js';
import { BrowserUnavailableError, INTERACT_ACTIONS } from '../preview/BrowserPreview.js';
import type { InteractStep, PreviewBrowser } from '../preview/BrowserPreview.js';
import type { LiveViews } from '../preview/LiveViews.js';
import type { PreviewHub } from '../preview/PreviewHub.js';
import type { LogicAnswer } from '@punyts/stateui-app/core';
import type { AppCalls } from '../sync/AppCalls.js';
import { READ_ONLY, SHOWS, WRITES, defineInput, fail, succeed } from './toolKit.js';
import type { ToolOutcome, UiToolDefinition } from './toolKit.js';

const APP_ID = { type: 'string', uuid: true, required: true, description: 'The application id from ui_app_create or ui_app_list' } as const;

export const MAX_INTERACT_ACTIONS = 20;

const STATE_GET = defineInput({ appId: APP_ID });

const PREVIEW = defineInput({ appId: APP_ID });

const COMMAND = defineInput({
    appId: APP_ID,
    target: { type: 'string', required: true, description: 'A dotted document path to a node under "app", such as "app.children.main.children.toasts"' },
    command: { type: 'string', required: true, description: 'A command the target component declares; ui_component_get lists them' },
    value: { type: 'json', description: 'The payload, for the commands that take one' }
});

const SCREENSHOT = defineInput({
    appId: APP_ID,
    path: { type: 'string', description: 'A state path of a node to capture just that element, such as "$.app.children.form"; without it the whole page' },
    width: { type: 'integer', minimum: 200, maximum: 3840, description: 'Viewport width in pixels (default 1280)' },
    height: { type: 'integer', minimum: 200, maximum: 4000, description: 'Viewport height in pixels (default 800)' },
    mode: { type: 'string', description: 'A "mode" overlay name from ui_tokens_list, such as "dark", applied to the headless page before the capture' }
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
            action: { type: 'string', required: true, enum: INTERACT_ACTIONS, description: 'click and hover act on the control of the component; fill types text into a field; press sends a key to the control; select picks an option of a select field' },
            path: { type: 'string', required: true, description: 'The state path of the node, such as "$.app.children.form.children.email". ui_outline shows the keys' },
            value: { type: 'string', description: 'The text for fill, the key for press (Enter, Tab, ArrowDown), the option value or label for select' }
        }
    }
});

const EVENTS_READ = defineInput({
    appId: APP_ID,
    since: { type: 'integer', minimum: 0, description: 'The cursor a previous call returned: only newer events come back. Without it every queued event comes back' }
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
    /** The URL a person opens for an app, such as `http://127.0.0.1:4100/apps/<id>` */
    readonly viewUrl: (appId: string) => string;
}

/** The tools that need a running view: the state a view holds, commands, the preview, screenshots, interaction and `emit` events */
export function createLiveTools(dependencies: LiveToolDependencies): readonly UiToolDefinition[] {
    const { useCases, hub, liveViews, browser, viewUrl, calls } = dependencies;

    async function revisionOf(appId: string): Promise<number | undefined> {
        const result = await useCases.getApp.execute(appId, { depth: 0 });
        return result.kind === 'found' ? result.revision : undefined;
    }

    return [
        {
            name: 'ui_state_get',
            description:
                'Read the state of an application: the data and articulation (what the user typed or picked) as { data, app }. The state is synced with every open view, so it holds what the user typed a moment ago, and a view that was offline sends its changes when it reconnects. Also returns the preview block: whether a view is open and its runtime errors. Returns { appId, revision, state, preview }.',
            inputSchema: STATE_GET.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = STATE_GET.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const result = await useCases.getState.execute(parsed.value.appId);
                if (result.kind === 'not-found') return notFound(result.appId);
                return succeed({ appId: result.appId, revision: result.revision, state: result.state, preview: result.preview });
            }
        },
        {
            name: 'ui_preview',
            description:
                'Open or refresh the headless browser page of the application and wait until it has rendered the current revision. Returns { appId, revision, url, rendered, errors }: url is the address a person opens in a browser to watch the same live app (it follows every later write), rendered says whether the headless page showed this revision within 10 seconds, and errors are the runtime errors the views reported. Validate first with ui_validate. If Chromium is not installed the url still works for a person and rendered is false with a note.',
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
                'Take a PNG screenshot of the application in the headless browser: the whole page, or one node when path is given. Optional width and height set the viewport, mode switches the theme overlay (such as "dark") first. Returns the image and a short summary { appId, revision, target, width, height, mode? }. Use it to check what the user will see after a write.',
            inputSchema: SCREENSHOT.schema,
            annotations: SHOWS,
            run: async (args) => {
                const parsed = SCREENSHOT.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { appId, path, width, height, mode } = parsed.value;
                const revision = await revisionOf(appId);
                if (revision === undefined) return notFound(appId);
                try {
                    const shot = await browser.screenshot(appId, revision, {
                        ...(path !== undefined && { path }),
                        ...(width !== undefined && { width }),
                        ...(height !== undefined && { height }),
                        ...(mode !== undefined && { mode })
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
                'Act on the running application in the headless browser like a user: click, hover, fill, press and select on nodes named by state path (such as "$.app.children.form.children.email"). Actions run in order and stop at the first failure. Returns { appId, revision, results, errors, emits, cursor }: results has one entry per action, errors are the runtime errors raised meanwhile and emits are the "emit" events the app raised (they stay readable with ui_events_read). The call is an error when an action failed.',
            inputSchema: INTERACT.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = INTERACT.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { appId } = parsed.value;
                const revision = await revisionOf(appId);
                if (revision === undefined) return notFound(appId);
                const steps: InteractStep[] = parsed.value.actions.map((item) => ({
                    action: item.action,
                    path: item.path,
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
                'Read the "emit" events the running application raised (a button with an emit action, a form submit), the logic.failed events and the logic.call events of its logic, oldest first. Answer a logic.call (payload { id, name, payload }) with ui_call_answer. There is no chat turn to carry them, so poll this tool after the user has had a chance to act, and pass the returned cursor as since next time. At most 500 events are kept per application and a restart empties the queue. Returns { appId, events: [{ cursor, name, payload, at, view }], cursor }.',
            inputSchema: EVENTS_READ.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = EVENTS_READ.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { appId, since } = parsed.value;
                if ((await revisionOf(appId)) === undefined) return notFound(appId);
                const { events, cursor } = hub.readEvents(appId, since);
                return succeed({ appId, events, cursor });
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
                'Run a component command in the open views of the application, the headless page included: showing a toast, focusing a field, scrolling to a record. It changes runtime state only and is not stored. Returns { appId, revision, command, previewAttached, message }; when no view is open the message says "no preview is open; the command was not delivered" and nothing happened (open one with ui_preview).',
            inputSchema: COMMAND.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = COMMAND.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { appId, target, command, value } = parsed.value;
                const result = await useCases.runCommand.execute(appId, { target, command, ...(value !== undefined && { value }) });
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
                }
            }
        }
    ];
}
