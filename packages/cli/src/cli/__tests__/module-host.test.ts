import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createModuleHost } from '../module-host.js';
import { getVersion } from '../cli-paths.js';
import { JsonIndexWriter } from '../../adapters/storage/json-index-writer.js';
import { compareCodepoint } from '../../core/compare-codepoint.js';
import type { FileIndex, SymbolNode } from '../../core/types.js';
import { isolateGitEnv, type IsolatedGitEnv } from './git-test-env.js';

// Developer machines often set commit.gpgsign=true globally; a signing prompt would hang the test.
const IDENTITY = ['-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@test.com'];

// The n-th commit of a temp repo is dated BASE_TIME + n days, so "newest first" and the since cutoff
// never depend on the clock or on how git breaks same-second ties.
const BASE_TIME = 1_700_000_000;
const SECONDS_PER_DAY = 86_400;

const tempDirs: string[] = [];
let gitEnv: IsolatedGitEnv;

beforeEach(() => {
  gitEnv = isolateGitEnv();
});

afterEach(() => {
  gitEnv.restore();
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best effort: Windows can hold a handle briefly after the test body returns */
    }
  }
});

function tempDir(prefix = 'ctxo-module-host-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function symbol(file: string, name: string, kind: SymbolNode['kind'], annotations?: SymbolNode['annotations']): SymbolNode {
  return { symbolId: `${file}::${name}::${kind}`, name, kind, startLine: 0, endLine: 1, ...(annotations ? { annotations } : {}) };
}

function fileIndex(file: string, symbols: SymbolNode[], edges: FileIndex['edges'] = []): FileIndex {
  return { file, lastModified: 1, symbols, edges, intent: [], antiPatterns: [] };
}

interface TempRepo {
  readonly dir: string;
  git(...args: string[]): string;
  write(file: string, content: string): void;
  /** Stages everything and commits as the n-th commit (dated BASE_TIME + n days). */
  commit(message: string): void;
}

