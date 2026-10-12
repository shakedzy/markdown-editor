import { caseInsensitiveFs, pathKey as keyOf } from '../shared/paths';

const CASE_INSENSITIVE = caseInsensitiveFs(window.api.platform);

/**
 * Identity of a path on this computer, so a document opened under a
 * differently cased or normalized path still matches (see shared/paths).
 */
export function pathKey(path: string): string {
  return keyOf(path, CASE_INSENSITIVE);
}
