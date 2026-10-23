import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runPackageManager = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('../../core/install/run-package-manager.js', () => ({ runPackageManager }));

import { InstallCommand, buildPluginSpecifiers, resolveInstallTargets, INSTALL_EXTRAS } from '../install-command.js';
import { getVersion } from '../cli-paths.js';

describe('ctxo install domain', () => {
  let dir: string;
  let errorSpy: MockInstance<typeof console.error>;
  let savedExitCode: typeof process.exitCode;
  let savedCI: string | undefined;

  beforeEach(() => {
    savedCI = process.env['CI'];
    delete process.env['CI'];
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
    runPackageManager.mockClear();
    dir = mkdtempSync(join(tmpdir(), 'ctxo-install-domain-'));
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedCI === undefined) delete process.env['CI'];
    else process.env['CI'] = savedCI;
    vi.restoreAllMocks();
    process.exitCode = savedExitCode;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const stderr = (): string => errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
  const withPackageJson = (): void => writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }), 'utf-8');

  it('maps domain to the extras and the rest to languages', () => {
    expect(INSTALL_EXTRAS).toEqual({ domain: '@ctxo/domain' });
    expect(resolveInstallTargets(['domain', 'tsql', 'ts', 'DOMAIN', 'cobol'])).toEqual({
      languages: ['sql', 'typescript'],
      extras: ['@ctxo/domain'],
      unknown: ['cobol'],
    });
  });

  it('pins extras to the version, else the CLI version', () => {
    const base = { jreAvailable: false, extras: ['@ctxo/domain'], cliVersion: '9.9.9' };
    expect(buildPluginSpecifiers(['sql'], base)).toEqual(['@ctxo/lang-sql', '@ctxo/domain@9.9.9']);
    expect(buildPluginSpecifiers([], { ...base, version: '1.2.3' })).toEqual(['@ctxo/domain@1.2.3']);
  });

  it('ctxo install domain sql plans @ctxo/domain at the CLI version and @ctxo/lang-sql', async () => {
    withPackageJson();
    await new InstallCommand(dir).run({ languages: ['domain', 'sql'], dryRun: true, pm: 'pnpm', force: true });

    expect(stderr()).toContain(`@ctxo/domain@${getVersion()}`);
    expect(stderr()).toContain('@ctxo/lang-sql');
    expect(runPackageManager).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('--version pins the extra', async () => {
    withPackageJson();
    await new InstallCommand(dir).run({ languages: ['domain', 'sql'], dryRun: true, pm: 'pnpm', force: true, version: '1.2.3' });

    expect(stderr()).toContain('@ctxo/domain@1.2.3');
    expect(stderr()).toContain('@ctxo/lang-sql@1.2.3');
  });

  it('installs globally without package.json and says so', async () => {
    await new InstallCommand(dir).run({ languages: ['domain'], dryRun: true, pm: 'npm' });

    expect(stderr()).toContain(
      '[ctxo] No package.json here: installing globally, so the MCP server, hooks and CLI share one copy.',
    );
    expect(stderr()).toMatch(/Command: npm .*-g/);
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses an implicit global install under CI=true, while --global is not refused', async () => {
    process.env['CI'] = 'true';
    await new InstallCommand(dir).run({ languages: ['domain'], dryRun: true, pm: 'npm' });
    expect(stderr()).toContain('CI environment detected');
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    errorSpy.mockClear();
    await new InstallCommand(dir).run({ languages: ['domain'], dryRun: true, pm: 'npm', global: true });
    expect(stderr()).not.toContain('CI environment detected');
    expect(stderr()).toMatch(/Command: npm .*-g/);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not print the notice when --global is explicit', async () => {
    await new InstallCommand(dir).run({ languages: ['domain'], dryRun: true, pm: 'npm', global: true });

    expect(stderr()).not.toContain('No package.json here');
  });

  it('reports unknown targets and exits 1', async () => {
    withPackageJson();
    await new InstallCommand(dir).run({ languages: ['cobol'], dryRun: true, pm: 'npm', force: true });

    expect(stderr()).toContain('Unknown language "cobol"');
    expect(process.exitCode).toBe(1);
  });
});
