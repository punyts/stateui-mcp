import { orderedMapKeyErrors } from '../domain/orderedMap.js';
import type { UiDocument } from '../domain/UiApp.js';
import { isBlockingError } from '../domain/UiBuildError.js';
import type { UiBuildError } from '../domain/UiBuildError.js';
import type { UiAppValidator } from './ports/UiAppValidator.js';

/** Keeps the first error of each code and state path, so the library and the ordered-map rule do not say it twice */
export function withoutRepeats(errors: readonly UiBuildError[]): UiBuildError[] {
    const seen = new Set<string>();
    return errors.filter((error) => {
        const key = `${error.code}|${error.statePath ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Every error and warning of a document: the ordered-map rule first, then the validator, each reported once */
export function checkDocument(document: UiDocument, validator: UiAppValidator): UiBuildError[] {
    return withoutRepeats([...orderedMapKeyErrors(document), ...validator.validate(document)]);
}

export function blockingErrors(errors: readonly UiBuildError[]): UiBuildError[] {
    return errors.filter(isBlockingError);
}

export function warningsOf(errors: readonly UiBuildError[]): UiBuildError[] {
    return errors.filter((error) => !isBlockingError(error));
}
