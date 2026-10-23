import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModuleHost } from '@ctxo/cli/internal';
import { contextsTouchedCommand } from '../contexts-touched-command.js';

const IDENTITY = ['-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@test.com'];
const BASE_TIME = 1_700_000_000;
const ISOLATED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'];

const REGISTRY = `version: 1
contexts:
  - id: lending
    name: Lending
    card: docs/domain/lending.md
    paths: ["src/Lending/**"]
    rung: named
  - id: billing
    name: Billing
    paths: ["src/Billing/**"]
    rung: fear
`;

interface Repo {
  readonly dir: string;
  git(...args: string[]): string;
  write(file: string, content: string): void;
  commit(message: string, ...more: string[]): string;
}

let saved: Map<string, string | undefined>;
let configDir: string;
const dirs: string[] = [];
let stderr: string[];
let stdout: string[];

beforeEach(() => {
  saved = new Map(ISOLATED.map((k) => [k, process.env[k]]));
  for (const k of ISOLATED) delete process.env[k];
  configDir = mkdtempSync(join(tmpdir(), 'ctxo-domain-gitenv-'));
  writeFileSync(join(configDir, 'gitconfig'), '');
  process.env['GIT_CONFIG_GLOBAL'] = join(configDir, 'gitconfig');
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  stderr = [];
  stdout = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.join(' '));
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(configDir, { recursive: true, force: true });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function createRepo(initialBranch = 'main', withRegistry = true): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'ctxo-domain-touched-'));
  dirs.push(dir);
  let n = 0;
  const run = (args: string[], env: Record<string, string> = {}): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf-8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  run(['init', '-q', '-b', initialBranch]);
  const repo: Repo = {
    dir,
    git: (...args) => run(args),
    write(file, content) {
      const full = join(dir, file);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf-8');
    },
    commit(message, ...more) {
      run(['add', '-A']);
      n += 1;
      const when = `${BASE_TIME + n * 60} +0000`;
      run([...IDENTITY, 'commit', '-q', ...[message, ...more].flatMap((m) => ['-m', m])], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
      return run(['rev-parse', 'HEAD']);
    },
  };
  if (withRegistry) repo.write('docs/domain/contexts.yaml', REGISTRY);
  repo.write('docs/domain/lending.md', '# Lending\n');
  repo.write('src/Lending/LoanPolicy.cs', 'class LoanPolicy {}\n');
  repo.write('src/Billing/Invoice.cs', 'class Invoice {}\n');
  repo.commit('init');
  return repo;
}

async function run(repo: Repo, ...args: string[]): Promise<number> {
  const host = createModuleHost({ projectRoot: repo.dir, mode: 'cli' });
  const command = contextsTouchedCommand(host);
  return command.run(args, { projectRoot: repo.dir, ctxoRoot: host.ctxoRoot, readStdin: async () => '' });
}

function json(): any {
  return JSON.parse(stdout.join(''));
}

