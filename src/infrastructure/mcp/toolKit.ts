import type { JsonObject } from '../../domain/JsonValue.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonValue } from '../../domain/JsonValue.js';

/**
 * Building blocks of the ui-builder tools: one field table gives both the JSON Schema the model sees and the check
 * the server runs on the arguments (the low-level MCP server does not enforce schemas). Schemas accept JSON values
 * only: strings, whole numbers, booleans, objects, lists of objects and one JSON value. No field takes template, CSS, controller or expression text
 */

interface FieldBase {
    readonly description: string;
    readonly required?: boolean;
}

export interface StringField extends FieldBase {
    readonly type: 'string';
    readonly enum?: readonly string[];
    /** The value must be a UUID */
    readonly uuid?: boolean;
    /** A required string may be empty (the document root path is `""`) */
    readonly allowEmpty?: boolean;
}

export interface IntegerField extends FieldBase {
    readonly type: 'integer';
    readonly minimum?: number;
    readonly maximum?: number;
}

export interface BooleanField extends FieldBase {
    readonly type: 'boolean';
}

export interface ObjectField extends FieldBase {
    readonly type: 'object';
}

/** Any JSON value: a string, number, boolean, null, list or object. Checked deeply; nothing else is accepted */
export interface JsonField extends FieldBase {
    readonly type: 'json';
}

/** A list of objects with the same fields, between `minItems` and `maxItems` long */
export interface ListField<I extends FieldTable = FieldTable> extends FieldBase {
    readonly type: 'list';
    readonly items: I;
    readonly minItems?: number;
    readonly maxItems?: number;
}

export type Field = StringField | IntegerField | BooleanField | ObjectField | JsonField | ListField;
export type FieldTable = Readonly<Record<string, Field>>;

type FieldValue<F extends Field> = F extends StringField
    ? F['enum'] extends readonly (infer Member)[]
        ? Member
        : string
    : F extends IntegerField
      ? number
      : F extends BooleanField
        ? boolean
        : F extends ObjectField
          ? JsonObject
          : F extends JsonField
            ? JsonValue
            : F extends ListField<infer Items>
              ? readonly ParsedArguments<Items>[]
              : never;

type RequiredKeys<T extends FieldTable> = { [K in keyof T]: T[K]['required'] extends true ? K : never }[keyof T];

/** The arguments of a tool after `parse`: required fields are present, the others may be absent */
export type ParsedArguments<T extends FieldTable> = { readonly [K in RequiredKeys<T>]: FieldValue<T[K]> } & {
    readonly [K in Exclude<keyof T, RequiredKeys<T>>]?: FieldValue<T[K]>;
};

export interface InputSchema {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly required?: readonly string[];
    readonly additionalProperties: false;
}

export type ParseResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly argument: string; readonly message: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fieldSchema(field: Field): Readonly<Record<string, unknown>> {
    switch (field.type) {
        case 'string':
            return {
                type: 'string',
                description: field.description,
                ...(field.enum !== undefined && { enum: field.enum }),
                ...(field.uuid === true && { format: 'uuid' })
            };
        case 'integer':
            return {
                type: 'integer',
                description: field.description,
                ...(field.minimum !== undefined && { minimum: field.minimum }),
                ...(field.maximum !== undefined && { maximum: field.maximum })
            };
        case 'boolean':
            return { type: 'boolean', description: field.description };
        case 'object':
            return { type: 'object', description: field.description };
        case 'json':
            return { description: field.description };
        case 'list':
            return {
                type: 'array',
                description: field.description,
                items: tableSchema(field.items),
                ...(field.minItems !== undefined && { minItems: field.minItems }),
                ...(field.maxItems !== undefined && { maxItems: field.maxItems })
            };
    }
}

function tableSchema(fields: FieldTable): InputSchema {
    const names = Object.keys(fields);
    const required = names.filter((name) => fields[name]?.required === true);
    return {
        type: 'object',
        properties: Object.fromEntries(names.map((name) => [name, fieldSchema(fields[name] as Field)])),
        ...(required.length > 0 && { required }),
        additionalProperties: false
    };
}

const MAX_JSON_DEPTH = 512;

