import { describe, it, expect } from 'vitest';
import { applyHubDamping, buildFileGraph, detectHubs, type FileGraph, type FilePair } from '../file-graph.js';
import type { CoChangeEntry, EdgeKind, FileIndex, SymbolKind } from '../../types.js';

const WEIGHTS = { dependency: 1, coChange: 1 };

function sym(file: string, name: string, kind: SymbolKind = 'function') {
  return { symbolId: `${file}::${name}::${kind}`, name, kind, startLine: 1, endLine: 2 };
}

function fileIndex(
  file: string,
  symbols: string[],
  edges: Array<[string, string, EdgeKind]> = [],
): FileIndex {
  return {
    file,
    lastModified: 1,
    symbols: symbols.map((name) => sym(file, name)),
    edges: edges.map(([from, to, kind]) => ({ from, to, kind })),
    intent: [],
    antiPatterns: [],
  };
}

const all = () => true;

function co(file1: string, file2: string, frequency: number): CoChangeEntry {
  return { file1, file2, sharedCommits: 3, frequency };
}

function basicIndices(): FileIndex[] {
  return [
    fileIndex(
      'a.ts',
      ['fa'],
      [
        ['a.ts::fa::function', 'b.ts::x::function', 'calls'],
        ['a.ts::fa::function', 'b.ts::y::function', 'calls'],
        ['a.ts::fa::function', 'b.ts::x::function', 'imports'],
      ],
    ),
    fileIndex('b.ts', ['x', 'y'], [['b.ts::x::function', 'a.ts::fa::function', 'uses']]),
    fileIndex('c.ts', ['fc'], [['c.ts::fc::function', 'd.ts::fd::function', 'imports']]),
    fileIndex('d.ts', ['fd']),
  ];
}

describe('buildFileGraph', () => {
  it('sums kind weights of distinct symbol edges per pair in both directions', () => {
    const graph = buildFileGraph({ indices: basicIndices(), isNode: all, weights: WEIGHTS });
    const ab = graph.pairs.find((p) => p.a === 'a.ts' && p.b === 'b.ts')!;
    const cd = graph.pairs.find((p) => p.a === 'c.ts' && p.b === 'd.ts')!;
    expect(ab.dependency).toBe(1);
    expect(cd.dependency).toBeCloseTo(Math.log2(1.5) / Math.log2(4.5), 5);
    expect(graph.pairs.map((p) => [p.a, p.b])).toEqual([
      ['a.ts', 'b.ts'],
      ['c.ts', 'd.ts'],
    ]);
  });

  it('counts a repeated symbol edge once', () => {
    const edge: [string, string, EdgeKind] = ['a.ts::fa::function', 'b.ts::x::function', 'calls'];
    const graph = buildFileGraph({
      indices: [fileIndex('a.ts', ['fa'], [edge, edge, edge]), fileIndex('b.ts', ['x'])],
      isNode: all,
      weights: WEIGHTS,
    });
    expect(graph.edgeCounts).toEqual([{ from: 'a.ts', to: 'b.ts', kind: 'calls', count: 1 }]);
  });

  it('ignores intra-file edges, edges into non-node files and unresolved targets', () => {
    const graph = buildFileGraph({
      indices: [
        fileIndex(
          'a.ts',
          ['fa', 'fb'],
          [
            ['a.ts::fa::function', 'a.ts::fb::function', 'calls'],
            ['a.ts::fa::function', 'skip.ts::s::function', 'calls'],
            ['a.ts::fa::function', 'nowhere.ts::ghost::function', 'calls'],
            ['a.ts::fa::function', 'Missing::class', 'uses'],
          ],
        ),
        fileIndex('skip.ts', ['s']),
      ],
      isNode: (file) => file !== 'skip.ts',
      weights: WEIGHTS,
    });
    expect(graph.pairs).toEqual([]);
    expect(graph.edgeCounts).toEqual([]);
    expect(graph.files).toEqual(['a.ts']);
  });

  it('resolves a 2-part name reference through the symbol graph', () => {
    const graph = buildFileGraph({
      indices: [
        fileIndex('a.ts', ['fa'], [['a.ts::fa::function', 'Bar::class', 'uses']]),
        {
          ...fileIndex('b.ts', []),
          symbols: [sym('b.ts', 'Bar', 'class')],
        },
      ],
      isNode: all,
      weights: WEIGHTS,
    });
    expect(graph.pairs.map((p) => [p.a, p.b])).toEqual([['a.ts', 'b.ts']]);
  });

  it('adds co-change frequency and keeps pairs that only co-change', () => {
    const coChangeMap = new Map([['a.ts', [co('a.ts', 'e.ts', 0.8)]]]);
    const indices = [fileIndex('a.ts', ['fa']), fileIndex('e.ts', ['fe'])];
    const plain = buildFileGraph({ indices, isNode: all, coChangeMap, weights: WEIGHTS });
    expect(plain.pairs).toEqual([{ a: 'a.ts', b: 'e.ts', dependency: 0, coChange: 0.8, weight: 0.8 }]);
    const scaled = buildFileGraph({ indices, isNode: all, coChangeMap, weights: { dependency: 0.5, coChange: 2 } });
    expect(scaled.pairs[0]!.weight).toBe(1.6);
  });

  it('makes co-change-only files nodes when isNode accepts them', () => {
    const coChangeMap = new Map([['db/schema.sql', [co('db/schema.sql', 'a.ts', 0.5)]]]);
    const graph = buildFileGraph({
      indices: [fileIndex('a.ts', ['fa'])],
      isNode: all,
      coChangeMap,
      weights: WEIGHTS,
    });
    expect(graph.files).toEqual(['a.ts', 'db/schema.sql']);
    const rejected = buildFileGraph({
      indices: [fileIndex('a.ts', ['fa'])],
      isNode: (f) => f !== 'db/schema.sql',
      coChangeMap,
      weights: WEIGHTS,
    });
    expect(rejected.files).toEqual(['a.ts']);
    expect(rejected.pairs).toEqual([]);
  });

  it('counts distinct dependent files', () => {
    const graph = buildFileGraph({ indices: basicIndices(), isNode: all, weights: WEIGHTS });
    expect(graph.dependents.get('b.ts')).toBe(1);
    const more = buildFileGraph({
      indices: [
        ...basicIndices(),
        fileIndex('e.ts', ['fe'], [['e.ts::fe::function', 'b.ts::x::function', 'calls']]),
      ],
      isNode: all,
      weights: WEIGHTS,
    });
    expect(more.dependents.get('b.ts')).toBe(2);
    expect(more.dependents.get('a.ts')).toBe(1);
  });

  it('does not depend on input order', () => {
    const forward = buildFileGraph({ indices: basicIndices(), isNode: all, weights: WEIGHTS });
    const reversed = buildFileGraph({ indices: basicIndices().reverse(), isNode: all, weights: WEIGHTS });
    expect(reversed).toEqual(forward);
  });
});

