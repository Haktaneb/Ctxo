import { extractSqlAccesses, type SqlTextKind } from '@ctxo/sql-extract';
import type { GraphEdge } from '@ctxo/plugin-api';

/** One SQL call site: the enclosing symbol, the 0-based line, the constant text and how to read it. */
export interface SqlCallSite {
  readonly symbolId: string;
  readonly line: number;
  readonly text: string;
  readonly kind: SqlTextKind;
}

/** Call-site texts longer than this (1 MiB in UTF-16 units) are skipped, like oversized `.sql` files. */
export const MAX_SQL_TEXT_LENGTH = 1_048_576;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Data edges of SQL call sites (the shared contract of PR 1C, duplicated in each plugin by design): each text
 * goes through `extractSqlAccesses(text, kind)`; reads and writes point at `<name>::table`, executes at
 * `<name>::procedure`. Unique by source, kind and target, sorted in codepoint order by the same keys.
 */
export function sqlEdgesFromCallSites(sites: readonly SqlCallSite[]): GraphEdge[] {
  const edges = new Map<string, GraphEdge>();
  for (const site of sites) {
    if (site.text.length > MAX_SQL_TEXT_LENGTH) continue;
    for (const access of extractSqlAccesses(site.text, site.kind)) {
      const to = `${access.name}::${access.kind === 'executes' ? 'procedure' : 'table'}`;
      const key = `${site.symbolId}\u0000${access.kind}\u0000${to}`;
      if (!edges.has(key)) edges.set(key, { from: site.symbolId, to, kind: access.kind });
    }
  }
  return [...edges.values()].sort((a, b) => cmp(a.from, b.from) || cmp(a.kind, b.kind) || cmp(a.to, b.to));
}
