/** `"error"` is the default when `severity` is absent; a `"warning"` never makes a document invalid */
export type UiBuildErrorSeverity = 'error' | 'warning';

/**
 * One problem found in a document. A plain, serialisable mirror of the `BuildError` of `@punyts/stateui-app`
 * (`core/errors/types.ts`), so the domain does not import the library. Messages carry paths and names only,
 * never content or data values
 */
export interface UiBuildError {
    code: string;
    message: string;
    severity?: UiBuildErrorSeverity;
    statePath?: string;
    component?: string;
    file?: string;
    line?: number;
    column?: number;
}

/** True unless the error is a warning: an absent `severity` means `"error"` */
export function isBlockingError(error: UiBuildError): boolean {
    return error.severity !== 'warning';
}

/** True when no error blocks a commit; warnings are allowed through */
export function isValid(errors: readonly UiBuildError[]): boolean {
    return !errors.some(isBlockingError);
}
