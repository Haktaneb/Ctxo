/**
 * Reachability from tests (H8): which symbols the characterization and contract tests reach over the forward
 * code edges. Data edges are never followed. A test without edges of its own starts from its container (JDT
 * edges are type-level), and a reached type or file stands for what it contains.
 */

import type { FileIndex, SymbolGraph, SymbolNode } from '@ctxo/cli/internal';

/** The forward edges a test reaches through; `reads`, `writes` and `executes` are left out. */
export const REACH_EDGE_KINDS: ReadonlySet<string> = new Set(['calls', 'uses', 'imports', 'extends', 'implements']);

export interface ReachGraph {
  /** Resolved targets per source symbol, unique and in codepoint order. */
  readonly successors: ReadonlyMap<string, readonly string[]>;
  /** The innermost other symbol of the same file whose span contains the symbol. */
  readonly containerOf: ReadonlyMap<string, string>;
  /** The indexed symbols per file (forward slashes), in codepoint order. */
  readonly symbolsByFile: ReadonlyMap<string, readonly string[]>;
  /** Every indexed symbol ID, the union of `symbolsByFile` (a module symbol is not in it). */
  readonly indexed: ReadonlySet<string>;
}

export type ReachedVia = 'symbol' | 'type' | 'file';

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const norm = (path: string): string => path.replace(/\\/g, '/');
const spanLength = (symbol: SymbolNode): number => symbol.endLine - symbol.startLine;

function fileOf(symbolId: string): string {
  const sep = symbolId.indexOf('::');
  return norm(sep < 0 ? symbolId : symbolId.slice(0, sep));
}

const hasOffsets = (s: SymbolNode): boolean => s.startOffset !== undefined && s.endOffset !== undefined;

/**
 * True when `outer` contains `inner`. Lines decide first; on the same lines character offsets decide when both
 * symbols carry them (the outer span wins, as in classifyTests). Only when the spans are equal, or offsets are
 * missing, the smaller symbol ID is the container, so two symbols never contain each other.
 */
function contains(outer: SymbolNode, inner: SymbolNode): boolean {
  if (outer.symbolId === inner.symbolId) return false;
  if (outer.startLine > inner.startLine || outer.endLine < inner.endLine) return false;
  if (hasOffsets(outer) && hasOffsets(inner)) {
    if (outer.startOffset! > inner.startOffset! || outer.endOffset! < inner.endOffset!) return false;
    if (outer.startOffset !== inner.startOffset || outer.endOffset !== inner.endOffset) return true;
  } else if (spanLength(outer) !== spanLength(inner)) {
    return true;
  }
  return compare(outer.symbolId, inner.symbolId) < 0;
}

/** Innermost first: fewer lines, then fewer characters when both carry offsets, then the smaller symbol ID. */
function innerFirst(a: SymbolNode, b: SymbolNode): number {
  const lines = spanLength(a) - spanLength(b);
  if (lines !== 0) return lines;
  if (hasOffsets(a) && hasOffsets(b)) {
    const chars = a.endOffset! - a.startOffset! - (b.endOffset! - b.startOffset!);
    if (chars !== 0) return chars;
  }
  return compare(a.symbolId, b.symbolId);
}

/** The definition: every pair, O(F^2). Used for files the sweep cannot take. */
function pairwiseContainers(symbols: readonly SymbolNode[], out: Map<string, string>): void {
  for (const symbol of symbols) {
    let best: SymbolNode | undefined;
    for (const other of symbols) {
      if (!contains(other, symbol)) continue;
      if (best === undefined || innerFirst(other, best) < 0) best = other;
    }
    if (best !== undefined) out.set(symbol.symbolId, best.symbolId);
  }
}

/**
 * The innermost container of each symbol (`contains`, then `innerFirst`) in O(F log F): sort by start, wider span
 * first, then ID, and sweep with a stack of open spans. The coordinate is the character offset when every symbol
 * of the file carries offsets, else the line. On nested spans the stack top is the innermost container, and among
 * equal spans the smallest ID is the container of the others (only it stays on the stack). A file with spans that
 * overlap without nesting, or with offsets on some symbols only, takes the pairwise definition, so the result is
 * always the pairwise one.
 */
