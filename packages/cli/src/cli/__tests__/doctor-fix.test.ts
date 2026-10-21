import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DoctorReport } from '../../core/diagnostics/types.js';
import { applyFixes, formatFixReport } from '../doctor-fix.js';

function report(overrides: Partial<DoctorReport['checks'][number]>[]): DoctorReport {
  const checks = overrides.map((o, i) => ({
    id: o.id ?? `check_${i}`,
    title: o.title ?? `Check ${i}`,
    status: o.status ?? 'warn',
    message: o.message ?? '',
    fix: o.fix,
    value: o.value,
  }));
  return {
    checks,
    summary: { pass: 0, warn: checks.filter((c) => c.status === 'warn').length, fail: checks.filter((c) => c.status === 'fail').length },
    exitCode: 1,
  };
}

describe('applyFixes', () => {
  let tmp: string;
  let savedCI: string | undefined;
  const savedGitEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ctxo-fix-'));
    savedCI = process.env['CI'];
    delete process.env['CI'];
    // A hook-driven test run exports GIT_DIR; the hook tests below must resolve against their own temp repo.
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) {
      savedGitEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (savedCI === undefined) delete process.env['CI'];
    else process.env['CI'] = savedCI;
    for (const [key, value] of savedGitEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedGitEnv.clear();
  });

  it('returns empty attempts on a clean report', async () => {
    const r = await applyFixes(report([]), {
      projectRoot: tmp,
      ctxoRoot: join(tmp, '.ctxo'),
      dryRun: true,
    });
    expect(r.attempts).toEqual([]);
    expect(r.halted).toBe(false);
  });

  it('halts in CI without --yes', async () => {
    process.env['CI'] = 'true';
    const r = await applyFixes(
      report([{ id: 'config_file', status: 'warn' }]),
      { projectRoot: tmp, ctxoRoot: join(tmp, '.ctxo') },
    );
    expect(r.halted).toBe(true);
    expect(r.reason).toMatch(/CI/);
  });

  it('produces planned attempts under --dry-run', async () => {
    const r = await applyFixes(
      report([
        { id: 'config_file', status: 'warn' },
        { id: 'sqlite_cache', status: 'warn' },
      ]),
      { projectRoot: tmp, ctxoRoot: join(tmp, '.ctxo'), dryRun: true },
    );
    expect(r.halted).toBe(false);
    expect(r.attempts.length).toBeGreaterThanOrEqual(2);
    expect(r.attempts.every((a) => a.status === 'planned')).toBe(true);
  });

  it('writes an audit log entry', async () => {
    await applyFixes(
      report([{ id: 'config_file', status: 'warn' }]),
      { projectRoot: tmp, ctxoRoot: join(tmp, '.ctxo'), dryRun: true },
    );
    const logPath = join(tmp, '.ctxo', 'doctor-fix.log');
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf-8')).toContain('doctor --fix');
  });

  describe('git_hooks', () => {
    const V1_BLOCK = [
      '# ctxo-start',
      '# Incremental re-index on commit (only changed files)',
      'if command -v ctxo >/dev/null 2>&1; then',
      '  for file in $(git diff --name-only HEAD~1 HEAD 2>/dev/null); do',
      '    ctxo index --file "$file" 2>/dev/null || true',
      '  done',
      'fi',
      '# ctxo-end',
    ].join('\n');

    function seedV1Hook(): string {
      execFileSync('git', ['init', '-q'], { cwd: tmp });
      const hookFile = join(tmp, '.git', 'hooks', 'post-commit');
      writeFileSync(hookFile, `#!/bin/sh\necho "mine"\n\n${V1_BLOCK}\necho "tail"\n`, 'utf-8');
      return hookFile;
    }

    it('doctor --fix upgrades a v1 block', async () => {
      const hookFile = seedV1Hook();

      const r = await applyFixes(
        report([{ id: 'git_hooks', status: 'warn' }]),
        { projectRoot: tmp, ctxoRoot: join(tmp, '.ctxo'), yes: true },
      );

      const hooksAttempt = r.attempts.find((a) => a.name === 'Git hooks');
      expect(hooksAttempt?.status).toBe('success');
      const content = readFileSync(hookFile, 'utf-8');
      expect(content).toContain('# ctxo-start v2');
      expect(content).toContain('ctxo index --commit HEAD');
      expect(content).not.toContain('ctxo index --file');
      expect(content).toContain('echo "mine"');
      expect(content).toContain('echo "tail"');
    });

    it('doctor --fix --dry-run leaves the hook untouched', async () => {
      const hookFile = seedV1Hook();
      const before = readFileSync(hookFile, 'utf-8');

      const r = await applyFixes(
        report([{ id: 'git_hooks', status: 'warn' }]),
        { projectRoot: tmp, ctxoRoot: join(tmp, '.ctxo'), dryRun: true },
      );

      expect(r.attempts.find((a) => a.name === 'Git hooks')?.status).toBe('planned');
      expect(readFileSync(hookFile, 'utf-8')).toBe(before);
    });
  });

  it('schedules an orphan prune attempt when orphaned_files is failing', async () => {
    const r = await applyFixes(
      report([{ id: 'orphaned_files', status: 'fail' }]),
      { projectRoot: tmp, ctxoRoot: join(tmp, '.ctxo'), dryRun: true },
    );
    expect(r.attempts.some((a) => a.name === 'Orphaned index files')).toBe(true);
  });
});

describe('formatFixReport', () => {
  it('emits one line per attempt with status glyph', () => {
    const out = formatFixReport({
      attempts: [
        { name: 'Config', action: 'create', status: 'success', durationMs: 12 },
        { name: 'Plugins', action: 'install', status: 'failed', error: 'network' },
        { name: 'Index', action: 'rebuild', status: 'skipped' },
        { name: 'Cache', action: 'rebuild', status: 'planned' },
      ],
      halted: false,
    });
    expect(out).toMatch(/✓ Config/);
    expect(out).toMatch(/✗ Plugins.*network/);
    expect(out).toMatch(/- Index/);
    expect(out).toMatch(/· Cache/);
  });

  it('appends halt reason when halted', () => {
    const out = formatFixReport({ attempts: [], halted: true, reason: 'CI detected' });
    expect(out).toContain('halted: CI detected');
  });
});
