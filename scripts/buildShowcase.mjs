// Builds the component showcase: the parts of the app `component-showcase` that the server installs on a new data
// directory. It reads the component catalog of @punyts/stateui-components and the hand-written examples under
// showcase/examples, and writes showcase/parts in the layout of a data directory (see PartFolders). Ids and timestamps
// are fixed, so the same catalog and examples always give the same files. Run it with `npm run showcase:build` after
// a component is added to the library or an example changes; a test checks that the committed parts are up to date.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The name of the showcase app */
export const SHOWCASE_APP = 'component-showcase';

/** The folders of the example sources and of the files the app ships, and the output */
export const EXAMPLES_DIR = join(root, 'showcase', 'examples');
export const FILES_DIR = join(root, 'showcase', 'files');
export const PARTS_DIR = join(root, 'showcase', 'parts');

/**
 * Catalog components the showcase leaves out, each with the reason. Every other component has a card on the screen
 * of its category; the build fails when one has none
 */
export const EXCLUDED = Object.freeze({ app: 'the root of an app, which places its screens; the showcase itself runs in one' });

/** The categories in the order of the category index (COMPONENT_CATEGORIES of @punyts/stateui-app) */
export const CATEGORY_ORDER = Object.freeze(['layout', 'navigation', 'forms', 'data', 'feedback', 'overlays', 'content', 'conversation', 'graphics']);

/** The theme presets the header switches between; the first is the default */
const PRESET_ORDER = Object.freeze(['clean', 'professional', 'playful', 'moody']);

/** The time every part and file was made, so a rebuild writes the same bytes */
const BUILT_AT = '2026-11-06T00:00:00.000Z';

/** The badge of a card by the tier of its component; a root component has none */
const TIER_BADGES = Object.freeze({ composed: 'Composed', shape: 'Shape' });

/** The 3D nodes of the graphics category, whose badge says so */
const NODES_3D = Object.freeze(['camera', 'group3d', 'label3d', 'light', 'mesh', 'model', 'repeat3d']);

/** The catalog of @punyts/stateui-components */
export function loadCatalog() {
    return createRequire(import.meta.url)('@punyts/stateui-components/catalog.json');
}

/** A stable UUID (version 5 layout) for a name, so ids do not move when parts are added */
export function stableId(name) {
    const hash = createHash('sha1').update(`stateui-mcp-showcase:${name}`).digest();
    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = hash.subarray(0, 16).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        let c = (crc ^ byte) & 0xff;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

/** A small landscape picture as a PNG data URL: a dusk sky over two rolling hills, drawn pixel by pixel */
function landscapeDataUrl() {
    const width = 160;
    const height = 90;
    const rows = [];
    for (let y = 0; y < height; y += 1) {
        const row = Buffer.alloc(1 + width * 3);
        for (let x = 0; x < width; x += 1) {
            const t = y / height;
            let pixel = [Math.round(70 + 170 * t), Math.round(90 + 80 * t), Math.round(170 - 40 * t)];
            const sun = (x - 112) ** 2 + (y - 40) ** 2;
            if (sun < 110) pixel = [255, 214, 120];
            const far = 58 + 8 * Math.sin(x / 17);
            const near = 70 + 7 * Math.sin(x / 11 + 2);
            if (y > far) pixel = [64, 120, 92];
            if (y > near) pixel = [40, 92, 64];
            row.set(pixel, 1 + x * 3);
        }
        rows.push(row);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
    return `data:image/png;base64,${png.toString('base64')}`;
}

/** A part file as the data directory holds it */
function partFile(kind, name, body) {
    return { id: stableId(`${kind}/${name}`), kind, name, revision: 1, createdAt: BUILT_AT, updatedAt: BUILT_AT, body };
}

function json(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

/** Title case of a category name: "conversation" is "Conversation" */
function titleOf(category) {
    return category.charAt(0).toUpperCase() + category.slice(1);
}

/**
 * Replaces the markers of the example sources in every string of a value: `$card` (alone or before a dot) is the path of
 * the component's card, `@file:<name>` the reference of a shipped file and `@image:landscape` the picture
 */
function expand(value, markers) {
    if (typeof value === 'string') {
        if (value === '$card' || value.startsWith('$card.')) return value.replace('$card', () => markers.card);
        if (value.startsWith('@file:')) {
            const file = markers.files.get(value.slice('@file:'.length));
            if (file === undefined) throw new Error(`No shipped file ${value}`);
            return { ...file.reference };
        }
        if (value === '@image:landscape') return markers.image;
        return value;
    }
    if (Array.isArray(value)) return value.map((item) => expand(item, markers));
    if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, markers)]));
    return value;
}

