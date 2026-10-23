import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CtxoHost } from '../../../ports/i-ctxo-module.js';

const warnings: string[] = [];
vi.mock('../../../core/logger.js', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    error: () => {},
    warn: (message: string) => {
      warnings.push(message);
    },
  }),
}));

const { loadCtxoModules, sameMinor } = await import('../module-loader.js');

const DEFAULT_BODY = `export async function register(host) {
  globalThis.__ctxoLoaderSeen = host.mode;
  return { id: 'domain' };
}
`;

function writeStub(root: string, version: string, body: string = DEFAULT_BODY): void {
  const dir = join(root, 'node_modules', '@ctxo', 'domain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@ctxo/domain', version, type: 'module', exports: { '.': './index.js' } }),
  );
  writeFileSync(join(dir, 'index.js'), body);
}

function makeHost(projectRoot: string, cliVersion: string, mode: CtxoHost['mode'] = 'cli'): CtxoHost {
  return {
    cliVersion,
    mode,
    projectRoot,
    ctxoRoot: join(projectRoot, '.ctxo'),
    services: {} as CtxoHost['services'],
  };
}

describe('module-loader', () => {
  let project: string;
  let cli: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'ctxo-mod-project-'));
    cli = mkdtempSync(join(tmpdir(), 'ctxo-mod-cli-'));
    warnings.length = 0;
    delete (globalThis as Record<string, unknown>).__ctxoLoaderSeen;
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(cli, { recursive: true, force: true });
  });

  it('loads a matching project copy and calls register with the host', async () => {
    writeStub(project, '1.2.0');
    const result = await loadCtxoModules(makeHost(project, '1.2.3', 'mcp'), { cliAnchor: cli });
    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]!.registration.id).toBe('domain');
    expect(result.modules[0]!.version).toBe('1.2.0');
    expect(result.reports).toEqual([
      { name: '@ctxo/domain', status: 'active', version: '1.2.0', source: 'project' },
    ]);
    expect((globalThis as Record<string, unknown>).__ctxoLoaderSeen).toBe('mcp');
    expect(warnings).toEqual([]);
  });

  it('skips a copy whose minor differs and warns', async () => {
    writeStub(project, '1.3.0');
    const result = await loadCtxoModules(makeHost(project, '1.2.3'), { cliAnchor: cli });
    expect(result.modules).toEqual([]);
    expect(result.reports[0]).toMatchObject({ status: 'version-mismatch', version: '1.3.0', source: 'project' });
    expect(warnings).toEqual([
      '@ctxo/domain 1.3.0 does not match @ctxo/cli 1.2.3; domain features are off. Install @ctxo/domain@1.2.3 next to the CLI you run.',
    ]);
  });

  it('falls back to the copy next to the CLI when the project copy has another minor', async () => {
    writeStub(project, '1.3.0');
    writeStub(cli, '1.2.1');
    const result = await loadCtxoModules(makeHost(project, '1.2.3'), { cliAnchor: cli });
    expect(result.modules).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({ status: 'active', version: '1.2.1', source: 'cli' });
    expect(warnings).toEqual([]);
  });

  it('reports not-installed without a warning when no copy exists', async () => {
    const result = await loadCtxoModules(makeHost(project, '1.2.3'), { cliAnchor: cli });
    expect(result.modules).toEqual([]);
    expect(result.reports).toEqual([{ name: '@ctxo/domain', status: 'not-installed' }]);
    expect(warnings).toEqual([]);
  });

  it.each([
    ['an import error', `throw new Error('boom');`, 'boom'],
    ['a missing register export', `export const other = 1;`, 'missing register export'],
    ['a rejected register', `export async function register() { throw new Error('nope'); }`, 'nope'],
    ['a wrong id', `export async function register() { return { id: 'other' }; }`, 'unexpected id'],
  ])('%s is load-failed and never throws', async (_label, body, reason) => {
    writeStub(project, '1.2.0', body);
    const result = await loadCtxoModules(makeHost(project, '1.2.3'), { cliAnchor: cli });
    expect(result.modules).toEqual([]);
    expect(result.reports[0]!.status).toBe('load-failed');
    expect(result.reports[0]!.reason).toContain(reason);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^@ctxo\/domain failed to load: .*; domain features are off\.$/);
  });

  it('register returning undefined leaves the module inactive', async () => {
    writeStub(project, '1.2.0', `export async function register() { return undefined; }`);
    const result = await loadCtxoModules(makeHost(project, '1.2.3'), { cliAnchor: cli });
    expect(result.modules).toEqual([]);
    expect(result.reports[0]).toMatchObject({ status: 'inactive', version: '1.2.0' });
    expect(warnings).toEqual([]);
  });

  it('lists a real path once when the project and the CLI resolve the same copy', async () => {
    const { resolvePackageCandidates } = await import('../../language/plugin-discovery.js');
    writeStub(project, '1.2.0');
    const same = resolvePackageCandidates('@ctxo/domain', project, project);
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({ source: 'project', version: '1.2.0' });
    writeStub(cli, '1.2.0');
    expect(resolvePackageCandidates('@ctxo/domain', project, cli).map((c) => c.source)).toEqual(['project', 'cli']);
  });

  it('sameMinor compares numeric major and minor only', () => {
    expect(sameMinor('0.13.0', '0.13.4')).toBe(true);
    expect(sameMinor('0.13.0', '0.14.0')).toBe(false);
    expect(sameMinor('1.0.0-alpha.1', '1.0.2')).toBe(true);
    expect(sameMinor('x', '1.0.0')).toBe(false);
  });

  it('memoizes per project and mode; refresh resolves again', async () => {
    const host = makeHost(project, '1.2.3');
    const first = await loadCtxoModules(host, { cliAnchor: cli });
    expect(first.reports[0]!.status).toBe('not-installed');

    writeStub(project, '1.2.0');
    const second = await loadCtxoModules(host, { cliAnchor: cli });
    expect(second).toBe(first);

    const otherMode = await loadCtxoModules(makeHost(project, '1.2.3', 'hook'), { cliAnchor: cli });
    expect(otherMode.reports[0]!.status).toBe('active');

    const refreshed = await loadCtxoModules(host, { cliAnchor: cli, refresh: true });
    expect(refreshed.reports[0]!.status).toBe('active');
    expect(await loadCtxoModules(host, { cliAnchor: cli })).toBe(refreshed);
  });
});
