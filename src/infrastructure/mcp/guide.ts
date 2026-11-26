/**
 * The guide: one table of topics, each a short text of how-to guidance with the step it is read before. It is the one
 * source of the guidance: the server instructions are built from it (`instructions.ts`) and `ui_guide` answers one
 * topic of it (`guideTools.ts`), so no rule is written twice. A topic text may depend on the catalog's category index
 * and theme presets and on the operator's functions, which are fixed for one server build, so the same topic always
 * gives the same text
 */

import type { FunctionEntry } from '@punyts/stateui-app/core';
import type { CategoryIndexEntry } from '../../application/ports/ComponentCatalog.js';

/** What a topic text may depend on: the catalog's category index and the library's theme preset names */
export interface GuideContext {
    readonly index: readonly CategoryIndexEntry[];
    readonly presets: readonly string[];
    /** The functions the operator installed, which the topic functions lists; none when absent */
    readonly functions?: readonly FunctionEntry[];
}

/** One topic of the guide */
export interface GuideTopic {
    /** The name `ui_guide` takes, such as "logic" */
    readonly name: string;
    /** The index line: the step the topic is read before, without the word "before" ("a machine or rule") */
    readonly when: string;
    /** The guidance, plain sentences, at most `MAX_TOPIC_CHARS` characters */
    readonly text: (context: GuideContext) => string;
    /** The server instructions give the topic in full; the others get one pointer line there */
    readonly alwaysOn: boolean;
}

/** A topic is about one screen of text */
export const MAX_TOPIC_CHARS = 2000;

/** The category index: one header line, then one line per category that has members, its count and three typical members */
function categoryIndexText(index: readonly CategoryIndexEntry[]): string {
    return ['Component categories (count, typical members):', ...index.map((entry) => `- ${entry.category} (${entry.count}): ${entry.typical.join(', ')}`)].join('\n');
}

/**
 * The build steps 1 to 5, from the plan to the screens. `presets` are the library's theme preset names; with none the
 * preset clause is left out, so the text never names a preset that is not there
 */
function startText({ presets }: GuideContext): string {
    return [
        'Build steps, in this order. The order is guidance: a new app goes through all of them, and an edit starts at the step the change needs (a new field starts at data, a new screen at screens).',
        [
            '1. Plan: ui_list to see what the owner already has, then decide the screens, the sections of each, the mood of the theme (colors, type and shape that suit the subject), the data and how it behaves. Make no catalog call yet. A large app (more than three screens, or one that writes to an owner dataset other apps use): show the plan to the user and wait for their OK before you build. A small app: go straight on.',
            `2. Theme: ui_theme_create (from another theme${presets.length > 0 ? ', or from a preset' : ''}) or ui_theme_write without expectedRevision (a first theme); token names come from ui_tokens_list.`,
            '3. Data: ui_model_write for the fields of a record, ui_data_write for a dataset of that model with seed records.',
            '4. App: ui_patterns_search with the first screen in plain words ("app with a side menu", "store front with a top menu"), then ui_app_create with home { pattern, params } and the themes, data bindings and logic it uses. An app is its screens, with no frame around them: a header or menu shared by several screens is a node each screen places, best one composed component (ui_composed_write) placed in every screen. The result lists the slots of home: the node paths to fill.',
            '5. Screens: ui_patterns_search with kind screen and each screen of the plan ("finance dashboard with totals and a trend"), then ui_screen_create with pattern and patternParams (the path params of a pattern name the datasets bound in uses.data). The result lists the slots of the screen. With no pattern that fits, give the screen a root node.'
        ].join('\n')
    ].join('\n\n');
}

/** The build steps 6 to 8, from the sections to the check, then what a weak search means, the theme presets and the category index */
function sectionsText({ index, presets }: GuideContext): string {
    return [
        [
            '6. Sections: for each part a pattern does not cover, ui_components_search with the need in plain words ("pick a date range", "show totals by month"), ui_component_get for the component you choose, then ui_nodes_write into a slot. ui_composed_write makes a reusable component, ui_locale_write another language, ui_icons_write an icon the icon set does not have.',
            '7. Logic: ui_logic_write for the machines, rules and tables of the app or of a logic module.',
            '8. Check: ui_validate, then ui_preview, ui_screenshot with fullPage: true and again with width: 375 (a phone), and ui_interact to try what the user will do.'
        ].join('\n'),
        'A weak search result means nothing fitted well: say the need another way, narrow a component search with a category from the index below, or build from components.',
        ...(presets.length > 0 ? [`Theme presets for ui_theme_create (preset): ${presets.join(', ')}.`] : []),
        categoryIndexText(index)
    ].join('\n\n');
}

