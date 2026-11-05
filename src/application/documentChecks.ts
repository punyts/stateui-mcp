import type { UiBuildError } from '../domain/UiBuildError.js';

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