function createRepo(): TempRepo {
  const dir = tempDir('ctxo-module-host-repo-');
  let commits = 0;
  const run = (args: string[], env: Record<string, string> = {}): string =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

  run(['init', '-q', '-b', 'main']);
  return {
    dir,
    git: (...args) => run(args),
    write(file, content) {
      const full = join(dir, file);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf-8');
    },
    commit(message) {
      commits += 1;
      const when = `${BASE_TIME + commits * SECONDS_PER_DAY} +0000`;
      run(['add', '-A']);
      run([...IDENTITY, 'commit', '-q', '-m', message], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
    },
  };
}

/** Four commits: a.ts, b.ts, a.ts renamed to c.ts, d.ts. */
function fourCommitRepo(): TempRepo {
  const repo = createRepo();
  repo.write('src/a.ts', 'export const a = 1;\n'.repeat(20));
  repo.commit('first');
  repo.write('src/b.ts', 'export const b = 2;\n');
  repo.commit('second');
  repo.git('mv', 'src/a.ts', 'src/c.ts');
  repo.commit('third renames a to c');
  repo.write('src/d.ts', 'export const d = 4;\n');
  repo.commit('fourth');
  return repo;
}

describe('createModuleHost', () => {
  it('createModuleHost reports the cli version and the project paths', () => {
    const root = tempDir();

    const host = createModuleHost({ projectRoot: root, mode: 'cli' });

    expect(host.cliVersion).toBe(getVersion());
    expect(host.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(host.mode).toBe('cli');
    expect(host.projectRoot).toBe(root);
    expect(host.ctxoRoot).toBe(join(root, '.ctxo'));

    const overridden = createModuleHost({ projectRoot: root, mode: 'hook', cliVersion: '9.8.7' });
    expect(overridden.cliVersion).toBe('9.8.7');
    expect(overridden.mode).toBe('hook');
  });
});

describe('host services', () => {
  it('host services load config, match globs, classify test files and read the index', () => {
    const root = tempDir();
    const ctxoRoot = join(root, '.ctxo');
    mkdirSync(ctxoRoot, { recursive: true });
    writeFileSync(join(ctxoRoot, 'config.yaml'), "version: '1.0'\nindex:\n  tests:\n    - '**/Specs/**'\n", 'utf-8');
    const writer = new JsonIndexWriter(ctxoRoot);
    writer.write(fileIndex('src/a.ts', [symbol('src/a.ts', 'a', 'function')]));
    writer.write(
      fileIndex('src/Lending.Checks/LoanChecks.cs', [
        symbol('src/Lending.Checks/LoanChecks.cs', 'LoanChecks.Approves', 'method', [{ name: 'Fact' }]),
      ]),
    );

    const { services, ctxoRoot: hostCtxoRoot } = createModuleHost({ projectRoot: root, mode: 'cli' });
    const loaded = services.loadConfig(hostCtxoRoot);
    expect(loaded.exists).toBe(true);
    expect(loaded.errors).toEqual([]);
    expect(loaded.config.index?.tests).toEqual(['**/Specs/**']);

    const indices = services.readIndex(hostCtxoRoot);
    expect(indices.map((index) => index.file).sort(compareCodepoint)).toEqual([
      'src/Lending.Checks/LoanChecks.cs',
      'src/a.ts',
    ]);

    const isTest = services.createTestFileCheck(loaded.config, indices);
    expect(isTest('src/x/Specs/a.cs')).toBe(true);
    expect(isTest('src/a.test.ts')).toBe(true);
    expect(isTest('src/Lending.Checks/LoanChecks.cs')).toBe(true);
    expect(isTest('src/a.ts')).toBe(false);

    const matchesSrc = services.makeGlobMatcher(Object.freeze(['src/**']));
    expect(matchesSrc('src\\a.ts')).toBe(true);
    expect(matchesSrc('lib/a.ts')).toBe(false);
  });

  it('the test-file check decides like the contexts view: a name-only *Tests.cs needs a test annotation once C# annotations exist', () => {
    const { services } = createModuleHost({ projectRoot: tempDir(), mode: 'cli' });
    const withCSharpAnnotations = [
      fileIndex('src/Lending/Loan.cs', [symbol('src/Lending/Loan.cs', 'Loan', 'class', [{ name: 'Serializable' }])]),
    ];
    const withoutAnnotations = [fileIndex('src/Lending/Loan.cs', [symbol('src/Lending/Loan.cs', 'Loan', 'class')])];

    expect(services.createTestFileCheck({}, withCSharpAnnotations)('src/Lending/LoanTests.cs')).toBe(false);
    expect(services.createTestFileCheck({}, withoutAnnotations)('src/Lending/LoanTests.cs')).toBe(true);
    // Path globs other than the name-only ones decide as before.
    expect(services.createTestFileCheck({}, withCSharpAnnotations)('src/Lending.Tests/Loan.cs')).toBe(true);
  });

  it('buildGraph builds the symbol graph of the indices', () => {
    const { services } = createModuleHost({ projectRoot: tempDir(), mode: 'cli' });
    const a = symbol('src/a.ts', 'a', 'function');
    const b = symbol('src/b.ts', 'b', 'function');
    // The edge sits in the file read first and points at a node of the file read later.
    const graph = services.buildGraph([
      fileIndex('src/a.ts', [a], [{ from: a.symbolId, to: b.symbolId, kind: 'calls' }]),
      fileIndex('src/b.ts', [b]),
    ]);

    expect(graph.nodeCount).toBe(2);
    expect(graph.getForwardEdges(a.symbolId).map((edge) => edge.to)).toEqual([b.symbolId]);
  });

  it('createGit binds the git port to the project root', async () => {
    const repo = createRepo();
    repo.write('README.md', 'hello\n');
    repo.commit('first');

    const git = createModuleHost({ projectRoot: repo.dir, mode: 'cli' }).services.createGit(repo.dir);

    expect(await git.resolveCommit?.('HEAD')).toBe(repo.git('rev-parse', 'HEAD'));
  });

  it('readCoChangeWindow returns the commits of the configured window', async () => {
    const repo = fourCommitRepo();
    const { services } = createModuleHost({ projectRoot: repo.dir, mode: 'cli' });

    const window = await services.readCoChangeWindow(repo.dir, { cochange: { maxCommits: 2 } });

    expect(window).toBeDefined();
    expect(window!.head).toBe(repo.git('log', '-1', '--format=%h'));
    expect(window!.headCommittedAt).toBe(BASE_TIME + 4 * SECONDS_PER_DAY);
    expect(window!.commits.map((commit) => commit.message)).toEqual(['fourth', 'third renames a to c']);
    // Raw commits: the rename keeps its old path.
    expect(window!.commits[1]!.changes).toEqual([{ status: 'R', path: 'src/c.ts', oldPath: 'src/a.ts' }]);
  });

  it('readCoChangeWindow applies the since cutoff counted back from HEAD', async () => {
    const repo = fourCommitRepo();
    const { services } = createModuleHost({ projectRoot: repo.dir, mode: 'cli' });

    // HEAD is day 4, so 2d keeps the commits of days 2, 3 and 4.
    const window = await services.readCoChangeWindow(repo.dir, { cochange: { maxCommits: 'all', since: '2d' } });

    expect(window!.commits.map((commit) => commit.message)).toEqual(['fourth', 'third renames a to c', 'second']);
  });

  it('readCoChangeWindow returns undefined without git history', async () => {
    const { services } = createModuleHost({ projectRoot: tempDir(), mode: 'cli' });
    const notARepo = tempDir('ctxo-module-host-plain-');
    const missing = join(notARepo, 'does-not-exist');

    expect(await services.readCoChangeWindow(notARepo, {})).toBeUndefined();
    expect(await services.readCoChangeWindow(missing, {})).toBeUndefined();
  });

  it('findGitRoot walks up to the repository root', () => {
    const repo = createRepo();
    const nested = join(repo.dir, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    const { services } = createModuleHost({ projectRoot: repo.dir, mode: 'cli' });

    expect(services.findGitRoot(nested)).toBe(repo.dir);
    expect(services.findGitRoot(repo.dir)).toBe(repo.dir);
    // A directory right below the filesystem root has no repository above it.
    expect(services.findGitRoot(join(parse(repo.dir).root, 'ctxo-module-host-no-such-dir'))).toBeUndefined();
  });

  it('createLogger returns a logger for the namespace', () => {
    const { services } = createModuleHost({ projectRoot: tempDir(), mode: 'cli' });
    const logger = services.createLogger('ctxo:domain');

    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.warn).toBe('function');
  });
});
