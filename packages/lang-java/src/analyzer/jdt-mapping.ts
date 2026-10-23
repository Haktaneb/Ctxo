import type { SymbolAnnotation, SymbolKind, SymbolNode } from '@ctxo/plugin-api';
import type { JdtAnnotation, JdtSymbol } from './jdt-process.js';

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
