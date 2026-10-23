import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModuleHost } from '@ctxo/cli/internal';
import type { GuardPayload, HookEvent } from '../../core/guard.js';
import { GuardSessionStore } from '../../adapters/guard-session-store.js';
import { domainGuardHookCommand, evaluateGuard, type GuardResult } from '../domain-guard-hook-command.js';

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
  head(): string;
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

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function initRepo(initialBranch = 'main'): Repo {
  const dir = tempDir('ctxo-domain-guard-');
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
      run([...IDENTITY, 'commit', '-q', '--allow-empty', ...[message, ...more].flatMap((m) => ['-m', m])], {
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when,
      });
      return run(['rev-parse', 'HEAD']);
    },
    head: () => run(['rev-parse', 'HEAD']),
  };
  repo.write('.gitignore', '.ctxo/.cache/\n');
  return repo;
}

/** `main` with the registry, the Lending card and code, then a `feat` branch. */
function createRepo(options: { readonly branch?: string } = {}): Repo {
  const repo = initRepo();
  repo.write('docs/domain/contexts.yaml', REGISTRY);
  repo.write('docs/domain/lending.md', '# Lending\n');
  repo.write('src/Lending/LoanPolicy.cs', 'class LoanPolicy {}\n');
  repo.write('src/Billing/Invoice.cs', 'class Invoice {}\n');
  repo.commit('init');
  if (options.branch !== 'main') repo.git('checkout', '-q', '-b', options.branch ?? 'feat');
  return repo;
}

let edits = 0;
function changeLending(repo: Repo, file = 'src/Lending/LoanPolicy.cs'): string {
  edits += 1;
  repo.write(file, `class LoanPolicy { int x${edits}; }\n`);
  return repo.commit(`change lending ${edits}`);
}

function payload(event: HookEvent, sessionId = 'session-1', stopHookActive = false): GuardPayload {
  return { sessionId, event, stopHookActive };
}

function guard(repo: Repo | string, p: GuardPayload): Promise<GuardResult> {
  const projectRoot = typeof repo === 'string' ? repo : repo.dir;
  const host = createModuleHost({ projectRoot, mode: 'hook' });
  return evaluateGuard(p, { host, projectRoot });
}

function storeOf(repo: Repo): GuardSessionStore {
  return new GuardSessionStore(join(repo.dir, '.ctxo', '.cache'));
}

function blockReason(result: GuardResult): string {
  expect(result.exitCode).toBe(0);
  expect(result.stdout?.endsWith('\n')).toBe(true);
  const parsed = JSON.parse(result.stdout ?? '') as { decision: string; reason: string };
  expect(Object.keys(parsed)).toEqual(['decision', 'reason']);
  expect(parsed.decision).toBe('block');
  return parsed.reason;
}

const ALLOW: GuardResult = { exitCode: 0 };

