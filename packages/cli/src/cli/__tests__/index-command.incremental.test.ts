import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { IndexCommand } from '../index-command.js';
import { SimpleGitAdapter } from '../../adapters/git/simple-git-adapter.js';
import { JsonIndexReader } from '../../adapters/storage/json-index-reader.js';
import { JsonIndexWriter } from '../../adapters/storage/json-index-writer.js';
import { SqliteStorageAdapter } from '../../adapters/storage/sqlite-storage-adapter.js';
import type {
  BoundaryViolationsArtifact,
  CoChangeMatrix,
  CommunitySnapshot,
  FileIndex,
} from '../../core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures', 'sample-project');

// Developer machines often set commit.gpgsign=true globally. Every operation that creates a commit in
// a temp repo (commit, merge) must override it, or the test would wait for a GPG prompt.
const IDENTITY = ['-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@test.com'];

// The n-th commit of a TempProject is dated BASE_TIME + n days, so "newest first" never depends on how
// git breaks same-second ties.
const BASE_TIME = 1_700_000_000;
const SECONDS_PER_DAY = 86_400;

/** True on file systems that treat `a` and `A` as one name (Windows and, by default, macOS). */
const CASE_INSENSITIVE_FS = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'ctxo-case-probe-'));
  try {
    writeFileSync(join(probe, 'probe.txt'), '', 'utf-8');
    return existsSync(join(probe, 'PROBE.TXT'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

interface TempProject {
  readonly dir: string;
  git(...args: string[]): string;
  /** Writes a file in the working tree, creating its folder when needed. */
  write(file: string, content: string): void;
  /** Appends one line to a file in the working tree. */
  append(file: string, line: string): void;
  /** Stages everything that is not ignored and commits it, dated one day after the previous commit. */
  commit(message: string): void;
  /** Merges `branch` into the current branch with a merge commit, dated like the other commits. */
  merge(branch: string): void;
  /** Short SHA of HEAD, as `git rev-parse --short HEAD` prints it. */
  head(): string;
}

// Every temp dir is registered the moment it exists, so afterEach removes it even when a later setup
// step throws.
const tempDirs: string[] = [];

/** A git repository holding the sample project, with one root commit named `init` (day 1). */
function createProject(): TempProject {
  const dir = mkdtempSync(join(tmpdir(), 'ctxo-incremental-'));
  tempDirs.push(dir);
  cpSync(FIXTURES_DIR, dir, { recursive: true });
  let commits = 0;

  const run = (args: string[], env: Record<string, string> = {}): string =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const nextDate = (): Record<string, string> => {
    commits += 1;
    const when = `${BASE_TIME + commits * SECONDS_PER_DAY} +0000`;
    return { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  };

  run(['init', '-q']);
  // Index runs write .ctxo/ and a .gitignore into the project; keep them out of later commits.
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
  appendFileSync(join(dir, '.git', 'info', 'exclude'), '.ctxo/\n.gitignore\n');

  const project: TempProject = {
    dir,
    git: (...args) => run(args),
    write(file, content) {
      const full = join(dir, file);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf-8');
    },
    append(file, line) {
      appendFileSync(join(dir, file), `${line}\n`, 'utf-8');
    },
    commit(message) {
      const env = nextDate();
      run(['add', '-A']);
      run([...IDENTITY, 'commit', '-q', '-m', message], env);
    },
    merge(branch) {
      run([...IDENTITY, 'merge', '--no-ff', '-q', '-m', `merge ${branch}`, branch], nextDate());
    },
    head: () => run(['rev-parse', '--short', 'HEAD']),
  };

  project.commit('init');
  return project;
}

const GREET_AND_TYPES = ['src/greet.ts', 'src/types.ts'] as const;

/** `count` commits that each modify src/greet.ts and src/types.ts. */
function commitGreetAndTypes(project: TempProject, count: number): void {
  for (let n = 1; n <= count; n++) {
    for (const file of GREET_AND_TYPES) project.append(file, `// change ${n}`);
    project.commit(`feat: change ${n}`);
  }
}

function indexJson(dir: string, file: string): string {
  return join(dir, '.ctxo', 'index', `${file}.json`);
}

function hasIndexEntry(dir: string, file: string): boolean {
  return existsSync(indexJson(dir, file));
}

function readFileIndex(dir: string, file: string): FileIndex {
  return JSON.parse(readFileSync(indexJson(dir, file), 'utf-8')) as FileIndex;
}

function symbolNames(dir: string, file: string): string[] {
  return readFileIndex(dir, file).symbols.map((symbol) => symbol.name);
}

function readCoChanges(dir: string): CoChangeMatrix {
  return JSON.parse(readFileSync(join(dir, '.ctxo', 'index', 'co-changes.json'), 'utf-8')) as CoChangeMatrix;
}

function readSnapshot(dir: string): CommunitySnapshot {
  return JSON.parse(readFileSync(join(dir, '.ctxo', 'index', 'communities.json'), 'utf-8')) as CommunitySnapshot;
}

function readViolations(dir: string): BoundaryViolationsArtifact {
  return JSON.parse(
    readFileSync(join(dir, '.ctxo', 'index', 'boundary-violations.json'), 'utf-8'),
  ) as BoundaryViolationsArtifact;
}

function writeConfig(dir: string, yaml: string): void {
  mkdirSync(join(dir, '.ctxo'), { recursive: true });
  writeFileSync(join(dir, '.ctxo', 'config.yaml'), `version: "1.0"\n${yaml}`, 'utf-8');
}

// A file whose source changes on disk, without a commit, while an incremental run names other files:
// that run must leave its index entry as it was. A full run, which re-indexes everything, would pick
// the marker up, so every scenario that has to prove "only the named files" uses this pair.
const MARKER = 'changedOnDiskOnly';

function changeOnDisk(project: TempProject, file: string): void {
  project.append(file, `export function ${MARKER}(): void {}`);
}

function expectNotReindexed(project: TempProject, file: string): void {
  expect(symbolNames(project.dir, file)).not.toContain(MARKER);
}

interface IndexContents {
  readonly files: string[];
  readonly symbolIds: string[];
  readonly edgeCount: number;
}

/** What the committed JSON index holds. */
function readJsonContents(dir: string): IndexContents {
  const indices = new JsonIndexReader(join(dir, '.ctxo')).readAll();
  return {
    files: indices.map((idx) => idx.file).sort(),
    symbolIds: indices.flatMap((idx) => idx.symbols.map((symbol) => symbol.symbolId)).sort(),
    edgeCount: indices.reduce((sum, idx) => sum + idx.edges.length, 0),
  };
}

/**
 * What the SQLite cache holds, read from a copy of the cache file placed in a root without a JSON
 * index. init() rebuilds the cache from the JSON index when there is one; with none, it keeps exactly
 * what the run under test persisted.
 */
async function readSqliteContents(dir: string): Promise<IndexContents> {
  const scratch = mkdtempSync(join(tmpdir(), 'ctxo-sqlite-view-'));
  tempDirs.push(scratch);
  mkdirSync(join(scratch, '.cache'), { recursive: true });
  cpSync(join(dir, '.ctxo', '.cache', 'symbols.db'), join(scratch, '.cache', 'symbols.db'));

  const storage = new SqliteStorageAdapter(scratch);
  try {
    await storage.init();
    return {
      files: storage.listIndexedFiles(),
      symbolIds: storage.getAllSymbols().map((symbol) => symbol.symbolId).sort(),
      edgeCount: storage.getAllEdges().length,
    };
  } finally {
    storage.close();
  }
}

function logLines(spy: MockInstance<typeof console.error>): string[] {
  return spy.mock.calls.map((args) => args.join(' '));
}

/** The run options that select the given paths: the `files` option, or the older `file` spelling. */
type Selector = (paths: string[]) => { files?: string[]; file?: string };

const SPELLINGS: Array<[string, Selector]> = [
  ['--files', (paths) => ({ files: paths })],
  ['--file', (paths) => ({ file: paths[0] })],
];

describe('IndexCommand incremental runs', () => {
  let project: TempProject;
  let errorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    project = createProject();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* best effort: Windows holds simple-git / sqlite handles briefly after the test body returns */
      }
    }
  });

  // --file is the old spelling of --files with one path; both must behave the same.
  describe.each(SPELLINGS)('%s', (_flag, select) => {
    it('keeps every co-change entry', async () => {
      commitGreetAndTypes(project, 3);
      await new IndexCommand(project.dir).run();
      const full = readCoChanges(project.dir);
      expect(full.entries.length).toBeGreaterThan(0);
      const before = readFileSync(join(project.dir, '.ctxo', 'index', 'co-changes.json'));
      changeOnDisk(project, 'src/utils.ts');

      await new IndexCommand(project.dir).run(select(['src/types.ts']));

      expect(readCoChanges(project.dir).entries).toEqual(full.entries);
      expect(readFileSync(join(project.dir, '.ctxo', 'index', 'co-changes.json')).equals(before)).toBe(true);
      expectNotReindexed(project, 'src/utils.ts');
    });

    it('keeps SQLite complete', async () => {
      await new IndexCommand(project.dir).run();
      expect((await readSqliteContents(project.dir)).files).toEqual(['src/greet.ts', 'src/types.ts', 'src/utils.ts']);
      changeOnDisk(project, 'src/utils.ts');

      await new IndexCommand(project.dir).run(select(['src/types.ts']));

      // Every indexed file, not just the one named, with the symbols and edges of the JSON index once each.
      const cache = await readSqliteContents(project.dir);
      const json = readJsonContents(project.dir);
      expect(cache.files).toEqual(['src/greet.ts', 'src/types.ts', 'src/utils.ts']);
      expect(cache.files).toEqual(json.files);
      expect(cache.symbolIds).toEqual(json.symbolIds);
      expect(cache.edgeCount).toBe(json.edgeCount);
      expect(cache.edgeCount).toBeGreaterThan(0);
      expectNotReindexed(project, 'src/utils.ts');
    });

    it('resolves edges against the committed registry', async () => {
      // A PascalCase function: without the registry its kind would be guessed as a class.
      project.write('src/models.ts', 'export function Widget(): string {\n  return "widget";\n}\n');
      project.write(
        'src/render.ts',
        "import { Widget } from './models';\n\nexport function render(): string {\n  return Widget();\n}\n",
      );
      project.commit('feat: add widget and render');
      await new IndexCommand(project.dir).run();
      const fullEdges = readFileIndex(project.dir, 'src/render.ts').edges;
      expect(fullEdges.length).toBeGreaterThan(0);
      expect(fullEdges.map((edge) => edge.to)).toContain('src/models.ts::Widget::function');
      project.append('src/render.ts', '// edited');
      changeOnDisk(project, 'src/utils.ts');

      await new IndexCommand(project.dir).run(select(['src/render.ts']));

      expect(readFileIndex(project.dir, 'src/render.ts').edges).toEqual(fullEdges);
      expectNotReindexed(project, 'src/utils.ts');
    });

    it('computes boundary-violations.json from the full graph', async () => {
      // Two tightly connected clusters joined by one edge, from a3 to b1. a1 has no edge that leaves
      // its cluster, so re-indexing a1 alone sees no violation unless the full graph is used.
      const cluster = (name: string, others: string[]): string =>
        others.map((other) => `import { ${other} } from './${other}';`).join('\n') +
        `\nexport function ${name}(): number {\n  return ${others.map((other) => `${other}()`).join(' + ')};\n}\n`;
      project.write('src/a/a1.ts', cluster('a1', ['a2', 'a3']));
      project.write('src/a/a2.ts', cluster('a2', ['a1', 'a3']));
      project.write(
        'src/a/a3.ts',
        "import { b1 } from '../b/b1';\n" + cluster('a3', ['a1', 'a2']).replace('return a1() + a2()', 'return b1() + a1() + a2()'),
      );
      project.write('src/b/b1.ts', cluster('b1', ['b2', 'b3']));
      project.write('src/b/b2.ts', cluster('b2', ['b1', 'b3']));
      project.write('src/b/b3.ts', cluster('b3', ['b1', 'b2']));
      project.commit('feat: two clusters with one bridge');
      await new IndexCommand(project.dir).run();
      const full = readViolations(project.dir);
      expect(full.violations.length).toBeGreaterThan(0);
      changeOnDisk(project, 'src/b/b2.ts');

      await new IndexCommand(project.dir).run(select(['src/a/a1.ts']));

      const incremental = readViolations(project.dir);
      expect(incremental.violations.length).toBe(full.violations.length);
      expect(incremental.commitSha).toBe(project.head());
      expectNotReindexed(project, 'src/b/b2.ts');
    });
  });

  it('--files re-indexes only the files that a full run would index', async () => {
    writeConfig(project.dir, 'index:\n  ignore:\n    - "fixtures/**"\n');
    project.write('fixtures/skip.ts', 'export const skipped = 1;\n');
    project.write('README.md', '# readme\n');
    project.commit('chore: add ignored fixture and readme');

    // Backslashes, a ./ prefix, an unsupported language, an ignored file, a path outside the project
    // and a file that does not exist: only the first two are indexed.
    await new IndexCommand(project.dir).run({
      files: ['src\\types.ts', './src/greet.ts', 'README.md', 'fixtures/skip.ts', '../outside.ts', 'src/missing.ts'],
    });

    expect(hasIndexEntry(project.dir, 'src/types.ts')).toBe(true);
    expect(hasIndexEntry(project.dir, 'src/greet.ts')).toBe(true);
    for (const file of ['src/utils.ts', 'README.md', 'fixtures/skip.ts', 'src/missing.ts']) {
      expect(hasIndexEntry(project.dir, file)).toBe(false);
    }
    const lines = logLines(errorSpy);
    expect(lines).toContain('[ctxo] Skipped ../outside.ts: not a path inside the project');
    // README.md and fixtures/skip.ts; src/missing.ts is indexable in principle, it is just not there.
    expect(lines.some((line) => line.startsWith('[ctxo] Skipped 2 listed file(s) that a full run would not index'))).toBe(true);
  });

  it('--files applies index.ignoreProjects and the workspace layout like a full run', async () => {
    project.write(
      'package.json',
      JSON.stringify({ name: 'root', workspaces: ['packages/*'], devDependencies: { '@ctxo/lang-typescript': 'workspace:*' } }),
    );
    writeConfig(project.dir, 'index:\n  ignoreProjects:\n    - "packages/experimental-*"\n');
    project.write('packages/keep/package.json', JSON.stringify({ name: 'keep' }));
    project.write('packages/keep/src/a.ts', 'export const a = 1;\n');
    project.write('packages/keep/src/not-listed.ts', 'export const notListed = 1;\n');
    project.write('packages/experimental-foo/package.json', JSON.stringify({ name: 'experimental-foo' }));
    project.write('packages/experimental-foo/src/b.ts', 'export const b = 2;\n');
    project.write('tools/outside.ts', 'export const outside = 3;\n');
    project.commit('feat: workspaces');

    await new IndexCommand(project.dir).run({
      files: ['packages/keep/src/a.ts', 'packages/experimental-foo/src/b.ts', 'tools/outside.ts'],
    });

    expect(hasIndexEntry(project.dir, 'packages/keep/src/a.ts')).toBe(true);
    expect(hasIndexEntry(project.dir, 'packages/experimental-foo/src/b.ts')).toBe(false);
    expect(hasIndexEntry(project.dir, 'tools/outside.ts')).toBe(false);
    // A full run would index this file too; a run for a.ts alone must not.
    expect(hasIndexEntry(project.dir, 'packages/keep/src/not-listed.ts')).toBe(false);
  });

  it('--files that selects nothing to index leaves the index, co-change and the snapshot as they were', async () => {
    commitGreetAndTypes(project, 2);
    await new IndexCommand(project.dir).run();
    const read = (file: string): Buffer => readFileSync(join(project.dir, '.ctxo', 'index', file));
    const before = { snapshot: read('communities.json'), coChanges: read('co-changes.json'), greet: read('src/greet.ts.json') };

    project.write('README.md', '# readme\n');
    await new IndexCommand(project.dir).run({ files: ['README.md'] });

    expect(read('communities.json').equals(before.snapshot)).toBe(true);
    expect(read('co-changes.json').equals(before.coChanges)).toBe(true);
    expect(read('src/greet.ts.json').equals(before.greet)).toBe(true);
    // The SQLite cache is rebuilt from the committed index and still holds every file.
    expect((await readSqliteContents(project.dir)).files).toEqual(['src/greet.ts', 'src/types.ts', 'src/utils.ts']);
  });

  it('--files drops a listed file that is gone from the working tree from the index', async () => {
    await new IndexCommand(project.dir).run();
    expect(hasIndexEntry(project.dir, 'src/utils.ts')).toBe(true);
    expect(JSON.stringify(readSnapshot(project.dir).communities)).toContain('src/utils.ts');
    rmSync(join(project.dir, 'src', 'utils.ts'));

    await new IndexCommand(project.dir).run({ files: ['src/utils.ts'] });

    expect(hasIndexEntry(project.dir, 'src/utils.ts')).toBe(false);
    expect((await readSqliteContents(project.dir)).files).toEqual(['src/greet.ts', 'src/types.ts']);
    // Removing a file changes the graph, so the snapshot is recomputed without it.
    expect(JSON.stringify(readSnapshot(project.dir).communities)).not.toContain('src/utils.ts');
  });

  it('--commit HEAD re-indexes changed files, removes deleted ones and follows a rename', async () => {
    project.write('src/extra.ts', 'export function extra(): number {\n  return 1;\n}\n');
    project.write('src/old-name.ts', 'export function legacy(): string {\n  return "legacy";\n}\n');
    project.commit('feat: add extra and old-name');
    project.append('src/extra.ts', '// touched');
    project.append('src/old-name.ts', '// touched');
    project.commit('chore: touch extra and old-name');
    await new IndexCommand(project.dir).run();
    expect(hasIndexEntry(project.dir, 'src/extra.ts')).toBe(true);
    expect(hasIndexEntry(project.dir, 'src/old-name.ts')).toBe(true);
    // They changed together twice, so the matrix has an entry for them before the last commit.
    expect(JSON.stringify(readCoChanges(project.dir).entries)).toContain('src/extra.ts');

    // One commit with a modification, a deletion and a rename, and a file that no language plugin indexes.
    project.append('src/greet.ts', 'export function farewell(name: string): string { return `Bye, ${name}`; }');
    project.git('rm', '-q', 'src/extra.ts');
    project.git('mv', 'src/old-name.ts', 'src/new-name.ts');
    project.write('README.md', '# notes\n');
    project.commit('refactor: change greet, drop extra, rename old-name');
    changeOnDisk(project, 'src/utils.ts'); // not part of the commit
    errorSpy.mockClear();

    await new IndexCommand(project.dir).run({ commit: 'HEAD' });

    expect(symbolNames(project.dir, 'src/greet.ts')).toContain('farewell');
    expect(hasIndexEntry(project.dir, 'src/extra.ts')).toBe(false);
    expect(hasIndexEntry(project.dir, 'src/old-name.ts')).toBe(false);
    expect(hasIndexEntry(project.dir, 'src/new-name.ts')).toBe(true);
    // The history of the renamed file goes back across the rename.
    expect(readFileIndex(project.dir, 'src/new-name.ts').intent.map((entry) => entry.message)).toEqual([
      'refactor: change greet, drop extra, rename old-name',
      'chore: touch extra and old-name',
      'feat: add extra and old-name',
    ]);
    expectNotReindexed(project, 'src/utils.ts');
    expect(hasIndexEntry(project.dir, 'README.md')).toBe(false);
    // The commit changes files that nothing indexes; that is normal and not worth a log line.
    expect(logLines(errorSpy).some((line) => line.includes('listed file(s)'))).toBe(false);
    expect(logLines(errorSpy)).toContain('[ctxo] Incremental re-index: 2 file(s) to index, 2 to remove (commit HEAD)');

    // The removed files are gone from everything built from the merged index.
    expect((await readSqliteContents(project.dir)).files).toEqual([
      'src/greet.ts',
      'src/new-name.ts',
      'src/types.ts',
      'src/utils.ts',
    ]);
    const gone = (text: string): boolean => text.includes('src/extra.ts') || text.includes('src/old-name.ts');
    expect(gone(JSON.stringify(readSnapshot(project.dir).communities))).toBe(false);
    expect(gone(JSON.stringify(readCoChanges(project.dir).entries))).toBe(false);
  });

  it('--commit HEAD on a commit that only deletes a file removes it everywhere and refreshes co-change and the snapshot', async () => {
    commitGreetAndTypes(project, 2);
    await new IndexCommand(project.dir).run();
    const headBefore = project.head();

    project.git('rm', '-q', 'src/utils.ts');
    project.commit('chore: remove utils');
    await new IndexCommand(project.dir).run({ commit: 'HEAD' });

    expect(project.head()).not.toBe(headBefore);
    expect(hasIndexEntry(project.dir, 'src/utils.ts')).toBe(false);
    expect((await readSqliteContents(project.dir)).files).toEqual(['src/greet.ts', 'src/types.ts']);
    expect(readSnapshot(project.dir).commitSha).toBe(project.head());
    expect(readCoChanges(project.dir).window?.head).toBe(project.head());
    expect(JSON.stringify(readSnapshot(project.dir).communities)).not.toContain('src/utils.ts');
  });

  it('--commit HEAD goes on when a removed file cannot be deleted from the index', async () => {
    commitGreetAndTypes(project, 2);
    await new IndexCommand(project.dir).run();
    project.git('rm', '-q', 'src/utils.ts');
    project.commit('chore: remove utils');
    vi.spyOn(JsonIndexWriter.prototype, 'delete').mockImplementation(() => {
      throw new Error('EPERM: locked');
    });

    await expect(new IndexCommand(project.dir).run({ commit: 'HEAD' })).resolves.toBeUndefined();

    expect(logLines(errorSpy)).toContain('[ctxo] Could not remove src/utils.ts from the index: EPERM: locked');
    // Everything else was still produced, without the file that could not be deleted.
    expect((await readSqliteContents(project.dir)).files).toEqual(['src/greet.ts', 'src/types.ts']);
    expect(readSnapshot(project.dir).commitSha).toBe(project.head());
    expect(JSON.stringify(readSnapshot(project.dir).communities)).not.toContain('src/utils.ts');
  });

  it('--commit HEAD never deletes an index artifact because a deleted repository file has its name', async () => {
    // The JSON entry of a file `x` is `x.json`, so a deleted file called `co-changes` would name the
    // co-change matrix. Only paths that really have an index entry are removed.
    project.write('co-changes', 'not source code\n');
    project.commit('chore: add a file named like an artifact');
    commitGreetAndTypes(project, 2);
    await new IndexCommand(project.dir).run();
    project.git('rm', '-q', 'co-changes');
    project.commit('chore: remove it again');

    await new IndexCommand(project.dir).run({ commit: 'HEAD' });

    expect(existsSync(join(project.dir, '.ctxo', 'index', 'co-changes.json'))).toBe(true);
    expect(readCoChanges(project.dir).window?.head).toBe(project.head());
  });

  it('--commit HEAD on a root commit indexes its files', async () => {
    // Not part of any commit: a full run would index it, a run for the root commit must not.
    project.write('src/untracked.ts', 'export const untracked = 1;\n');

    await new IndexCommand(project.dir).run({ commit: 'HEAD' });

    for (const file of ['src/greet.ts', 'src/types.ts', 'src/utils.ts']) {
      expect(hasIndexEntry(project.dir, file)).toBe(true);
    }
    expect(hasIndexEntry(project.dir, 'src/untracked.ts')).toBe(false);
    expect(readSnapshot(project.dir).commitSha).toBe(project.head());
    expect(readCoChanges(project.dir).window).toMatchObject({ head: project.head(), commitsScanned: 1 });
  });

  it('--commit HEAD on a merge commit re-indexes nothing but refreshes co-change and the snapshot', async () => {
    commitGreetAndTypes(project, 2);
    const main = project.git('rev-parse', '--abbrev-ref', 'HEAD');
    project.git('checkout', '-q', '-b', 'side');
    project.write('src/side.ts', 'export function side(): number {\n  return 2;\n}\n');
    project.append('src/greet.ts', 'export function sideGreeting(): string { return "side"; }');
    project.commit('feat: work on the side branch');
    project.git('checkout', '-q', main);
    project.append('src/utils.ts', 'export const MAIN_ONLY = true;');
    project.commit('feat: work on the main branch');

    await new IndexCommand(project.dir).run();
    const headBefore = project.head();
    const files = ['src/greet.ts', 'src/types.ts', 'src/utils.ts'];
    const bytesBefore = files.map((file) => readFileSync(indexJson(project.dir, file)));
    const commitsBefore = readCoChanges(project.dir).window!.commitsScanned;

    project.merge('side');
    expect(project.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3); // a real merge
    await expect(new IndexCommand(project.dir).run({ commit: 'HEAD' })).resolves.toBeUndefined();

    // Nothing was re-indexed: the merged-in file is not indexed and no entry changed.
    expect(hasIndexEntry(project.dir, 'src/side.ts')).toBe(false);
    files.forEach((file, i) => expect(readFileSync(indexJson(project.dir, file)).equals(bytesBefore[i]!)).toBe(true));
    // Co-change and the snapshot follow the new HEAD.
    expect(project.head()).not.toBe(headBefore);
    const window = readCoChanges(project.dir).window!;
    expect(window.head).toBe(project.head());
    expect(window.commitsScanned).toBe(commitsBefore + 1); // the side commit joined the history
    expect(readSnapshot(project.dir).commitSha).toBe(project.head());
  });

  // `Case.ts` and `case.ts` name one JSON file here, so the entry of the old name must be deleted
  // before the entry of the new name is written, or the delete would take the new entry with it.
  it.skipIf(!CASE_INSENSITIVE_FS)('--commit HEAD follows a case-only rename on a case-insensitive file system', async () => {
    project.write('src/Case.ts', 'export function shout(): string {\n  return "hi";\n}\n');
    project.commit('feat: add Case');
    await new IndexCommand(project.dir).run();
    project.git('mv', 'src/Case.ts', 'src/case.ts');
    project.commit('refactor: lower-case the file name');

    await new IndexCommand(project.dir).run({ commit: 'HEAD' });

    const indexed = new JsonIndexReader(join(project.dir, '.ctxo')).readAll().map((idx) => idx.file);
    expect(indexed).toContain('src/case.ts');
    expect(indexed).not.toContain('src/Case.ts');
    expect((await readSqliteContents(project.dir)).files).toContain('src/case.ts');
  });

  it('--commit with a revision git cannot resolve fails and indexes nothing', async () => {
    await expect(new IndexCommand(project.dir).run({ commit: 'no-such-revision' })).rejects.toThrow(
      /--commit no-such-revision/,
    );

    expect(hasIndexEntry(project.dir, 'src/greet.ts')).toBe(false);
    expect(existsSync(join(project.dir, '.ctxo', 'index', 'co-changes.json'))).toBe(false);
  });

  it('the snapshot commitSha is the real short HEAD', async () => {
    commitGreetAndTypes(project, 1);
    await new IndexCommand(project.dir).run();
    expect(readSnapshot(project.dir).commitSha).toBe(project.head());

    commitGreetAndTypes(project, 1);
    await new IndexCommand(project.dir).run({ commit: 'HEAD' });

    expect(readSnapshot(project.dir).commitSha).toBe(project.head());
    expect(readViolations(project.dir).commitSha).toBe(project.head());
  });

  it('the snapshot commitSha falls back to git in the project directory when the git adapter cannot tell HEAD', async () => {
    commitGreetAndTypes(project, 1);
    vi.spyOn(SimpleGitAdapter.prototype, 'getHeadSha').mockResolvedValue(undefined);

    await new IndexCommand(project.dir).run();

    // The process runs in another repository (this one); only the project directory gives the right SHA.
    expect(readSnapshot(project.dir).commitSha).toBe(project.head());
  });

  it('the snapshot commitSha is the untruncated short HEAD, whatever length git abbreviates to', async () => {
    // The staleness check compares the snapshot's commitSha with `git rev-parse --short HEAD`, so a
    // repository that abbreviates to 12 characters must not get its SHA cut to 8.
    project.git('config', 'core.abbrev', '12');
    commitGreetAndTypes(project, 1);

    await new IndexCommand(project.dir).run({ commit: 'HEAD' });

    const { commitSha } = readSnapshot(project.dir);
    expect(commitSha).toHaveLength(12);
    expect(commitSha).toBe(project.head());
  });
});
