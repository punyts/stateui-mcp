import { assembleApp } from '@punyts/stateui-app/core';
import type { JsonValue as LibraryJsonValue } from '@punyts/stateui-app/core';
import { loadPartSource } from '../../application/partSource.js';
import type { BindingScope, InstanceShape } from '../../application/ports/InstanceStates.js';
import type { UiPartRepository } from '../../application/ports/UiPartRepository.js';
import type { InstanceKey } from '../../domain/InstanceKey.js';
import { partReferences } from '../../domain/partReferences.js';
import type { UiDocument } from '../../domain/UiApp.js';
import type { UiPart } from '../../domain/UiPart.js';

/** One data binding of an app: its scope and, for a persona binding, the model its records are of */
export interface InstanceBinding {
    readonly scope: BindingScope;
    readonly model?: string;
}

/** What a running instance starts from: its key, the assembled document and the app's data bindings */
export interface InstanceStart {
    readonly key: InstanceKey;
    readonly document: UiDocument;
    readonly bindings: Readonly<Record<string, InstanceBinding>>;
}

/** The scope of each binding, as the port gives it */
export function bindingScopes(start: InstanceStart): InstanceShape['bindings'] {
    return Object.fromEntries(Object.entries(start.bindings).map(([name, binding]) => [name, binding.scope]));
}

/**
 * Assembles an app part with every owner part it reaches (`assembleApp` of the library). Errors of the assembly are
 * not refused here: they were reported when the parts were written, and the instance runs what assembles
 */
export async function assembleInstance(parts: UiPartRepository, app: UiPart<'apps'>, key: InstanceKey): Promise<InstanceStart> {
    const source = await loadPartSource(parts, partReferences('apps', app.body));
    const { document } = assembleApp(app.body, source);
    const bindings: Record<string, InstanceBinding> = {};
    for (const [name, binding] of Object.entries(app.body.uses?.data ?? {})) {
        bindings[name] = 'dataset' in binding ? { scope: 'shared' } : { scope: 'persona', model: binding.model };
    }
    return { key, document: JSON.parse(JSON.stringify(document as unknown as LibraryJsonValue)) as UiDocument, bindings };
}
