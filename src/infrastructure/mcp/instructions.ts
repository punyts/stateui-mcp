/**
 * What the model is told about this server. The MCP server is the only place it sees this guidance, so the working
 * loop and the rules that cost a failed call live here (in the server `instructions`) and, for the two tools a build
 * starts with, in their descriptions
 */

import type { CategoryIndexEntry } from '../../application/ports/ComponentCatalog.js';

/**
 * Plan first, then search the catalog by need, then build and check; with the generated category index. Its own
 * function so the other sections can be rewritten without touching it
 */
export function searchWorkflowSection(index: readonly CategoryIndexEntry[]): string {
    return [
        'Plan before you search. Decide the sections of the app, their layout, the mood of its theme (colors, type and shape that suit the subject), the data it holds and how it behaves. Make no catalog call yet.',
        'Then, for each part of the plan: ui_components_search with the need in plain words ("pick a date range", "show totals by month"), ui_component_get for the component you choose, then ui_app_create, ui_nodes_write, ui_validate, ui_preview and ui_screenshot to see the result. A weak result means nothing fitted well: say the need another way, or narrow it with a category from the index below.',
        'A large app (more than three screens, or one that writes to an owner dataset other apps use): show the plan to the user and wait for their OK before you build. A small app: go straight to building. This order is guidance, not a rule.',
        categoryIndexText(index)
    ].join('\n\n');
}

/** One header line, then one line per category that has members: its count and three typical members */
function categoryIndexText(index: readonly CategoryIndexEntry[]): string {
    return ['Component categories (count, typical members):', ...index.map((entry) => `- ${entry.category} (${entry.count}): ${entry.typical.join(', ')}`)].join('\n');
}

const WORKING_LOOP = [
    'What you build is parts the owner keeps by name: themes, models, datasets (data), logic modules, composed components and apps. An app uses parts by name (its "uses": themes, data bindings, logic modules), has a shell (the frame around every screen, with one outlet where the current screen shows) and one or more screens. A part is written once and every app that uses it shares it, so build a theme, model or dataset once and use it by name. Build time tools change definitions and never touch an instance; run time tools act on the default user\'s instance of an app and never change a definition. Each description starts with "Build time:" or "Run time:".',
    'Build steps, in this order where they apply: ui_list to see what the owner already has; ui_theme_create (a theme from another theme) or ui_theme_write without expectedRevision (a first theme); ui_model_write for the fields of a record and ui_data_write for a dataset of that model, with seed records; ui_logic_write for the machines, rules and tables of a logic module or of an app; ui_composed_write for a reusable component; ui_app_create with the themes, data bindings, logic modules and shell; ui_screen_create for each further screen, with its params; ui_nodes_write for the nodes of the shell or of one screen; ui_locale_write for another language; then ui_validate to check the app with everything it uses, and ui_preview, ui_screenshot and ui_interact to see and try it.',
    'Paths: "$.app" is the shell, "$.screens.<name>" a screen (its root is "$.screens.<name>"), "$.route" the current screen and its params, "$.data.<binding>" a data binding. Tools take "$.app.children.main" and "app.children.main" alike. ui_tree shows the structure of an app with the path of every node, content: true what the user sees, logic: true the machines with their current state, the rules and tables (those of modules too); ui_interact clicks, types and drags in the running app. Rows of a list and cards of a board get their own paths while the app runs (...body.main.slots.0); ui_tree with rendered: true lists them, for ui_interact and ui_screenshot. A screen has params: ui_command with navigate, the screen name as target and the params as value shows it, and $.route holds where the app is.',
    'Revisions and warnings: every part has its own revision. Read the part you will change with ui_get (a path and a depth), write it with expectedRevision set to the revision you read, check the warnings in the result, run ui_validate, then ui_preview. On a conflict read again and repeat; a write to one part never raises the revision of another. A part something uses is not deleted (the result names its users), and ui_rename rewrites every reference to the part it renames.',
    'Icon names come from ui_icons_list. Never guess an icon name.',
    'Token names for "theme" overrides and overlay names for theme switches come from ui_tokens_list; component token names come from ui_component_get. Never guess a token or overlay name.',
    'Keys of records and of keyed maps (children, options, columns, items, steps, messages, and objects under data) must not be integer-like: use "o42", not "42". JavaScript would reorder them and the order is part of the application.',
    'A set through a missing parent fails. Add the parent first or use merge, which creates missing keys. Read the path with ui_get before writing under it. ui_nodes_write and ui_data_write also take move, which keeps the key and the whole subtree of an entry: prefer it to remove and rewrite.',
    'ui_get with resolved: true is read only. Never write a resolved value back; write only what you change.',
    'Modules and params: a logic module names no node or screen and touches only the data in its needs; an app uses it by name with values for its params ("uses.logic"), and every data name a module needs must be bound under "uses.data". A screen declares params by name and type; a pattern or a link passes them.'
];