const PARTS = 'What you build is parts the owner keeps by name: themes, models, datasets (data), logic modules, composed components and apps. An app uses parts by name (its "uses": themes, data bindings, logic modules), has an app node ("$.app": the layout of its screens, the document title, the toasts and the app events) and one or more screens. An app is its screens: each screen is a layout and its components, and a header or menu shared by screens is a component each screen places. A part is written once and every app that uses it shares it, so build a theme, model or dataset once and use it by name. Build time tools change definitions and never touch an instance; run time tools act on the default user\'s instance of an app and never change a definition. Each description starts with "Build time:" or "Run time:".';

const PATHS = 'Paths: "$.app" is the app node, "$.app.toasts" its toasts, "$.screens.<name>" a screen (its root is "$.screens.<name>"), "$.route" the current screen and its params, "$.data.<binding>" a data binding. Tools take "$.screens.home.children.main" and "screens.home.children.main" alike. ui_tree shows the structure of an app with the path of every node, content: true what the user sees, logic: true the machines with their current state, the rules and tables (those of modules too); ui_interact clicks, types and drags in the running app. Rows of a list and cards of a board get their own paths while the app runs (...body.main.slots.0); ui_tree with rendered: true lists them, for ui_interact and ui_screenshot. A screen has params: ui_command with navigate, the screen name as target and the params as value shows it, and $.route holds where the app is. A node is named by its key, or by its @id when it has one ("@id": "username"): "#username.value" links to it from anywhere in the app ("<-value": "#username.value"), an on target or a logic path takes it alike, and inside a list row it means the copy in that row. Two nodes with one @id are an error.';

const REVISIONS = 'Revisions and warnings: every part has its own revision. Read the part you will change with ui_get (a path and a depth), write it with expectedRevision set to the revision you read, check the warnings in the result, run ui_validate, then ui_preview. On a conflict read again and repeat; a write to one part never raises the revision of another. A part something uses is not deleted (the result names its users), and ui_rename rewrites every reference to the part it renames.';

/** The rules that cost a failed call: names come from their tools, keys are not integer-like, a set needs its parent */
const KEYS = [
    'Icon names come from ui_icons_list. Never guess an icon name. For a glyph the set does not have, draw the app its own icon with ui_icons_write (24×24 outline path data); ui_icons_list with app lists it, and it wins over a set icon of the same name.',
    'Token names for "theme" overrides and overlay names for theme switches come from ui_tokens_list; component token names come from ui_component_get. Never guess a token or overlay name.',
    'Keys of records and of keyed maps (children, options, columns, items, steps, messages, and objects under data) must not be integer-like: use "o42", not "42". JavaScript would reorder them and the order is part of the application.',
    'A set through a missing parent fails. Add the parent first or use merge, which creates missing keys. Read the path with ui_get before writing under it. ui_nodes_write and ui_data_write also take move, which keeps the key and the whole subtree of an entry: prefer it to remove and rewrite.',
    'ui_get with resolved: true is read only. Never write a resolved value back; write only what you change.'
].join('\n\n');

const MODULES = 'Modules and params: a logic module names no node or screen and touches only the data in its needs; an app uses it by name with values for its params ("uses.logic"), and every data name a module needs must be bound under "uses.data". A screen declares params by name and type; a pattern or a link passes them.';

const TABLES = 'A table (logic.tables.<name>: { inputs, outputs, rows }) is a lookup table that only writes values: an input is a path (read in output values as $name) or { path or value (one {{ }} expression), values (a list, "*" for any other, or { keys: a data map }) or breaks (ascending numbers that split it into buckets) }; outputs name the paths they write; a row gives conditions for inputs (a value, a list, "*", ">=50" or "<100" with a break) and values for outputs, and the first matching row wins. A change to an input runs the table (per record when its paths capture {id}), and only outputs that change are written. Every combination needs a row (SUI-LOGIC-GAP names the missing ones; a last row with no conditions is the default), a row that never wins is a warning, and tables that feed each other are SUI-LOGIC-CYCLE. rows: { from: a data map } keeps the rows in data that users edit. lookup(\'name\', inputs...) in an expression gives the outputs of the winning row. Side effects (notify, save-data) go in rules that listen to the outputs of a table. Example: { "inputs": { "country": { "path": "$.data.order.country", "values": ["NL", "*"] }, "total": { "path": "$.data.order.total", "breaks": [50] } }, "outputs": { "fee": "$.data.order.shipping" }, "rows": [{ "country": "NL", "total": ">=50", "fee": 0 }, { "fee": 5 }] }.';

