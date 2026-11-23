/**
 * The `files` of the runtime's `load` (docs/design/statenet-paths-route.md, "The frame's side"): the absolute URL of the
 * app's files on `/paths` (the frame's own origin cannot resolve a relative one) and the read grant the page holds.
 * Undefined when the page names no `/paths` URL (`data-paths`)
 */
export function filesSource(paths: string | undefined, grant: string | undefined, pageUrl: string): { url: string; grant?: string } | undefined {
    if (paths === undefined || paths === '') return undefined;
    const url = new URL(`${paths.replace(/\/+$/, '')}/files`, pageUrl);
    return { url: `${url.origin}${url.pathname}`, ...(grant !== undefined && grant !== '' && { grant }) };
}
