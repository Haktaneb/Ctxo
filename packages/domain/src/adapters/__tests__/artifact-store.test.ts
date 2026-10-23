import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextHistoryEntry } from '../../core/context-metrics.js';
import { DomainArtifactStore, type BoundariesArtifact, type ContextsArtifact } from '../artifact-store.js';

let root: string;
let domainDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctxo-domain-store-'));
  domainDir = join(root, 'index', 'domain');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const CONTEXTS: ContextsArtifact = {
  ctxoArtifact: 'domain-contexts',
  version: 1,
  registryHash: 'h1',
  contexts: [{ id: 'lending', name: 'Lending', rung: 'named', card: 'docs/domain/lending.md', fileCount: 1, files: ['src/Lending/Loan.ts'] }],
  unowned: { count: 0, files: [] },
  multiplyOwned: [],
  movedFiles: [],
};

const BOUNDARIES: BoundariesArtifact = {
  ctxoArtifact: 'domain-boundaries',
  version: 1,
  registryHash: 'h1',
  mode: 'by-rung',
  blockingRungs: ['bounded', 'boring'],
  crossEdges: [],
  violations: [],
};

function entry(commitSha: string, committedAt: number): ContextHistoryEntry {
  return { ctxoArtifact: 'domain-history', version: 1, commitSha, committedAt, registryHash: 'h1', contexts: [] };
}

const OLD = new Date('2001-01-01T00:00:00Z');