/** The files of showcase/files with their file-store reference, by file name */
function shippedFiles(appId, filesDir) {
    const types = { '.glb': 'model/gltf-binary' };
    const files = new Map();
    for (const name of readdirSync(filesDir).sort()) {
        const type = types[name.slice(name.lastIndexOf('.'))];
        if (type === undefined) throw new Error(`showcase/files/${name}: no file type for this extension`);
        const bytes = readFileSync(join(filesDir, name));
        const id = stableId(`file/${name}`);
        files.set(name, {
            bytes,
            reference: { id, name, size: bytes.length, type },
            entry: { id, name, size: bytes.length, type, sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: BUILT_AT }
        });
    }
    return { appId, files };
}

/** The card of one component: its name, its catalog summary, a badge for a composed component or a shape, and the example */
function cardOf(component, example, path, markers) {
    const badge = NODES_3D.includes(component.name) ? '3D node' : TIER_BADGES[component.tier];
    const expanded = expand(example, { ...markers, card: path });
    const children = expanded.children ?? { example: expanded.example };
    if (expanded.children === undefined && expanded.example === undefined) throw new Error(`The example of ${component.name} has no example and no children`);
    return {
        component: 'card',
        _title: component.name,
        _subtitle: component.summary,
        ...(badge !== undefined && { actions: { component: 'badge', size: 'sm', tone: component.tier === 'composed' ? 'accent' : 'info', _text: badge } }),
        ...(expanded.wide === true && { placement: { span: 2 } }),
        children
    };
}

/** The screen of one category: a grid of cards, one per component, in the order of the examples file */
function categoryScreen(category, source, components, markers) {
    const names = components.map((component) => component.name);
    const unknown = Object.keys(source.components).filter((name) => !names.includes(name));
    if (unknown.length > 0) throw new Error(`showcase/examples/${category}.json: ${unknown.join(', ')} are not ${category} components of the catalog`);
    const missing = names.filter((name) => !Object.hasOwn(source.components, name) && !Object.hasOwn(EXCLUDED, name));
    if (missing.length > 0) throw new Error(`showcase/examples/${category}.json has no example of ${missing.join(', ')}; add one or list it in EXCLUDED with the reason`);
    const cards = {};
    for (const [name, example] of Object.entries(source.components)) {
        const component = components.find((candidate) => candidate.name === name);
        cards[name] = cardOf(component, example, `$.screens.${category}.children.content.children.${name}`, markers);
    }
    return {
        title: source.title,
        root: framed({
            component: 'panel',
            _title: source.title,
            _description: `${source.description} ${components.length} components.`,
            layout: { type: 'grid', cols: 2, collapseBelow: 'md' },
            children: cards
        })
    };
}

/** The home screen: what the showcase is, a card per category with its count and a link, and a chart of the counts */
function homeScreen(sources, counts, total) {
    const categories = {};
    for (const category of CATEGORY_ORDER) {
        categories[category] = {
            component: 'card',
            _title: sources[category].title,
            _subtitle: sources[category].description,
            children: {
                count: { component: 'stat', _label: 'Components', value: counts[category] },
                open: { component: 'link', _text: `Open ${sources[category].title.toLowerCase()}`, screen: category }
            }
        };
    }
    return {
        title: 'Home',
        root: framed({
            component: 'panel',
            _title: 'Component showcase',
            children: {
                intro: {
                    component: 'markdown',
                    _text: [
                        `Every component of the StateUI library, **${total}** in all, each with a live example. Pick a category in the menu, or one of the cards below.`,
                        '',
                        'This showcase is an ordinary app of parts: open it with `ui_get` to see how each example is built, or copy a node into your own app. Switch the theme in the header to see every component in another preset.'
                    ].join('\n')
                },
                categories: { component: 'panel', padding: 'none', layout: { type: 'grid', cols: 3, collapseBelow: 'md' }, children: categories },
                glance: {
                    component: 'card',
                    _title: 'The catalog at a glance',
                    _subtitle: 'Components per category',
                    children: {
                        chart: { component: 'chart', type: 'donut', _title: 'Components per category', x: 'label', series: { count: { field: 'count', _label: 'Components' } }, '<-records': '$.data.categories' }
                    }
                }
            }
        })
    };
}