describe('evaluateGuard', () => {
  it("blocks once when this session's commits change a context without a card update", async () => {
    const repo = createRepo();
    expect(await guard(repo, payload('SessionStart'))).toEqual(ALLOW);
    expect(storeOf(repo).read('session-1')).toEqual({ version: 1, startHead: repo.head(), blocked: [] });

    changeLending(repo);
    const reason = blockReason(await guard(repo, payload('Stop')));
    expect(reason).toBe(
      [
        'ctxo domain guard: 1 context has committed changes without a card update.',
        '- lending: 1 file (src/Lending/LoanPolicy.cs)',
        '  card: docs/domain/lending.md (unchanged)',
        'Update the card if behaviour changed (rules, decisions, contracts), then commit it.',
        'If behaviour did not change, add this trailer to a commit:',
        '  Domain-Unchanged: lending (reason)',
      ].join('\n'),
    );
    expect(storeOf(repo).read('session-1')?.blocked).toEqual([`${repo.head()}|lending`]);

    // The same HEAD and the same unresolved contexts: blocked once already.
    expect(await guard(repo, payload('Stop'))).toEqual(ALLOW);
  });

  it('allows after a card commit', async () => {
    const repo = createRepo();
    await guard(repo, payload('SessionStart'));
    changeLending(repo);
    blockReason(await guard(repo, payload('Stop')));
    repo.write('docs/domain/lending.md', '# Lending\n\nLEND-03: a member holds at most five loans.\n');
    repo.commit('docs: fold lending');
    expect(await guard(repo, payload('Stop'))).toEqual(ALLOW);
  });

  it('allows after an empty commit carrying the trailer', async () => {
    const repo = createRepo();
    await guard(repo, payload('SessionStart'));
    changeLending(repo);
    blockReason(await guard(repo, payload('Stop')));
    repo.commit('chore: fold', 'Domain-Unchanged: lending (refactor only)');
    expect(await guard(repo, payload('Stop'))).toEqual(ALLOW);
  });

  it('always allows when stop_hook_active is true', async () => {
    const repo = createRepo();
    await guard(repo, payload('SessionStart'));
    changeLending(repo);
    expect(await guard(repo, payload('Stop', 'session-1', true))).toEqual(ALLOW);
    expect(await guard(repo, payload('TaskCompleted', 'session-1', true))).toEqual(ALLOW);
    expect(storeOf(repo).read('session-1')?.blocked).toEqual([]);
  });

  it('does not block a new session for commits made before it started', async () => {
    const repo = createRepo();
    await guard(repo, payload('SessionStart', 'earlier'));
    changeLending(repo);
    blockReason(await guard(repo, payload('Stop', 'earlier')));

    await guard(repo, payload('SessionStart', 'later'));
    expect(await guard(repo, payload('Stop', 'later'))).toEqual(ALLOW);
  });

  it('a resumed session keeps its original record', async () => {
    const repo = createRepo();
    await guard(repo, payload('SessionStart'));
    const start = repo.head();
    changeLending(repo);
    await guard(repo, payload('SessionStart'));
    expect(storeOf(repo).read('session-1')?.startHead).toBe(start);
    blockReason(await guard(repo, payload('Stop')));
  });

  it('records HEAD and allows when the hook was installed mid-session', async () => {
    const repo = createRepo();
    changeLending(repo);
    expect(await guard(repo, payload('Stop'))).toEqual(ALLOW);
    expect(storeOf(repo).read('session-1')).toEqual({ version: 1, startHead: repo.head(), blocked: [] });
    changeLending(repo);
    expect(blockReason(await guard(repo, payload('Stop')))).toContain('- lending: 1 file');
  });

  it('re-anchors and allows after a rebase or a branch switch', async () => {
    const repo = createRepo();
    changeLending(repo);
    await guard(repo, payload('SessionStart'));
    // A branch from main does not contain the session's start commit.
    repo.git('checkout', '-q', '-b', 'other', 'main');
    changeLending(repo);
    expect(await guard(repo, payload('Stop'))).toEqual(ALLOW);
    expect(storeOf(repo).read('session-1')).toEqual({ version: 1, startHead: repo.head(), blocked: [] });

    changeLending(repo);
    blockReason(await guard(repo, payload('Stop')));

    // A reset below the anchor: the blocked fingerprints survive the re-anchor.
    const blocked = storeOf(repo).read('session-1')?.blocked;
    expect(blocked).toHaveLength(1);
    repo.git('reset', '-q', '--hard', 'main');
    expect(await guard(repo, payload('Stop'))).toEqual(ALLOW);
    expect(storeOf(repo).read('session-1')).toEqual({ version: 1, startHead: repo.head(), blocked });
  });

  it('TaskCompleted blocks with exit 2 and the reason on stderr', async () => {
    const repo = createRepo();
    await guard(repo, payload('SessionStart'));
    changeLending(repo);
    const result = await guard(repo, payload('TaskCompleted'));
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBeUndefined();
    expect(result.stderr).toMatch(/^ctxo domain guard: 1 context has committed changes without a card update\.\n/);
    expect(result.stderr).toContain('  Domain-Unchanged: lending (reason)\n');
  });

  it('SubagentStop is ignored unless domain.guard.subagents is true', async () => {
    const repo = createRepo();
    await guard(repo, payload('SessionStart'));
    changeLending(repo);
    expect(await guard(repo, payload('SubagentStop'))).toEqual(ALLOW);
    expect(storeOf(repo).read('session-1')?.blocked).toEqual([]);

    repo.write('.ctxo/config.yaml', 'version: "1.0"\ndomain:\n  guard:\n    subagents: true\n');
    expect(blockReason(await guard(repo, payload('SubagentStop')))).toContain('lending');
  });

  it('allows everything when domain.guard.enabled is false', async () => {
    const repo = createRepo();
    repo.write('.ctxo/config.yaml', 'version: "1.0"\ndomain:\n  guard:\n    enabled: false\n');
    await guard(repo, payload('SessionStart'));
    changeLending(repo);
    expect(await guard(repo, payload('Stop'))).toEqual(ALLOW);
    expect(await guard(repo, payload('TaskCompleted'))).toEqual(ALLOW);
  });

  it('uncommitted changes never block', async () => {
    const repo = createRepo();
    await guard(repo, payload('SessionStart'));
    repo.write('src/Lending/LoanPolicy.cs', 'class LoanPolicy { int staged; }\n');
    repo.git('add', '-A');
    repo.write('src/Lending/Renewal.cs', 'class Renewal {}\n');
    expect(await guard(repo, payload('Stop'))).toEqual(ALLOW);
    expect(await guard(repo, payload('TaskCompleted'))).toEqual(ALLOW);
  });

  it('on the default branch only unpushed commits count', async () => {
    const repo = createRepo({ branch: 'main' });
    const remote = tempDir('ctxo-domain-guard-remote-');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { stdio: 'ignore' });
    repo.git('remote', 'add', 'origin', remote);
    repo.git('push', '-q', '-u', 'origin', 'main');

    await guard(repo, payload('SessionStart'));
    changeLending(repo);
    expect(blockReason(await guard(repo, payload('Stop')))).toContain('lending');

    // A new HEAD, pushed: nothing is unpushed, so nothing counts.
    changeLending(repo);
    repo.git('push', '-q', 'origin', 'main');
    expect(await guard(repo, payload('Stop'))).toEqual(ALLOW);
  });

  it('a feature branch counts only commits after the merge base', async () => {
    const repo = createRepo({ branch: 'main' });
    // A session that started before main moved on: main's own commits are outside the branch range.
    await guard(repo, payload('SessionStart'));
    changeLending(repo);
    repo.git('checkout', '-q', '-b', 'feat');
    repo.write('src/Billing/Invoice.cs', 'class Invoice { int y; }\n');
    repo.commit('billing only');
    expect(await guard(repo, payload('Stop'))).toEqual(ALLOW);
  });

  it('a session that started before the first commit counts every commit', async () => {
    const repo = initRepo();
    await guard(repo, payload('SessionStart'));
    expect(storeOf(repo).read('session-1')).toEqual({ version: 1, startHead: null, blocked: [] });

    // The card is named in the registry but never committed.
    repo.write('docs/domain/contexts.yaml', REGISTRY);
    repo.write('src/Lending/LoanPolicy.cs', 'class LoanPolicy {}\n');
    repo.commit('init');
    repo.write('README.md', 'hello\n');
    repo.commit('readme');
    expect(blockReason(await guard(repo, payload('Stop')))).toContain('- lending: 1 file (src/Lending/LoanPolicy.cs)');
  });

  it('allows without a registry', async () => {
    const repo = initRepo();
    repo.write('src/Lending/LoanPolicy.cs', 'class LoanPolicy {}\n');
    repo.commit('init');
    await guard(repo, payload('SessionStart'));
    changeLending(repo);
    expect(await guard(repo, payload('Stop'))).toEqual(ALLOW);
  });

  it('fails open on a git failure or a corrupt registry', async () => {
    const corrupt = createRepo();
    await guard(corrupt, payload('SessionStart'));
    corrupt.write('docs/domain/contexts.yaml', 'version: 1\ncontexts: [ {');
    changeLending(corrupt);
    expect(await guard(corrupt, payload('Stop'))).toEqual(ALLOW);

    const broken = createRepo();
    await guard(broken, payload('SessionStart'));
    changeLending(broken);
    renameSync(join(broken.dir, '.git'), join(broken.dir, 'git-moved'));
    expect(await guard(broken, payload('Stop'))).toEqual(ALLOW);
    expect(await guard(broken, payload('TaskCompleted'))).toEqual(ALLOW);

    const missing = join(tempDir('ctxo-domain-guard-gone-'), 'does-not-exist');
    const result = await guard(missing, payload('Stop'));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBeUndefined();
  });
});

