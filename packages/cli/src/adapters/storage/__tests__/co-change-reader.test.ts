import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoChangeReader } from '../co-change-reader.js';
import type { CoChangeEntry, CoChangeMatrix } from '../../../core/types.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ctxo-co-change-reader-'));
  roots.push(root);
  return root;
}

function entry(file1: string, file2: string, frequency: number, sharedCommits: number): CoChangeEntry {
  return { file1, file2, sharedCommits, frequency };
}

function matrix(entries: CoChangeEntry[]): CoChangeMatrix {
  return { version: 1, timestamp: 1_000, entries };
}

function matrixPath(root: string): string {
  return join(root, 'index', 'co-changes.json');
}

/**
 * Writes the matrix file and sets its mtime to `minute` past a fixed date. Two writes inside one timer
 * tick would otherwise get the same mtime, and the tests below are about what the reader does when the
 * mtime does or does not change.
 */
function writeMatrixFile(root: string, content: unknown, minute: number): void {
  mkdirSync(join(root, 'index'), { recursive: true });
  const path = matrixPath(root);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf-8');
  const when = new Date(Date.UTC(2026, 0, 1, 0, minute));
  utimesSync(path, when, when);
}

it('CoChangeReader returns a map for a valid file, undefined for missing or invalid files, and re-reads after mtime changes', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const root = tempRoot();
  const reader = new CoChangeReader(root);

  // No file yet: nothing to read.
  expect(reader.readCoChangeMap()).toBeUndefined();

  // A valid matrix: every entry is reachable from both of its files.
  writeMatrixFile(root, matrix([entry('src/a.ts', 'src/b.ts', 0.8, 4)]), 1);
  const first = reader.readCoChangeMap();
  expect(first?.get('src/a.ts')).toEqual([entry('src/a.ts', 'src/b.ts', 0.8, 4)]);
  expect(first?.get('src/b.ts')).toEqual([entry('src/a.ts', 'src/b.ts', 0.8, 4)]);

  // Rewritten with a newer mtime: the reader reads it again.
  writeMatrixFile(root, matrix([entry('src/a.ts', 'src/c.ts', 0.6, 3)]), 2);
  const second = reader.readCoChangeMap();
  expect(second?.get('src/a.ts')).toEqual([entry('src/a.ts', 'src/c.ts', 0.6, 3)]);
  expect(second?.has('src/b.ts')).toBe(false);

  // Invalid content: not JSON, then JSON that is not a matrix.
  writeMatrixFile(root, '{ not json', 3);
  expect(reader.readCoChangeMap()).toBeUndefined();
  writeMatrixFile(root, { version: 1, timestamp: 1 }, 4);
  expect(reader.readCoChangeMap()).toBeUndefined();

  // Repaired: valid again.
  writeMatrixFile(root, matrix([entry('src/a.ts', 'src/b.ts', 0.8, 4)]), 5);
  expect(reader.readCoChangeMap()?.size).toBe(2);

  // Gone again: nothing to read.
  rmSync(matrixPath(root));
  expect(reader.readCoChangeMap()).toBeUndefined();
});

it('CoChangeReader keeps serving the parsed map while mtime and size are unchanged', () => {
  const root = tempRoot();
  const reader = new CoChangeReader(root);
  writeMatrixFile(root, matrix([entry('src/a.ts', 'src/b.ts', 0.8, 4)]), 1);

  const first = reader.readCoChangeMap();
  expect(reader.readCoChangeMap()).toBe(first);

  // Same byte length and same mtime: only the cache can still answer with the old frequency.
  writeMatrixFile(root, matrix([entry('src/a.ts', 'src/b.ts', 0.7, 4)]), 1);
  expect(reader.readCoChangeMap()).toBe(first);
  expect(first?.get('src/a.ts')?.[0]?.frequency).toBe(0.8);
});

it('CoChangeReader forgets the cached map when the file is deleted', () => {
  const root = tempRoot();
  const reader = new CoChangeReader(root);
  writeMatrixFile(root, matrix([entry('src/a.ts', 'src/b.ts', 0.8, 4)]), 1);
  expect(reader.readCoChangeMap()?.get('src/a.ts')?.[0]?.frequency).toBe(0.8);

  rmSync(matrixPath(root));
  expect(reader.readCoChangeMap()).toBeUndefined();

  // Recreated with the same size and mtime but other content: nothing cached may answer for it.
  writeMatrixFile(root, matrix([entry('src/a.ts', 'src/b.ts', 0.7, 4)]), 1);
  expect(reader.readCoChangeMap()?.get('src/a.ts')?.[0]?.frequency).toBe(0.7);
});

