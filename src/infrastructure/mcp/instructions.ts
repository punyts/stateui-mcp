/**
 * What the model is told about this server. The MCP server is the only place it sees this guidance, so the working
 * loop and the rules that cost a failed call live here (in the server `instructions`) and, for the two tools a build
 * starts with, in their descriptions
 */

import type { CategoryIndexEntry } from '../../application/ports/ComponentCatalog.js';

/**
 * Plan first, then search the catalog by need, then build and check; with the generated category index. Its own
 * function so the owner-tree instructions (O3.12) can rewrite the other sections without touching it
 */
export function searchWorkflowSection(index: readonly CategoryIndexEntry[]): string {
    return [
        'Plan before you search. Decide the sections of the app, their layout, the mood of its theme (colors, type and shape that suit the subject), the data it holds and how it behaves. Make no catalog call yet.',
        'Then, for each part of the plan: ui_components_search with the need in plain words ("pick a date range", "show totals by month"), ui_component_get for the component you choose, then ui_app_create, ui_app_write, ui_validate, ui_preview and ui_screenshot to see the result. A weak result means nothing fitted well: say the need another way, or narrow it with a category from the index below.',
        'A large app (more than three screens, or one that writes to an owner dataset other apps use): show the plan to the user and wait for their OK before you build. A small app: go straight to building. This order is guidance, not a rule.',
        categoryIndexText(index)
    ].join('\n\n');
}

/** One header line, then one line per category that has members: its count and three typical members */
function categoryIndexText(index: readonly CategoryIndexEntry[]): string {
    return ['Component categories (count, typical members):', ...index.map((entry) => `- ${entry.category} (${entry.count}): ${entry.typical.join(', ')}`)].join('\n');
}

const WORKING_LOOP = [
    'ui_tree shows the structure with the path of every node, ui_outline the content; ui_interact clicks, types and drags in the running app.',
    'Paths: "$.app.children.main" and "app.children.main" name the same node, and every tool takes either form. Rows of a list and cards of a board get their own paths while the app runs (...body.main.slots.0); ui_tree with rendered: true lists them, for ui_interact and ui_screenshot.',
    'Write loop: read the part you will change with ui_app_get and a path, call ui_app_write with expectedRevision set to the revision you read, check the warnings in the result, run ui_validate, then ui_preview. On a conflict read again and repeat.',
    'Icon names come from ui_icons_list. Never guess an icon name.',
    'Token names for "theme" overrides and overlay names for theme switches come from ui_tokens_list; component token names come from ui_component_get. Never guess a token or overlay name.',
    'Keys of records and of keyed maps (children, options, columns, items, steps, messages, and objects under data) must not be integer-like: use "o42", not "42". JavaScript would reorder them and the order is part of the application.',
    'A set through a missing parent fails. Write the parent first ("composed", then "composed.x") or use merge, which creates missing keys. Read the path with ui_app_get before writing under it. ui_app_write also takes move, which keeps the key and the whole subtree of an entry: prefer it to remove and rewrite.',
    'ui_app_get with resolved: true is read only. Never write a resolved value back; write only what you change.'
];

const LIVE_VIEW = [
    'Every app has a live view at the url ui_preview returns. A person can open it in a browser; it follows every ui_app_write, ui_state_set and ui_command at once. ui_preview also opens a headless Chromium page of the same url, which ui_screenshot, ui_interact, ui_state_get and ui_command use.',
    'ui_state_get reads the state from an open view (source "live") and falls back to the stored copy (source "stored") when no view is open. ui_validate and ui_state_get include a preview block: whether a view is open (attached) and the runtime errors the views reported.',
    'To test behavior from a known state: ui_state_reset puts the state back to the document, ui_state_set with logic: false sets up values without firing rules, and ui_logic_trace shows what every machine, rule, table and guard did with each change and why one did not fire.',
    'ui_command runs a component command (a toast, a focus, a scroll) in the open views. With no view open it answers "no preview is open; the command was not delivered" and nothing happens: call ui_preview first.',
    'No chat turn carries the events a running app raises. When the user may have acted in the app, call ui_events_read with the cursor from the last call. An emit event is the user acting in the app, not a message to answer.',
    'Files a user uploads to a fileField are listed as { id, name, size, type } references in ui_state_get and in emit payloads. ui_file_read reads text, CSV, Markdown and JSON files (up to 256 KiB); other types return the reference with text null.'
];

const LOGIC = [
    'Behavior goes in the "logic" of the document: machines (a state path, an initial state and transitions from one state to another when a trigger matches) and rules (a trigger and commands). A trigger is a state path ("$.data.contacts.{id}"; * and {name} match one segment) or the result of a save-data or delete-data command ("result": its "as" name; a machine waits for its own commands, a rule or table for those of rules and tables), narrowed by "is" and "if". Within one step a unit runs after the units whose commands write under its trigger path, so a rule over $.data.bag sees the line totals a table writes. Commands: set, merge, copy, toggle, increment, reset, save-data, delete-data, pull-data, query, notify, emit, reject. A rule whose only command is reject is a guard: it refuses the change. A Save button sets a flag the machine watches (an on command takes "from": a path whose value it uses instead of "value", so set copies a value); save-data copies the form into $.data. Tables (logic.tables: when, inputs, rows of { match?, if?, do }) run the first matching row, with a last row of neither match nor if as the default. "was" compares the value a change replaced ($previous). "debounce": ms waits for a path to be quiet; "after": ms on a machine transition with "from" fires that long after the machine entered the state. call (machines only) asks a server procedure: one the server does not know arrives as a logic.call event { id, name, payload } in ui_events_read; answer it with ui_call_answer and the machine gets the answer as its "as" result. ui_outline lists the machines with their current state and the tables, and failures arrive as logic.failed events.'
];

const SAFETY = [
    'ui_app_delete and ui_delete cannot be undone, and ui_rename rewrites every part that names the part it renames. Ask the user before you call them, and pass the revision you read as expectedRevision; a conflict means it changed and nothing was deleted or renamed.'
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
export const START_HERE = 'Start of the working loop: ui_components_search, ui_component_get, ui_app_create, ui_app_write, ui_validate, ui_preview (see the server instructions). Icon names come from ui_icons_list, keys must not be integer-like ("o42", not "42"), and a set through a missing parent fails (write the parent first or use merge).';