const EFFECTS = 'Three tiers of logic: tables for quick lookups, expressions ({{ }}) for small scripts, and code for the rest. Code is a function the operator of the server installs, named by its path: $.functions.<group>.<name>, the host functions under $.functions.host, or $.components.<component>.functions.<name> for a function of a component. A document never holds code. A compute (logic.computes.<name>: { inputs, run, outputs }, run a function path) runs a sync function: inputs are paths or { path | value }, the function gets them by name and returns an object whose fields go to the outputs; a missing input skips the unit, and it runs in the chain like a table. An effect (logic.effects.<name>: { request, run, status, records?: { into, key }, window?, value?, cache? }) does async work with a request token. A cell sets the request (a value at the request path, such as { page, size, filter }); the token is a hash of that value. A new token aborts the call that runs and drops its answer when it comes; the status path holds { token, state: loading | ready | error, total?, reason?, at }. The answer { records, first, total, value } commits at once: records merge into the data map records.into by their key (the primary key, under $.data or $.server), the window node (a #name or path) shows rows first+i keyed by that key, and a later change to a record rewrites the rows that show it. cache: n keeps the last n answers by token, so going back to a page shows it with no call. Removing the request makes the status idle. An expression calls a function by its path: {{ $.functions.text.upper($.data.name) }}. A run or call of a function this server does not run is a warning (SUI-LOGIC-FUNCTION) and fails when it runs; in Full mode the server asks the agent instead: a logic.effect event { id, name, token, request } in ui_events_read, answered with ui_effect_answer. ui_logic_trace lists each effect with its token, running and cache size.';

const SAVING =
    'A save-data or delete-data with "as" gives its accepted result once the write is durable: stored where it survives the server, the shared dataset record included. So a machine that moves to "saved" on that result shows Saved only when it is, and a write that could not be stored comes back rejected with the reason. "await": "applied" gives the result as soon as the write is in the state, for steps nobody waits on. Some state is shared but never worth storing: a pointer, presence, who is typing, a drag in progress. List those paths in the ephemeral list of the app (ui_app_configure; "$.data.presence.*", * for any one segment): their changes reach everyone using the app at once, are never written to the database, and never hold up a save. Do not make a record or anything a person would miss ephemeral: it is gone when the server restarts. A node marks its own state the same way: "@transient": true (or a list of its properties) is shared and never stored, "@local": ["collapsed"] stays on the device of the person and is never sent, "@secret": ["value"] (a password) goes to server logic only, never stored, logged or shown to others. "@share": { "cursor": "peers of .board" } with "<-all": "$peers.cursor" shows the cursors on the same .board. A person who may only suggest changes (shared with request, not write) sends ordinary changes that wait for the owner: the app\'s toasts say Sent for approval (an on entry for sync.requested on $.app replaces that), and $.runtime.requests lists the requests by id ({ id, path, op, value, status: pending, approved, rejected, expired or withdrawn, mine, by, note }). Link a list to it and give its rows buttons that run request.approve, request.reject or request.withdraw with "value": "$row.id" (request.reject also takes { id, note }); approving applies the change through the app\'s logic. A button that runs undo or redo (no target or value) steps back or forward through the last 100 changes a person made to the app; an undo runs no logic.';

const SIMILAR =
    'A server with embeddings can find records by meaning. Mark a string field of a model embed: true (ui_model_write), and the server embeds that field of every record of the datasets and person bindings of that model as it changes; other servers ignore embed. Logic asks with call (machines only): target similar, value { binding, field, text, limit? } (binding: a data binding of the app; limit: 10 by default, at most 50), and an "as" name. The answer is accepted with the value { results: [{ key, score }] }, the closest records first (score 1 is the same meaning), or rejected with a reason (no such binding, or the field is not embedded). Over a person binding only the records of the person whose instance runs the logic are searched. The answer gives keys, not records: read each record at $.data.<binding>.<key>, or copy the keys into a list the screen shows. A record just written is found a moment later, once it is embedded.';

const LOGIC = 'Behavior goes in the logic of an app or of a logic module (ui_logic_write): machines (a state path, an initial state and transitions between states when a trigger matches) and rules (a trigger and commands). A trigger is a state path ("$.data.contacts.{id}"; * and {name} match one segment) or the result of a save-data or delete-data command ("result": its "as" name; a machine waits for its own commands, a rule for those of rules), narrowed by "is" and "if". Within one step a unit runs after the units whose commands write under its trigger path, so a rule over $.data.bag sees the line totals a table writes. Commands: set, merge, copy, toggle, increment, reset, save-data, delete-data, pull-data, query, notify, reject. A rule whose only command is reject is a guard: it refuses the change. Events are state: each event a node raises is written to $.raised.<node path>.<event> (true, or its data) each time, so a trigger on "$.raised.screens.home.children.save.press" runs on each press; hover only when the logic names it. save-data copies the form into $.data. An on command takes "from", a path whose value it uses instead of "value". Tables (logic.tables) are lookup tables that write values: see the tables topic; compute units and effects (code the host registers, async requests with a token): see the effects topic. "was" compares the value a change replaced ($previous); "is" and "was" may list values, any of which matches. A rule of path triggers and set, merge, copy or query also runs at start for each record, unless it reads $previous, now() or today(). "debounce": ms waits for a path to be quiet; "after": ms on a machine transition with "from" fires that long after the machine entered the state. call (machines only) asks a server procedure; one the server does not know arrives as a logic.call event in ui_events_read, answered with ui_call_answer. ui_tree with logic: true lists the machines, their states and the tables; failures arrive as logic.failed events.';

