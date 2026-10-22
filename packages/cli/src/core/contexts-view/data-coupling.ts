import type { DataResourceKind } from '@ctxo/plugin-api';

import { compareCodepoint } from '../compare-codepoint.js';
import { DATA_EDGE_KINDS, isDataResourceKind } from '../data-coupling/data-kinds.js';
import type { SymbolGraph } from '../graph/symbol-graph.js';
import type { SymbolNode } from '../types.js';

export type DataAccessMode = 'reads' | 'writes';

/** How one candidate accesses a resource; `modes` lists `reads` before `writes`. */
export interface CandidateDataAccess {
  readonly candidate: number;
  readonly modes: readonly DataAccessMode[];
}

/** A table or view that at least one candidate reads or writes. */
export interface DataResourceUsage {
  /** Canonical `schema.name`. */
  readonly name: string;
  /** Absent when external. */
  readonly kind?: DataResourceKind;
  /** No indexed table or view defines it. */
  readonly external: boolean;
  /** By candidate id. */
  readonly accesses: readonly CandidateDataAccess[];
  /** Candidates that write it, by id; more than one means several writers. */
  readonly writers: readonly number[];
  /** The only writer. */
  readonly owner?: number;
}

/** A resource this candidate and at least one other candidate access. */
export interface CandidateSharedTable {
  readonly name: string;
  /** Absent when external. */
  readonly kind?: DataResourceKind;
  readonly external: boolean;
  readonly accesses: readonly CandidateDataAccess[];
  readonly owner?: number;
}

export interface DataCouplingInput {
  /** The symbol graph of the index, from `buildIndexGraph`. */
  readonly graph: SymbolGraph;
  /** The candidate of each member file and of each assigned hub; other files are left out. */
  readonly fileCandidate: ReadonlyMap<string, number>;
}

export interface DataCoupling {
  /** Every resource with at least one access, by name. */
  readonly resources: readonly DataResourceUsage[];
  /** Per candidate id (ascending), the resources of two or more candidates, by name; candidates without any are absent. */
  readonly sharedTables: ReadonlyMap<number, readonly CandidateSharedTable[]>;
}

const MODES: readonly DataAccessMode[] = ['reads', 'writes'];

function fileOf(symbolId: string): string {
  const at = symbolId.indexOf('::');
  return at < 0 ? symbolId : symbolId.slice(0, at);
}

/** The name part of `<file>::<name>::<kind>` or of a 2-part reference `<name>::<kind>`. */
function nameOf(id: string): string | undefined {
  const parts = id.split('::');
  if (parts.length === 3) return parts[1];
  if (parts.length === 2) return parts[0];
  return undefined;
}

function kindOf(id: string): string {
  return id.slice(id.lastIndexOf('::') + 2);
}

/**
 * Data coupling between candidates (spec 8.6): which candidate reads or writes which table or view.
 *
 * - A `reads` or `writes` edge from a symbol in a candidate file records that candidate and mode for its target.
 * - An `executes` edge to a resolved procedure adds that procedure's reads and writes, following further
 *   `executes` edges transitively with a visited set; an unresolved procedure adds nothing.
 * - Reading a view does not expand to its tables.
 * - A target that no indexed table or view defines is external and has no kind. Resources are keyed by
 *   canonical name; when several definitions share a name, the smallest symbol ID gives the kind, as
 *   SymbolGraph resolves 2-part references.
 *
 * Pure and deterministic: the result does not depend on the order of the graph or the map.
 */