describe('DomainArtifactStore', () => {
  it('writeIfChanged leaves an equal file untouched', () => {
    const store = new DomainArtifactStore(root);

    expect(store.writeIfChanged('contexts.json', CONTEXTS)).toBe(true);
    const file = join(domainDir, 'contexts.json');
    utimesSync(file, OLD, OLD);

    expect(store.writeIfChanged('contexts.json', CONTEXTS)).toBe(false);
    expect(statSync(file).mtimeMs).toBe(OLD.getTime());
    expect(store.readContexts()).toEqual(CONTEXTS);

    expect(store.writeIfChanged('contexts.json', { ...CONTEXTS, registryHash: 'h2' })).toBe(true);
    expect(store.readContexts()?.registryHash).toBe('h2');
  });

  it('writeIfChanged ignores CRLF-only differences', () => {
    const store = new DomainArtifactStore(root);
    store.writeIfChanged('boundaries.json', BOUNDARIES);
    const file = join(domainDir, 'boundaries.json');
    const lf = readFileSync(file, 'utf-8');
    expect(lf).not.toContain('\r');
    writeFileSync(file, `﻿${lf.replace(/\n/g, '\r\n')}`, 'utf-8');
    utimesSync(file, OLD, OLD);

    expect(store.writeIfChanged('boundaries.json', BOUNDARIES)).toBe(false);
    expect(statSync(file).mtimeMs).toBe(OLD.getTime());
    expect(store.readBoundaries()).toEqual(BOUNDARIES);
  });

  it('writeHistory keeps one entry per commit and the newest ten by committer date', () => {
    const store = new DomainArtifactStore(root);
    for (let i = 0; i < 12; i++) store.writeHistory(entry(`abcdef${i.toString(16)}0123456789`, 1_700_000_000 + i * 10));
    // The same commit again, with other content: replaces, never duplicates.
    store.writeHistory({ ...entry('abcdefb0123456789', 1_700_000_110), registryHash: 'h2' });

    const files = readdirSync(join(domainDir, 'history')).sort();
    expect(files).toHaveLength(10);
    expect(files[0]).toBe('1700000020-abcdef2.json');
    expect(files[9]).toBe('1700000110-abcdefb.json');

    const history = store.readHistory();
    expect(history.map((h) => h.committedAt)).toEqual(Array.from({ length: 10 }, (_, i) => 1_700_000_110 - i * 10));
    expect(history[0]?.registryHash).toBe('h2');

    store.writeHistory(entry('fffffff', 1_700_000_500), 3);
    expect(readdirSync(join(domainDir, 'history'))).toHaveLength(3);
  });

  it('invalid artifacts read as missing', () => {
    const store = new DomainArtifactStore(root);
    expect(store.readContexts()).toBeUndefined();
    expect(store.readBoundaries()).toBeUndefined();
    expect(store.readHistory()).toEqual([]);

    mkdirSync(join(domainDir, 'history'), { recursive: true });
    writeFileSync(join(domainDir, 'contexts.json'), '{ not json', 'utf-8');
    writeFileSync(join(domainDir, 'boundaries.json'), JSON.stringify({ ...BOUNDARIES, ctxoArtifact: 'domain-contexts' }), 'utf-8');
    writeFileSync(join(domainDir, 'history', '1-aaaaaaa.json'), JSON.stringify({ ...entry('aaaaaaa', 1), version: 2 }), 'utf-8');
    writeFileSync(join(domainDir, 'history', '2-bbbbbbb.json'), JSON.stringify(entry('bbbbbbb', 2)), 'utf-8');

    expect(store.readContexts()).toBeUndefined();
    expect(store.readBoundaries()).toBeUndefined();
    expect(store.readHistory().map((h) => h.commitSha)).toEqual(['bbbbbbb']);
  });

  it('removeAll deletes the artifacts and the history, and nothing else', () => {
    const store = new DomainArtifactStore(root);
    store.writeIfChanged('contexts.json', CONTEXTS);
    store.writeIfChanged('boundaries.json', BOUNDARIES);
    store.writeHistory(entry('aaaaaaa', 1));
    writeFileSync(join(domainDir, 'Order.ts.json'), '{}', 'utf-8');

    store.removeAll();

    expect(existsSync(join(domainDir, 'contexts.json'))).toBe(false);
    expect(existsSync(join(domainDir, 'boundaries.json'))).toBe(false);
    expect(existsSync(join(domainDir, 'history'))).toBe(false);
    expect(existsSync(join(domainDir, 'Order.ts.json'))).toBe(true);
    store.removeAll();
  });

  describe('source index entries under index/domain/ (I1)', () => {
    const sourceEntry = (file: string): string => JSON.stringify({ file, lastModified: 1, symbols: [], edges: [] });

    function seed(): Record<string, string> {
      mkdirSync(join(domainDir, 'history'), { recursive: true });
      const entries: Record<string, string> = {
        [join(domainDir, 'history', 'order-history.ts.json')]: sourceEntry('domain/history/order-history.ts'),
        [join(domainDir, 'history', '5-abc1234.json')]: sourceEntry('domain/history/5-abc1234'),
        [join(domainDir, 'contexts.json')]: sourceEntry('domain/contexts'),
        [join(domainDir, 'boundaries.json')]: sourceEntry('domain/boundaries'),
      };
      for (const [path, text] of Object.entries(entries)) writeFileSync(path, text, 'utf-8');
      return entries;
    }

    const expectUntouched = (entries: Record<string, string>): void => {
      for (const [path, text] of Object.entries(entries)) expect(readFileSync(path, 'utf-8')).toBe(text);
    };

    it('removeAll keeps unmarked entries, including history/<file>.ts.json', () => {
      const entries = seed();
      new DomainArtifactStore(root).removeAll();
      expectUntouched(entries);
    });

    it('removeAll still removes marked artifacts and an emptied history folder', () => {
      const store = new DomainArtifactStore(root);
      store.writeIfChanged('contexts.json', CONTEXTS);
      store.writeHistory(entry('aaaaaaa', 1));
      writeFileSync(join(domainDir, 'history', '9-zzzzzzz.json'), JSON.stringify({ ...entry('zzzzzzz', 9), version: 2 }), 'utf-8');
      store.removeAll();
      expect(existsSync(join(domainDir, 'contexts.json'))).toBe(false);
      expect(existsSync(join(domainDir, 'history'))).toBe(false);
    });

    it('writeHistory cleanup and retention never delete an unmarked entry', () => {
      const entries = seed();
      const store = new DomainArtifactStore(root);
      store.writeHistory(entry('abc1234ffff', 1), 1);
      store.writeHistory(entry('def5678ffff', 2), 1);
      store.writeHistory(entry('abc1234ffff', 3), 1);
      expectUntouched(entries);
      expect(store.readHistory().map((h) => h.commitSha)).toEqual(['abc1234ffff']);
    });

    it('writeIfChanged refuses to overwrite an unmarked JSON file and reports no change', () => {
      const entries = seed();
      const store = new DomainArtifactStore(root);
      expect(store.writeIfChanged('contexts.json', CONTEXTS)).toBe(false);
      expect(store.writeIfChanged('boundaries.json', BOUNDARIES)).toBe(false);
      expectUntouched(entries);
    });

    it('writeIfChanged still replaces a corrupt (unparseable) or marked artifact', () => {
      mkdirSync(domainDir, { recursive: true });
      writeFileSync(join(domainDir, 'contexts.json'), '{ not json', 'utf-8');
      const store = new DomainArtifactStore(root);
      expect(store.writeIfChanged('contexts.json', CONTEXTS)).toBe(true);
      expect(store.writeIfChanged('contexts.json', { ...CONTEXTS, registryHash: 'h2' })).toBe(true);
    });
  });
});
