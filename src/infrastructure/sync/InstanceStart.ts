import { assembleApp } from '@punyts/stateui-app/core';
import type { JsonValue as LibraryJsonValue } from '@punyts/stateui-app/core';
import { loadPartSource } from '../../application/partSource.js';
import type { BindingScope, InstanceShape } from '../../application/ports/InstanceStates.js';
import type { UiPartRepository } from '../../application/ports/UiPartRepository.js';
import { ownerOfTestPerson } from '../../domain/InstanceKey.js';
import type { InstanceKey } from '../../domain/InstanceKey.js';
import { partReferences } from '../../domain/partReferences.js';
import type { UiDocument } from '../../domain/UiApp.js';
import type { UiPart } from '../../domain/UiPart.js';

/**
 * One data binding of an app: its scope and, for a person binding, the model its records are of, or, for a shared
 * binding, the dataset part it shows. A test run's copy of a dataset is a person binding that names both
 */
export interface InstanceBinding {
    readonly scope: BindingScope;
    readonly model?: string;
    readonly dataset?: string;
}

/** What a running instance starts from: its key, the assembled document and the app's data bindings */
export interface InstanceStart {
    readonly key: InstanceKey;
    readonly document: UiDocument;
    readonly bindings: Readonly<Record<string, InstanceBinding>>;
}

/**
 * The start as JSON text without the records of its shared bindings and a test run's copies, which the dataset hub
 * keeps in step while the instance runs: two starts with the same text run the same definition
 */
export function definitionText(start: InstanceStart): string {
    const data = start.document['data'];
    const shared = Object.keys(start.bindings).filter((name) => start.bindings[name]?.dataset !== undefined);
    const kept = data !== null && typeof data === 'object' && !Array.isArray(data) ? Object.fromEntries(Object.entries(data).filter(([name]) => !shared.includes(name))) : data;
    return JSON.stringify([{ ...start.document, data: kept }, start.bindings]);
}

/** The scope of each binding, as the port gives it */
export function bindingScopes(start: InstanceStart): InstanceShape['bindings'] {
    return Object.fromEntries(Object.entries(start.bindings).map(([name, binding]) => [name, binding.scope]));
}

/**
 * Assembles an app part with every owner part it reaches (`assembleApp` of the library). Errors of the assembly are
 * not refused here: they were reported when the parts were written, and the instance runs what assembles. In a test
 * run (`testPersonOf`, docs/design/stateui-test-runs.md) a shared binding is a person binding of its dataset's model:
 * its records start as the dataset's (which the document holds), its writes stay in the instance (checked against the model by the dataset hub), and a reset drops them
 */
export async function assembleInstance(parts: UiPartRepository, app: UiPart<'apps'>, key: InstanceKey): Promise<InstanceStart> {
    const source = await loadPartSource(parts, partReferences('apps', app.body));
    const { document } = assembleApp(app.body, source);
    const bindings: Record<string, InstanceBinding> = {};
    const test = ownerOfTestPerson(key.person) !== undefined;
    for (const [name, binding] of Object.entries(app.body.uses?.data ?? {})) {
        if (!('dataset' in binding)) bindings[name] = { scope: 'person', model: binding.model };
        else if (!test) bindings[name] = { scope: 'shared', dataset: binding.dataset };
        else {
            const model = (await parts.findByName('data', binding.dataset))?.body.model;
            bindings[name] = typeof model === 'string' ? { scope: 'person', model, dataset: binding.dataset } : { scope: 'shared', dataset: binding.dataset };
        }
    }
    return { key, document: JSON.parse(JSON.stringify(document as unknown as LibraryJsonValue)) as UiDocument, bindings };
}