describe('domainGuardHookCommand', () => {
  async function runCommand(stdin: string, projectRoot: string): Promise<number> {
    const host = createModuleHost({ projectRoot, mode: 'hook' });
    const command = domainGuardHookCommand(host);
    expect(command.name).toBe('domain-guard-hook');
    expect(command.hidden).toBe(true);
    return command.run([], { projectRoot, ctxoRoot: join(projectRoot, '.ctxo'), readStdin: async () => stdin });
  }

  it('reads the payload from stdin and finds the project from its cwd', async () => {
    const repo = createRepo();
    const elsewhere = tempDir('ctxo-domain-guard-elsewhere-');
    const start = JSON.stringify({ session_id: 'cmd', hook_event_name: 'SessionStart', cwd: join(repo.dir, 'src') });
    expect(await runCommand(start, elsewhere)).toBe(0);
    changeLending(repo);
    const stop = JSON.stringify({ session_id: 'cmd', hook_event_name: 'Stop', stop_hook_active: false, cwd: join(repo.dir, 'src') });
    expect(await runCommand(stop, elsewhere)).toBe(0);
    const out = JSON.parse(stdout.join('')) as { decision: string; reason: string };
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Domain-Unchanged: lending (reason)');
  });

  it('exits 0 with no output on a payload it does not understand', async () => {
    const repo = createRepo();
    expect(await runCommand('{oops', repo.dir)).toBe(0);
    expect(await runCommand('', repo.dir)).toBe(0);
    expect(stdout).toEqual([]);
  });
});
