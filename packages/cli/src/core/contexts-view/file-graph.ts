import { compareCodepoint } from '../compare-codepoint.js';
import { makeGlobMatcher, type ResolvedContextsViewConfig } from '../config/load-config.js';
import { SymbolGraph } from '../graph/symbol-graph.js';
import type { CoChangeEntry, EdgeKind, FileIndex } from '../types.js';

/** Weight of one distinct symbol edge by kind (spec 7.2). */
export const EDGE_KIND_WEIGHTS: Readonly<Record<EdgeKind, number>> = {
  calls: 1,
  extends: 1,
  implements: 1,
  uses: 1,
  imports: 0.5,
};

export interface FileEdgeCount {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  readonly count: number;
}

/** An undirected file pair (`a` < `b`) with its blended weight. */
export interface FilePair {
  readonly a: string;
  readonly b: string;
  readonly dependency: number;
  readonly coChange: number;
  readonly weight: number;
}

export interface FileGraph {
  readonly files: readonly string[];
  readonly pairs: readonly FilePair[];
  readonly edgeCounts: readonly FileEdgeCount[];
  readonly dependents: ReadonlyMap<string, number>;
}

export interface FileGraphInput {
  readonly indices: readonly FileIndex[];
  readonly isNode: (file: string) => boolean;
  readonly coChangeMap?: ReadonlyMap<string, readonly CoChangeEntry[]>;
  readonly weights: ResolvedContextsViewConfig['weights'];
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fileOf(symbolId: string): string {
  const at = symbolId.indexOf('::');
  return at < 0 ? symbolId : symbolId.slice(0, at);
}

function pairKey(a: string, b: string): string {
  return `${a}\n${b}`;
}

function orderedPair(x: string, y: string): [string, string] {
  return compareCodepoint(x, y) < 0 ? [x, y] : [y, x];
}

/**
 * Builds the undirected file graph: distinct symbol edges between node files, weighted by kind and
 * log-scaled against the strongest pair, blended with the co-change frequency. Deterministic: the
 * same indices in any order give a deep-equal result. Rounding order: `weight` is computed from the
 * unrounded dependency and rounded once to 6 decimals; `dependency` is rounded to 6 decimals.
 */
export function buildFileGraph(input: FileGraphInput): FileGraph {
  const sorted = [...input.indices].sort((x, y) => compareCodepoint(x.file, y.file));
  const graph = new SymbolGraph();
  for (const index of sorted) {
    for (const symbol of index.symbols) graph.addNode(symbol);
  }
  for (const index of sorted) {
    for (const edge of index.edges) graph.addEdge(edge);
  }

  const nodes = new Set<string>();
  for (const index of sorted) {
    if (input.isNode(index.file)) nodes.add(index.file);
  }

  const coEntries = new Map<string, { a: string; b: string; frequency: number }>();
  for (const entries of input.coChangeMap?.values() ?? []) {
    for (const entry of entries) {
      if (entry.file1 === entry.file2) continue;
      // A co-change file accepted by isNode is a node even when all its partners are rejected.
      const ok1 = input.isNode(entry.file1);
      const ok2 = input.isNode(entry.file2);
      if (ok1) nodes.add(entry.file1);
      if (ok2) nodes.add(entry.file2);
      if (!ok1 || !ok2) continue;
      const [a, b] = orderedPair(entry.file1, entry.file2);
      const key = pairKey(a, b);
      const known = coEntries.get(key);
      if (!known || entry.frequency > known.frequency) coEntries.set(key, { a, b, frequency: entry.frequency });
    }
  }

  const symbolIds = new Set(graph.allNodes().map((node) => node.symbolId));
  const directed = new Map<string, FileEdgeCount>();
  const dependentSets = new Map<string, Set<string>>();
  for (const edge of graph.allEdges()) {
    if (!symbolIds.has(edge.to)) continue;
    const from = fileOf(edge.from);
    const to = fileOf(edge.to);
    if (from === to || !nodes.has(from) || !nodes.has(to)) continue;
    const key = `${from}\n${to}\n${edge.kind}`;
    const known = directed.get(key);
    directed.set(key, { from, to, kind: edge.kind, count: (known?.count ?? 0) + 1 });
    const set = dependentSets.get(to) ?? new Set<string>();
    set.add(from);
    dependentSets.set(to, set);
  }

  const edgeCounts = [...directed.values()].sort(
    (x, y) => compareCodepoint(x.from, y.from) || compareCodepoint(x.to, y.to) || compareCodepoint(x.kind, y.kind),
  );

  const rawDependency = new Map<string, { a: string; b: string; value: number }>();
  for (const entry of edgeCounts) {
    const [a, b] = orderedPair(entry.from, entry.to);
    const key = pairKey(a, b);
    const known = rawDependency.get(key) ?? { a, b, value: 0 };
    known.value += EDGE_KIND_WEIGHTS[entry.kind] * entry.count;
    rawDependency.set(key, known);
  }
  let maxValue = 0;
  for (const { value } of rawDependency.values()) maxValue = Math.max(maxValue, value);

  const keys = new Set<string>([...rawDependency.keys(), ...coEntries.keys()]);
  const pairs: FilePair[] = [];
  for (const key of keys) {
    const dep = rawDependency.get(key);
    const co = coEntries.get(key);
    const ends = (dep ?? co)!;
    const dependency = dep && maxValue > 0 ? Math.log2(1 + dep.value) / Math.log2(1 + maxValue) : 0;
    const coChange = co?.frequency ?? 0;
    const weight = round(input.weights.dependency * dependency + input.weights.coChange * coChange, 6);
    if (!(weight > 0)) continue;
    pairs.push({ a: ends.a, b: ends.b, dependency: round(dependency, 6), coChange, weight });
  }
  pairs.sort((x, y) => compareCodepoint(x.a, y.a) || compareCodepoint(x.b, y.b));

  const files = [...nodes].sort(compareCodepoint);
  const dependents = new Map<string, number>();
  for (const file of files) dependents.set(file, dependentSets.get(file)?.size ?? 0);

  return { files, pairs, edgeCounts, dependents };
}

export type HubReason = 'configured' | 'fan-in' | 'god-node';

export interface HubDecision {
  readonly file: string;
  readonly reasons: readonly HubReason[];
  readonly dependents: number;
  readonly damping: number;
}

/**
 * Finds hub files: `hubs.paths` matches (damping 0), and with `hubs.auto` the files in the top
 * `topPercent` by dependents (every tie included, at least `minDependents`) and god-node files.
 * `damping` is `1 / log2(2 + dependents)` rounded to 3 decimals, a display value only:
 * `applyHubDamping` recomputes the exact factor. Sorted by file.
 */
export function detectHubs(
  graph: FileGraph,
  options: { readonly hubs: ResolvedContextsViewConfig['hubs']; readonly godNodeFiles: ReadonlySet<string> },
): HubDecision[] {
  const { hubs } = options;
  const isConfigured = makeGlobMatcher([...hubs.paths]);
  let fanInCut = Number.POSITIVE_INFINITY;
  if (hubs.auto && graph.files.length > 0) {
    const k = Math.max(1, Math.ceil((graph.files.length * hubs.topPercent) / 100));
    const counts = graph.files.map((file) => graph.dependents.get(file) ?? 0).sort((x, y) => y - x);
    fanInCut = counts[Math.min(k, counts.length) - 1]!;
  }

  const decisions: HubDecision[] = [];
  for (const file of graph.files) {
    const dependents = graph.dependents.get(file) ?? 0;
    const reasons: HubReason[] = [];
    const configured = isConfigured(file);
    if (configured) reasons.push('configured');
    if (hubs.auto && dependents >= fanInCut && dependents >= hubs.minDependents) reasons.push('fan-in');
    if (hubs.auto && options.godNodeFiles.has(file)) reasons.push('god-node');
    if (reasons.length === 0) continue;
    decisions.push({
      file,
      reasons,
      dependents,
      damping: configured ? 0 : round(1 / Math.log2(2 + dependents), 3),
    });
  }
  return decisions;
}

/**
 * Multiplies each pair's weight by the exact factor of every hub endpoint (0 for a configured hub,
 * else `1 / log2(2 + dependents)`, not the rounded `damping`), then rounds the weight once to
 * 6 decimals. Zero weights are dropped.
 */
export function applyHubDamping(pairs: readonly FilePair[], hubs: readonly HubDecision[]): FilePair[] {
  const damping = new Map(
    hubs.map((hub) => [hub.file, hub.reasons.includes('configured') ? 0 : 1 / Math.log2(2 + hub.dependents)]),
  );
  const result: FilePair[] = [];
  for (const pair of pairs) {
    const weight = round(pair.weight * (damping.get(pair.a) ?? 1) * (damping.get(pair.b) ?? 1), 6);
    if (weight > 0) result.push({ ...pair, weight });
  }
  return result;
}
