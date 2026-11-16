import type { PartKind } from '../../domain/partName.js';
import { appWithRenamedScreen, bodyWithRenamedPart, hasScreen } from '../../domain/renameReferences.js';
import { partNameProblem } from '../../domain/UiPart.js';
import type { UiPartRepository, UiPartRewrite, UiPartRewritten } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';
import type { UsageSource } from '../UsageIndex.js';

/** A rename moves this many times at most when another write keeps changing a part it rewrites */
export const RENAME_ATTEMPTS = 3;

/** A part of the owner tree under a new name */
export interface RenamePartInput {
    readonly kind: PartKind;
    readonly name: string;
    readonly to: string;
    /** The part's revision the caller read; a part at another revision is not renamed (`conflict`) */
    readonly expectedRevision?: number;
}

/** A screen of an app under a new name: a write of the app, so it takes the app's revision */
export interface RenameScreenInput {
    readonly kind: 'screens';
    readonly app: string;
    readonly name: string;
    readonly to: string;
    readonly expectedRevision: number;
}

export type RenamePartResult =
    | {
          readonly kind: 'renamed';
          /** The renamed part's revision; for a screen, the app's */
          readonly revision: number;
          /** The parts that named it, written with their new bodies */
          readonly rewritten: readonly UiPartRewritten[];
      }
    | { readonly kind: 'invalid'; readonly reason: string }
    | { readonly kind: 'duplicate-name' }
    | { readonly kind: 'not-found' }
    /** A screen rename with a stale app revision, or a part that kept changing while the rename read it */
    | { readonly kind: 'conflict'; readonly currentRevision: number };

/**
 * Renames a part and rewrites every part that names it, all together (the repository writes them through a journal):
 * theme lists, bindings' datasets and models, `uses.logic` keys, `needs` models, datasets' models and the composed
 * names in nodes. The part keeps its id, so instances and persona data, which are keyed by id, stay where they are.
 * Renaming a screen is a write of its app with its revision: the key in `screens`, `start` and every `navigate` to it
 */
export class RenamePart {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly usage: UsageSource,
        private readonly report: UseCaseReport
    ) {}

    async execute(input: RenamePartInput | RenameScreenInput): Promise<RenamePartResult> {
        const problem = partNameProblem(input.to);
        const result: RenamePartResult =
            problem !== undefined ? { kind: 'invalid', reason: problem } : input.kind === 'screens' ? await this.renameScreen(input) : await this.renamePart(input);
        this.report.info('Part rename', {
            kind: input.kind,
            outcome: result.kind,
            ...(result.kind === 'renamed' && { revision: result.revision, rewritten: result.rewritten.length })
        });
        return result;
    }

    private async renamePart(input: RenamePartInput): Promise<RenamePartResult> {
        const { kind, name, to } = input;
        let result: RenamePartResult = { kind: 'not-found' };
        for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt++) {
            const part = await this.parts.findByName(kind, name);
            if (part === undefined) return { kind: 'not-found' };
            if (input.expectedRevision !== undefined && part.revision !== input.expectedRevision) return { kind: 'conflict', currentRevision: part.revision };
            if ((await this.parts.findByName(kind, to)) !== undefined) return { kind: 'duplicate-name' };
            const rewrites = await this.rewrites(kind, name, to);
            const renamed = await this.parts.rename(kind, name, to, rewrites);
            if (renamed.kind !== 'conflict') return renamed;
            result = { kind: 'conflict', currentRevision: renamed.currentRevision };
        }
        return result;
    }

    /** The new body of each part that names `kind`/`name`, the part itself included when it names itself */
    private async rewrites(kind: PartKind, name: string, to: string): Promise<UiPartRewrite[]> {
        const index = await this.usage.usage();
        const users = [{ kind, name }, ...index.usedBy(kind, name).filter((user) => user.kind !== kind || user.name !== name)];
        const rewrites: UiPartRewrite[] = [];
        for (const user of users) {
            const part = await this.parts.findByName(user.kind, user.name);
            if (part === undefined) continue;
            const body = bodyWithRenamedPart(user.kind, part.body, kind, name, to);
            if (body !== undefined) rewrites.push({ kind: user.kind, name: user.name, body, expectedRevision: part.revision });
        }
        return rewrites;
    }

    private async renameScreen(input: RenameScreenInput): Promise<RenamePartResult> {
        const app = await this.parts.findByName('apps', input.app);
        if (app === undefined || !hasScreen(app.body, input.name)) return { kind: 'not-found' };
        if (hasScreen(app.body, input.to)) return { kind: 'duplicate-name' };
        const body = appWithRenamedScreen(app.body, input.name, input.to);
        if (body === undefined) return { kind: 'not-found' };
        const written = await this.parts.write('apps', input.app, body, input.expectedRevision);
        if (written.kind === 'written') return { kind: 'renamed', revision: written.revision, rewritten: [] };
        return written;
    }
}
