import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { SimpleGitAdapter } from '../simple-git-adapter.js';
import { isolateGitEnv, type IsolatedGitEnv } from '../../../cli/__tests__/git-test-env.js';

// Developer machines often set commit.gpgsign=true globally; these overrides keep every commit
// or merge in a temp repo from opening a GPG prompt.
const IDENTITY = ['-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@test.com'];

// The n-th commit made through a TempRepo is dated BASE_TIME + n minutes, so "newest first"
// never depends on how git breaks same-second ties.
const BASE_TIME = 1_700_000_000;

interface TempRepo {
  readonly dir: string;
  git(...args: string[]): string;
  write(file: string, content: string): void;
  /** Stages everything, commits, and returns the full SHA. */
  commit(message: string, ...moreParagraphs: string[]): string;
  /** Merges with --no-ff; returns the full SHA. */
  merge(branch: string, ...messages: string[]): string;
}

const tempDirs: string[] = [];
let gitEnv: IsolatedGitEnv;

beforeEach(() => {
  gitEnv = isolateGitEnv();
});

afterEach(() => {
  gitEnv.restore();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function createRepo(): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), 'ctxo-ranges-'));
  tempDirs.push(dir);
  let commits = 0;

  const run = (args: string[], env: Record<string, string> = {}): string =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

  const nextTimestamp = (): Record<string, string> => {
    commits += 1;
    const when = `${BASE_TIME + commits * 60} +0000`;
    return { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  };

  run(['init', '-q', '-b', 'main']);
  run(['config', 'diff.renames', 'false']);

  return {
    dir,
    git: (...args) => run(args),
    write(file, content) {
      const full = join(dir, file);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf-8');
    },
    commit(message, ...moreParagraphs) {
      run(['add', '-A']);
      const messages = [message, ...moreParagraphs].flatMap((m) => ['-m', m]);
      run([...IDENTITY, 'commit', '-q', ...messages], nextTimestamp());
      return run(['rev-parse', 'HEAD']);
    },
    merge(branch, ...messages) {
      run([...IDENTITY, 'merge', '--no-ff', branch, ...messages.flatMap((m) => ['-m', m])], nextTimestamp());
      return run(['rev-parse', 'HEAD']);
    },
  };
}