/** True when the value is made of JSON types only: no undefined, function, symbol, bigint, NaN, Infinity or class instance */
function isJsonValue(value: unknown, depth = 0): value is JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (depth >= MAX_JSON_DEPTH || typeof value !== 'object') return false;
    if (Array.isArray(value)) return (value as unknown[]).every((item) => isJsonValue(item, depth + 1));
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function checkField(name: string, field: Field, value: unknown): string | TableProblem | undefined {
    switch (field.type) {
        case 'string':
            if (typeof value !== 'string') return `${name} must be a string`;
            if (field.required === true && field.allowEmpty !== true && value.trim() === '') return `${name} must not be empty`;
            if (field.enum !== undefined && !field.enum.includes(value)) return `${name} must be one of: ${field.enum.join(', ')}`;
            if (field.uuid === true && !UUID_PATTERN.test(value)) return `${name} must be an application id (a UUID) from ui_app_create or ui_app_list`;
            return undefined;
        case 'integer':
            if (typeof value !== 'number' || !Number.isInteger(value)) return `${name} must be a whole number`;
            if (field.minimum !== undefined && value < field.minimum) return `${name} must be at least ${field.minimum}`;
            if (field.maximum !== undefined && value > field.maximum) return `${name} must be at most ${field.maximum}`;
            return undefined;
        case 'boolean':
            return typeof value === 'boolean' ? undefined : `${name} must be true or false`;
        case 'object':
            return isJsonObject(value) && isJsonValue(value) ? undefined : `${name} must be a JSON object`;
        case 'json':
            return isJsonValue(value) ? undefined : `${name} must be a JSON value: a string, number, boolean, null, list or object`;
        case 'list': {
            if (!Array.isArray(value)) return `${name} must be a list`;
            const items = value as unknown[];
            if (field.minItems !== undefined && items.length < field.minItems) return `${name} must have at least ${field.minItems} items`;
            if (field.maxItems !== undefined && items.length > field.maxItems) return `${name} must have at most ${field.maxItems} items`;
            for (const [index, item] of items.entries()) {
                if (!isJsonObject(item)) return { argument: `${name}[${index}]`, message: `${name}[${index}] must be a JSON object` };
                const problem = checkTable(field.items, item, `${name}[${index}].`);
                if (problem !== undefined) return problem;
            }
            return undefined;
        }
    }
}

interface TableProblem {
    readonly argument: string;
    readonly message: string;
}

function checkTable(fields: FieldTable, args: Readonly<Record<string, unknown>>, prefix: string): TableProblem | undefined {
    const names = Object.keys(fields);
    for (const key of Object.keys(args)) {
        if (!names.includes(key)) return { argument: `${prefix}${key}`, message: `${prefix}${key} is not an argument of this tool` };
    }
    for (const name of names) {
        const field = fields[name] as Field;
        const value = args[name];
        if (value === undefined) {
            if (field.required === true) return { argument: `${prefix}${name}`, message: `${prefix}${name} is required` };
            continue;
        }
        const problem = checkField(`${prefix}${name}`, field, value);
        if (typeof problem === 'string') return { argument: `${prefix}${name}`, message: problem };
        if (problem !== undefined) return problem;
    }
    return undefined;
}

/** The JSON Schema and the argument check of one tool, from one field table */
export function defineInput<const T extends FieldTable>(
    fields: T
): { readonly schema: InputSchema; readonly parse: (args: Readonly<Record<string, unknown>>) => ParseResult<ParsedArguments<T>> } {
    function parse(args: Readonly<Record<string, unknown>>): ParseResult<ParsedArguments<T>> {
        const problem = checkTable(fields, args, '');
        if (problem !== undefined) return { ok: false, ...problem };
        return { ok: true, value: args as ParsedArguments<T> };
    }

    return { schema: tableSchema(fields), parse };
}

/** An image the tool returns next to its text, as MCP image content: base64 data and a media type */
export interface ToolImage {
    readonly data: string;
    readonly mimeType: 'image/png';
}

/** What a tool run produces: a JSON body, whether it is an error, and optional images. The server turns it into MCP content */
export interface ToolOutcome {
    readonly isError: boolean;
    readonly body: object;
    readonly images?: readonly ToolImage[];
}

export function succeed(body: object, images: readonly ToolImage[] = []): ToolOutcome {
    return { isError: false, body, ...(images.length > 0 && { images }) };
}

/** An error result: `error` is a stable code, `message` says what to change, `details` carries the use case own fields */
export function fail(code: string, message: string, details: object = {}): ToolOutcome {
    return { isError: true, body: { error: code, message, ...details } };
}

export interface ToolAnnotations {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
}

/** One tool of the server */
export interface UiToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: InputSchema;
    readonly annotations: ToolAnnotations;
    readonly run: (args: Readonly<Record<string, unknown>>) => Promise<ToolOutcome> | ToolOutcome;
}

export const READ_ONLY: ToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
};

/** Changes an application or its state; repeating a call changes the revision again, so it is not idempotent */
export const WRITES: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
};

/** Changes nothing stored and gives the same answer for the same revision */
export const SHOWS: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
};

export const CREATES: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
};

/** Removes an application for good: destructive, and not repeatable (a second call finds nothing) */
export const DESTROYS: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false
};