function fanInGraph(dependentCount: number): FileGraph {
  const indices: FileIndex[] = [fileIndex('src/shared/db.ts', ['db'])];
  for (let i = 0; i < dependentCount; i++) {
    const file = `src/f${String(i).padStart(2, '0')}.ts`;
    indices.push(fileIndex(file, ['fn'], [[`${file}::fn::function`, 'src/shared/db.ts::db::function', 'calls']]));
  }
  return buildFileGraph({ indices, isNode: all, weights: WEIGHTS });
}

const AUTO_HUBS = { auto: true, topPercent: 1, minDependents: 10, paths: [] as string[] };

describe('detectHubs', () => {
  it('marks god-node files and top fan-in files with at least minDependents dependents', () => {
    const graph = fanInGraph(12);
    const hubs = detectHubs(graph, { hubs: AUTO_HUBS, godNodeFiles: new Set(['src/f00.ts']) });
    expect(hubs).toHaveLength(2);
    const db = hubs.find((h) => h.file === 'src/shared/db.ts')!;
    expect(db.reasons).toEqual(['fan-in']);
    expect(db.dependents).toBe(12);
    expect(db.damping).toBeCloseTo(1 / Math.log2(14), 3);
    expect(hubs.find((h) => h.file === 'src/f00.ts')!.reasons).toEqual(['god-node']);
    expect(hubs.map((h) => h.file)).toEqual(['src/f00.ts', 'src/shared/db.ts']);
  });

  it('includes every file tied with the top-percent cut', () => {
    const indices: FileIndex[] = [fileIndex('t1.ts', ['t']), fileIndex('t2.ts', ['t'])];
    for (let i = 0; i < 3; i++) {
      const file = `u${i}.ts`;
      indices.push(
        fileIndex(file, ['u'], [
          [`${file}::u::function`, 't1.ts::t::function', 'calls'],
          [`${file}::u::function`, 't2.ts::t::function', 'calls'],
        ]),
      );
    }
    const graph = buildFileGraph({ indices, isNode: all, weights: WEIGHTS });
    const hubs = detectHubs(graph, {
      hubs: { ...AUTO_HUBS, minDependents: 1 },
      godNodeFiles: new Set(),
    });
    expect(hubs.map((h) => h.file)).toEqual(['t1.ts', 't2.ts']);
  });

  it('with auto false keeps only hubs.paths matches with damping 0', () => {
    const graph = fanInGraph(12);
    const hubs = detectHubs(graph, {
      hubs: { auto: false, topPercent: 1, minDependents: 10, paths: ['src/shared/**'] },
      godNodeFiles: new Set(['src/f00.ts']),
    });
    expect(hubs).toEqual([{ file: 'src/shared/db.ts', reasons: ['configured'], dependents: 12, damping: 0 }]);
  });
});

describe('applyHubDamping', () => {
  it('multiplies edges touching a hub by its damping, once per hub endpoint, and drops configured-hub edges', () => {
    const pairs: FilePair[] = [
      { a: 'a.ts', b: 'h1.ts', dependency: 1, coChange: 0, weight: 1 },
      { a: 'a.ts', b: 'b.ts', dependency: 1, coChange: 0, weight: 0.5 },
      { a: 'h1.ts', b: 'h2.ts', dependency: 1, coChange: 0, weight: 1 },
      { a: 'a.ts', b: 'zero.ts', dependency: 1, coChange: 0, weight: 1 },
    ];
    const result = applyHubDamping(pairs, [
      { file: 'h1.ts', reasons: ['fan-in'], dependents: 10, damping: 0.5 },
      { file: 'h2.ts', reasons: ['fan-in'], dependents: 10, damping: 0.4 },
      { file: 'zero.ts', reasons: ['configured'], dependents: 0, damping: 0 },
    ]);
    expect(result.map((p) => [p.a, p.b, p.weight])).toEqual([
      ['a.ts', 'h1.ts', 0.5],
      ['a.ts', 'b.ts', 0.5],
      ['h1.ts', 'h2.ts', 0.2],
    ]);
  });
});