/** The names of the composed parts every screen places: the header and the menu */
const HEADER = 'showcaseHeader';
const MENU = 'showcaseMenu';

/**
 * A screen root: the shared header on top, the menu down the side (a menu button on a phone) and the content of the
 * screen in the middle
 */
function framed(content) {
    return {
        component: 'panel',
        padding: 'none',
        layout: { type: 'region', collapseBelow: 'md' },
        children: {
            header: { component: HEADER, placement: { region: 'n' } },
            menu: { component: MENU, placement: { region: 'w' } },
            content: { ...content, placement: { region: 'center' } }
        }
    };
}

/**
 * The header each screen places: the title and the theme switch. The pickers show and save `$.data.preferences.current`
 * through their link, and set the active theme on change, so the header of every screen shows the same choice
 */
function headerPart() {
    const presets = {};
    for (const preset of PRESET_ORDER) presets[`showcase-${preset}`] = { _label: titleOf(preset) };
    const picker = (kind) => [
        { command: 'set', target: `$.theme.active.${kind}`, from: '.value' }
    ];
    return {
        summary: 'The header of the showcase: its title and the switches of the theme preset and of light or dark',
        category: 'layout',
        purposes: ['header of every showcase screen', 'switch the theme preset and the mode'],
        tree: {
            component: 'toolbar',
            align: 'between',
            children: {
                title: { component: 'text', textRole: 'title', _text: 'Component showcase' },
                actions: {
                    component: 'toolbar',
                    align: 'end',
                    children: {
                        theme: {
                            component: 'segmented',
                            size: 'sm',
                            _label: 'Theme preset',
                            options: presets,
                            '<-value': '$.data.preferences.current.theme',
                            on: { change: picker('theme') }
                        },
                        mode: {
                            component: 'segmented',
                            size: 'sm',
                            iconOnly: true,
                            _label: 'Light or dark',
                            options: { light: { _label: 'Light', icon: 'sun' }, dark: { _label: 'Dark', icon: 'moon' } },
                            '<-value': '$.data.preferences.current.mode',
                            on: { change: picker('mode') }
                        }
                    }
                }
            }
        },
        exposes: [{ path: 'children.title._text', description: 'The title at the start of the header' }]
    };
}

/** The menu each screen places: an item per screen, and the component count below the items */
function menuPart(sources, total) {
    const items = { home: { component: 'menuItem', icon: 'home', _label: 'Home', screen: 'home' } };
    for (const category of CATEGORY_ORDER) items[category] = { component: 'menuItem', icon: sources[category].icon, _label: sources[category].title, screen: category };
    return {
        summary: 'The menu of the showcase: a screen per category; a menu button on a phone',
        category: 'navigation',
        purposes: ['menu of every showcase screen', 'move between the component categories'],
        tree: {
            component: 'nav',
            collapseBelow: 'md',
            _label: 'Showcase sections',
            children: items,
            footer: { component: 'text', textRole: 'caption', _text: `${total} components of @punyts/stateui-components` }
        },
        exposes: [{ path: 'children', description: 'The menu items, one per screen' }]
    };
}

/** The app node: the screens in a column, the document title and the toasts the examples show */
function appNode() {
    return {
        component: 'app',
        _title: 'Component showcase',
        layout: { type: 'column' },
        toasts: {
            component: 'toastRegion',
            position: 'bottomEnd',
            duration: 5000,
            messages: {
                saved: { tone: 'success', _title: 'Saved', _text: 'Your changes were saved.' },
                deleted: { tone: 'danger', _title: 'Deleted', _text: 'The record was deleted.' },
                sent: { tone: 'info', _title: 'Sent', _text: 'The form was sent.' }
            }
        }
    };
}

/**
 * Builds every file of showcase/parts from the catalog and the examples: a map from the path under showcase/parts
 * (forward slashes) to its content, a string for JSON and a Buffer for a shipped file
 */