const LIVE_VIEW = [
    'Every app has a live view at the url ui_preview returns. A person can open it in a browser; it follows every part write, ui_state_set and ui_command at once. ui_preview also opens a headless Chromium page of the same url, which ui_screenshot, ui_interact, ui_state_get and ui_command use.',
    'ui_state_get reads the state of the default user\'s instance of the app from the server (source "instance"), whether or not a view is open (with path, a node property nothing changed yet comes from the definition, source "definition"), and includes a preview block: whether a view is open (attached) and the runtime errors the views reported.',
    'To test behavior from a known state: ui_state_reset puts the instance back to the definition, ui_state_set with logic: false sets up values without firing rules, and ui_logic_trace shows what every machine, rule, table and guard did with each change and why one did not fire.',
    'ui_command runs a component command (a toast, a focus, a scroll) in the open views. With no view open it answers "no preview is open; the command was not delivered" and nothing happens: call ui_preview first.',
    'No chat turn carries the events a running app raises. When the user may have acted in the app, call ui_events_read with the cursor from the last call. An event named <id>.<event> is the user acting on a node with that @id, not a message to answer.'
].join('\n\n');

const FILES = 'Files a user uploads to a fileField are listed as { id, name, size, type } references in ui_state_get and in event payloads. ui_file_read reads text, CSV, Markdown and JSON files (up to 256 KiB); other types return the reference with text null.';

/** The shape vocabulary of drawings and its rules (G1.10 and G1.11 of the graphics epic 1) */
const DRAWING = [
    'Drawings: a drawing node (category graphics) holds shape nodes in its children: rect, circle, ellipse, line, polyline, polygon, path, drawText, drawImage, drawGroup (shapes in its own children) and drawRepeat (one copy of its row shape per record). A shape is accepted only inside a drawing, a drawGroup or a drawRepeat row; ui_component_get gives the properties of each.',
    '- viewBox ({ x, y, width, height }) sets the drawing units the shapes use; fit says how it fills the box.',
    '- A shape value is a literal, a theme token ("fill": "{color.accent.base}") or a link ("<-cx": "$.data.chart.x"). No expressions: a value that changes is linked to state that logic writes.',
    '- A colour that depends on a record comes from the record: in a drawRepeat row, "<-fill": "$row.fill", where a rule or table writes the record\'s fill field. $row links read the record, as in a list row.',
    '- interactive: true makes a shape pressable and focusable; give it a _label (its accessible name). Its "on" entries run on press and hover (once each time the pointer enters), like a button\'s.',
    '- drawImage draws a picture: src is a data: URL of a png, jpeg, gif or webp picture, or the reference { id, name, size, type } of such a file of the app\'s store (an SVG is refused); width and height size its box and fit (contain, cover, stretch) places the picture in it. A file that cannot be read is not drawn and is reported as SUI-RUN-FILE.',
    '- draggable ("x", "y" or "both") moves a shape that also has interactive: true (without it draggable does nothing); the drag writes the final position once, on release, through its <-x and <-y links when it has them (a drawRepeat row links "<-x": "$row.x").',
    '- Check a drawing with ui_screenshot of its path. ui_tree with rendered: true lists its interactive shapes with their paths (...rows.<recordKey> for a repeat copy), and ui_interact takes click, press, hover, focus, key and drag on those paths (drag value "+dx,+dy" moves it by page pixels, such as "+40,0").'
].join('\n');

/** The painting field (G2.11 of the graphics epic 2) */
const PAINT_FIELD = [
    'Painting: paintField (category forms) is a form field where a person paints a signature or a sketch with a pointer; it saves itself as a PNG in the app\'s file store and its value is that file\'s reference { id, name, size, type } (link it with "<-value"), and a form waits for the save before it submits.',
    'Painting needs a pointer: when the form must work without one, put a textField beside it for a typed alternative (a typed signature).'
].join('\n');

/**
 * 3D scenes (graphics epic 3, releases 3A and 3B; G3.11), a header and one bullet per subject in the order an agent
 * builds a scene, in three topics so each stays one screen: the scene, its node values and its camera; model files,
 * texture files and `repeat3d`; press and hover, `label3d`, motion and the screenshot check
 */
