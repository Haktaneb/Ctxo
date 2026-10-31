import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createModuleHost } from '../module-host.js';
import { getVersion } from '../cli-paths.js';
import { DATA_RESOURCE_KINDS } from '@ctxo/plugin-api';
import { TEST_FRAMEWORK_ANNOTATIONS } from '../../core/test-files/test-file-classifier.js';
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
  it('testFrameworkAnnotations is the classifier constant', () => {
    const { services } = createModuleHost({ projectRoot: tempDir(), mode: 'cli' });
    expect(services.testFrameworkAnnotations).toEqual(TEST_FRAMEWORK_ANNOTATIONS);
  });

  it('dataResourceKinds is the plugin API constant', () => {
    const { services } = createModuleHost({ projectRoot: tempDir(), mode: 'cli' });
    expect(services.dataResourceKinds).toEqual(DATA_RESOURCE_KINDS);
  });

  it('createDocumentSearch returns BM25 hits over the documents', () => {
    const { services } = createModuleHost({ projectRoot: tempDir(), mode: 'cli' });
    const search = services.createDocumentSearch([
      { id: 'rule:LEND-03', title: 'LEND-03 A member holds at most five loans', kind: 'rule', path: 'docs/domain/lending.md', text: 'The sixth loan is refused while five are open.' },
      { id: 'term:lending/hold', title: 'Hold', kind: 'term', path: 'docs/domain/glossary.md', text: 'A reservation of a copy for a member.' },
    ]);

    const response = search.search('sixth loan');
    expect(response.results[0]!.symbolId).toBe('rule:LEND-03');
    expect(response.results[0]!.name).toBe('LEND-03 A member holds at most five loans');
    expect(search.search('member', 1).results).toHaveLength(1);
  });

  it('createDocumentSearch hands out search only, not the engine', () => {
    const { services } = createModuleHost({ projectRoot: tempDir(), mode: 'cli' });
    const search = services.createDocumentSearch([
      { id: 'term:lending/hold', title: 'Hold', kind: 'term', path: 'docs/domain/glossary.md', text: 'A reservation of a copy for a member.' },
    ]);

    expect(Object.keys(search)).toEqual(['search']);
    const raw = search as unknown as Record<string, unknown>;
    expect(raw['buildIndex']).toBeUndefined();
    expect(raw['buildDocumentIndex']).toBeUndefined();
    expect(raw['updateFile']).toBeUndefined();
    expect(search.search('reservation').results[0]!.symbolId).toBe('term:lending/hold');
  });

  it('createDocumentSearch keeps the input order for equal scores', () => {
    const { services } = createModuleHost({ projectRoot: tempDir(), mode: 'cli' });
    const twin = (id: string) => ({ id, title: 'Hold', kind: 'term', path: 'docs/domain/glossary.md', text: 'A reservation of a copy.' });

    const ab = services.createDocumentSearch([twin('a'), twin('b')]).search('reservation').results.map((r) => r.symbolId);
    const ba = services.createDocumentSearch([twin('b'), twin('a')]).search('reservation').results.map((r) => r.symbolId);

    expect(ab).toEqual(['a', 'b']);
    expect(ba).toEqual(['b', 'a']);
  });

  it('splitIdentifier splits camelCase, PascalCase and snake_case', () => {
    const { services } = createModuleHost({ projectRoot: tempDir(), mode: 'cli' });
    expect(services.splitIdentifier('ILoanRepository')).toEqual(['I', 'Loan', 'Repository']);
    expect(services.splitIdentifier('member_account_id')).toEqual(['member', 'account', 'id']);
  });

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

  it('readCoChangeEntries returns the entries of co-changes.json once per pair and undefined for a missing or invalid file', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { services, ctxoRoot } = createModuleHost({ projectRoot: tempDir(), mode: 'cli' });
      const matrixFile = join(ctxoRoot, 'index', 'co-changes.json');
      const writeMatrix = (content: string, minute: number) => {
        writeFileSync(matrixFile, content, 'utf-8');
        // A fixed mtime per write, so two writes in one timer tick still look different to the reader.
        const when = new Date(Date.UTC(2026, 0, 1, 0, minute));
        utimesSync(matrixFile, when, when);
      };

      // No matrix yet.
      expect(services.readCoChangeEntries(ctxoRoot)).toBeUndefined();

      // One pair gives exactly one entry; flattening readCoChangeMap() would give it twice.
      const pair = { file1: 'src/Lending/Loan.cs', file2: 'src/Members/Member.cs', sharedCommits: 3, frequency: 0.6 };
      mkdirSync(join(ctxoRoot, 'index'), { recursive: true });
      writeMatrix(JSON.stringify({ version: 1, timestamp: 1, entries: [pair] }), 1);
      expect(services.readCoChangeEntries(ctxoRoot)).toEqual([pair]);

      // Invalid content: undefined, never a throw.
      writeMatrix('{ not json', 2);
      expect(services.readCoChangeEntries(ctxoRoot)).toBeUndefined();
      writeMatrix(JSON.stringify({ version: 2, timestamp: 1, entries: [pair] }), 3);
      expect(services.readCoChangeEntries(ctxoRoot)).toBeUndefined();

      // Gone again.
      rmSync(matrixFile);
      expect(services.readCoChangeEntries(ctxoRoot)).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
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
