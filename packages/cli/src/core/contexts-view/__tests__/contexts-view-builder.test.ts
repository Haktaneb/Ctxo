import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../config/config-schema.js';
import { resolveContextsViewConfig, type ResolvedContextsViewConfig } from '../../config/load-config.js';
import type { CoChangeEntry, EdgeKind, FileIndex, SymbolKind, SymbolNode } from '../../types.js';
import { buildContextsView, type ContextCandidate, type ContextsViewInput } from '../contexts-view-builder.js';

const DEFAULTS = resolveContextsViewConfig(DEFAULT_CONFIG);

type Edge = [from: string, to: string, kind: EdgeKind];

function sym(file: string, name: string, kind: SymbolKind = 'function'): SymbolNode {
  return { symbolId: `${file}::${name}::${kind}`, name, kind, startLine: 1, endLine: 2 };
}

function fileIndex(file: string, symbols: SymbolNode[], edges: Edge[] = []): FileIndex {
  return {
    file,
    lastModified: 1,
    symbols,
    edges: edges.map(([from, to, kind]) => ({ from, to, kind })),
    intent: [],
    antiPatterns: [],
  };
}

/** One function per file, named after the file's base name. */
function fnOf(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1).replace(/\.ts$/, '');
  return `${file}::${base}::function`;
}

function plain(file: string, edges: Edge[] = [], extra: SymbolNode[] = []): FileIndex {
  const base = file.slice(file.lastIndexOf('/') + 1).replace(/\.ts$/, '');
  return fileIndex(file, [sym(file, base), ...extra], edges);
}

/** Files that call each other in every pair (one `calls` edge per pair). */
function clique(files: string[], extraEdges: Record<string, Edge[]> = {}): FileIndex[] {
  return files.map((file, i) =>
    plain(file, [
      ...files.slice(i + 1).map((other): Edge => [fnOf(file), fnOf(other), 'calls']),
      ...(extraEdges[file] ?? []),
    ]),
  );
}

function withSettings(patch: Partial<ResolvedContextsViewConfig>): ResolvedContextsViewConfig {
  return { ...DEFAULTS, ...patch };
}

function input(indices: FileIndex[], overrides: Partial<ContextsViewInput> = {}): ContextsViewInput {
  return {
    indices,
    isNode: () => true,
    godNodeFiles: new Set(),
    filePageRank: new Map(),
    settings: DEFAULTS,
    commitSha: 'abc1234',
    ...overrides,
  };
}

function fingerprintOf(files: readonly string[]): string {
  return createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 16);
}

function byLabel(candidates: readonly ContextCandidate[], label: string): ContextCandidate {
  const found = candidates.find((candidate) => candidate.label === label);
  if (!found) throw new Error(`no candidate labelled ${label}`);
  return found;
}

const DB = 'src/shared/db.ts';
const DB_FUNCTIONS = Array.from({ length: 40 }, (_, i) => `q${String(i).padStart(2, '0')}`);
const BILLING = [1, 2, 3, 4, 5].map((i) => `src/billing/b${i}.ts`);
const SHIPPING = [1, 2, 3, 4, 5].map((i) => `src/shipping/s${i}.ts`);

/**
 * Spec 7.5: two areas, each a chain of one `imports` edge per neighbour, that share only `src/shared/db.ts`.
 * Every area file calls all 40 functions of the hub.
 */
function hubFixture(extra: Record<string, SymbolNode[]> = {}): FileIndex[] {
  const db = fileIndex(DB, DB_FUNCTIONS.map((name) => sym(DB, name)));
  const area = (files: string[]) =>
    files.map((file, i) => {
      const edges: Edge[] = DB_FUNCTIONS.map((name): Edge => [fnOf(file), `${DB}::${name}::function`, 'calls']);
      const next = files[i + 1];
      if (next) edges.push([fnOf(file), fnOf(next), 'imports']);
      return plain(file, edges, extra[file] ?? []);
    });
  return [db, ...area(BILLING), ...area(SHIPPING)];
}

