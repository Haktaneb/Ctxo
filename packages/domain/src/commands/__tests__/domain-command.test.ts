import { execFileSync } from 'node:child_process';
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

  it('--check fails and --write refuses when a prefixed file without the marker sits at an expected path', async () => {
    const dir = project();
    put(dir, '.claude/rules/ctxo-context-lending.md', '# my own lending rule\n');
    expect(await run(dir, 'rules', '--check')).toBe(1);
    const message = 'exists without the generated marker; rename it or delete it, then run --write';
    expect(stderr.join('\n')).toContain(`.claude/rules/ctxo-context-lending.md ${message}`);
    stderr.length = 0;
    expect(await run(dir, 'rules', '--write')).toBe(1);
    expect(stderr.join('\n')).toContain(`.claude/rules/ctxo-context-lending.md ${message}`);
    expect(readFileSync(join(dir, '.claude/rules/ctxo-context-lending.md'), 'utf-8')).toBe('# my own lending rule\n');
    expect(existsSync(join(dir, '.claude/rules/ctxo-context-fold.md'))).toBe(true);
  });

  it('a user file that quotes the marker in its body is not generated', async () => {
    const dir = project();
    const quoted = '# mine\n<!-- generated by ctxo domain rules; do not edit -->\n';
    put(dir, '.claude/rules/ctxo-context-lending.md', quoted);
    put(dir, '.claude/rules/ctxo-context-old.md', quoted);
    await run(dir, 'rules', '--write');
    expect(readFileSync(join(dir, '.claude/rules/ctxo-context-old.md'), 'utf-8')).toBe(quoted);
    expect(readFileSync(join(dir, '.claude/rules/ctxo-context-lending.md'), 'utf-8')).toBe(quoted);
  });

  it('ignores .tmp files in the rules directories', async () => {
    const dir = project();
    await run(dir, 'rules', '--write');
    put(dir, '.claude/rules/ctxo-context-lending.md.123.abc.tmp', 'leftover\n');
    stderr.length = 0;
    expect(await run(dir, 'rules', '--check')).toBe(0);
    expect(stderr.join('\n')).not.toContain('.tmp');
  });

  it('a write failure gives skipped and exit 1', async () => {
    const dir = project();
    put(dir, '.claude/rules', 'a file where the directory should be');
    expect(await run(dir, 'rules', '--write')).toBe(1);
    expect(stderr.join('\n')).toContain('skipped');
  });

  it('--write with --check, and an unknown flag, give exit 1', async () => {
    const dir = project();
    expect(await run(dir, 'rules', '--write', '--check')).toBe(1);
    expect(await run(dir, 'rules', '--bogus')).toBe(1);
    expect(existsSync(join(dir, '.claude/rules/ctxo-context-lending.md'))).toBe(false);
  });

  it('lists several contexts in sorted order', async () => {
    const extra = '  - id: alpha\n    name: Alpha\n    card: docs/domain/alpha.md\n    paths: ["src/Alpha/**"]\n    rung: named\n';
    const dir = project(REGISTRY + extra);
    expect(await run(dir, 'rules', '--check')).toBe(1);
    const missing = stderr.filter((l) => l.includes('missing'));
    expect(missing.map((l) => l.trim().split(/\s+/)[1])).toEqual([
      '.claude/rules/ctxo-context-alpha.md',
      '.claude/rules/ctxo-context-fold.md',
      '.claude/rules/ctxo-context-lending.md',
    ]);
  });
});

describe('ctxo domain discover', () => {
  function gitRepo(subjectsList: string[]): string {
    const dir = project(null);
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@test.com', ...args], {
        cwd: dir,
        stdio: 'ignore',
      });
    };
    git('init', '-q');
    subjectsList.forEach((subject, i) => {
      put(dir, `f${i}.txt`, `${i}\n`);
      git('add', '.');
      git('commit', '-q', '-m', subject);
    });
    return dir;
  }

  const five = ['LEND-1 a', 'LEND-2 b', 'LEND-3 c', 'LEND-4 d', 'LEND-5 e'];
  let stdout: string[];
  beforeEach(() => {
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  it('prints the evidence to stderr and writes nothing without --write', async () => {
    const dir = gitRepo(five);
    expect(await run(dir, 'discover')).toBe(0);
    const text = stderr.join('\n');
    expect(text).toContain('Rule IDs');
    expect(text).toContain('LEND in 5');
    expect(text).toContain('trackerPrefixes');
    expect(existsSync(join(dir, '.ctxo', 'config.yaml'))).toBe(false);
    expect(stdout.join('')).toBe('');
  });

  it('--json prints evidence and proposal on stdout', async () => {
    const dir = gitRepo(five);
    expect(await run(dir, 'discover', '--json')).toBe(0);
    const out = JSON.parse(stdout.join('')) as { evidence: { trackerKeys: unknown[] }; proposal: { trackerPrefixes: string[] } };
    expect(out.proposal.trackerPrefixes).toEqual(['LEND']);
    expect(out.evidence.trackerKeys).toEqual([{ prefix: 'LEND', occurrences: 5, overlapsRulePrefix: false }]);
    expect(existsSync(join(dir, '.ctxo', 'config.yaml'))).toBe(false);
  });

  it('--write merges the proposal into .ctxo/config.yaml and lists the added values', async () => {
    const dir = gitRepo(five);
    put(dir, '.ctxo/config.yaml', 'version: "1.0"\n# keep me\n');
    expect(await run(dir, 'discover', '--write')).toBe(0);
    const written = readFileSync(join(dir, '.ctxo', 'config.yaml'), 'utf-8');
    expect(written).toContain('# keep me');
    expect(written).toMatch(/trackerPrefixes:\s*\[\s*LEND\s*\]/);
    expect(stderr.join('\n')).toContain('LEND');
    stderr.length = 0;
    expect(await run(dir, 'discover', '--write')).toBe(0);
    expect(readFileSync(join(dir, '.ctxo', 'config.yaml'), 'utf-8')).toBe(written);
    expect(stderr.join('\n')).toContain('nothing to add');
  });

  it('works without a registry and without git history', async () => {
    const dir = project(null);
    expect(await run(dir, 'discover')).toBe(0);
    expect(stderr.join('\n')).toContain('Rule IDs');
  });

  it('rejects an unknown flag', async () => {
    expect(await run(project(null), 'discover', '--bogus')).toBe(1);
  });
});
