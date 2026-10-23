import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModuleHost } from '@ctxo/cli/internal';
import { domainCommand } from '../domain-command.js';

const REGISTRY = `version: 1
contexts:
  - id: lending
    name: Lending
    card: docs/domain/lending.md
    paths: ["src/Lending/**"]
    rung: named
  - id: fold
    name: Fold
    card: docs/domain/fold.md
    paths: ["src/Fold/**"]
    rung: named
`;

let stderr: string[];
const dirs: string[] = [];

beforeEach(() => {
  stderr = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function project(registry: string | null = REGISTRY): string {
  const dir = mkdtempSync(join(tmpdir(), 'ctxo-domain-rules-'));
  dirs.push(dir);
  if (registry !== null) put(dir, 'docs/domain/contexts.yaml', registry);
  return dir;
}

function put(dir: string, file: string, content: string): void {
  const full = join(dir, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

async function run(dir: string, ...args: string[]): Promise<number> {
  const host = createModuleHost({ projectRoot: dir, mode: 'cli' });
  return domainCommand(host).run(args, { projectRoot: dir, ctxoRoot: host.ctxoRoot, readStdin: async () => '' });
}

describe('ctxo domain rules', () => {
  it('--check passes right after --write and fails after a registry change', async () => {
    const dir = project();
    expect(await run(dir, 'rules', '--check')).toBe(1);
    expect(await run(dir, 'rules', '--write')).toBe(0);
    expect(existsSync(join(dir, '.claude/rules/ctxo-context-lending.md'))).toBe(true);
    expect(await run(dir, 'rules', '--check')).toBe(0);
    put(dir, 'docs/domain/contexts.yaml', REGISTRY.replace('src/Lending/**', 'src/Loans/**'));
    expect(await run(dir, 'rules', '--check')).toBe(1);
    expect(stderr.join('\n')).toContain('outdated  .claude/rules/ctxo-context-lending.md');
  });

  it('--write deletes stale generated files and keeps a prefixed file without the marker', async () => {
    const dir = project();
    await run(dir, 'rules', '--write');
    put(dir, 'docs/domain/contexts.yaml', REGISTRY.replace(/  - id: fold[\s\S]*$/, ''));
    put(dir, '.claude/rules/ctxo-context-mine.md', '# my own\n');
    expect(await run(dir, 'rules', '--check')).toBe(1);
    expect(await run(dir, 'rules', '--write')).toBe(0);
    expect(existsSync(join(dir, '.claude/rules/ctxo-context-fold.md'))).toBe(false);
    expect(existsSync(join(dir, '.claude/rules/ctxo-context-lending.md'))).toBe(true);
    expect(readFileSync(join(dir, '.claude/rules/ctxo-context-mine.md'), 'utf-8')).toBe('# my own\n');
    expect(await run(dir, 'rules', '--check')).toBe(0);
  });

  it('the file names use the ctxo-context- prefix and never touch the ctxo-domain-fold skill files', async () => {
    const dir = project();
    put(dir, '.cursor/rules/ctxo-domain-fold.mdc', 'skill\n');
    put(dir, '.claude/skills/ctxo-domain-fold/SKILL.md', 'skill\n');
    expect(await run(dir, 'rules', '--write')).toBe(0);
    expect(existsSync(join(dir, '.claude/rules/ctxo-context-fold.md'))).toBe(true);
    expect(existsSync(join(dir, '.cursor/rules/ctxo-context-fold.mdc'))).toBe(true);
    expect(readFileSync(join(dir, '.cursor/rules/ctxo-domain-fold.mdc'), 'utf-8')).toBe('skill\n');
    expect(readFileSync(join(dir, '.claude/skills/ctxo-domain-fold/SKILL.md'), 'utf-8')).toBe('skill\n');
    expect(stderr.join('\n')).not.toContain('ctxo-domain-fold');
    expect(await run(dir, 'rules', '--check')).toBe(0);
    expect(stderr.join('\n')).not.toContain('ctxo-domain-fold');
  });

  it('Cursor files appear only when .cursor/ exists', async () => {
    const dir = project();
    await run(dir, 'rules', '--write');
    expect(existsSync(join(dir, '.cursor'))).toBe(false);
    mkdirSync(join(dir, '.cursor'));
    expect(await run(dir, 'rules', '--check')).toBe(1);
    await run(dir, 'rules', '--write');
    expect(existsSync(join(dir, '.cursor/rules/ctxo-context-lending.mdc'))).toBe(true);
  });

  it('prints usage and exits 1 without a flag or for an unknown subcommand; --help exits 0', async () => {
    const dir = project();
    expect(await run(dir, 'rules')).toBe(1);
    expect(await run(dir, 'bogus')).toBe(1);
    expect(await run(dir)).toBe(1);
    expect(await run(dir, '--help')).toBe(0);
    expect(await run(dir, 'rules', '--help')).toBe(0);
    expect(stderr.join('\n')).toContain('Usage: ctxo domain rules --write | --check');
  });

  it('gives the hint and exit 0 without a registry, and exit 2 for a broken one', async () => {
    expect(await run(project(null), 'rules', '--check')).toBe(0);
    expect(await run(project('version: 2\n'), 'rules', '--check')).toBe(2);
  });
});