function containers(index: FileIndex, out: Map<string, string>): void {
  const symbols = index.symbols;
  const withOffsets = symbols.filter(hasOffsets).length;
  if (withOffsets !== 0 && withOffsets !== symbols.length) return pairwiseContainers(symbols, out);
  const byChars = withOffsets !== 0;
  const start = (s: SymbolNode): number => (byChars ? s.startOffset! : s.startLine);
  const end = (s: SymbolNode): number => (byChars ? s.endOffset! : s.endLine);
  const sorted = [...symbols].sort((a, b) => start(a) - start(b) || end(b) - end(a) || compare(a.symbolId, b.symbolId));

  const found = new Map<string, string>();
  const stack: SymbolNode[] = [];
  for (const symbol of sorted) {
    while (stack.length > 0 && !contains(stack[stack.length - 1]!, symbol)) {
      const closed = stack.pop()!;
      // Overlap without nesting: the stack no longer describes containment.
      if (end(closed) >= start(symbol)) return pairwiseContainers(symbols, out);
    }
    const top = stack[stack.length - 1];
    if (top !== undefined) {
      found.set(symbol.symbolId, top.symbolId);
      // An equal span: the top stays the container of everything inside both.
      if (start(top) === start(symbol) && end(top) === end(symbol)) continue;
    }
    stack.push(symbol);
  }
  for (const [id, container] of found) out.set(id, container);
}

/** H8: the forward code edges of the graph (targets resolved to node IDs) and the containment of the indices. */
export function buildReachGraph(graph: SymbolGraph, indices: readonly FileIndex[]): ReachGraph {
  const sets = new Map<string, Set<string>>();
  for (const edge of graph.allEdges()) {
    if (!REACH_EDGE_KINDS.has(edge.kind)) continue;
    const to = graph.getNode(edge.to)?.symbolId ?? edge.to;
    if (to === edge.from) continue;
    const set = sets.get(edge.from);
    if (set === undefined) sets.set(edge.from, new Set([to]));
    else set.add(to);
  }
  const successors = new Map<string, readonly string[]>();
  for (const from of [...sets.keys()].sort(compare)) successors.set(from, [...sets.get(from)!].sort(compare));

  const containerOf = new Map<string, string>();
  const byFile = new Map<string, Set<string>>();
  for (const index of indices) {
    containers(index, containerOf);
    const file = norm(index.file);
    const set = byFile.get(file) ?? new Set<string>();
    for (const symbol of index.symbols) set.add(symbol.symbolId);
    byFile.set(file, set);
  }
  const symbolsByFile = new Map<string, readonly string[]>();
  const indexed = new Set<string>();
  for (const file of [...byFile.keys()].sort(compare)) {
    const ids = [...byFile.get(file)!].sort(compare);
    symbolsByFile.set(file, ids);
    for (const id of ids) indexed.add(id);
  }
  return { successors, containerOf, symbolsByFile, indexed };
}

/** Every symbol a walk from the tests visits; a test with no successors starts from its container as well. */
export function reachableFrom(reach: ReachGraph, tests: Iterable<string>): ReadonlySet<string> {
  const visited = new Set<string>();
  const queue: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    queue.push(id);
  };
  for (const test of tests) {
    visit(test);
    if ((reach.successors.get(test)?.length ?? 0) === 0) {
      const container = reach.containerOf.get(test);
      if (container !== undefined) visit(container);
    }
  }
  for (let i = 0; i < queue.length; i++) for (const next of reach.successors.get(queue[i]!) ?? []) visit(next);
  return visited;
}

/**
 * How a symbol counts as reached: `symbol` when visited, `type` when its container is visited, `file` when it
 * is no indexed symbol (a module symbol) and any symbol of its file is visited; undefined when none holds.
 */
export function reachedVia(reach: ReachGraph, visited: ReadonlySet<string>, symbolId: string): ReachedVia | undefined {
  if (visited.has(symbolId)) return 'symbol';
  const container = reach.containerOf.get(symbolId);
  if (container !== undefined && visited.has(container)) return 'type';
  if (!reach.indexed.has(symbolId) && (reach.symbolsByFile.get(fileOf(symbolId)) ?? []).some((id) => visited.has(id))) return 'file';
  return undefined;
}
