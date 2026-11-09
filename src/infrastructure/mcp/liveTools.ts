import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import type { RunCommandInput, RunCommandResult } from '../../application/use-cases/RunCommand.js';
import { NO_PREVIEW_MESSAGE } from '../../application/use-cases/RunCommand.js';
import { BrowserUnavailableError, INTERACT_ACTIONS, MAX_FULL_PAGE_HEIGHT, PATHLESS_ACTIONS } from '../preview/BrowserPreview.js';
import type { InteractStep, PreviewBrowser, PreviewScreen } from '../preview/BrowserPreview.js';
import { DRAG_OFFSET_FORM, dragTargetOf } from '../preview/dragTarget.js';
import type { InstanceViews } from '../preview/InstanceViews.js';
import type { LiveViews } from '../preview/LiveViews.js';
import type { PreviewHub } from '../preview/PreviewHub.js';
import type { LogicAnswer, LogicEffectAnswer } from '@punyts/stateui-app/core';
import type { AppCalls } from '../sync/AppCalls.js';
import type { AgentEffectAnswer, AppEffects } from '../sync/AppEffects.js';
import type { AppAuthorities } from '../sync/AppAuthorities.js';
import { isRunTarget, RUN_APP_FIELDS, runName, runTargets } from './runTarget.js';
import type { RunTarget } from './runTarget.js';
import { defineInput, documentPath, fail, READ_ONLY, SHOWS, succeed, WRITES } from './toolKit.js';
import type { ToolOutcome, UiToolDefinition } from './toolKit.js';

export const MAX_INTERACT_ACTIONS = 20;

const LOGIC_TRACE = defineInput({
    ...RUN_APP_FIELDS,
    limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many of the latest runs to return (default 10, at most 25)' },
    clear: { type: 'boolean', description: 'true: empty the trace after reading it, so the next read shows only what happens after' }
});

const SCREEN_FIELDS = {
    screen: { type: 'string', description: 'With app: a screen to show first, such as "about"; the instance moves there, as a navigate would. Without it the screen the instance is on' },
    params: { type: 'object', description: 'With screen: the params of the screen, such as { "id": "o42" }' }
} as const;

const PREVIEW = defineInput({ ...RUN_APP_FIELDS, ...SCREEN_FIELDS });

const COMMAND = defineInput({
    ...RUN_APP_FIELDS,
    target: { type: 'string', required: true, description: 'A node under app or a screen, such as "app.children.main.children.toasts" or "screens.home.children.list" (a leading "$." is allowed); for navigate, a screen name' },
    command: { type: 'string', required: true, description: 'A command the target component declares (ui_component_get lists them), or "navigate"' },
    value: { type: 'json', description: 'The payload, for the commands that take one; for navigate, the params of the screen as an object' }
});

const SCREENSHOT = defineInput({
    ...RUN_APP_FIELDS,
    ...SCREEN_FIELDS,
    path: { type: 'string', description: 'A node to capture alone, such as "$.app.children.form" or a drawing; rows, cards and shapes have runtime paths (ui_tree with rendered: true). Without it the whole page' },
    width: { type: 'integer', minimum: 200, maximum: 3840, description: 'Viewport width in pixels (default 1280)' },
    height: { type: 'integer', minimum: 200, maximum: 4000, description: 'Viewport height in pixels (default 800)' },
    mode: { type: 'string', description: 'A "mode" overlay name from ui_tokens_list, such as "dark", applied to the headless page before the capture' },
    fullPage: { type: 'boolean', description: `Grow the height to everything the page can scroll to (at most ${MAX_FULL_PAGE_HEIGHT} px) and capture it all; page captures only, height is the starting height` }
});