const SCENE3D = [
    '3D: a scene3d node (category graphics) draws a WebGL scene from the 3D nodes in its children: camera, light, mesh, model, label3d, group3d (3D nodes in its own children) and repeat3d. A 3D node is accepted only inside a scene3d or a group3d; ui_component_get gives the properties of each.',
    '- Give every scene3d a _title (the scene\'s accessible name) and a _fallback (the text shown where the scene cannot draw: no WebGL, or the renderer did not load). Chromium keeps at most 16 WebGL contexts a page: ui_validate warns past 16 scenes on one page, and the oldest show _fallback.',
    '- position, target, rotation (degrees) and scale are [x, y, z]. A mesh has a geometry ({ kind: box, sphere, cylinder, cone, plane, torus or capsule, and its sizes; or kind custom with vertices [[x, y, z], ...] and faces, each a list of 3 to 32 vertex indices counter-clockwise seen from outside, flat and convex, shading flat or smooth, at most 4,000 of each; topic scene3d-modeling shapes one }) and a material ({ color, metalness, roughness, opacity, emissive, map }); colours are literals or theme tokens.',
    '- With no camera node the scene frames what it draws; environment (studio by default, daylight, neutral, none) adds preset lights and a background to the light nodes. controls: "orbit" (turn and zoom) or "pan" lets a person move the camera with a pointer or the arrow keys; the scene writes the active camera node\'s position and target once, when the gesture is released (through their links when they have them), so a reload keeps the view. Give the scene a camera node: the default camera moves but keeps nothing.'
].join('\n');

const SCENE3D_MODELS = [
    '- model.src is the file reference { id, name, size, type } of a GLB (model/gltf-binary, binary glTF 2.0, at most 10 MiB) a person uploaded to the app\'s files, as listed by ui_state_get. Its embedded textures draw; a .gltf, a Draco, Meshopt or KTX2 compressed model or one with external files is refused (SUI-RUN-3D), a file that cannot be read is SUI-RUN-FILE, and the other nodes still draw. A set exportRequest on a scene3d (any value, such as a counter or the turn, set by logic) saves what the scene draws as <_title>.glb in the app\'s files once per new value (meshes, repeat copies and models with world positions and plain colours; no textures, lights or labels). The scene writes exported { request, file } and raises exported with { file }, or writes exported { request, error } (too_large, quota, offline).',
    '- material.map is the file reference of an uploaded png, jpeg, gif or webp image, wrapped around the mesh and tinted by its color; another type is SUI-STATE-INVALID, and a file that cannot be read is SUI-RUN-FILE with the colour drawn.',
    '- repeat3d draws its row once per record of records (a list or a keyed map), linked like a list row ("<-position": "$row.at", "<-material": "$row.paint"). The row is a mesh, or a group3d of meshes and groups (a piece of several parts; at most 16 meshes), each mesh drawn as one instanced mesh. Each node of a record has its own position, rotation, scale, visible and material.color; geometry and the rest of material are shared, so records that differ there are SUI-RUN-DRAW. At most 20,000 records (more are cut, SUI-RUN-CAP); keep them small, as an app\'s data is at most 512 KiB.'
].join('\n');

const SCENE3D_BEHAVIOR = [
    '- interactive: true on a 3D node (with a _label) makes it pressable: its "on" entries run on press (a click, not a drag that turns the camera) and hover (on entering), and on a repeat3d copy with $row at its record. ui_tree with rendered: true lists those nodes (...rows.<recordKey> for a copy) and ui_interact clicks, hovers, focuses and presses keys on their paths; drag turns the camera of a scene with controls, or moves a node with draggable ("x", "z" or "ground"; bounds, step, snap), which writes its position once on release, then dragEnd; gizmo (move, rotate, scale) adds handles writing position, rotation or scale so; a repeat3d copy writes the field "<-position": "$row.<field>" names. keys on a scene3d (arrows, Space, Enter, Escape, a-z, 0-9) makes the focused scene raise key { key } for a listed key, not move the camera; each press is written to $.raised.<scene path without $.>.key, so a rule with when { path } there reads $trigger.key. random(seed, n) gives 0 to n - 1, fixed by the seed: seed it from state (game id, turn) so all players roll alike.',
    '- label3d draws its _text (plain text, linkable) in the page font, always facing the camera, at its position; fontSize is in scene units (0.3 by default) and color defaults to the theme text colour. An empty _text draws nothing.',
    '- A node with transition ({ duration, easing } as for 2D shapes) eases position, rotation, scale, material color and opacity, a light\'s intensity and a camera\'s position and target when state changes them; with reduced motion it jumps. animate ({ name: spin, bob or pulse, duration, loop, delay }) plays on a node, and a model plays its GLB clip named by animation while playing is true; neither writes state, an unknown clip is SUI-RUN-3D naming the file\'s clips, and with reduced motion neither plays.',
    '- Check a scene with ui_screenshot of its path: it waits until the scene, its models and textures are drawn and its transitions have arrived (a playing animate or clip does not hold it back).'
].join('\n');

