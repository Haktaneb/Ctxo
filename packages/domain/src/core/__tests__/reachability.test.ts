import { describe, it, expect } from 'vitest';
import { createModuleHost, type FileIndex, type GraphEdge, type SymbolNode } from '@ctxo/cli/internal';
import { REACH_EDGE_KINDS, buildReachGraph, reachableFrom, reachedVia } from '../reachability.js';

const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: process.cwd() });

function sym(file: string, name: string, kind: SymbolNode['kind'], startLine: number, endLine: number): SymbolNode {
  return { symbolId: `${file}::${name}::${kind}`, name, kind, startLine, endLine };
}

function fileIndex(file: string, symbols: SymbolNode[], edges: GraphEdge[] = []): FileIndex {
  return { file, lastModified: 1, symbols, edges, intent: [], antiPatterns: [] };
}

function reach(indices: FileIndex[]) {
  return buildReachGraph(host.services.buildGraph(indices), indices);
}

const TEST = 'tests/LoanTests.cs::LoanTests.Borrows::method';
const TEST_CLASS = 'tests/LoanTests.cs::LoanTests::class';
const BORROW = 'src/Loan.cs::LoanService.Borrow::method';
const SERVICE = 'src/Loan.cs::LoanService::class';
const POLICY = 'src/Policy.cs::Policy.Check::method';
const RENEW = 'src/Loan.cs::LoanService.Renew::method';

function testFile(edges: GraphEdge[], classEdges: GraphEdge[] = []): FileIndex {
  return fileIndex(
    'tests/LoanTests.cs',
    [sym('tests/LoanTests.cs', 'LoanTests', 'class', 0, 20), sym('tests/LoanTests.cs', 'LoanTests.Borrows', 'method', 2, 6)],
    [...edges, ...classEdges],
  );
}

function loanFile(edges: GraphEdge[] = []): FileIndex {
  return fileIndex(
    'src/Loan.cs',
    [sym('src/Loan.cs', 'LoanService', 'class', 0, 30), sym('src/Loan.cs', 'LoanService.Borrow', 'method', 2, 8), sym('src/Loan.cs', 'LoanService.Renew', 'method', 10, 14)],
    edges,
  );
}

const policyFile = fileIndex('src/Policy.cs', [sym('src/Policy.cs', 'Policy', 'class', 0, 10), sym('src/Policy.cs', 'Policy.Check', 'method', 1, 4)]);

describe('reachability', () => {
  it('REACH_EDGE_KINDS are the five forward code edges', () => {
    expect([...REACH_EDGE_KINDS].sort()).toEqual(['calls', 'extends', 'implements', 'imports', 'uses']);
  });

  it('a test reaches what it calls transitively', () => {
    const indices = [
      testFile([{ from: TEST, to: BORROW, kind: 'calls' }]),
      loanFile([{ from: BORROW, to: POLICY, kind: 'calls' }]),
      policyFile,
    ];
    const graph = reach(indices);
    expect(graph.containerOf.get(BORROW)).toBe(SERVICE);
    expect(graph.containerOf.get(SERVICE)).toBeUndefined();
    const visited = reachableFrom(graph, [TEST]);
    expect([...visited].sort()).toEqual([POLICY, BORROW, TEST].sort());
    expect(reachedVia(graph, visited, POLICY)).toBe('symbol');
    expect(reachedVia(graph, visited, RENEW)).toBeUndefined();
  });

  it('a test without edges starts from its class', () => {
    const indices = [testFile([], [{ from: TEST_CLASS, to: SERVICE, kind: 'uses' }]), loanFile()];
    const graph = reach(indices);
    const visited = reachableFrom(graph, [TEST]);
    expect(visited.has(TEST_CLASS)).toBe(true);
    expect(visited.has(SERVICE)).toBe(true);
  });

  it('reaching a class counts its methods via type', () => {
    const indices = [testFile([{ from: TEST, to: SERVICE, kind: 'uses' }]), loanFile()];
    const graph = reach(indices);
    const visited = reachableFrom(graph, [TEST]);
    expect(reachedVia(graph, visited, SERVICE)).toBe('symbol');
    expect(reachedVia(graph, visited, RENEW)).toBe('type');
    expect(reachedVia(graph, visited, BORROW)).toBe('type');
  });

  it('a module symbol counts as reached via file', () => {
    const indices = [testFile([{ from: TEST, to: BORROW, kind: 'calls' }]), loanFile()];
    const graph = reach(indices);
    const visited = reachableFrom(graph, [TEST]);
    expect(graph.indexed.has(BORROW)).toBe(true);
    expect(graph.indexed.has('src/Loan.cs::<module>::variable')).toBe(false);
    expect(graph.indexed.size).toBe(5);
    expect(reachedVia(graph, visited, 'src/Loan.cs::<module>::variable')).toBe('file');
    expect(reachedVia(graph, visited, 'src/Other.cs::<module>::variable')).toBeUndefined();
  });

  it('on one line the outer span by offsets is the container: class ChargeId { constructor(...) {} }', () => {
    const file = 'src/Billing/ChargeId.ts';
    const klass: SymbolNode = { symbolId: `${file}::ChargeId::class`, name: 'ChargeId', kind: 'class', startLine: 0, endLine: 0, startOffset: 0, endOffset: 60 };
    const ctor: SymbolNode = {
      symbolId: `${file}::ChargeId.constructor::method`,
      name: 'ChargeId.constructor',
      kind: 'method',
      startLine: 0,
      endLine: 0,
      startOffset: 17,
      endOffset: 58,
    };
    const indices = [testFile([{ from: TEST, to: klass.symbolId, kind: 'uses' }]), fileIndex(file, [ctor, klass])];
    const graph = reach(indices);
    expect(graph.containerOf.get(ctor.symbolId)).toBe(klass.symbolId);
    expect(graph.containerOf.has(klass.symbolId)).toBe(false);
    expect(reachedVia(graph, reachableFrom(graph, [TEST]), ctor.symbolId)).toBe('type');

    // Without offsets (or with equal ones) the smaller symbol ID stays the tie-break.
    const bare = (s: SymbolNode): SymbolNode => ({ symbolId: s.symbolId, name: s.name, kind: s.kind, startLine: 0, endLine: 0 });
    const tie = reach([fileIndex(file, [bare(klass), bare(ctor)])]);
    expect(tie.containerOf.get(klass.symbolId)).toBe(ctor.symbolId);
    expect(tie.containerOf.has(ctor.symbolId)).toBe(false);
  });

  it('data edges are not followed', () => {
    const indices = [
      testFile([
        { from: TEST, to: 'dbo.loans::table', kind: 'reads' },
        { from: TEST, to: BORROW, kind: 'writes' },
        { from: TEST, to: POLICY, kind: 'executes' },
      ]),
      loanFile(),
      policyFile,
    ];
    const graph = reach(indices);
    expect(graph.successors.get(TEST)).toBeUndefined();
    const visited = reachableFrom(graph, [TEST]);
    expect(visited.has(BORROW)).toBe(false);
    expect(visited.has(POLICY)).toBe(false);
  });
});