const INTERACT = defineInput({
    ...RUN_APP_FIELDS,
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
                    'click, hover: the control of the node. fill: type value into a field. press: send the key value to the control of the node. select: pick an option of a select field. choose: pick an option by its value or label (radioField, segmented, select). focus: focus the control inside the node, or else its nearest focusable ancestor (a board card, a list row). key: press the key value on whatever has focus; no path (Space then ArrowRight moves a picked board card). drag: drag the node with the mouse onto the node whose path is value (both must fit on screen together), or by the offset value "+dx,+dy" (page pixels, signed whole numbers such as "+40,-10") from the middle of its box. A shape of a drawing (path from ui_tree with rendered: true) takes click, press, hover, focus, key (key with its path focuses it first) and drag; fill, select and choose are refused. A drag of a shape that is not draggable (interactive: true and draggable) is refused and moves nothing; a draggable shape writes its position once, on release'
            },
            path: { type: 'string', description: 'The node, such as "$.app.children.form.children.email"; every action but key needs one. ui_tree shows the paths, and with rendered: true the paths of rows and cards' },
            value: {
                type: 'string',
                description: 'The text for fill, the key for press and key (Enter, Tab, Space, ArrowDown), the option value or label for select and choose, for drag the path of the drop target or an offset "+dx,+dy" in page pixels ("+40,-10": 40 right, 10 up)'
            }
        }
    }
});

const EVENTS_READ = defineInput({
    ...RUN_APP_FIELDS,
    since: { type: 'integer', minimum: 0, description: 'The cursor a previous call returned: only newer events come back. Without it every queued event comes back' },
    cursor: { type: 'integer', minimum: 0, description: 'The same as since' }
});

const CALL_ANSWER = defineInput({
    ...RUN_APP_FIELDS,
    id: { type: 'string', required: true, description: 'The id of the logic.call event from ui_events_read' },
    status: { type: 'string', required: true, enum: ['accepted', 'rejected'], description: 'accepted gives the machine $result.value; rejected gives it $result.reason' },
    value: { type: 'json', description: 'The answer, for accepted' },
    reason: { type: 'string', description: 'Why, for rejected; shown to the machine as $result.reason' }
});

const EFFECT_ANSWER = defineInput({
    ...RUN_APP_FIELDS,
    id: { type: 'string', required: true, description: 'The id of the logic.effect event from ui_events_read' },
    records: { type: 'json', description: 'The records of the answer, a list in the order to show them; each holds its primary key in the field the effect names' },
    first: { type: 'integer', minimum: 0, description: 'The position of the first record in the window; 0 when absent' },
    total: { type: 'integer', minimum: 0, description: 'How many records there are in all, for the window and the status' },
    value: { type: 'json', description: 'A value the effect writes at its value path' },
    error: { type: 'string', description: 'Why the request failed, instead of an answer: the status becomes error with this reason' }
});

function invalidArgument(parsed: { argument: string; message: string }): ToolOutcome {
    return fail('invalid-argument', parsed.message, { argument: parsed.argument });
}

/** The drawings and scenes that did not finish drawing within the wait, for a result: `scenes: "pending"` and their paths */
function pendingScenes(pending: readonly string[] | undefined): { scenes?: 'pending'; pending?: readonly string[] } {
    return pending === undefined || pending.length === 0 ? {} : { scenes: 'pending', pending };
}

function browserUnavailable(error: BrowserUnavailableError): ToolOutcome {
    return fail('browser-unavailable', error.message);
}

/**
 * Where a preview or screenshot opens: the screen and params given, checked against the instance's screens. undefined
 * when none is given; an error for an unknown screen
 */
function screenOf(target: RunTarget, screen: string | undefined, params: Readonly<Record<string, unknown>> | undefined): PreviewScreen | undefined | ToolOutcome {
    if (screen === undefined) return params === undefined ? undefined : fail('invalid-argument', 'params go with a screen', { argument: 'params' });
    if (!target.screens.includes(screen)) {
        const known = target.screens.length > 0 ? `its screens: ${target.screens.join(', ')}` : 'it has no screens';
        return fail('invalid-argument', `The app has no screen "${screen}"; ${known}`, { argument: 'screen', screens: target.screens });
    }
    return { screen, ...(params !== undefined && { params }) };
}

function isOutcome(value: PreviewScreen | undefined | ToolOutcome): value is ToolOutcome {
    return value !== undefined && 'isError' in value;
}

