import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { leavesProject, readRepoText, readRepoTexts, repoFileExists, repoIsFile, SOURCE_SCAN_MAX_BYTES } from '../repo-files.js';

describe('readRepoTexts', () => {
  let parent: string;
  let root: string;

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'ctxo-domain-texts-'));
    root = join(parent, 'project');
    mkdirSync(join(root, 'src', 'dir'), { recursive: true });
    writeFileSync(join(root, 'src', 'b.ts'), 'plain', 'utf-8');
    writeFileSync(join(root, 'src', 'a.ts'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('// rule: LEND-03\n')]));
    writeFileSync(join(root, 'src', 'Z.ts'), 'upper', 'utf-8');
    writeFileSync(join(root, 'src', 'big.ts'), 'x'.repeat(101), 'utf-8');
    writeFileSync(join(root, 'src', 'limit.ts'), 'y'.repeat(100), 'utf-8');
    writeFileSync(join(root, 'src', 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
    writeFileSync(join(root, 'src', 'late-nul.ts'), Buffer.concat([Buffer.from('z'.repeat(8192)), Buffer.from([0x00])]));
    writeFileSync(join(parent, 'secret.ts'), 'secret', 'utf-8');
  });

  afterEach(() => {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('readRepoTexts skips missing, oversized and binary files and strips a BOM', () => {
    const files = ['src/b.ts', 'src/missing.ts', 'src/big.ts', 'src/bin.dat', 'src/a.ts', 'src/dir', '../secret.ts', 'src/limit.ts', 'src/Z.ts', 'src/a.ts'];
    const texts = readRepoTexts(root, files, 100);
    expect(texts.map((t) => t.file)).toEqual(['src/Z.ts', 'src/a.ts', 'src/b.ts', 'src/limit.ts']);
    expect(texts[1]!.text).toBe('// rule: LEND-03\n');
  });

  it('readRepoTexts checks only the first 8 KiB for a NUL byte and defaults to 1 MiB', () => {
    expect(SOURCE_SCAN_MAX_BYTES).toBe(1_048_576);
    expect(readRepoTexts(root, ['src/late-nul.ts']).map((t) => t.file)).toEqual(['src/late-nul.ts']);
    writeFileSync(join(root, 'src', 'huge.ts'), 'h'.repeat(SOURCE_SCAN_MAX_BYTES + 1), 'utf-8');
    expect(readRepoTexts(root, ['src/huge.ts'])).toEqual([]);
  });

  it('repoIsFile is true for a file and false for a directory, a missing path or an escape', () => {
    expect(repoIsFile(root, 'src/a.ts')).toBe(true);
    expect(repoIsFile(root, 'src/dir')).toBe(false);
    expect(repoIsFile(root, 'src/missing.ts')).toBe(false);
    expect(repoIsFile(root, '../secret.ts')).toBe(false);
  });
});

describe('repo-files path gate (M12)', () => {
  let parent: string;
  let root: string;

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'ctxo-domain-repo-'));
    root = join(parent, 'project');
    mkdirSync(join(root, 'docs'), { recursive: true });
    mkdirSync(join(root, '..hidden'), { recursive: true });
    writeFileSync(join(root, 'docs', 'card.md'), 'card', 'utf-8');
    writeFileSync(join(root, '..hidden', 'x.md'), 'hidden', 'utf-8');
    writeFileSync(join(parent, 'secret.md'), 'secret', 'utf-8');
  });

  afterEach(() => {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const cases: readonly [string, string, string | undefined][] = [
    ['a plain file', 'docs/card.md', 'card'],
    ['a dotted path that stays inside', 'docs/../docs/card.md', 'card'],
    ['a folder whose name starts with two dots', '..hidden/x.md', 'hidden'],
    ['a parent traversal', '../secret.md', undefined],
    ['a deeper parent traversal', 'docs/../../secret.md', undefined],
    ['a backslash parent traversal', '..\\secret.md', undefined],
    ['the project root itself', '.', undefined],
    ['the parent folder itself', '..', undefined],
    ['an empty path', '', undefined],
    ['an absolute path', resolve(tmpdir(), 'secret.md'), undefined],
    ['a missing file', 'docs/missing.md', undefined],
  ];

  it.each(cases)('%s', (_label, repoPath, expected) => {
    expect(readRepoText(root, repoPath)).toBe(expected);
    // `.` and `..` are directories that exist but are never reachable through the gate.
    expect(repoFileExists(root, repoPath)).toBe(expected !== undefined);
  });

  it('leavesProject tells a real escape from a name that merely starts with two dots', () => {
    expect(leavesProject('..')).toBe(true);
    expect(leavesProject('../x')).toBe(true);
    expect(leavesProject('..\\x')).toBe(true);
    expect(leavesProject(resolve(parent, 'x'))).toBe(true);
    expect(leavesProject('..hidden/x.md')).toBe(false);
    expect(leavesProject('docs/card.md')).toBe(false);
    expect(leavesProject('')).toBe(false);
  });
});