describe('buildContextsView', () => {
  it('buildContextsView separates two areas that share only a hub and merges them with hub damping off', () => {
    const damped = buildContextsView(input(hubFixture()));

    expect(damped.candidates.map(({ id, label, files }) => ({ id, label, files }))).toEqual([
      { id: 1, label: 'src/billing', files: BILLING },
      { id: 2, label: 'src/shipping', files: SHIPPING },
    ]);
    expect(damped.hubs).toEqual([
      { file: DB, reasons: ['fan-in'], dependents: 10, damping: 0.279, candidate: 1 },
    ]);

    const undamped = buildContextsView(
      input(hubFixture(), { settings: withSettings({ hubs: { ...DEFAULTS.hubs, auto: false } }) }),
    );

    expect(undamped.hubs).toEqual([]);
    expect(undamped.candidates).toHaveLength(1);
    expect(undamped.candidates[0]!.files).toEqual([...BILLING, DB, ...SHIPPING]);
    expect(undamped.candidates[0]!.fileCount).toBe(11);
    // Common directory `src` is the root of every node, so the first member (no PageRank) names it.
    expect(undamped.candidates[0]!.label).toBe('src/billing');
  });

  it('configured hubs lose every edge and are reported without a candidate', () => {
    const view = buildContextsView(
      input(hubFixture(), { settings: withSettings({ hubs: { ...DEFAULTS.hubs, paths: ['src/shared/**'] } }) }),
    );

    expect(view.hubs).toEqual([{ file: DB, reasons: ['configured', 'fan-in'], dependents: 10, damping: 0 }]);
    expect('candidate' in view.hubs[0]!).toBe(false);
    expect(view.candidates.map((candidate) => candidate.files)).toEqual([BILLING, SHIPPING]);
    expect(view.coverage).toEqual({ files: 11, covered: 10, ratio: 0.909 });
  });

  it('a hub goes to the candidate of its strongest neighbour inside a candidate, past stronger unclustered ones', () => {
    // u.ts calls all three hub functions (the hub's strongest edge) but has no other edge, so it ends up
    // unclustered; a/x.ts calls one hub function and sits in candidate 1.
    const hubFunctions = ['h1', 'h2', 'h3'].map((name) => sym('h.ts', name));
    const view = buildContextsView(
      input(
        [
          fileIndex('h.ts', hubFunctions),
          plain(
            'u.ts',
            hubFunctions.map((target): Edge => [fnOf('u.ts'), target.symbolId, 'calls']),
          ),
          ...clique(['a/x.ts', 'a/y.ts', 'a/z.ts'], { 'a/x.ts': [[fnOf('a/x.ts'), 'h.ts::h1::function', 'calls']] }),
        ],
        { godNodeFiles: new Set(['h.ts']) },
      ),
    );

    expect(view.unclustered).toEqual({ count: 1, files: ['u.ts'] });
    expect(view.candidates.map((candidate) => [candidate.id, candidate.files])).toEqual([
      [1, ['a/x.ts', 'a/y.ts', 'a/z.ts']],
    ]);
    expect(view.hubs).toEqual([{ file: 'h.ts', reasons: ['god-node'], dependents: 2, damping: 0.5, candidate: 1 }]);
  });

  it('ids are sequential by size desc, then label, and fingerprints hash the sorted members', () => {
    const view = buildContextsView(
      input([
        ...clique(['b/x.ts', 'b/y.ts', 'b/z.ts']),
        ...clique(['z/w.ts', 'z/x.ts', 'z/y.ts', 'z/z.ts']),
        ...clique(['a/x.ts', 'a/y.ts', 'a/z.ts']),
      ]),
    );

    expect(view.candidates.map(({ id, label, fileCount }) => ({ id, label, fileCount }))).toEqual([
      { id: 1, label: 'z', fileCount: 4 },
      { id: 2, label: 'a', fileCount: 3 },
      { id: 3, label: 'b', fileCount: 3 },
    ]);
    for (const candidate of view.candidates) {
      expect(candidate.files).toEqual([...candidate.files].sort());
      expect(candidate.fingerprint).toBe(fingerprintOf(candidate.files));
      expect(candidate.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('labels use the longest common directory, else the directory of the top-PageRank member', () => {
    const indices = [
      plain('src/billing/a.ts', [[fnOf('src/billing/a.ts'), fnOf('src/billing/sub/b.ts'), 'calls']]),
      plain('src/billing/sub/b.ts'),
      plain('lib/x.ts', [[fnOf('lib/x.ts'), fnOf('src/y.ts'), 'calls']]),
      plain('src/y.ts'),
      plain('a.ts', [[fnOf('a.ts'), fnOf('b.ts'), 'calls']]),
      plain('b.ts'),
    ];
    const settings = withSettings({ minCandidateFiles: 2 });
    const labelOf = (view: ReturnType<typeof buildContextsView>, file: string) =>
      view.candidates.find((candidate) => candidate.files.includes(file))!.label;

    const yRanksHigher = buildContextsView(
      input(indices, { settings, filePageRank: new Map([['lib/x.ts', 0.1], ['src/y.ts', 0.9]]) }),
    );
    expect(labelOf(yRanksHigher, 'src/billing/a.ts')).toBe('src/billing');
    expect(labelOf(yRanksHigher, 'lib/x.ts')).toBe('src');
    expect(labelOf(yRanksHigher, 'a.ts')).toBe('.');

    const xRanksHigher = buildContextsView(
      input(indices, { settings, filePageRank: new Map([['lib/x.ts', 0.9], ['src/y.ts', 0.1]]) }),
    );
    expect(labelOf(xRanksHigher, 'lib/x.ts')).toBe('lib');
  });

  it('labels fall back to the top-PageRank member\'s directory when the common directory is the root of every node', () => {
    const billing = 'src/App/Billing/x.ts';
    const shipping = 'src/App/Shipping/y.ts';
    const loansA = 'src/App/Loans/a.ts';
    const loansB = 'src/App/Loans/b.ts';
    const view = buildContextsView(
      input(
        [
          plain(billing, [[fnOf(billing), fnOf(shipping), 'calls']]),
          plain(shipping),
          plain(loansA, [[fnOf(loansA), fnOf(loansB), 'calls']]),
          plain(loansB),
        ],
        {
          settings: withSettings({ minCandidateFiles: 2 }),
          filePageRank: new Map([[billing, 0.9], [shipping, 0.1], [loansA, 0.5], [loansB, 0.4]]),
        },
      ),
    );

    expect(view.candidates.map((candidate) => [candidate.label, candidate.files])).toEqual([
      ['src/App/Billing', [billing, shipping]],
      ['src/App/Loans', [loansA, loansB]],
    ]);
  });

  it('a view whose nodes share no directory keeps the repo-root rule', () => {
    const view = buildContextsView(
      input([plain('a.ts', [[fnOf('a.ts'), fnOf('b.ts'), 'calls']]), plain('b.ts'), ...clique(['src/x/p.ts', 'src/x/q.ts'])], {
        settings: withSettings({ minCandidateFiles: 2 }),
      }),
    );

    expect(byLabel(view.candidates, '.').files).toEqual(['a.ts', 'b.ts']);
    expect(byLabel(view.candidates, 'src/x').files).toEqual(['src/x/p.ts', 'src/x/q.ts']);
  });

  it('labels treat backslashes as directory separators', () => {
    const view = buildContextsView(
      input(
        [
          plain('src\\billing\\a.ts', [[fnOf('src\\billing\\a.ts'), fnOf('src\\billing\\b.ts'), 'calls']]),
          plain('src\\billing\\b.ts'),
        ],
        { settings: withSettings({ minCandidateFiles: 2 }) },
      ),
    );

    expect(view.candidates.map((candidate) => [candidate.label, candidate.files])).toEqual([
      ['src/billing', ['src\\billing\\a.ts', 'src\\billing\\b.ts']],
    ]);
  });

  it('cohesion is internal weight over internal plus boundary weight', () => {
    // Each clique pair carries one `calls` edge (weight 1); the bridge carries one `imports` edge, so its weight
    // is log2(1.5) / log2(2). Hub edges are not boundary: the damped db edges leave billing at cohesion 1.
    const view = buildContextsView(
      input([
        ...clique(['a/x.ts', 'a/y.ts', 'a/z.ts'], { 'a/x.ts': [[fnOf('a/x.ts'), fnOf('b/x.ts'), 'imports']] }),
        ...clique(['b/x.ts', 'b/y.ts', 'b/z.ts']),
      ]),
    );
    const bridge = Math.round((Math.log2(1.5) / Math.log2(2)) * 1e6) / 1e6;
    const expected = Math.round((3 / (3 + bridge)) * 1000) / 1000;

    expect(view.candidates.map((candidate) => [candidate.label, candidate.cohesion])).toEqual([
      ['a', expected],
      ['b', expected],
    ]);
    expect(expected).toBe(0.837);

    const hub = buildContextsView(input(hubFixture()));
    expect(byLabel(hub.candidates, 'src/billing').cohesion).toBe(1);
  });

  it('crossEdges count symbol edges to other candidates by kind', () => {
    const view = buildContextsView(
      input([
        ...clique(['a/x.ts', 'a/y.ts', 'a/z.ts'], {
          'a/x.ts': [
            [fnOf('a/x.ts'), fnOf('b/x.ts'), 'calls'],
            [fnOf('a/x.ts'), 'b/x.ts::helper::function', 'calls'],
          ],
          'a/y.ts': [[fnOf('a/y.ts'), fnOf('b/y.ts'), 'imports']],
        }),
        ...clique(['b/x.ts', 'b/y.ts', 'b/z.ts'], {
          'b/z.ts': [[fnOf('b/z.ts'), fnOf('a/z.ts'), 'uses']],
        }).map((index) =>
          index.file === 'b/x.ts' ? { ...index, symbols: [...index.symbols, sym('b/x.ts', 'helper')] } : index,
        ),
      ]),
    );
    const a = byLabel(view.candidates, 'a');
    const b = byLabel(view.candidates, 'b');

    expect(a.crossEdges).toEqual([{ candidate: b.id, total: 3, byKind: { calls: 2, imports: 1 } }]);
    expect(b.crossEdges).toEqual([{ candidate: a.id, total: 1, byKind: { uses: 1 } }]);
  });

  it('coChangePairs keep the top 10 crossing pairs', () => {
    const left = ['a/w.ts', 'a/x.ts', 'a/y.ts', 'a/z.ts'];
    const right = ['b/w.ts', 'b/x.ts', 'b/y.ts', 'b/z.ts'];
    const entries: CoChangeEntry[] = [{ file1: 'a/w.ts', file2: 'a/x.ts', sharedCommits: 9, frequency: 0.5 }];
    let frequency = 12;
    for (const l of left) {
      for (const r of right.slice(0, 3)) {
        entries.push({ file1: l, file2: r, sharedCommits: 5, frequency: frequency / 100 });
        frequency--;
      }
    }
    const coChangeMap = new Map<string, CoChangeEntry[]>();
    for (const entry of entries) {
      for (const file of [entry.file1, entry.file2]) coChangeMap.set(file, [...(coChangeMap.get(file) ?? []), entry]);
    }

    const view = buildContextsView(input([...clique(left), ...clique(right)], { coChangeMap }));
    const a = byLabel(view.candidates, 'a');
    const b = byLabel(view.candidates, 'b');

    expect(a.coChangePairs).toHaveLength(10);
    expect(a.coChangePairs[0]).toEqual({
      file: 'a/w.ts',
      otherFile: 'b/w.ts',
      otherCandidate: b.id,
      frequency: 0.12,
      sharedCommits: 5,
    });
    expect(a.coChangePairs.map((p) => p.frequency)).toEqual([
      0.12, 0.11, 0.1, 0.09, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03,
    ]);
    expect(b.coChangePairs[0]).toEqual({
      file: 'b/w.ts',
      otherFile: 'a/w.ts',
      otherCandidate: a.id,
      frequency: 0.12,
      sharedCommits: 5,
    });
    expect(b.coChangePairs).toHaveLength(10);
  });

  it('coverage counts candidate files plus assigned hubs over all nodes', () => {
    const view = buildContextsView(input([...hubFixture(), plain('src/lonely.ts')]));

    expect(view.coverage).toEqual({ files: 12, covered: 11, ratio: 0.917 });
    expect(view.unclustered).toEqual({ count: 1, files: ['src/lonely.ts'] });
  });

  it('the same input in reversed order gives byte-identical JSON', () => {
    const extra: Record<string, SymbolNode[]> = {
      'src/billing/b1.ts': [
        sym('src/billing/b1.ts', 'Invoice', 'class'),
        sym('src/billing/b1.ts', 'Invoice.total', 'method'),
        sym('src/billing/b1.ts', 'InvoiceStatus', 'type'),
        sym('src/billing/b1.ts', 'InvoiceStatus.Paid', 'variable'),
      ],
      'src/shipping/s1.ts': [
        sym('src/shipping/s1.ts', 'Invoice', 'class'),
        sym('src/shipping/s1.ts', 'Invoice.weight', 'method'),
        sym('src/shipping/s1.ts', 'Parcel', 'interface'),
      ],
    };
    const entries: CoChangeEntry[] = [
      { file1: 'src/billing/b2.ts', file2: 'src/shipping/s2.ts', sharedCommits: 3, frequency: 0.02 },
      { file1: 'src/billing/b1.ts', file2: 'src/billing/b3.ts', sharedCommits: 4, frequency: 0.4 },
    ];
    const mapOf = (list: CoChangeEntry[]) => {
      const map = new Map<string, CoChangeEntry[]>();
      for (const entry of list) {
        for (const file of [entry.file1, entry.file2]) map.set(file, [...(map.get(file) ?? []), entry]);
      }
      return map;
    };
    const pageRank = [...BILLING, ...SHIPPING, DB].map((file, i): [string, number] => [file, (i + 1) / 100]);

    const forward = buildContextsView(
      input([...hubFixture(extra), plain('src/lonely.ts')], {
        coChangeMap: mapOf(entries),
        filePageRank: new Map(pageRank),
      }),
    );
    const reversed = buildContextsView(
      input(
        [...hubFixture(extra), plain('src/lonely.ts')]
          .reverse()
          .map((index) => ({ ...index, symbols: [...index.symbols].reverse(), edges: [...index.edges].reverse() })),
        { coChangeMap: mapOf([...entries].reverse()), filePageRank: new Map([...pageRank].reverse()) },
      ),
    );

    expect(forward.candidates).toHaveLength(2);
    expect(forward.candidates[0]!.coChangePairs).toHaveLength(1);
    expect(forward.collisions.map((collision) => collision.name)).toEqual(['invoice']);
    expect(forward.candidates[0]!.topTerms.length).toBeGreaterThan(0);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));

    // Regression: b/x.ts declares Foo as a type and as a variable, and the Foo::class edge resolves by
    // file::name. Symbol order inside a file must not decide which Foo it lands on.
    const fooIndices = () => [
      ...clique(['a/x.ts', 'a/y.ts', 'a/z.ts'], {
        'a/x.ts': [
          [fnOf('a/x.ts'), 'b/x.ts::Foo::type', 'uses'],
          [fnOf('a/x.ts'), 'b/x.ts::Foo::class', 'uses'],
        ],
      }),
      ...clique(['b/x.ts', 'b/y.ts', 'b/z.ts']).map((index) =>
        index.file === 'b/x.ts'
          ? { ...index, symbols: [...index.symbols, sym('b/x.ts', 'Foo', 'type'), sym('b/x.ts', 'Foo', 'variable')] }
          : index,
      ),
    ];
    const fooForward = buildContextsView(input(fooIndices()));
    const fooReversed = buildContextsView(
      input(
        fooIndices()
          .reverse()
          .map((index) => ({ ...index, symbols: [...index.symbols].reverse(), edges: [...index.edges].reverse() })),
      ),
    );

    expect(byLabel(fooForward.candidates, 'a').crossEdges).toEqual([
      { candidate: byLabel(fooForward.candidates, 'b').id, total: 2, byKind: { uses: 2 } },
    ]);
    expect(JSON.stringify(fooReversed)).toBe(JSON.stringify(fooForward));
  });

  it('an index without edges puts every node in unclustered', () => {
    const view = buildContextsView(input([plain('c.ts'), plain('a.ts'), plain('b.ts')]));

    expect(view.candidates).toEqual([]);
    expect(view.hubs).toEqual([]);
    expect(view.unclustered).toEqual({ count: 3, files: ['a.ts', 'b.ts', 'c.ts'] });
    expect(view.coverage).toEqual({ files: 3, covered: 0, ratio: 0 });
  });

  it('no node gives an empty view with ratio 0', () => {
    const empty = {
      version: 1,
      commitSha: 'abc1234',
      settings: DEFAULTS,
      coverage: { files: 0, covered: 0, ratio: 0 },
      candidates: [],
      hubs: [],
      unclustered: { count: 0, files: [] },
      collisions: [],
    };

    expect(buildContextsView(input([]))).toEqual(empty);
    // Everything excluded (contextsView.exclude: ["**"]) leaves no node either.
    expect(buildContextsView(input(hubFixture(), { isNode: () => false }))).toEqual(empty);
  });

  it('a candidate under a non-ASCII directory with spaces keeps that spelling as its label and the same fingerprint across runs', () => {
    const files = ['src/şube kaydı/a.ts', 'src/şube kaydı/b.ts', 'src/şube kaydı/c.ts'];
    const first = buildContextsView(input(clique(files)));
    const second = buildContextsView(input(clique(files).reverse()));

    expect(first.candidates).toHaveLength(1);
    expect(first.candidates[0]!.label).toBe('src/şube kaydı');
    expect(first.candidates[0]!.files).toEqual(files);
    expect(first.candidates[0]!.fingerprint).toBe(fingerprintOf(files));
    expect(second.candidates[0]!.fingerprint).toBe(first.candidates[0]!.fingerprint);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
