/**
 * Part names are slugs (`^[a-z][a-z0-9-]{0,62}$`, never integer-like). The rule lives in `@punyts/stateui-app/core`, so
 * the server, the converter and AI Minion check names the same way
 */
export { PART_KINDS, isPartName, slugifyName } from '@punyts/stateui-app/core';
export type { PartKind } from '@punyts/stateui-app/core';
