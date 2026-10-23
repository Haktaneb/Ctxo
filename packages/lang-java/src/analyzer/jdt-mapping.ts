import type { GraphEdge, SymbolAnnotation, SymbolKind, SymbolNode } from '@ctxo/plugin-api';
import { sqlEdgesFromCallSites } from '../sql-edges.js';
import type { JdtAnnotation, JdtFileResult, JdtSymbol } from './jdt-process.js';

const FULL_SYMBOL_ID = /^.+::.+::.+$/;

/**
 * The graph edges of one analyzer file result, shared by the batch and keep-alive paths: the analyzer's
 * own edges (full three-part source ids, non-empty target), then the SQL data edges of the call-site
 * records when `sqlCallSites` is on. Data edges bypass the three-part filter: their targets are
 * `<name>::table` and `<name>::procedure`.
 */
export function toGraphEdges(file: JdtFileResult, options: { readonly sqlCallSites: boolean }): GraphEdge[] {
  const edges = file.edges
    .filter((e) => FULL_SYMBOL_ID.test(e.from) && e.to.length > 0)
    .map((e) => ({ from: e.from, to: e.to, kind: e.kind as GraphEdge['kind'] }));
  if (!options.sqlCallSites || !file.sqlCallSites?.length) return edges;
  return [...edges, ...sqlEdgesFromCallSites(file.sqlCallSites)];
}

function toAnnotation(a: JdtAnnotation): SymbolAnnotation {
  const named = a.named && Object.keys(a.named).length > 0 ? { ...a.named } : undefined;
  return {
    name: a.name,
    ...(a.args && a.args.length > 0 ? { args: [...a.args] } : {}),
    ...(named ? { named } : {}),
  };
}

/**
 * One analyzer symbol as a plugin symbol, shared by the batch and keep-alive paths: offsets when
 * the analyzer sent them, annotations when there is at least one (empty `args` and `named` are
 * dropped, so the index never holds empty lists).
 */
export function toSymbolNode(s: JdtSymbol): SymbolNode {
  return {
    symbolId: s.symbolId,
    name: s.name,
    kind: s.kind as SymbolKind,
    startLine: s.startLine,
    endLine: s.endLine,
    ...(s.startOffset != null ? { startOffset: s.startOffset } : {}),
    ...(s.endOffset != null ? { endOffset: s.endOffset } : {}),
    ...(s.annotations && s.annotations.length > 0 ? { annotations: s.annotations.map(toAnnotation) } : {}),
  };
}
