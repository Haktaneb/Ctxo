import { describe, it, expect } from 'vitest';
import { cliInstallKind, mcpLauncherOf, mcpNpxPin, assessInstallCopies, type InstallCopiesFacts } from '../install-kind.js';

describe('cliInstallKind', () => {
  it.each([
    ['project', '/repo/node_modules/@ctxo/cli', '/repo', 'linux'],
    ['project (hoisted to a workspace root)', '/repo/node_modules/@ctxo/cli', '/repo/packages/app', 'linux'],
    ['npx', '/home/u/.npm/_npx/ab12/node_modules/@ctxo/cli', '/repo', 'linux'],
    ['pnpm dlx', 'C:\\Users\\u\\AppData\\Local\\pnpm\\dlx\\x\\node_modules\\@ctxo\\cli', 'C:\\repo', 'win32'],
    ['bunx', '/tmp/bunx-1000-@ctxo/cli@latest/node_modules/@ctxo/cli', '/repo', 'linux'],
    ['global', '/usr/lib/node_modules/@ctxo/cli', '/repo', 'linux'],
    ['project (win32 ignores case)', 'c:\\repo\\node_modules\\@ctxo\\cli', 'C:\\Repo', 'win32'],
  ] as const)('classifies %s installs', (_label, cliRoot, projectRoot, platform) => {
    const expected = _label.startsWith('project') ? 'project' : _label === 'global' ? 'global' : 'npx';
    expect(cliInstallKind(cliRoot, projectRoot, platform)).toBe(expected);
  });

  it('treats a node_modules of another tree as global', () => {
    expect(cliInstallKind('/other/node_modules/@ctxo/cli', '/repo', 'linux')).toBe('global');
  });
});

describe('mcpLauncherOf', () => {
  it.each([
    [{ command: 'npx', args: ['-y', '@ctxo/cli'] }, 'npx'],
    [{ command: 'npx', args: ['-y', '@ctxo/cli@0.13.0'] }, 'npx'],
    [{ command: 'npx', args: ['-y', '@ctxo/cli-other'] }, 'other'],
    [{ command: 'npx.cmd', args: ['-y', '@ctxo/cli'] }, 'npx'],
    [{ command: 'cmd', args: ['/c', 'npx', '-y', '@ctxo/cli'] }, 'npx'],
    [{ command: 'ctxo', args: [] }, 'path-binary'],
    [{ command: 'C:\\bin\\ctxo.cmd' }, 'path-binary'],
    [{ command: 'cmd', args: ['/c', 'ctxo'] }, 'path-binary'],
    [{ command: 'npx', args: ['-y', 'other-server'] }, 'other'],
    [{ command: 'node', args: ['x.js'] }, 'other'],
    ['ctxo', undefined],
    [null, undefined],
    [{ args: [] }, undefined],
  ])('recognises %j as %s', (entry, expected) => {
    expect(mcpLauncherOf(entry)).toBe(expected);
  });
});

describe('assessInstallCopies', () => {
  const facts = (over: Partial<InstallCopiesFacts>): InstallCopiesFacts => ({
    launchers: [],
    hooksCallCtxo: false,
    ctxoOnPath: true,
    ...over,
  });

  it('warns about the PATH first, before the npx warning', () => {
    expect(assessInstallCopies(facts({ launchers: ['npx'], hooksCallCtxo: true, ctxoOnPath: false }))).toEqual({
      status: 'warn',
      message: 'hooks call "ctxo" but no ctxo is on PATH, so they never run',
      fix: 'Install @ctxo/cli globally ("npm i -g @ctxo/cli")',
    });
  });

  it('warns about a pinned npx entry that differs from the global copy, naming @ctxo/domain only when installed', () => {
    const base = { launchers: ['npx'] as const, hooksCallCtxo: true, npxPins: ['0.12.0'], globalCliVersion: '0.13.1' };
    expect(assessInstallCopies(facts({ ...base, domainInstalled: true }))).toEqual({
      status: 'warn',
      message:
        'MCP starts "npx -y @ctxo/cli@0.12.0" while hooks run "ctxo" 0.13.1 from PATH: two copies, and @ctxo/domain installed in one is missing from the other',
      fix: 'Install once globally ("npm i -g @ctxo/cli @ctxo/domain"), then run "ctxo init --only mcp" from that install',
    });
    const plain = assessInstallCopies(facts(base));
    expect(plain).toMatchObject({
      status: 'warn',
      message:
        'MCP starts "npx -y @ctxo/cli@0.12.0" while hooks run "ctxo" 0.13.1 from PATH: two copies, so a package installed next to one is not seen by the other',
    });
    expect(JSON.stringify(plain)).not.toContain('@ctxo/domain');
  });

  it('treats an unpinned npx entry as the global copy (npx runs the global install)', () => {
    expect(assessInstallCopies(facts({ launchers: ['npx'], hooksCallCtxo: true, globalCliVersion: '0.13.1' }))).toEqual({
      status: 'pass',
      message: 'one copy: MCP and hooks run ctxo from PATH',
    });
  });

  it('does not warn about a pin equal to the global version or when the global version is unknown', () => {
    const same = facts({ launchers: ['npx'], hooksCallCtxo: true, npxPins: ['0.13.1'], globalCliVersion: '0.13.1' });
    expect(assessInstallCopies(same).status).toBe('pass');
    const unknown = facts({ launchers: ['npx'], hooksCallCtxo: true, npxPins: ['0.12.0'] });
    expect(assessInstallCopies(unknown).status).toBe('pass');
  });

  it.each([
    [facts({ launchers: ['path-binary'], hooksCallCtxo: true }), 'one copy: MCP and hooks run ctxo from PATH'],
    [facts({ launchers: ['npx'], hooksCallCtxo: false }), 'nothing to compare (no ctxo hooks or no MCP entry)'],
    [facts({ launchers: [], hooksCallCtxo: true }), 'nothing to compare (no ctxo hooks or no MCP entry)'],
  ])('passes with the right message', (input, message) => {
    expect(assessInstallCopies(input)).toEqual({ status: 'pass', message });
  });
});

describe('mcpNpxPin', () => {
  it.each([
    [{ command: 'npx', args: ['-y', '@ctxo/cli@0.12.0'] }, '0.12.0'],
    [{ command: 'cmd', args: ['/c', 'npx', '-y', '@ctxo/cli@1.0.0-beta.1'] }, '1.0.0-beta.1'],
    [{ command: 'npx', args: ['-y', '@ctxo/cli'] }, undefined],
    [{ command: 'npx', args: ['-y', '@ctxo/cli@latest'] }, undefined],
    [{ command: 'ctxo', args: [] }, undefined],
    [null, undefined],
  ])('reads the pin of %j as %s', (entry, expected) => {
    expect(mcpNpxPin(entry)).toBe(expected);
  });
});