const LIVE_VIEW = [
    'Every app has a live view at the url ui_preview returns. A person can open it in a browser; it follows every part write, ui_state_set and ui_command at once. ui_preview also opens a headless Chromium page of the same url, which ui_screenshot, ui_interact, ui_state_get and ui_command use.',
    'ui_state_get reads the state of the default user\'s instance of the app from the server (source "instance"), whether or not a view is open, and includes a preview block: whether a view is open (attached) and the runtime errors the views reported.',
    'To test behavior from a known state: ui_state_reset puts the instance back to the definition, ui_state_set with logic: false sets up values without firing rules, and ui_logic_trace shows what every machine, rule, table and guard did with each change and why one did not fire.',
    'ui_command runs a component command (a toast, a focus, a scroll) in the open views. With no view open it answers "no preview is open; the command was not delivered" and nothing happens: call ui_preview first.',
    'No chat turn carries the events a running app raises. When the user may have acted in the app, call ui_events_read with the cursor from the last call. An emit event is the user acting in the app, not a message to answer.',
    'Files a user uploads to a fileField are listed as { id, name, size, type } references in ui_state_get and in emit payloads. ui_file_read reads text, CSV, Markdown and JSON files (up to 256 KiB); other types return the reference with text null.'
];

const LOGIC = [
    'Behavior goes in the logic of an app or of a logic module (ui_logic_write): machines (a state path, an initial state and transitions from one state to another when a trigger matches) and rules (a trigger and commands). A trigger is a state path ("$.data.contacts.{id}"; * and {name} match one segment) or the result of a save-data or delete-data command ("result": its "as" name; a machine waits for its own commands, a rule or table for those of rules and tables), narrowed by "is" and "if". Within one step a unit runs after the units whose commands write under its trigger path, so a rule over $.data.bag sees the line totals a table writes. Commands: set, merge, copy, toggle, increment, reset, save-data, delete-data, pull-data, query, notify, emit, reject. A rule whose only command is reject is a guard: it refuses the change. A Save button sets a flag the machine watches (an on command takes "from": a path whose value it uses instead of "value", so set copies a value); save-data copies the form into $.data. Tables (logic.tables: when, inputs, rows of { match?, if?, do }) run the first matching row, with a last row of neither match nor if as the default. "was" compares the value a change replaced ($previous). "debounce": ms waits for a path to be quiet; "after": ms on a machine transition with "from" fires that long after the machine entered the state. call (machines only) asks a server procedure: one the server does not know arrives as a logic.call event { id, name, payload } in ui_events_read; answer it with ui_call_answer and the machine gets the answer as its "as" result. ui_tree with logic: true lists the machines with their current state and the tables, and failures arrive as logic.failed events.'
];

const SAFETY = [
    'ui_delete cannot be undone, and ui_rename rewrites every part that names the part it renames. Ask the user before you call them, and pass the revision you read as expectedRevision; a conflict means it changed and nothing was deleted or renamed.'
];

/** The `instructions` field of the server, shown by the client to the model, with the catalog's category index */
export function buildServerInstructions(index: readonly CategoryIndexEntry[]): string {
    return [
        'StateUI app builder. Apps are declarative documents; you build them with tools and check them in a real browser.',
        searchWorkflowSection(index),
        ...WORKING_LOOP,
        ...LOGIC,
        ...LIVE_VIEW,
        ...SAFETY
    ].join('\n\n');
}

/** Appended to the descriptions of the tools a build starts with, so the loop is in front of the model at the first call */
export const START_HERE = 'Start of the working loop: ui_list, ui_theme_create, ui_components_search, ui_component_get, ui_app_create, ui_nodes_write, ui_validate, ui_preview (see the server instructions). Icon names come from ui_icons_list, keys must not be integer-like ("o42", not "42"), and a set through a missing parent fails (add the parent first or use merge).';