/** The game loop of a scene3d (docs/design/stateui-game-loop.md): play, body, velocity, contact, and trying a game */
const SCENE3D_PLAY = [
    '- A scene3d game: play { running, gravity } on the scene (gravity [0, -9.8, 0] by default). While running is true, each mesh, group3d, model or repeat3d copy with a body moves itself 60 times a second by its velocity ([x, y, z] per second, a node property beside position), the keys held on body.control ({ "ArrowLeft": [-6, 0, 0] }, scene keys only) and gravity when body.falls. body.solid makes it collide with the solids of the same parent as its box, or as a sphere for a sphere mesh scaled evenly; body.onContact is stop (default), bounce or pass. bounds ({ x, z, width, depth }) keeps it on a board. Walls and floors are solid bodies with no velocity.',
    '- State is written only when bodies meet (both position and velocity), when one comes to rest and when running turns false; never per frame. Each body that met raises contact { key, with, repeat, side }: with is the other node key, a copy record key (repeat names its repeat3d) or bounds; side is left, right, bottom, top, back or front. on.contact on the node (on the row for a copy, with $row at its record) scores, removes a record or ends the game; it is written to $.raised.<path without $.>.contact for a rule. A set of velocity or position while the game runs is taken up: a jump is set velocity [0, 6, 0] on key Space.',
    '- A copy that moves needs "<-position": "$row.<field>" (and "<-velocity" to keep its speed) so the game writes its record; without it the copy is no body (SUI-RUN-DRAW). Spawn with after, a repeating machine transition, adding a record.',
    '- Try a game with ui_interact: focus the scene, then key with value ArrowRight and hold in ms (at most 5000); the call waits for the bodies to rest and lists in moving the scenes still moving. ui_state_get reads where they stopped.'
].join('\n');

/** The mesh editor (docs/design/stateui-mesh-editor.md): custom geometry, edit mode, the operations and their limits */
const SCENE3D_MODELING = [
    '- Model a shape as a mesh with geometry kind custom: vertices [[x, y, z], ...] and faces of 3 to 32 vertex indices, counter-clockwise seen from outside, flat and convex (at most 4,000 of each; numbers keep 4 decimals). Start from a box: vertices [[-0.5,-0.5,-0.5],[0.5,-0.5,-0.5],[0.5,0.5,-0.5],[-0.5,0.5,-0.5],[-0.5,-0.5,0.5],[0.5,-0.5,0.5],[0.5,0.5,0.5],[-0.5,0.5,0.5]], faces [[0,3,2,1],[4,5,6,7],[0,1,5,4],[3,7,6,2],[0,4,7,3],[1,2,6,5]] (face 3 is the top). Write geometry with ui_nodes_write, or ui_data_write when "<-geometry" links it to a record.',
    '- A person shapes it in the page: interactive: true and edit { mode: vertex, edge or face, picked } show the vertices and edges; a press picks (Shift adds), written to edit.picked (vertex or face indices, edges [a, b]). gizmo (move, rotate, scale) then moves the pick, writing geometry once on release; Ctrl+Z and Ctrl+Shift+Z undo and redo with the scene focused. Link edit to data ("<-edit": "$.data.workshop.edit") so buttons set edit.mode.',
    '- editRequest { op, amount, n } runs one operation on the pick when it changes: extrude (faces, amount in units, 0.2 by default), inset (faces, amount 0 to 1 of the way to the centre, 0.2), delete (any mode), merge (vertices), fill (3 or more vertices, a face in pick order), flip (faces), subdivide (the whole mesh, one Catmull-Clark level), undo, redo. The scene writes geometry and edit.picked once and records the request in edit.done; it runs again only for another value, so n counts requests. on cannot count: a button sets an input path, and a rule on it increments a count and sets the request to { op: "$trigger", n: "<count path>" }. One that does not fit the mode or pick writes only edit.done and is SUI-RUN-3D; a subdivide past the limits is refused.',
    '- Save a finished model as a GLB with the exportRequest of the scene3d (topic scene3d-models). Try it with ui_interact: press the mesh to pick, press the operation buttons, then ui_state_get reads the geometry.'
].join('\n');

const SAFETY = 'ui_delete cannot be undone, and ui_rename rewrites every part that names the part it renames. Ask the user before you call them, and pass the revision you read as expectedRevision; a conflict means it changed and nothing was deleted or renamed.';

const FUNCTIONS_INTRO = 'The functions this server runs, by path. An expression calls one ({{ $.functions.host.tax($.data.total) }}), a compute or an effect names one in run, by its kind. The operator installs them: a function that is not listed is one to ask the operator for, and an app that names it gets SUI-LOGIC-FUNCTION. A function a component brings sits at $.components.<component>.functions.<name>.';