describe('contexts-touched', () => {
  it('reports the spec example as acknowledged', async () => {
    const repo = createRepo();
    const base = repo.git('rev-parse', 'HEAD');
    repo.git('checkout', '-q', '-b', 'feat');
    repo.write('src/Lending/LoanPolicy.cs', 'class LoanPolicy { int x; }\n');
    repo.commit('refactor loan policy', 'Domain-Unchanged: lending (refactor only)');

    const code = await run(repo, '--since', 'main', '--json');

    const report = json();
    expect(code).toBe(0);
    expect(Object.keys(report)).toEqual(['mode', 'since', 'base', 'head', 'contexts', 'unowned', 'unresolved', 'warnings']);
    expect(report.mode).toBe('all');
    expect(report.since).toBe('main');
    expect(report.base).toBe(base.slice(0, 7));
    expect(report.head).toBe(repo.git('rev-parse', 'HEAD').slice(0, 7));
    expect(report.contexts).toHaveLength(1);
    expect(report.contexts[0]).toMatchObject({
      id: 'lending',
      files: ['src/Lending/LoanPolicy.cs'],
      card: 'docs/domain/lending.md',
      cardChanged: false,
      status: 'acknowledged',
      acknowledged: { reason: 'refactor only' },
    });
    expect(report.unresolved).toEqual([]);
  });

  it('--check exits 1 for an unresolved context and 0 after a card commit', async () => {
    const repo = createRepo();
    repo.git('checkout', '-q', '-b', 'feat');
    repo.write('src/Lending/LoanPolicy.cs', 'class LoanPolicy { int x; }\n');
    repo.commit('change policy');

    expect(await run(repo, '--since', 'main', '--check')).toBe(1);
    expect(stderr.join('\n')).toContain('[ctxo] Unresolved: lending. Update the card, or add "Domain-Unchanged: lending (reason)" to a commit.');
    expect(stderr.join('\n')).toContain('  lending  unresolved  1 file(s)  card docs/domain/lending.md');

    repo.write('docs/domain/lending.md', '# Lending\nmore\n');
    repo.commit('update card');
    stderr.length = 0;

    expect(await run(repo, '--since', 'main', '--check')).toBe(0);
  });

  it('the default mode includes staged, unstaged and untracked changes; --committed ignores them', async () => {
    const repo = createRepo();
    repo.git('checkout', '-q', '-b', 'feat');
    repo.write('src/Lending/LoanPolicy.cs', 'class LoanPolicy { int staged; }\n');
    repo.git('add', 'src/Lending/LoanPolicy.cs');
    repo.write('src/Billing/Invoice.cs', 'class Invoice { int unstaged; }\n');
    repo.write('src/Billing/New.cs', 'class New {}\n');

    await run(repo, '--since', 'main', '--json');
    const all = json();
    expect(all.contexts.map((c: { id: string }) => c.id)).toEqual(['billing', 'lending']);
    expect(all.contexts[0].files).toEqual(['src/Billing/Invoice.cs', 'src/Billing/New.cs']);

    stdout.length = 0;
    await run(repo, '--since', 'main', '--committed', '--json');
    expect(json().contexts).toEqual([]);
    expect(json().mode).toBe('committed');

    stdout.length = 0;
    await run(repo, '--staged', '--json');
    const staged = json();
    expect(staged.mode).toBe('staged');
    expect(staged.since).toBeUndefined();
    expect(staged.base).toBeUndefined();
    expect(staged.contexts.map((c: { id: string }) => c.id)).toEqual(['lending']);
  });

  it('uncommitted changes cannot be acknowledged', async () => {
    const repo = createRepo();
    repo.git('checkout', '-q', '-b', 'feat');
    repo.write('src/Billing/Invoice.cs', 'class Invoice { int x; }\n');
    repo.commit('billing only', 'Domain-Unchanged: billing (nothing)');
    repo.write('src/Lending/LoanPolicy.cs', 'class LoanPolicy { int dirty; }\n');

    const code = await run(repo, '--since', 'main', '--json', '--check');

    const report = json();
    expect(code).toBe(1);
    expect(report.contexts.find((c: { id: string }) => c.id === 'lending')).toMatchObject({ status: 'unresolved' });
    expect(report.unresolved).toEqual(['lending']);
  });

  it('the default base falls back to main, then master', async () => {
    const onMain = createRepo('main');
    onMain.git('checkout', '-q', '-b', 'feat');
    onMain.write('src/Lending/LoanPolicy.cs', 'class LoanPolicy { int x; }\n');
    onMain.commit('change');

    expect(await run(onMain, '--json')).toBe(0);
    expect(json().since).toBe('main');
    expect(json().contexts).toHaveLength(1);

    stdout.length = 0;
    const onMaster = createRepo('master');
    onMaster.git('checkout', '-q', '-b', 'feat');
    onMaster.write('src/Lending/LoanPolicy.cs', 'class LoanPolicy { int x; }\n');
    onMaster.commit('change');

    expect(await run(onMaster, '--json')).toBe(0);
    expect(json().since).toBe('master');
    expect(json().contexts).toHaveLength(1);
  });

  it('no default base exits 2 and asks for --since', async () => {
    const repo = createRepo('trunk');

    expect(await run(repo)).toBe(2);
    expect(stderr.join('\n')).toContain('[ctxo] No base branch found (origin/HEAD, main or master); pass --since <ref>.');
  });

  it('an unknown --since ref exits 2 with the fetch-depth hint', async () => {
    const repo = createRepo();

    expect(await run(repo, '--since', 'nope')).toBe(2);
    expect(stderr.join('\n')).toContain(
      '[ctxo] Cannot find the merge base of nope and HEAD. In CI, fetch the base branch with full history (actions/checkout fetch-depth: 0).',
    );
  });

  it('no registry prints the hint and exits 0', async () => {
    const repo = createRepo('main', false);

    expect(await run(repo, '--since', 'main')).toBe(0);
    expect(stderr.join('\n')).toContain('[ctxo] No domain registry at docs/domain/contexts.yaml. Create one with "ctxo init --domain".');
  });

  it('a registry with problems exits 2', async () => {
    const repo = createRepo('main', false);
    repo.write('docs/domain/contexts.yaml', 'version: 1\ncontexts: nope\n');

    expect(await run(repo, '--since', 'main')).toBe(2);
    expect(stderr.join('\n')).toContain('[ctxo] The domain registry at docs/domain/contexts.yaml has problems; run "ctxo verify-domain".');
  });

  it('--committed with --staged exits 1', async () => {
    const repo = createRepo();

    expect(await run(repo, '--committed', '--staged')).toBe(1);
    expect(stderr.join('\n')).toContain('[ctxo] --committed and --staged cannot be combined');
  });

  it('an unknown flag exits 1', async () => {
    const repo = createRepo();

    expect(await run(repo, '--bogus')).toBe(1);
    expect(stderr.join('\n')).toContain('[ctxo] Unknown contexts-touched flag: --bogus');
  });

  it('--help prints the usage', async () => {
    const repo = createRepo();
    const command = contextsTouchedCommand(createModuleHost({ projectRoot: repo.dir, mode: 'cli' }));

    expect(command.name).toBe('contexts-touched');
    expect(command.help).toContain('  ctxo contexts-touched     Named contexts changed since a ref (--since, --committed, --staged, --json, --check)');
    expect(await run(repo, '--help')).toBe(0);
    expect(await run(repo, '-h')).toBe(0);
    expect(stderr.join('\n')).toContain('ctxo contexts-touched [--since <ref>] [--committed | --staged] [--json] [--check]');
  });
});
