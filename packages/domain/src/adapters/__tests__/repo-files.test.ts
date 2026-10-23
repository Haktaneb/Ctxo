import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { leavesProject, readRepoText, repoFileExists } from '../repo-files.js';

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
