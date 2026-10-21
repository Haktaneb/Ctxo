import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { InitCommand } from '../init-command.js';

const tempDirs: string[] = [];

// A git hook run by the owner's tooling exports GIT_DIR and friends. If this suite inherited them,
// `git rev-parse --git-path hooks` would point at the live hooks instead of the temp repo.
const SCRUBBED_GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX'] as const;
const savedGitEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of SCRUBBED_GIT_ENV) {
    savedGitEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  tempDirs.length = 0;
  for (const [key, value] of savedGitEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedGitEnv.clear();
});

/** A real, empty git repository in the OS temp dir. Hook tests never touch any other repository. */
function makeTempProject(prefix = 'ctxo-init-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

/** The post-commit block that every v1 install wrote (unversioned `# ctxo-start`). */
const V1_POST_COMMIT_BLOCK = [
  '# ctxo-start',
  '# Incremental re-index on commit (only changed files)',
  'if command -v ctxo >/dev/null 2>&1; then',
  '  for file in $(git diff --name-only HEAD~1 HEAD 2>/dev/null); do',
  '    ctxo index --file "$file" 2>/dev/null || true',
  '  done',
  'fi',
  '# ctxo-end',
].join('\n');

/** Spec 6.3, verbatim. */
const V2_POST_COMMIT_BLOCK = [
  '# ctxo-start v2',
  '# Incremental re-index of the files changed by this commit (one run per commit)',
  'if command -v ctxo >/dev/null 2>&1; then',
  '  ctxo index --commit HEAD >/dev/null 2>&1 || true',
  'fi',
  '# ctxo-end',
].join('\n');

/** The post-merge block, which this task keeps as it was. */
const POST_MERGE_BLOCK = [
  '# ctxo-start',
  '# Rebuild SQLite cache after merge (index updated via git pull)',
  'if command -v ctxo >/dev/null 2>&1; then',
  '  ctxo sync 2>/dev/null || true',
  'fi',
  '# ctxo-end',
].join('\n');

function hookPath(dir: string, name = 'post-commit'): string {
  return join(dir, '.git', 'hooks', name);
}

describe('InitCommand — hook installation', () => {
  it('installs post-commit and post-merge git hooks', () => {
    const dir = makeTempProject();
    new InitCommand(dir).installHooks();

    expect(existsSync(join(dir, '.git', 'hooks', 'post-commit'))).toBe(true);
    expect(existsSync(join(dir, '.git', 'hooks', 'post-merge'))).toBe(true);
  });

  it('installHooks writes the v2 block calling ctxo index --commit HEAD once', () => {
    const dir = makeTempProject();
    new InitCommand(dir).installHooks();

    const content = readFileSync(hookPath(dir), 'utf-8');
    expect(content).toBe(`#!/bin/sh\n\n${V2_POST_COMMIT_BLOCK}\n`);
    expect(content.match(/ctxo index --commit HEAD/g)).toHaveLength(1);
    expect(content).not.toContain('ctxo index --file');
    expect(content).not.toContain('\r');
  });

  it('installHooks replaces an old v1 block and keeps user lines before and after it', () => {
    const dir = makeTempProject();
    const before = '#!/bin/sh\necho "before"\n\n';
    const after = '\necho "after"\nexit 0\n';
    writeFileSync(hookPath(dir), before + V1_POST_COMMIT_BLOCK + after, 'utf-8');

    new InitCommand(dir).installHooks();

    const content = readFileSync(hookPath(dir), 'utf-8');
    expect(content).toBe(before + V2_POST_COMMIT_BLOCK + after);
    expect(content).not.toContain('ctxo index --file');
    expect(content.match(/# ctxo-start/g) ?? []).toHaveLength(1);
  });

  it('installHooks replaces a v1 block that ends the file without a trailing newline', () => {
    const dir = makeTempProject();
    const before = '#!/bin/sh\necho "before"\n';
    writeFileSync(hookPath(dir), before + V1_POST_COMMIT_BLOCK, 'utf-8');

    new InitCommand(dir).installHooks();

    expect(readFileSync(hookPath(dir), 'utf-8')).toBe(before + V2_POST_COMMIT_BLOCK);
  });

  it('installHooks is idempotent', () => {
    const dir = makeTempProject();
    writeFileSync(hookPath(dir), `#!/bin/sh\necho "mine"\n\n${V1_POST_COMMIT_BLOCK}\necho "tail"\n`, 'utf-8');

    new InitCommand(dir).installHooks();
    const firstPostCommit = readFileSync(hookPath(dir), 'utf-8');
    const firstPostMerge = readFileSync(hookPath(dir, 'post-merge'), 'utf-8');
    new InitCommand(dir).installHooks();

    expect(readFileSync(hookPath(dir), 'utf-8')).toBe(firstPostCommit);
    expect(readFileSync(hookPath(dir, 'post-merge'), 'utf-8')).toBe(firstPostMerge);
  });

  it('installHooks honours core.hooksPath', () => {
    const dir = makeTempProject();
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: dir });

    new InitCommand(dir).installHooks();

    const custom = readFileSync(join(dir, '.githooks', 'post-commit'), 'utf-8');
    expect(custom).toContain(V2_POST_COMMIT_BLOCK);
    expect(existsSync(join(dir, '.githooks', 'post-merge'))).toBe(true);
    expect(existsSync(hookPath(dir))).toBe(false);
  });

  it('installHooks honours an absolute core.hooksPath', () => {
    const dir = makeTempProject();
    const shared = mkdtempSync(join(tmpdir(), 'ctxo-shared-hooks-'));
    tempDirs.push(shared);
    execFileSync('git', ['config', 'core.hooksPath', shared], { cwd: dir });

    new InitCommand(dir).installHooks();

    expect(readFileSync(join(shared, 'post-commit'), 'utf-8')).toContain(V2_POST_COMMIT_BLOCK);
    expect(existsSync(hookPath(dir))).toBe(false);
  });

  it('installHooks falls back to .git/hooks when git cannot answer', () => {
    // An empty `.git` directory is not a repository, so `git rev-parse` fails inside it.
    const dir = mkdtempSync(join(tmpdir(), 'ctxo-init-nogit-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, '.git'));

    new InitCommand(dir).installHooks();

    expect(readFileSync(hookPath(dir), 'utf-8')).toContain(V2_POST_COMMIT_BLOCK);
  });

  it('installHooks keeps hook files executable', () => {
    if (process.platform === 'win32') return; // POSIX mode bits do not exist on Windows
    const dir = makeTempProject();
    new InitCommand(dir).installHooks();

    expect(statSync(hookPath(dir)).mode & 0o111).not.toBe(0);
    expect(statSync(hookPath(dir, 'post-merge')).mode & 0o111).not.toBe(0);
  });

  it('the installed post-commit hook runs ctxo index --commit HEAD once for a multi-file commit', () => {
    const dir = makeTempProject();
    const binDir = mkdtempSync(join(tmpdir(), 'ctxo-fake-bin-'));
    tempDirs.push(binDir);
    const logFile = join(binDir, 'ctxo.log');
    // A stand-in `ctxo` that records its arguments; the hook resolves it through `command -v ctxo`.
    writeFileSync(join(binDir, 'ctxo'), '#!/bin/sh\necho "$@" >> "$CTXO_LOG"\n', { mode: 0o755 });
    new InitCommand(dir).installHooks();

    for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(dir, name), name, 'utf-8');
    const env = { ...process.env, CTXO_LOG: logFile, PATH: `${binDir}${delimiter}${process.env['PATH'] ?? ''}` };
    execFileSync('git', ['add', '-A'], { cwd: dir, env });
    execFileSync(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@test.com', 'commit', '-q', '-m', 'three files'],
      { cwd: dir, env },
    );

    expect(readFileSync(logFile, 'utf-8').trim().split('\n')).toEqual(['index --commit HEAD']);
  });

  it('installHooks leaves an up-to-date post-merge block byte for byte as it was', () => {
    const dir = makeTempProject();
    const before = '#!/bin/sh\necho "merge start"\n\n';
    const after = '\necho "merge end"\n';
    writeFileSync(hookPath(dir, 'post-merge'), before + POST_MERGE_BLOCK + after, 'utf-8');

    new InitCommand(dir).installHooks();

    expect(readFileSync(hookPath(dir, 'post-merge'), 'utf-8')).toBe(before + POST_MERGE_BLOCK + after);
  });

  it('installHooks replaces an edited post-merge block in place', () => {
    const dir = makeTempProject();
    const before = '#!/bin/sh\necho "merge start"\n\n';
    const after = '\necho "merge end"\n';
    const stale = '# ctxo-start\nctxo sync --legacy\n# ctxo-end';
    writeFileSync(hookPath(dir, 'post-merge'), before + stale + after, 'utf-8');

    new InitCommand(dir).installHooks();

    expect(readFileSync(hookPath(dir, 'post-merge'), 'utf-8')).toBe(before + POST_MERGE_BLOCK + after);
  });

  it('installHooks keeps user lines when a ctxo-start marker has no matching ctxo-end', () => {
    const dir = makeTempProject();
    writeFileSync(hookPath(dir), '#!/bin/sh\n# ctxo-start\necho "user line that must survive"\n', 'utf-8');

    new InitCommand(dir).installHooks();
    const once = readFileSync(hookPath(dir), 'utf-8');
    new InitCommand(dir).installHooks();
    const twice = readFileSync(hookPath(dir), 'utf-8');

    expect(once).toContain('echo "user line that must survive"');
    expect(once).toContain(V2_POST_COMMIT_BLOCK);
    expect(twice).toBe(once);
  });

  it('preserves existing hook content (appends ctxo block)', () => {
    const dir = makeTempProject();
    const hookPath = join(dir, '.git', 'hooks', 'post-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho "existing hook"\n', 'utf-8');

    new InitCommand(dir).installHooks();

    const result = readFileSync(hookPath, 'utf-8');
    expect(result).toContain('existing hook');
    expect(result).toContain('# ctxo-start');
    expect(result).toContain('# ctxo-end');
  });

  it('is idempotent — running twice does not duplicate ctxo block', () => {
    const dir = makeTempProject();
    new InitCommand(dir).installHooks();
    new InitCommand(dir).installHooks();

    const content = readFileSync(join(dir, '.git', 'hooks', 'post-commit'), 'utf-8');
    const startCount = (content.match(/# ctxo-start/g) ?? []).length;
    expect(startCount).toBe(1);
  });

  it('uses # ctxo-start / # ctxo-end markers', () => {
    const dir = makeTempProject();
    new InitCommand(dir).installHooks();

    const content = readFileSync(join(dir, '.git', 'hooks', 'post-commit'), 'utf-8');
    expect(content).toContain('# ctxo-start');
    expect(content).toContain('# ctxo-end');
  });
});

describe('InitCommand — non-interactive mode', () => {
  it('creates index directory and installs hooks with --yes', async () => {
    const dir = makeTempProject();
    await new InitCommand(dir).run({ yes: true });

    expect(existsSync(join(dir, '.ctxo', 'index'))).toBe(true);
    expect(existsSync(join(dir, '.git', 'hooks', 'post-commit'))).toBe(true);
  });

  it('generates rules for specified tools', async () => {
    const dir = makeTempProject();
    await new InitCommand(dir).run({ tools: ['windsurf', 'cursor'], yes: true });

    expect(existsSync(join(dir, '.windsurfrules'))).toBe(true);
    expect(existsSync(join(dir, '.cursor', 'rules', 'ctxo.mdc'))).toBe(true);
  });

  it('rejects unknown tool IDs', async () => {
    const dir = makeTempProject();
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(new InitCommand(dir).run({ tools: ['unknown'], yes: true })).rejects.toThrow('exit');

    mockExit.mockRestore();
  });

  it('--rules only regenerates rules without hooks', async () => {
    const dir = makeTempProject();
    await new InitCommand(dir).run({ tools: ['windsurf'], rulesOnly: true });

    expect(existsSync(join(dir, '.windsurfrules'))).toBe(true);
    // No hooks installed
    expect(existsSync(join(dir, '.git', 'hooks', 'post-commit'))).toBe(false);
  });

  it('--dry-run does not create any files', async () => {
    const dir = makeTempProject();
    await new InitCommand(dir).run({ tools: ['windsurf'], dryRun: true });

    expect(existsSync(join(dir, '.windsurfrules'))).toBe(false);
  });

  it('--dry-run names the hooks directory git resolves', async () => {
    const dir = makeTempProject();
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: dir });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await new InitCommand(dir).run({ tools: ['windsurf'], dryRun: true });
      const output = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(output).toContain('.githooks/post-commit');
      expect(output).toContain('.githooks/post-merge');
      expect(output).not.toContain('.git/hooks/');
    } finally {
      errorSpy.mockRestore();
    }
    expect(existsSync(join(dir, '.githooks'))).toBe(false);
  });

  it('installs safe-edit guard for claude-code in non-interactive mode', async () => {
    const dir = makeTempProject();
    await new InitCommand(dir).run({ tools: ['claude-code'], yes: true, rulesOnly: false, noInstall: true });

    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf-8'));
    const pre = cfg.hooks?.PreToolUse ?? [];
    expect(pre.some((e: { hooks?: Array<{ command?: string }> }) =>
      e.hooks?.some(h => h.command?.includes('gate-hook'))
    )).toBe(true);
  });

  it('does NOT install guard for claude-code when --rules-only', async () => {
    const dir = makeTempProject();
    await new InitCommand(dir).run({ tools: ['claude-code'], rulesOnly: true });

    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(false);
  });
});

describe('InitCommand — cursor: skills + rules, no guard', () => {
  it('writes cursor rules file', async () => {
    const dir = makeTempProject();
    await new InitCommand(dir).run({ tools: ['cursor'], yes: true, noInstall: true });

    expect(existsSync(join(dir, '.cursor', 'rules', 'ctxo.mdc'))).toBe(true);
  });

  it('writes cursor skill .mdc files', async () => {
    const dir = makeTempProject();
    await new InitCommand(dir).run({ tools: ['cursor'], yes: true, noInstall: true });

    expect(existsSync(join(dir, '.cursor', 'rules', 'ctxo-safe-edit.mdc'))).toBe(true);
  });

  it('does NOT create .claude/settings.json guard for cursor-only init', async () => {
    const dir = makeTempProject();
    await new InitCommand(dir).run({ tools: ['cursor'], yes: true, noInstall: true });

    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(false);
  });
});

// Import vi for mocking
import { vi } from 'vitest';
