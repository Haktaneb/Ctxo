import { describe, it, expect } from 'vitest';
import type { FileChange, RangeCommit } from '@ctxo/cli/internal';
import { computeTouched, type TouchedInput } from '../touched.js';
import type { DomainContext, DomainRegistry } from '../registry.js';
import type { Ownership } from '../ownership.js';

function ctx(id: string, prefix: string, card?: string): DomainContext {
  return { id, name: id, ...(card ? { card } : {}), paths: [`${prefix}/**`], rung: 'named', contracts: {} };
}

const REGISTRY: DomainRegistry = {
  version: 1,
  contexts: [ctx('lending', 'src/lending', 'docs/lending.md'), ctx('billing', 'src/billing', 'docs/billing.md'), ctx('plain', 'src/plain')],
  unownedAllow: ['src/shared/**'],
  glossary: 'g.md',
  contextMap: 'm.md',
};

const OWNERSHIP: Ownership = {
  owners: (path) => REGISTRY.contexts.filter((c) => path.startsWith(c.paths[0]!.replace('**', ''))).map((c) => c.id),
  ownerOf: () => undefined,
  isAllowedUnowned: (path) => path.startsWith('src/shared/'),
  isContract: () => false,
};

const isTestFile = (path: string): boolean => path.includes('.test.');
const mod = (path: string, oldPath?: string): FileChange => ({ status: oldPath ? 'R' : 'M', path, ...(oldPath ? { oldPath } : {}) });

function commit(hash: string, changes: FileChange[], trailers: string[] = []): RangeCommit {
  return { hash, subject: 's', isMerge: false, trailers, changes };
}

function run(partial: Partial<TouchedInput>) {
  return computeTouched({
    registry: REGISTRY,
    ownership: OWNERSHIP,
    isTestFile,
    commits: [],
    workingTree: [],
    mode: 'all',
    ...partial,
  });
}

describe('computeTouched', () => {
  it('a changed non-test file marks its context touched; a test file does not', () => {
    const report = run({
      commits: [commit('a'.repeat(40), [mod('src/lending/a.cs'), mod('src/billing/b.test.cs')])],
    });

    expect(report.contexts.map((c) => c.id)).toEqual(['lending']);
    expect(report.contexts[0]?.files).toEqual(['src/lending/a.cs']);
    expect(report.unresolved).toEqual(['lending']);
  });

  it('a card change wins over an acknowledgement', () => {
    const report = run({
      commits: [commit('b'.repeat(40), [mod('src/lending/a.cs'), mod('docs/lending.md')], ['lending (not needed)'])],
    });

    expect(report.contexts[0]).toMatchObject({ id: 'lending', cardChanged: true, status: 'card-changed' });
    expect(report.contexts[0]?.acknowledged).toBeUndefined();
    expect(report.unresolved).toEqual([]);
  });

  it('the acknowledgement comes from the newest commit naming the context', () => {
    const report = run({
      commits: [
        commit('1111111' + 'f'.repeat(33), [mod('src/lending/a.cs')], ['lending (newest)']),
        commit('2222222' + 'f'.repeat(33), [mod('src/lending/b.cs')], ['lending (older)']),
      ],
    });

    expect(report.contexts[0]?.status).toBe('acknowledged');
    expect(report.contexts[0]?.acknowledged).toEqual({ commit: '1111111', reason: 'newest' });
  });

  it('a context without a card is no-card, never unresolved', () => {
    const report = run({ commits: [commit('c'.repeat(40), [mod('src/plain/x.cs')])] });

    expect(report.contexts[0]).toMatchObject({ id: 'plain', status: 'no-card' });
    expect(report.contexts[0]?.card).toBeUndefined();
    expect(report.unresolved).toEqual([]);
  });

  it('renames count both the old and the new path', () => {
    const report = run({ commits: [commit('d'.repeat(40), [mod('src/billing/new.cs', 'src/lending/old.cs')])] });

    expect(report.contexts.map((c) => c.id)).toEqual(['billing', 'lending']);
  });

  it('an unknown id in a trailer gives one warning', () => {
    const report = run({
      commits: [commit('e'.repeat(40), [mod('src/lending/a.cs')], ['ghost, ghost (why)', 'lending'])],
    });

    expect(report.warnings).toEqual(['Domain-Unchanged in eeeeeee names unknown context "ghost"']);
  });

  it('staged mode ignores commits', () => {
    const report = run({
      mode: 'staged',
      commits: [commit('f'.repeat(40), [mod('src/billing/a.cs')], ['lending'])],
      workingTree: [mod('src/lending/a.cs')],
    });

    expect(report.contexts.map((c) => c.id)).toEqual(['lending']);
    expect(report.contexts[0]?.status).toBe('unresolved');
    expect(report.warnings).toEqual([]);
  });

  it('committed mode ignores the working tree', () => {
    const report = run({ mode: 'committed', workingTree: [mod('src/lending/a.cs')] });

    expect(report.contexts).toEqual([]);
  });

  it('unowned lists indexed, non-test, non-allowlisted changed files', () => {
    const report = run({
      indexedFiles: new Set(['src/other/a.cs', 'src/other/a.test.cs', 'src/shared/s.cs', 'src/lending/a.cs']),
      workingTree: [mod('src/other/a.cs'), mod('src/other/a.test.cs'), mod('src/shared/s.cs'), mod('src/other/notindexed.cs'), mod('src/lending/a.cs')],
    });

    expect(report.unowned).toEqual(['src/other/a.cs']);
  });

  it('lists are in codepoint order', () => {
    const report = run({
      indexedFiles: new Set(['z/b.cs', 'Z/a.cs', 'a/c.cs']),
      commits: [commit('a'.repeat(40), [mod('src/lending/b.cs'), mod('src/billing/z.cs'), mod('src/lending/B.cs'), mod('z/b.cs'), mod('Z/a.cs'), mod('a/c.cs')], ['zeta, alpha'])],
    });

    expect(report.contexts.map((c) => c.id)).toEqual(['billing', 'lending']);
    expect(report.contexts[1]?.files).toEqual(['src/lending/B.cs', 'src/lending/b.cs']);
    expect(report.unowned).toEqual(['Z/a.cs', 'a/c.cs', 'z/b.cs']);
    expect(report.warnings).toEqual([
      'Domain-Unchanged in aaaaaaa names unknown context "alpha"',
      'Domain-Unchanged in aaaaaaa names unknown context "zeta"',
    ]);
  });
});