/**
 * The containment rule by definition, pairwise (the round-1 implementation): lines first, then character offsets
 * when both symbols carry them (the outer span wins), the smaller ID only on equal or missing offsets; the
 * innermost candidate by lines, then characters, then ID. The sweep must give the same `containerOf`.
 */
function referenceContainers(indices: readonly FileIndex[]): Map<string, string> {
  const len = (s: SymbolNode): number => s.endLine - s.startLine;
  const offs = (s: SymbolNode) => (s.startOffset !== undefined && s.endOffset !== undefined ? { start: s.startOffset, end: s.endOffset } : undefined);
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const contains = (outer: SymbolNode, inner: SymbolNode): boolean => {
    if (outer.symbolId === inner.symbolId) return false;
    if (outer.startLine > inner.startLine || outer.endLine < inner.endLine) return false;
    const o = offs(outer);
    const i = offs(inner);
    if (o !== undefined && i !== undefined) {
      if (o.start > i.start || o.end < i.end) return false;
      if (o.start !== i.start || o.end !== i.end) return true;
    } else if (len(outer) !== len(inner)) {
      return true;
    }
    return cmp(outer.symbolId, inner.symbolId) < 0;
  };
  const innerFirst = (a: SymbolNode, b: SymbolNode): number => {
    const lines = len(a) - len(b);
    if (lines !== 0) return lines;
    const oa = offs(a);
    const ob = offs(b);
    if (oa !== undefined && ob !== undefined && oa.end - oa.start !== ob.end - ob.start) return oa.end - oa.start - (ob.end - ob.start);
    return cmp(a.symbolId, b.symbolId);
  };
  const out = new Map<string, string>();
  for (const index of indices) {
    for (const symbol of index.symbols) {
      let best: SymbolNode | undefined;
      for (const other of index.symbols) if (contains(other, symbol) && (best === undefined || innerFirst(other, best) < 0)) best = other;
      if (best !== undefined) out.set(symbol.symbolId, best.symbolId);
    }
  }
  return out;
}

/** Deterministic PRNG (mulberry32), so a failing case can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A nested (laminar) file: every span lies inside its parent or beside its siblings, children may repeat their
 * parent's span, and IDs are random so their order differs from the position order. With `offsets`, spans are
 * character ranges and lines are derived from them (40 characters a line), so one-line nesting occurs; without,
 * spans are line ranges.
 */
