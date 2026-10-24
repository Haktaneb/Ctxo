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