/** The names of a schema's properties, or none */
function schemaNames(schema: FunctionEntry['inputs']): string {
    const properties = (schema as { properties?: unknown }).properties;
    return properties !== null && typeof properties === 'object' ? Object.keys(properties).join(', ') : '';
}

/** One line per function: path, kind, sides, summary and the names of its inputs and outputs */
function functionLine(entry: FunctionEntry): string {
    const inputs = schemaNames(entry.inputs);
    const outputs = schemaNames(entry.outputs);
    const shape = [inputs === '' ? '' : `inputs ${inputs}`, outputs === '' ? '' : `outputs ${outputs}`].filter((part) => part !== '').join('; ');
    return `- ${entry.path} (${entry.kind}, ${entry.runs.join(' and ')}): ${entry.summary}${shape === '' ? '' : ` (${shape})`}`;
}

/** The operator's functions, as many as fit under the cap, then how many more there are */
function functionsText({ functions = [] }: GuideContext): string {
    if (functions.length === 0) return `${FUNCTIONS_INTRO}\n\nThis server runs no functions.`;
    const lines: string[] = [];
    let length = FUNCTIONS_INTRO.length + 2;
    for (const [index, entry] of functions.entries()) {
        const line = functionLine(entry);
        if (length + line.length + 40 > MAX_TOPIC_CHARS) {
            lines.push(`and ${functions.length - index} more`);
            break;
        }
        lines.push(line);
        length += line.length + 1;
    }
    return `${FUNCTIONS_INTRO}\n\n${lines.join('\n')}`;
}

/** A topic whose text depends on nothing */
function fixed(text: string): (context: GuideContext) => string {
    return () => text;
}

/**
 * The topics, in index order. The server instructions give the always-on ones in full in this order (K1.2 of the
 * guide-tool epic): the build steps with the category index and presets (start, sections) and the rules that cost a
 * failed call (keys); every other topic, the graphics ones included, is one pointer line there. ui_guide answers the
 * topic start with the whole instructions, for a client that does not show them
 */
export const GUIDE_TOPICS: readonly GuideTopic[] = Object.freeze([
    { name: 'start', when: 'you build an app, only if your client did not show you the server instructions (it repeats them in full; skip it when you have them)', text: startText, alwaysOn: true },
    { name: 'sections', when: 'you fill the sections of a screen, add logic or check an app (the later build steps, the theme presets and the component categories)', text: sectionsText, alwaysOn: true },
    { name: 'parts', when: 'you plan the parts of an app (what a part is, how apps share them, build time and run time)', text: fixed(PARTS), alwaysOn: false },
    { name: 'paths', when: 'you write a node, screen or route path, or look at a running app with ui_tree', text: fixed(PATHS), alwaysOn: false },
    { name: 'revisions', when: 'you change a part that exists', text: fixed(REVISIONS), alwaysOn: false },
    { name: 'keys', when: 'you name an icon or token, give a record key or set a value under a path', text: fixed(KEYS), alwaysOn: true },
    { name: 'modules', when: 'a logic module or the params of a screen', text: fixed(MODULES), alwaysOn: false },
    { name: 'logic', when: 'a machine or rule', text: fixed(LOGIC), alwaysOn: false },
    { name: 'saving', when: 'a save the person waits for, a change that waits for the owner, or shared state such as a pointer that is never stored', text: fixed(SAVING), alwaysOn: false },
    { name: 'similar', when: 'records found by meaning (an embed field and the similar call)', text: fixed(SIMILAR), alwaysOn: false },
    { name: 'tables', when: 'a lookup table (its inputs, outputs and rows)', text: fixed(TABLES), alwaysOn: false },
    { name: 'effects', when: 'a compute unit, an effect, a request token or paged records', text: fixed(EFFECTS), alwaysOn: false },
    { name: 'functions', when: 'a function you call from an expression or name in a compute or effect (what this server runs)', text: functionsText, alwaysOn: false },
    { name: 'live-view', when: 'you preview, test or watch a running app', text: fixed(LIVE_VIEW), alwaysOn: false },
    { name: 'files', when: 'you read a file a user uploaded', text: fixed(FILES), alwaysOn: false },
    { name: 'drawing', when: 'a drawing and its shapes', text: fixed(DRAWING), alwaysOn: false },
    { name: 'paint-field', when: 'a paintField (a painted signature or sketch)', text: fixed(PAINT_FIELD), alwaysOn: false },
    { name: 'scene3d', when: 'a scene3d, its node values and its camera', text: fixed(SCENE3D), alwaysOn: false },
    { name: 'scene3d-models', when: 'a 3D model file, a texture, a repeat3d or a GLB export', text: fixed(SCENE3D_MODELS), alwaysOn: false },
    { name: 'scene3d-behavior', when: 'a pressable 3D node, keys over a scene, a label3d, 3D motion or the check of a scene', text: fixed(SCENE3D_BEHAVIOR), alwaysOn: false },
    { name: 'scene3d-play', when: 'a real-time game in a scene3d (play, body, velocity, contact)', text: fixed(SCENE3D_PLAY), alwaysOn: false },
    { name: 'scene3d-modeling', when: 'a custom 3D shape a person or you model (vertices, faces, edit mode, extrude and the other operations)', text: fixed(SCENE3D_MODELING), alwaysOn: false },
    { name: 'safety', when: 'you delete or rename a part', text: fixed(SAFETY), alwaysOn: false }
] satisfies GuideTopic[]);