export function buildShowcase(catalog = loadCatalog(), examplesDir = EXAMPLES_DIR, filesDir = FILES_DIR) {
    const output = new Map();
    const appId = stableId(`apps/${SHOWCASE_APP}`);
    const shipped = shippedFiles(appId, filesDir);
    const markers = { files: shipped.files, image: landscapeDataUrl() };

    const sources = {};
    for (const category of CATEGORY_ORDER) sources[category] = readJson(join(examplesDir, `${category}.json`));
    const extra = readdirSync(examplesDir).filter((name) => name.endsWith('.json') && name !== 'datasets.json' && !CATEGORY_ORDER.includes(name.slice(0, -'.json'.length)));
    if (extra.length > 0) throw new Error(`showcase/examples has files of no category: ${extra.join(', ')}`);

    const byCategory = {};
    for (const component of catalog.components) {
        if (!CATEGORY_ORDER.includes(component.category)) throw new Error(`The component ${component.name} has the category ${component.category}, which the showcase does not know`);
        (byCategory[component.category] ??= []).push(component);
    }
    const counts = Object.fromEntries(CATEGORY_ORDER.map((category) => [category, (byCategory[category] ?? []).length]));
    const total = catalog.components.length;

    // Themes: one per preset of the library, so the header switches between them
    const themes = [];
    for (const name of PRESET_ORDER) {
        const preset = catalog.themePresets.find((candidate) => candidate.name === name);
        if (preset === undefined) throw new Error(`The catalog has no theme preset ${name}`);
        const { name: _name, summary: _summary, ...body } = structuredClone(preset);
        const part = partFile('themes', `showcase-${name}`, body);
        output.set(`themes/${part.id}.json`, json(part));
        themes.push(part.name);
    }

    // Models and datasets of the examples, and the counts the home screen charts
    const data = readJson(join(examplesDir, 'datasets.json'));
    const models = { ...data.models, preference: { fields: { id: { type: 'string', required: true }, theme: { type: 'string', default: `showcase-${PRESET_ORDER[0]}` }, mode: { type: 'string', default: 'light' } } }, share: { fields: { id: { type: 'string', required: true }, label: { type: 'string', required: true }, count: { type: 'integer', default: 0 } } } };
    for (const [name, body] of Object.entries(models)) {
        const part = partFile('models', `showcase-${name}`, body);
        output.set(`models/${part.id}.json`, json(part));
    }
    const shares = {};
    for (const category of CATEGORY_ORDER) shares[category] = { id: category, label: sources[category].title, count: counts[category] };
    const datasets = {
        ...data.datasets,
        categories: { model: 'share', records: shares },
        preferences: { model: 'preference', records: { current: { id: 'current', theme: `showcase-${PRESET_ORDER[0]}`, mode: 'light' } } }
    };
    const bindings = {};
    for (const [name, dataset] of Object.entries(datasets)) {
        const part = partFile('data', `showcase-${name}`, { model: `showcase-${dataset.model}`, records: dataset.records });
        output.set(`data/${part.id}.json`, json(part));
        bindings[name] = { dataset: part.name };
    }

    // The header and the menu every screen places
    for (const [name, body] of [[HEADER, headerPart()], [MENU, menuPart(sources, total)]]) {
        const part = partFile('components', name, body);
        output.set(`components/${part.id}.json`, json(part));
    }

    // The app: the home screen and a screen per category
    const screens = { home: homeScreen(sources, counts, total) };
    for (const category of CATEGORY_ORDER) screens[category] = categoryScreen(category, sources[category], byCategory[category] ?? [], markers);
    const app = partFile('apps', SHOWCASE_APP, {
        title: 'Component showcase',
        start: 'home',
        app: appNode(),
        screens,
        uses: { themes, data: bindings }
    });
    if (app.id !== appId) throw new Error('The app id is not the one its files are stored under');
    output.set(`apps/${app.id}.json`, json(app));

    // The files the examples use, in the app's side folder
    if (shipped.files.size > 0) {
        output.set(`${appId}/files.json`, json([...shipped.files.values()].map((file) => file.entry)));
        for (const file of shipped.files.values()) output.set(`${appId}/files/${file.entry.id}`, file.bytes);
    }
    return output;
}

/** Writes the built files to `dir`, removing what was there */
export function writeShowcase(files, dir = PARTS_DIR) {
    rmSync(dir, { recursive: true, force: true });
    for (const [path, content] of files) {
        const target = join(dir, ...path.split('/'));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
    }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const files = buildShowcase();
    writeShowcase(files);
    process.stdout.write(`Wrote ${files.size} files to showcase/parts\n`);
}
