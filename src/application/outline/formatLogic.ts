import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';

/** Longest expression or value text shown on a line, in characters */
const MAX_TEXT_CHARS = 60;

function shorten(text: string): string {
    const single = text.replace(/\s+/g, ' ').trim();
    return single.length > MAX_TEXT_CHARS ? `${single.slice(0, MAX_TEXT_CHARS - 1)}…` : single;
}

function show(value: JsonValue | undefined): string {
    return shorten(typeof value === 'string' ? value : JSON.stringify(value));
}

function trigger(when: JsonValue | undefined): string {
    if (!isJsonObject(when)) return 'when ?';
    const parts: string[] = [];
    if (typeof when['path'] === 'string') parts.push(`when ${when['path']}`);
    if (typeof when['result'] === 'string') parts.push(`when result ${when['result']}`);
    if (typeof when['after'] === 'number') parts.push(`after ${when['after']} ms`);
    if (Object.hasOwn(when, 'was')) parts.push(`was ${show(when['was'])}`);
    if (Object.hasOwn(when, 'is')) parts.push(`is ${show(when['is'])}`);
    if (typeof when['if'] === 'string') parts.push(`if ${show(when['if'])}`);
    if (typeof when['debounce'] === 'number') parts.push(`debounce ${when['debounce']} ms`);
    return parts.length === 0 ? 'when ?' : parts.join(' ');
}

/** The commands as `name`, with the notify, emit or call target, the `as` name and a reject reason */
function commands(list: JsonValue | undefined): string {
    if (!Array.isArray(list) || list.length === 0) return '';
    const names = (list as readonly JsonValue[]).map((item) => {
        if (!isJsonObject(item) || typeof item['command'] !== 'string') return '?';
        const name = item['command'];
        const parts = [name];
        if ((name === 'notify' || name === 'emit' || name === 'call') && typeof item['target'] === 'string') parts.push(item['target']);
        if (typeof item['as'] === 'string') parts.push(`as ${item['as']}`);
        if (name === 'reject' && typeof item['reason'] === 'string') parts.push(`"${shorten(item['reason'])}"`);
        return parts.join(' ');
    });
    return `: ${names.join(', ')}`;
}

/** A rule whose only command is `reject` refuses changes instead of reacting to them */
function isGuard(rule: JsonObject): boolean {
    const list = rule['do'];
    return Array.isArray(list) && list.length === 1 && isJsonObject(list[0]) && list[0]['command'] === 'reject';
}

/**
 * The lines of a document's `logic`: each machine with its current state (from `stateAt`, else its initial state)
 * and one line per transition, each rule and guard with its trigger and commands, then each table with its trigger
 * and one line per row. Empty when there is no logic
 */
export function formatLogic(logic: JsonValue | undefined, stateAt: (path: string) => JsonValue | undefined): string[] {
    if (!isJsonObject(logic)) return [];
    const lines: string[] = [];
    const machines = isJsonObject(logic['machines']) ? logic['machines'] : {};
    for (const [name, machine] of Object.entries(machines)) {
        if (!isJsonObject(machine)) continue;
        const path = typeof machine['state'] === 'string' ? machine['state'] : undefined;
        const current = path === undefined ? undefined : stateAt(path);
        const state = typeof current === 'string' ? current : machine['initial'];
        lines.push(`  machine ${name}: ${typeof state === 'string' ? state : '?'}${path === undefined ? '' : ` (at ${path})`}`);
        const transitions = Array.isArray(machine['transitions']) ? (machine['transitions'] as readonly JsonValue[]) : [];
        for (const transition of transitions) {
            if (!isJsonObject(transition)) continue;
            const from = typeof transition['from'] === 'string' ? transition['from'] : '*';
            const to = typeof transition['to'] === 'string' ? transition['to'] : from;
            lines.push(`    ${from} → ${to} ${trigger(transition['when'])}${commands(transition['do'])}`);
        }
    }
    const rules = isJsonObject(logic['rules']) ? logic['rules'] : {};
    for (const [name, rule] of Object.entries(rules)) {
        if (!isJsonObject(rule)) continue;
        lines.push(`  ${isGuard(rule) ? 'guard' : 'rule'} ${name} ${trigger(rule['when'])}${commands(rule['do'])}`);
    }
    const tables = isJsonObject(logic['tables']) ? logic['tables'] : {};
    for (const [name, table] of Object.entries(tables)) {
        if (!isJsonObject(table)) continue;
        const inputs = isJsonObject(table['inputs']) ? Object.keys(table['inputs']) : [];
        lines.push(`  table ${name} ${trigger(table['when'])}${inputs.length === 0 ? '' : ` inputs ${inputs.join(', ')}`}`);
        const rows = Array.isArray(table['rows']) ? (table['rows'] as readonly JsonValue[]) : [];
        for (const row of rows) {
            if (!isJsonObject(row)) continue;
            const parts: string[] = [];
            if (isJsonObject(row['match'])) parts.push(...Object.entries(row['match']).map(([input, value]) => `${input} = ${show(value)}`));
            if (typeof row['if'] === 'string') parts.push(`if ${show(row['if'])}`);
            lines.push(`    ${parts.length === 0 ? 'otherwise' : parts.join(', ')}${commands(row['do'])}`);
        }
    }
    return lines.length === 0 ? [] : ['logic', ...lines];
}