export function computeDataCoupling(input: DataCouplingInput): DataCoupling {
  const { graph, fileCandidate } = input;

  const nodes = new Map<string, SymbolNode>();
  const definitions = new Map<string, { readonly symbolId: string; readonly kind: DataResourceKind }>();
  for (const node of graph.allNodes()) {
    nodes.set(node.symbolId, node);
    if (!isDataResourceKind(node.kind)) continue;
    const name = nameOf(node.symbolId)!;
    const known = definitions.get(name);
    if (!known || compareCodepoint(node.symbolId, known.symbolId) < 0) {
      definitions.set(name, { symbolId: node.symbolId, kind: node.kind });
    }
  }

  /** The resource name of an edge target, or undefined when the target is no table or view. */
  const resourceOf = (target: string): string | undefined => {
    const node = nodes.get(target);
    if (node) return isDataResourceKind(node.kind) ? nameOf(node.symbolId) : undefined;
    return isDataResourceKind(kindOf(target)) ? nameOf(target) : undefined;
  };
  const isProcedure = (target: string): boolean => nodes.get(target)?.kind === 'procedure';

  const usage = new Map<string, Map<number, Set<DataAccessMode>>>();
  const record = (candidate: number, target: string, mode: DataAccessMode): void => {
    const name = resourceOf(target);
    if (name === undefined) return;
    const byCandidate = usage.get(name) ?? new Map<number, Set<DataAccessMode>>();
    const modes = byCandidate.get(candidate) ?? new Set<DataAccessMode>();
    modes.add(mode);
    byCandidate.set(candidate, modes);
    usage.set(name, byCandidate);
  };

  const executed = new Map<number, string[]>();
  for (const edge of graph.allEdges()) {
    if (!DATA_EDGE_KINDS.has(edge.kind)) continue;
    const candidate = fileCandidate.get(fileOf(edge.from));
    if (candidate === undefined) continue;
    if (edge.kind === 'executes') {
      if (!isProcedure(edge.to)) continue;
      const list = executed.get(candidate);
      if (list) list.push(edge.to);
      else executed.set(candidate, [edge.to]);
      continue;
    }
    record(candidate, edge.to, edge.kind === 'writes' ? 'writes' : 'reads');
  }

  // One walk per candidate over the procedures it executes, directly or through other procedures.
  for (const [candidate, starts] of executed) {
    const visited = new Set<string>();
    const stack = [...starts];
    while (stack.length > 0) {
      const procedure = stack.pop()!;
      if (visited.has(procedure)) continue;
      visited.add(procedure);
      for (const edge of graph.getForwardEdges(procedure)) {
        if (edge.kind === 'executes') {
          if (isProcedure(edge.to) && !visited.has(edge.to)) stack.push(edge.to);
        } else if (edge.kind === 'reads' || edge.kind === 'writes') {
          record(candidate, edge.to, edge.kind);
        }
      }
    }
  }

  const resources = [...usage.entries()]
    .sort(([x], [y]) => compareCodepoint(x, y))
    .map(([name, byCandidate]): DataResourceUsage => {
      const accesses = [...byCandidate.entries()]
        .sort(([x], [y]) => x - y)
        .map(([candidate, modes]): CandidateDataAccess => ({ candidate, modes: MODES.filter((mode) => modes.has(mode)) }));
      const writers = accesses.filter((access) => access.modes.includes('writes')).map((access) => access.candidate);
      const definition = definitions.get(name);
      return {
        name,
        ...(definition ? { kind: definition.kind } : {}),
        external: definition === undefined,
        accesses,
        writers,
        ...(writers.length === 1 ? { owner: writers[0]! } : {}),
      };
    });

  const shared = new Map<number, CandidateSharedTable[]>();
  for (const resource of resources) {
    if (resource.accesses.length < 2) continue;
    const entry: CandidateSharedTable = {
      name: resource.name,
      ...(resource.kind !== undefined ? { kind: resource.kind } : {}),
      external: resource.external,
      accesses: resource.accesses,
      ...(resource.owner !== undefined ? { owner: resource.owner } : {}),
    };
    for (const access of resource.accesses) {
      const list = shared.get(access.candidate);
      if (list) list.push(entry);
      else shared.set(access.candidate, [entry]);
    }
  }
  const sharedTables = new Map([...shared.entries()].sort(([x], [y]) => x - y));

  return { resources, sharedTables };
}