function nestedFile(seed: number, offsets: boolean): FileIndex {
  const random = rng(seed);
  const file = `src/Gen${seed}${offsets ? 'o' : 'l'}.ts`;
  const symbols: SymbolNode[] = [];
  const used = new Set<string>();
  const add = (lo: number, hi: number): void => {
    let name: string;
    do name = `s${Math.floor(random() * 1e6)}`;
    while (used.has(name));
    used.add(name);
    const symbolId = `${file}::${name}::function`;
    symbols.push(
      offsets
        ? { symbolId, name, kind: 'function', startLine: Math.floor(lo / 40), endLine: Math.floor(hi / 40), startOffset: lo, endOffset: hi }
        : { symbolId, name, kind: 'function', startLine: lo, endLine: hi },
    );
  };
  const grow = (lo: number, hi: number, depth: number): void => {
    add(lo, hi);
    if (random() < 0.15) add(lo, hi);
    if (depth >= 4 || hi - lo < 2) return;
    let at = lo + (random() < 0.3 ? 0 : 1);
    const children = 1 + Math.floor(random() * 4);
    for (let c = 0; c < children && at < hi; c++) {
      const width = Math.max(0, Math.floor(random() * ((hi - at) / 2 + 1)));
      const end = Math.min(hi, at + width);
      grow(at, end, depth + 1);
      at = end + 1 + (random() < 0.5 ? 0 : 1);
    }
  };
  grow(0, offsets ? 800 : 60, 0);
  // The file order is shuffled too: the sweep must not depend on it.
  for (let i = symbols.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [symbols[i], symbols[j]] = [symbols[j]!, symbols[i]!];
  }
  return fileIndex(file, symbols);
}

describe('containerOf sweep', () => {
  it('gives the pairwise result on the existing cases and on generated nested files', () => {
    const file = 'src/Billing/ChargeId.ts';
    const klass: SymbolNode = { symbolId: `${file}::ChargeId::class`, name: 'ChargeId', kind: 'class', startLine: 0, endLine: 0, startOffset: 0, endOffset: 60 };
    const ctor: SymbolNode = { symbolId: `${file}::ChargeId.constructor::method`, name: 'ChargeId.constructor', kind: 'method', startLine: 0, endLine: 0, startOffset: 17, endOffset: 58 };
    const bare = (s: SymbolNode): SymbolNode => ({ symbolId: s.symbolId, name: s.name, kind: s.kind, startLine: 0, endLine: 0 });
    const fixed: FileIndex[][] = [
      [testFile([]), loanFile(), policyFile],
      [fileIndex(file, [ctor, klass])],
      [fileIndex(file, [bare(klass), bare(ctor)])],
      // Overlap without nesting (pairwise fallback): b (2-6) and c (4-8) both contain d; the definition picks the
      // smaller ID b, a stack without the fallback would keep the later-opened c.
      [fileIndex('src/O.ts', [sym('src/O.ts', 'a', 'class', 0, 20), sym('src/O.ts', 'b', 'function', 2, 6), sym('src/O.ts', 'c', 'function', 4, 8), sym('src/O.ts', 'd', 'function', 5, 6)])],
      // Offsets on some symbols only (pairwise fallback).
      [fileIndex(file, [klass, bare(ctor), sym(file, 'ChargeId.value', 'variable', 0, 0)])],
    ];
    for (const indices of fixed) expect(reach(indices).containerOf).toEqual(referenceContainers(indices));
    for (let seed = 1; seed <= 60; seed++) {
      for (const offsets of [true, false]) {
        const indices = [nestedFile(seed, offsets)];
        expect(new Map([...reach(indices).containerOf].sort()), `seed ${seed} offsets ${offsets}`).toEqual(new Map([...referenceContainers(indices)].sort()));
      }
    }
  });

  // The pairwise rule took about 480 ms here and the sweep about 7 ms; 150 ms separates them with headroom.
  it('one file with 10,000 nested and sibling symbols is swept well under a second', () => {
    const file = 'src/Generated/Big.cs';
    const symbols: SymbolNode[] = [sym(file, 'Ns', 'class', 0, 30000)];
    for (let c = 0; c < 1111; c++) {
      const base = c * 25 + 1;
      symbols.push(sym(file, `Ns.C${c}`, 'class', base, base + 23));
      for (let m = 0; m < 8; m++) symbols.push(sym(file, `Ns.C${c}.M${m}`, 'method', base + 1 + m * 2, base + 2 + m * 2));
    }
    expect(symbols.length).toBe(10000);
    const index = fileIndex(file, symbols);
    const started = performance.now();
    const graph = buildReachGraph(host.services.buildGraph([]), [index]);
    const elapsed = performance.now() - started;
    expect(graph.containerOf.get(`${file}::Ns.C7.M3::method`)).toBe(`${file}::Ns.C7::class`);
    expect(graph.containerOf.get(`${file}::Ns.C7::class`)).toBe(`${file}::Ns::class`);
    expect(graph.containerOf.has(`${file}::Ns::class`)).toBe(false);
    expect(graph.containerOf.size).toBe(9999);
    expect(elapsed).toBeLessThan(150);
  });
});