describe('SimpleGitAdapter.getRangeLog', () => {
  it('lists commits reachable from head and from no excluded ref, newest first', async () => {
    const repo = createRepo();
    repo.write('a.ts', '1');
    const c1 = repo.commit('c1');
    repo.git('checkout', '-q', '-b', 'feat');
    repo.write('b.ts', '2');
    const c2 = repo.commit('c2');
    repo.write('c.ts', '3');
    const c3 = repo.commit('c3');

    const log = await new SimpleGitAdapter(repo.dir).getRangeLog({ head: 'HEAD', exclude: [c1] });

    expect(log?.map((c) => c.hash)).toEqual([c3, c2]);
    expect(log?.map((c) => c.subject)).toEqual(['c3', 'c2']);
    expect(log?.[0]).toMatchObject({ isMerge: false, trailers: [], changes: [{ status: 'A', path: 'c.ts' }] });
  });

  it('honours several excluded refs', async () => {
    const repo = createRepo();
    repo.write('a.ts', '1');
    const c1 = repo.commit('c1');
    repo.write('b.ts', '2');
    const c2 = repo.commit('c2');
    repo.write('c.ts', '3');
    const c3 = repo.commit('c3');

    const log = await new SimpleGitAdapter(repo.dir).getRangeLog({ head: 'HEAD', exclude: [c1, c2] });

    expect(log?.map((c) => c.hash)).toEqual([c3]);
  });

  it('marks merge commits, gives them no changes and keeps their trailers', async () => {
    const repo = createRepo();
    repo.write('a.ts', '1');
    const c1 = repo.commit('c1');
    repo.git('checkout', '-q', '-b', 'feat');
    repo.write('b.ts', '2');
    repo.commit('c2');
    repo.git('checkout', '-q', 'main');
    repo.write('c.ts', '3');
    repo.commit('c3');
    const mergeSha = repo.merge('feat', 'merge', 'Domain-Unchanged: lending');

    const log = await new SimpleGitAdapter(repo.dir).getRangeLog({ head: 'HEAD', exclude: [c1] }, { trailerKey: 'Domain-Unchanged' });

    const merge = log?.find((c) => c.hash === mergeSha);
    expect(merge).toMatchObject({ isMerge: true, changes: [], trailers: ['lending'], subject: 'merge' });
    expect(log?.filter((c) => !c.isMerge).every((c) => c.changes.length === 1)).toBe(true);
  });

  it('reads the requested trailer key only, in message order', async () => {
    const repo = createRepo();
    repo.write('a.ts', '1');
    const c1 = repo.commit('c1');
    repo.write('b.ts', '2');
    repo.commit(
      'c2',
      'Domain-Unchanged: lending (refactor only)\nDomain-Unchanged: billing\nSigned-off-by: T',
    );

    const adapter = new SimpleGitAdapter(repo.dir);
    const withKey = await adapter.getRangeLog({ head: 'HEAD', exclude: [c1] }, { trailerKey: 'Domain-Unchanged' });
    const withoutKey = await adapter.getRangeLog({ head: 'HEAD', exclude: [c1] });

    expect(withKey?.[0]?.trailers).toEqual(['lending (refactor only)', 'billing']);
    expect(withoutKey?.[0]?.trailers).toEqual([]);
  });

  it('keeps renames and paths with spaces and non-ASCII characters', async () => {
    const repo = createRepo();
    repo.write('src/a.ts', 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
    const c1 = repo.commit('c1');
    repo.git('mv', 'src/a.ts', 'src/şube kaydı.ts');
    repo.commit('c2');

    const log = await new SimpleGitAdapter(repo.dir).getRangeLog({ head: 'HEAD', exclude: [c1] });

    expect(log?.[0]?.changes).toEqual([{ status: 'R', path: 'src/şube kaydı.ts', oldPath: 'src/a.ts' }]);
  });

  it('returns [] for an empty range and undefined for an unknown ref', async () => {
    const repo = createRepo();
    repo.write('a.ts', '1');
    const c1 = repo.commit('c1');
    const adapter = new SimpleGitAdapter(repo.dir);

    expect(await adapter.getRangeLog({ head: 'HEAD', exclude: [c1] })).toEqual([]);
    expect(await adapter.getRangeLog({ head: 'no-such-ref', exclude: [] })).toBeUndefined();
    expect(await adapter.getRangeLog({ head: 'HEAD', exclude: ['no-such-ref'] })).toBeUndefined();
  });

  it('refuses option-like refs and trailer keys', async () => {
    const repo = createRepo();
    repo.write('a.ts', '1');
    repo.commit('c1');
    const adapter = new SimpleGitAdapter(repo.dir);

    expect(await adapter.getRangeLog({ head: '--all', exclude: [] })).toBeUndefined();
    expect(await adapter.getRangeLog({ head: 'HEAD', exclude: ['-x'] })).toBeUndefined();
    expect(await adapter.getRangeLog({ head: 'HEAD', exclude: [] }, { trailerKey: 'a,b' })).toBeUndefined();
  });
});

describe('SimpleGitAdapter.getWorkingTreeChanges', () => {
  it('reports staged, unstaged and untracked files, and only staged ones for staged', async () => {
    const repo = createRepo();
    repo.write('edit.ts', 'one\ntwo\nthree\nfour\nfive\n');
    repo.write('move.ts', 'alpha\nbeta\ngamma\ndelta\nepsilon\n');
    repo.commit('c1');
    repo.write('staged-new.ts', 'x');
    repo.git('add', 'staged-new.ts');
    repo.write('edit.ts', 'one\ntwo\nthree\nfour\nfive\nsix\n');
    repo.write('untracked.ts', 'y');
    repo.git('mv', 'move.ts', 'moved.ts');

    const adapter = new SimpleGitAdapter(repo.dir);
    const all = await adapter.getWorkingTreeChanges('all');
    const staged = await adapter.getWorkingTreeChanges('staged');

    const byPath = (list: typeof all) => [...(list ?? [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    expect(byPath(all)).toEqual([
      { status: 'M', path: 'edit.ts' },
      { status: 'R', path: 'moved.ts', oldPath: 'move.ts' },
      { status: 'A', path: 'staged-new.ts' },
      { status: 'A', path: 'untracked.ts' },
    ]);
    expect(byPath(staged)).toEqual([
      { status: 'R', path: 'moved.ts', oldPath: 'move.ts' },
      { status: 'A', path: 'staged-new.ts' },
    ]);
  });

  it('maps a deletion in either column to D and leaves ignored files out', async () => {
    const repo = createRepo();
    repo.write('.gitignore', 'ignored.ts\n');
    repo.write('gone.ts', 'x');
    repo.write('gone2.ts', 'x');
    repo.commit('c1');
    repo.git('rm', '-q', 'gone.ts');
    rmSync(join(repo.dir, 'gone2.ts'));
    repo.write('ignored.ts', 'z');

    const all = await new SimpleGitAdapter(repo.dir).getWorkingTreeChanges('all');

    expect([...(all ?? [])].sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual([
      { status: 'D', path: 'gone.ts' },
      { status: 'D', path: 'gone2.ts' },
    ]);
  });

  it('returns undefined outside a repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxo-ranges-nogit-'));
    tempDirs.push(dir);
    // A parent directory may be a repository; pin discovery to this directory.
    process.env['GIT_CEILING_DIRECTORIES'] = dirname(dir);
    try {
      expect(await new SimpleGitAdapter(dir).getWorkingTreeChanges('all')).toBeUndefined();
    } finally {
      delete process.env['GIT_CEILING_DIRECTORIES'];
    }
  });
});

describe('SimpleGitAdapter branch relationships', () => {
  it('mergeBase, isAncestor and resolveCommit describe branch relationships', async () => {
    const repo = createRepo();
    repo.write('a.ts', '1');
    const c1 = repo.commit('c1');
    repo.git('checkout', '-q', '-b', 'feat');
    repo.write('b.ts', '2');
    const c2 = repo.commit('c2');
    repo.git('checkout', '-q', 'main');
    repo.write('c.ts', '3');
    const c3 = repo.commit('c3');
    const adapter = new SimpleGitAdapter(repo.dir);

    expect(await adapter.resolveCommit('feat')).toBe(c2);
    expect(await adapter.resolveCommit('HEAD')).toBe(c3);
    expect(await adapter.resolveCommit('no-such-ref')).toBeUndefined();
    expect(await adapter.mergeBase('main', 'feat')).toBe(c1);
    expect(await adapter.isAncestor(c1, 'feat')).toBe(true);
    expect(await adapter.isAncestor('feat', c1)).toBe(false);
    expect(await adapter.isAncestor('no-such-ref', 'feat')).toBeUndefined();

    expect(await adapter.resolveCommit('-x')).toBeUndefined();
    expect(await adapter.mergeBase('-x', 'feat')).toBeUndefined();
    expect(await adapter.mergeBase('main', '-x')).toBeUndefined();
    expect(await adapter.isAncestor('-x', 'feat')).toBeUndefined();
    expect(await adapter.isAncestor('main', '-x')).toBeUndefined();
  });
});

describe('SimpleGitAdapter.getRefs', () => {
  it('reports the branch, upstream, origin/HEAD and branch list', async () => {
    const repo = createRepo();
    const remote = mkdtempSync(join(tmpdir(), 'ctxo-ranges-remote-'));
    tempDirs.push(remote);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: remote, stdio: 'ignore' });
    repo.write('a.ts', '1');
    repo.commit('c1');
    repo.git('remote', 'add', 'origin', remote);
    repo.git('push', '-q', '-u', 'origin', 'main');
    repo.git('remote', 'set-head', 'origin', 'main');
    const adapter = new SimpleGitAdapter(repo.dir);

    expect(await adapter.getRefs()).toEqual({
      currentBranch: 'main',
      upstream: 'origin/main',
      originHead: 'origin/main',
      branches: ['main', 'origin/main'],
    });

    repo.git('checkout', '-q', '--detach');
    const detached = await adapter.getRefs();
    expect(detached?.currentBranch).toBeUndefined();
    expect(detached?.upstream).toBeUndefined();
    expect(detached?.originHead).toBe('origin/main');
    expect(detached?.branches).toEqual(['main', 'origin/main']);
  });

  it('leaves absent fields undefined in a repository without a remote', async () => {
    const repo = createRepo();
    repo.write('a.ts', '1');
    repo.commit('c1');
    repo.git('branch', 'b-feature');

    const refs = await new SimpleGitAdapter(repo.dir).getRefs();

    expect(refs).toEqual({ currentBranch: 'main', branches: ['b-feature', 'main'] });
  });
});

describe('SimpleGitAdapter.listTrackedFiles', () => {
  it('returns repo-relative forward-slash paths', async () => {
    const repo = createRepo();
    repo.write('src/deep/a.ts', '1');
    repo.write('src/şube kaydı.ts', '2');
    repo.write('root.ts', '3');
    repo.commit('c1');
    repo.write('untracked.ts', '4');

    const files = await new SimpleGitAdapter(repo.dir).listTrackedFiles();

    expect([...(files ?? [])].sort()).toEqual(['root.ts', 'src/deep/a.ts', 'src/şube kaydı.ts']);
  });
});