export interface LiveToolDependencies {
    readonly useCases: Pick<UiBuilderUseCases, 'findPartApp' | 'getPartState' | 'runPartCommand'>;
    readonly hub: PreviewHub;
    readonly liveViews: Pick<LiveViews, 'command'>;
    readonly browser: Pick<PreviewBrowser, 'open' | 'screenshot' | 'interact'>;
    readonly calls: Pick<AppCalls, 'answer'>;
    /** The effects that wait for the agent; absent: ui_effect_answer finds none waiting */
    readonly effects?: Pick<AppEffects, 'answer'>;
    /** The trace of the logic that runs on the server; absent: ui_logic_trace answers that the logic does not run here */
    readonly logic?: Pick<AppAuthorities, 'traceOf' | 'clearTraceOf' | 'effectsOf'>;
    readonly instanceViews: Pick<InstanceViews, 'view' | 'namespace'>;
    /** The URL a person opens for an app, such as `http://127.0.0.1:4100/apps/<id>` */
    readonly viewUrl: (appId: string) => string;
}

/** The tools that need a running view: the state a view holds, commands, the preview, screenshots, interaction and `emit` events */
export function createLiveTools(dependencies: LiveToolDependencies): readonly UiToolDefinition[] {
    const { useCases, hub, liveViews, browser, viewUrl, calls, effects, logic, instanceViews } = dependencies;
    const resolve = runTargets({ useCases, instanceViews });

    /** The runtime errors the views of the target reported */
    async function viewErrors(target: RunTarget): Promise<readonly unknown[]> {
        return (await useCases.getPartState.execute(target.part)).preview.errors;
    }

    /** The trace of the logic the target runs on the server */
    function traceOf(target: RunTarget, clear: boolean): ReturnType<AppAuthorities['traceOf']> {
        if (logic === undefined) return undefined;
        const namespace = instanceViews.namespace(target.part);
        const runs = logic.traceOf(namespace);
        if (clear) logic.clearTraceOf(namespace);
        return runs;
    }

    /** A command on the target: checked against the document the instance runs */
    function command(target: RunTarget, input: RunCommandInput): Promise<RunCommandResult> {
        return useCases.runPartCommand.execute(target.part, input);
    }

    return [
        {
            name: 'ui_preview',
            description:
                'Run time: open the headless browser page of the app, or reload it when it is already open, and wait until it has rendered the current definition. It shows the instance of the app part (screen and params open a screen first, and the instance stays there). Nothing of the definition changes. Returns { app, revision, url, rendered, errors }: url is the address a person opens in a browser to watch the same live app (it follows every later write), rendered says whether the headless page showed it within 10 seconds, and errors are the runtime errors the views reported. Validate first. If Chromium is not installed the url still works for a person and rendered is false with a note.',
            inputSchema: PREVIEW.schema,
            annotations: SHOWS,
            run: async (args) => {
                const parsed = PREVIEW.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const target = await resolve(parsed.value);
                if (!isRunTarget(target)) return target;
                const at = screenOf(target, parsed.value.screen, parsed.value.params);
                if (isOutcome(at)) return at;
                const { appId, revision } = target;
                let rendered = false;
                let note: string | undefined;
                try {
                    rendered = (await browser.open(appId, target.viewRevision, at)).rendered;
                } catch (error) {
                    if (!(error instanceof BrowserUnavailableError)) throw error;
                    note = error.message;
                }
                return succeed({
                    ...runName(target),
                    revision,
                    url: viewUrl(appId),
                    rendered,
                    errors: await viewErrors(target),
                    ...(note !== undefined && { note })
                });
            }
        },
        {
            name: 'ui_screenshot',
            description:
                'Run time: take a PNG screenshot of the app in the headless browser: the whole page, or one node when path is given. With app it shows the instance of the app part, and screen and params capture that screen (the instance stays on it). Optional width and height set the viewport, fullPage: true captures the whole scrolling height, mode switches the theme overlay (such as "dark") for the capture. The capture waits until every drawing has drawn (up to 10 seconds); one that did not is named in pending, with scenes: "pending", and the capture is still taken. Nothing of the definition changes. Returns the image and a short summary { app, revision, target, width, height, mode?, screen?, scenes?, pending? }. Use it to check what the user will see after a write.',
            inputSchema: SCREENSHOT.schema,
            annotations: SHOWS,
            run: async (args) => {
                const parsed = SCREENSHOT.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { path, width, height, mode, fullPage, screen } = parsed.value;
                if (fullPage === true && path !== undefined) return fail('invalid-argument', 'fullPage captures the page; leave path out, or capture the node without fullPage', { argument: 'fullPage' });
                const target = await resolve(parsed.value);
                if (!isRunTarget(target)) return target;
                const at = screenOf(target, screen, parsed.value.params);
                if (isOutcome(at)) return at;
                const { appId, revision, viewRevision } = target;
                try {
                    if (at !== undefined) await browser.open(appId, viewRevision, at);
                    const shot = await browser.screenshot(appId, viewRevision, {
                        ...(path !== undefined && { path }),
                        ...(width !== undefined && { width }),
                        ...(height !== undefined && { height }),
                        ...(mode !== undefined && { mode }),
                        ...(fullPage === true && { fullPage })
                    });
                    return succeed(
                        {
                            ...runName(target),
                            revision,
                            target: shot.target,
                            width: shot.width,
                            height: shot.height,
                            ...(mode !== undefined && { mode }),
                            ...(screen !== undefined && { screen }),
                            ...pendingScenes(shot.pending)
                        },
                        [{ data: shot.png.toString('base64'), mimeType: 'image/png' }]
                    );
                } catch (error) {
                    if (error instanceof BrowserUnavailableError) return browserUnavailable(error);
                    if (error instanceof Error && error.name === 'InteractionError') return fail('not-rendered', error.message, { ...runName(target), ...(path !== undefined && { path }) });
                    throw error;
                }
            }
        },
        {
            name: 'ui_interact',
            description:
                'Run time: act on the running app in the headless page like a user, on the instance of an app part: click, hover, fill, press, select, choose (by option value or label), focus and drag (onto another node, or by an offset "+dx,+dy" in page pixels) on nodes by path, and key on whatever has focus. The interactive shapes of a drawing are reached by their paths too (ui_tree with rendered: true lists them). An action on a node behind an open modal fails. Actions run in order and stop at the first failure; an action whose element was re-rendered meanwhile is tried again. Returns { app, revision, results, errors, emits, cursor }: one result per action, the runtime errors raised meanwhile, and the emit events the app raised (also readable with ui_events_read). What the actions change is the instance\'s state, never the definition. The call is an error when an action failed.',
            inputSchema: INTERACT.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = INTERACT.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const pathless = parsed.value.actions.findIndex((item) => item.path === undefined && !PATHLESS_ACTIONS.includes(item.action));
                if (pathless >= 0) return fail('invalid-argument', `Action ${pathless} (${parsed.value.actions[pathless]?.action}) needs a path`, { argument: `actions.${pathless}.path` });
                // A drag value that starts like an offset must be a whole one: refused here, before the page is opened
                for (const [index, item] of parsed.value.actions.entries()) {
                    if (item.action !== 'drag' || item.value === undefined) continue;
                    const dragTarget = dragTargetOf(item.value);
                    if ('error' in dragTarget) return fail('invalid-argument', dragTarget.error, { argument: `actions.${index}.value`, form: DRAG_OFFSET_FORM });
                }
                const target = await resolve(parsed.value);
                if (!isRunTarget(target)) return target;
                const { appId, revision } = target;
                const steps: InteractStep[] = parsed.value.actions.map((item) => ({
                    action: item.action,
                    ...(item.path !== undefined && { path: item.path }),
                    ...(item.value !== undefined && { value: item.value })
                }));
                try {
                    const result = await browser.interact(appId, target.viewRevision, steps);
                    const failed = result.results.some((step) => !step.ok);
                    const body = { ...runName(target), revision, results: result.results, errors: result.errors, emits: result.events, cursor: result.cursor, ...pendingScenes(result.pending) };
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
                'Run time: read the events the running app raised, oldest first, for the instance of an app part: emit events (a button with an emit action, a form submit), logic.failed, logic.call (payload { id, name, payload }; answer it with ui_call_answer) and logic.effect (payload { id, name, token, request }: an effect whose function the server does not have; answer it with ui_effect_answer). No chat turn carries them: read them after the user may have acted, and pass the returned cursor as since next time. At most 500 are kept per app; a restart empties the queue. Reading changes nothing. Returns { app, events: [{ cursor, name, payload, at, view }], cursor }.',
            inputSchema: EVENTS_READ.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = EVENTS_READ.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const since = parsed.value.since ?? parsed.value.cursor;
                const target = await resolve(parsed.value);
                if (!isRunTarget(target)) return target;
                const { events, cursor } = hub.readEvents(target.appId, since);
                return succeed({ ...runName(target), events, cursor });
            }
        },
        {
            name: 'ui_logic_trace',
            description:
                'Run time: read the latest runs of the logic of the instance of an app part, newest last. A run has its cause (change, result, timer, answer, start, guard), the paths that changed, and one event per machine, rule, table or guard whose trigger matched, with its chain step (depth) and outcome: fired (with the transition, table row and writes), failed (with the reason), refused (a guard), condition (is, was or if was false, or no table row matched), other-state (the machine was in another state), unchanged (the value did not change), parent-removed (removed with its record), already-fired (once per chain) or debounced. Effects run after a chain (cause effect, with the writes of loading, an answer or a cached answer). Use it when a rule did not fire or fired twice. Reading changes nothing; clear empties the trace only. Returns { app, runs, effects }: effects lists each effect with the token of the request it last acted on, whether a call is running and how many answers its cache holds.',
            inputSchema: LOGIC_TRACE.schema,
            annotations: READ_ONLY,
            run: async (args) => {
                const parsed = LOGIC_TRACE.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { limit, clear } = parsed.value;
                const target = await resolve(parsed.value);
                if (!isRunTarget(target)) return target;
                const runs = traceOf(target, clear === true);
                if (runs === undefined) {
                    return fail('no-logic', 'The logic of this app does not run on the server: it has no logic, its logic did not start (see ui_validate), nothing has used the instance yet', runName(target));
                }
                return succeed({ ...runName(target), runs: runs.slice(-(limit ?? 10)), effects: logic?.effectsOf(instanceViews.namespace(target.part)) ?? [] });
            }
        },
        {
            name: 'ui_call_answer',
            description:
                'Run time: answer a "call" command of the logic of the instance of an app part: the logic.call event from ui_events_read carries its id, the procedure name and the payload. The machine that called gets accepted with $result.value, or rejected with $result.reason, and moves on. The answer goes to the running logic only, never to the definition. Returns { app, id, answered }; an id that is not waiting (answered already, or lost on a restart) is the error not-waiting.',
            inputSchema: CALL_ANSWER.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = CALL_ANSWER.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { id, status, value, reason } = parsed.value;
                const target = await resolve(parsed.value);
                if (!isRunTarget(target)) return target;
                const answer =
                    status === 'accepted'
                        ? { status: 'accepted' as const, ...(value !== undefined && { value: value as LogicAnswer['value'] }) }
                        : { status: 'rejected' as const, ...(reason !== undefined && { reason }) };
                if (!calls.answer(target.appId, id, answer)) return fail('not-waiting', 'No call with this id is waiting for an answer', { ...runName(target), id });
                return succeed({ ...runName(target), id, answered: true });
            }
        },
        {
            name: 'ui_effect_answer',
            description:
                'Run time: answer an effect of the logic of the instance of an app part whose function the server does not have: the logic.effect event from ui_events_read carries its id, the effect name, the request token and the request. Give records (a list, in the order to show them), first, total and value, or error. The answer commits like a function\'s: the records merge into the effect\'s data map by their key, the window shows them by position from first with total, and the status becomes ready (or error with the reason). Only the latest request of an effect waits: a newer request drops the older one, whose id is then not waiting. The answer goes to the running logic only, never to the definition. Returns { app, id, answered }; an id that is not waiting (answered already, replaced by a newer request, or lost on a restart) is the error not-waiting.',
            inputSchema: EFFECT_ANSWER.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = EFFECT_ANSWER.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { id, records, first, total, value, error } = parsed.value;
                if (records !== undefined && !Array.isArray(records)) return fail('invalid-argument', 'records must be a list of records', { argument: 'records' });
                if (error !== undefined && (records !== undefined || value !== undefined)) return fail('invalid-argument', 'Give an answer (records, value) or an error, not both', { argument: 'error' });
                const target = await resolve(parsed.value);
                if (!isRunTarget(target)) return target;
                const answer: AgentEffectAnswer =
                    error !== undefined
                        ? { error }
                        : {
                              answer: {
                                  ...(records !== undefined && { records: records as LogicEffectAnswer['records'] }),
                                  ...(first !== undefined && { first }),
                                  ...(total !== undefined && { total }),
                                  ...(value !== undefined && { value: value as LogicEffectAnswer['value'] })
                              }
                          };
                if (effects?.answer(target.appId, id, answer) !== true) return fail('not-waiting', 'No effect with this id is waiting for an answer', { ...runName(target), id });
                return succeed({ ...runName(target), id, answered: true });
            }
        },
        {
            name: 'ui_command',
            description:
                'Run time: run a component command in the open views of the instance of an app part, the headless page included: show a toast, focus a field, scroll to a record. In an app with screens, command "navigate" with a screen name as target and the params as value shows that screen. Nothing of the definition changes; a navigate moves the instance to the screen. Returns { app, revision, command, previewAttached, message }; with no view open the message says the command was not delivered (open one with ui_preview).',
            inputSchema: COMMAND.schema,
            annotations: WRITES,
            run: async (args) => {
                const parsed = COMMAND.parse(args);
                if (!parsed.ok) return invalidArgument(parsed);
                const { value } = parsed.value;
                const on = await resolve(parsed.value);
                if (!isRunTarget(on)) return on;
                const named = runName(on);
                const result = await command(on, { target: documentPath(parsed.value.target), command: parsed.value.command, ...(value !== undefined && { value }) });
                switch (result.kind) {
                    case 'issued': {
                        const delivered = liveViews.command(result.appId, result.command);
                        return succeed({
                            ...named,
                            revision: result.revision,
                            command: result.command,
                            previewAttached: delivered > 0,
                            message: delivered > 0 ? `delivered to ${delivered} open view${delivered === 1 ? '' : 's'}` : NO_PREVIEW_MESSAGE
                        });
                    }
                    case 'not-found':
                        return fail('not-found', 'No application with this id', named);
                    case 'invalid-target':
                        return fail('invalid-target', result.reason, { ...named });
                    case 'missing-path':
                        return fail('missing-path', `Nothing exists at ${result.missingAt}`, { ...named, target: result.target, missingAt: result.missingAt });
                    case 'not-a-node':
                        return fail('not-a-node', `${result.target} is not a node, so it has no commands`, { ...named, target: result.target });
                    case 'unknown-component':
                        return fail('unknown-component', `The component "${result.component}" at ${result.target} is not in the catalog`, {
                            ...named,
                            target: result.target,
                            component: result.component
                        });
                    case 'unknown-command':
                        return fail('unknown-command', `${result.component} does not declare the command "${result.command}"`, {
                            ...named,
                            target: result.target,
                            component: result.component,
                            command: result.command,
                            declared: result.declared
                        });
                    case 'invalid-value':
                        return fail('invalid-value', result.message, { ...named, command: result.command });
                    case 'unknown-screen':
                        return fail(
                            'unknown-screen',
                            result.screens.length === 0 ? `The app has no screens, so it cannot navigate to "${result.target}"` : `No screen is named "${result.target}"`,
                            { ...named, target: result.target, screens: result.screens }
                        );
                }
            }
        }
    ];
}