it('CoChangeReader re-reads when the size changed although the mtime did not', () => {
  const root = tempRoot();
  const reader = new CoChangeReader(root);
  writeMatrixFile(root, matrix([entry('src/a.ts', 'src/b.ts', 0.8, 4)]), 1);
  expect(reader.readCoChangeMap()?.get('src/a.ts')).toHaveLength(1);

  writeMatrixFile(root, matrix([entry('src/a.ts', 'src/b.ts', 0.8, 4), entry('src/a.ts', 'src/c.ts', 0.6, 3)]), 1);
  expect(reader.readCoChangeMap()?.get('src/a.ts')).toHaveLength(2);
});

it('CoChangeReader warns once per invalid file version and says nothing about a missing file', () => {
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
  const root = tempRoot();
  const reader = new CoChangeReader(root);

  expect(reader.readCoChangeMap()).toBeUndefined();
  expect(reader.readCoChangeMap()).toBeUndefined();
  expect(warn).not.toHaveBeenCalled();

  writeMatrixFile(root, '{ not json', 1);
  expect(reader.readCoChangeMap()).toBeUndefined();
  expect(reader.readCoChangeMap()).toBeUndefined();
  expect(reader.readCoChangeMap()).toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain('co-changes.json');
  expect(String(warn.mock.calls[0]?.[0])).toContain('is not valid JSON');

  // A new version of the file that is invalid again is news, so it warns again.
  writeMatrixFile(root, { version: 2, timestamp: 1, entries: [] }, 2);
  expect(reader.readCoChangeMap()).toBeUndefined();
  expect(reader.readCoChangeMap()).toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(2);
  expect(String(warn.mock.calls[1]?.[0])).toContain('is not a valid co-change matrix (version:');
});

it('CoChangeReader returns undefined and warns when the file cannot be read', () => {
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
  const root = tempRoot();
  // A folder where the file should be: it exists, but reading it fails.
  mkdirSync(matrixPath(root), { recursive: true });

  const reader = new CoChangeReader(root);
  expect(reader.readCoChangeMap()).toBeUndefined();
  expect(reader.readCoChangeMap()).toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain('cannot be read');
});

it.each<[string, unknown]>([
  ['an array', []],
  ['null', null],
  ['a wrong version', { version: 2, timestamp: 1, entries: [] }],
  ['a missing timestamp', { version: 1, entries: [] }],
  ['a missing entries list', { version: 1, timestamp: 1 }],
  ['a frequency above 1', matrix([entry('src/a.ts', 'src/b.ts', 1.5, 2)])],
  ['a negative frequency', matrix([entry('src/a.ts', 'src/b.ts', -0.1, 2)])],
  ['a shared count of zero', matrix([entry('src/a.ts', 'src/b.ts', 0.8, 0)])],
  ['an empty file name', matrix([entry('', 'src/b.ts', 0.8, 2)])],
  ['a malformed window', { ...matrix([]), window: { maxCommits: 0 } }],
])('CoChangeReader rejects a file with %s', (_label, content) => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const root = tempRoot();
  writeMatrixFile(root, content, 1);

  expect(new CoChangeReader(root).readCoChangeMap()).toBeUndefined();
});

it('CoChangeReader accepts a matrix without window metadata, one with it, one with unknown keys, and an empty one', () => {
  const root = tempRoot();
  const reader = new CoChangeReader(root);
  const entries = [entry('src/a.ts', 'src/b.ts', 0.8, 4)];
  const window = {
    maxCommits: 2000, head: 'abc1234', commitsScanned: 10, commitsUsed: 9, massSkipped: 1, maxFilesPerCommit: 30, minShared: 2,
  };

  // Written before the window was recorded.
  writeMatrixFile(root, { version: 1, timestamp: 1, entries }, 1);
  expect(reader.readCoChangeMap()?.get('src/a.ts')).toEqual(entries);

  writeMatrixFile(root, { version: 1, timestamp: 1, window, entries }, 2);
  expect(reader.readCoChangeMap()?.get('src/a.ts')).toEqual(entries);

  // A newer Ctxo may add keys: they are dropped, not rejected.
  writeMatrixFile(root, { version: 1, timestamp: 1, window, entries, extra: { future: true } }, 3);
  expect(reader.readCoChangeMap()?.get('src/a.ts')).toEqual(entries);

  // A matrix without pairs is a matrix: an empty map, not "no matrix".
  writeMatrixFile(root, { version: 1, timestamp: 1, window, entries: [] }, 4);
  const empty = reader.readCoChangeMap();
  expect(empty).toBeDefined();
  expect(empty?.size).toBe(0);
});
