import { DATA_RESOURCE_KINDS, type DataResourceKind } from '@ctxo/plugin-api';
import type { EdgeKind } from '../types.js';

/** Edge kinds that couple code to data resources (protocol v2). */
export const DATA_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>(['reads', 'writes', 'executes']);

export function isDataResourceKind(kind: string): kind is DataResourceKind {
  return (DATA_RESOURCE_KINDS as readonly string[]).includes(kind);
}