/** The topic names, in table order */
export const GUIDE_TOPIC_NAMES: readonly string[] = Object.freeze(GUIDE_TOPICS.map((topic) => topic.name));

/** One topic by name, or undefined */
export function guideTopic(name: string): GuideTopic | undefined {
    return GUIDE_TOPICS.find((topic) => topic.name === name);
}

/** The text of a topic for one server build's catalog; throws for a name that is not in the table (a programming error) */
export function guideText(name: string, context: GuideContext): string {
    const topic = guideTopic(name);
    if (topic === undefined) throw new Error(`No guide topic named "${name}"`);
    return topic.text(context);
}

/**
 * The topic that explains each tool error code `fail()` gives (K1.3 of the guide-tool epic). A code with no topic that
 * explains it (such as `invalid-argument` or `not-found`, whose message says it all) is left out, and its error body
 * gets no `guide` field
 */
export const TOOL_CODE_TOPICS: Readonly<Record<string, string>> = Object.freeze({
    'conflict': 'revisions',
    'duplicate-name': 'revisions',
    'in-use': 'revisions',
    'missing-parts': 'parts',
    'missing-path': 'paths',
    'invalid-path': 'paths',
    'unknown-path': 'paths',
    'not-a-node': 'paths',
    'invalid-target': 'paths',
    'unknown-screen': 'paths',
    'not-rendered': 'paths',
    'logic-guard': 'logic',
    'not-waiting': 'logic',
    'no-logic': 'live-view',
    'unknown-command': 'live-view',
    'browser-unavailable': 'live-view'
});

/**
 * The topic that explains each family of validation codes of the app's error catalog (`ERROR_CATALOG`): a prefix is a
 * family of `ERROR_PREFIXES` or a longer part of one, down to a single code, and the longest prefix a code starts
 * with wins. A family with no topic that explains it (such as `SUI-LAYOUT` or `SUI-ON`) is left out
 */
export const VALIDATION_PREFIX_TOPICS: Readonly<Record<string, string>> = Object.freeze({
    'SUI-LOGIC': 'logic',
    'SUI-LOGIC-FUNCTION': 'functions',
    'SUI-MODULE': 'modules',
    'SUI-USES': 'parts',
    'SUI-USES-NEEDS': 'modules',
    'SUI-ROUTE': 'paths',
    'SUI-NODE-MISSING': 'paths',
    'SUI-INSTANCE': 'live-view',
    'SUI-DOC-ORDER': 'keys',
    'SUI-STATE-TOKEN': 'keys',
    'SUI-THEME-TOKEN': 'keys',
    'SUI-RUN-ICON': 'keys',
    'SUI-DOC-ICON': 'keys',
    'SUI-DOC-EPHEMERAL': 'saving',
    'SUI-STATE-PAINT': 'drawing',
    'SUI-STATE-LABEL': 'drawing',
    'SUI-RUN-DRAW': 'drawing',
    'SUI-DOC-LIMIT-SCENES': 'scene3d',
    'SUI-RUN-3D': 'scene3d-models',
    'SUI-RUN-CAP': 'scene3d-models'
});

/** True when `code` is `prefix` or starts with `prefix` and a dash: "SUI-LOGIC" covers "SUI-LOGIC-PATH", not "SUI-LOGICAL" */
function inFamily(code: string, prefix: string): boolean {
    return code === prefix || code.startsWith(`${prefix}-`);
}

/** The topic that explains an error code: a tool code by name, a validation code by its longest mapped prefix; undefined when none does */
export function guideFor(code: string): string | undefined {
    if (Object.hasOwn(TOOL_CODE_TOPICS, code)) return TOOL_CODE_TOPICS[code];
    let best: string | undefined;
    for (const prefix of Object.keys(VALIDATION_PREFIX_TOPICS)) {
        if (inFamily(code, prefix) && (best === undefined || prefix.length > best.length)) best = prefix;
    }
    return best === undefined ? undefined : VALIDATION_PREFIX_TOPICS[best];
}
