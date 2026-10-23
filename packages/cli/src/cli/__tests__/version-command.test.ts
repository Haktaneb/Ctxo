import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CtxoLanguagePlugin } from '@ctxo/plugin-api';
import type { DiscoveredPlugin } from '../../adapters/language/plugin-discovery.js';
import {
  collectModuleReports,
  gatherVersionInfo,
  formatShort,
  formatVerbose,
  formatJson,
  type VersionInfo,
} from '../version-command.js';
import { writeStubDomainPackage } from './helpers/stub-domain-package.js';

function makePlugin(over: Partial<CtxoLanguagePlugin> = {}): CtxoLanguagePlugin {
  return {
    apiVersion: '1',
    id: 'typescript',
    name: 'TypeScript',
    version: '0.7.0-alpha.0',
    extensions: ['.ts'],
    tier: 'full',
    createAdapter: () => ({
      extractSymbols: async () => [],
      extractEdges: async () => [],
      extractComplexity: async () => [],
      isSupported: () => true,
    }),
    ...over,
  };
}

function makeDiscovered(plugin: CtxoLanguagePlugin, specifier: string): DiscoveredPlugin {
  return { plugin, specifier };
}

describe('gatherVersionInfo', () => {
  it('returns empty plugin list when no plugins discovered', () => {
    const info = gatherVersionInfo([]);
    expect(info.plugins).toEqual([]);
    expect(info.pluginApiVersion).toBe('2');
    expect(info.runtime.node).toBe(process.version);
    expect(info.runtime.platform).toBe(process.platform);
    expect(info.runtime.arch).toBe(process.arch);
  });

  it('marks v1 and v2 plugins compatible', () => {
    const info = gatherVersionInfo([
      makeDiscovered(makePlugin({ id: 'a', apiVersion: '1' }), 'a'),
      makeDiscovered(makePlugin({ id: 'b', apiVersion: '2' }), 'b'),
    ]);
    expect(info.plugins.map((p) => p.compatible)).toEqual([true, true]);
  });

  it('reports pluginApiVersion 2 and pluginApiVersions 1, 2 in JSON', () => {
    const parsed = JSON.parse(formatJson(gatherVersionInfo([]))) as VersionInfo;
    expect(parsed.pluginApiVersion).toBe('2');
    expect(parsed.pluginApiVersions).toEqual(['1', '2']);
  });

  it('verbose output shows Plugin API: 1, 2', () => {
    expect(formatVerbose(gatherVersionInfo([]))).toContain('Plugin API: 1, 2');
  });

  it('marks plugins with matching apiVersion as compatible', () => {
    const discovered = [
      makeDiscovered(makePlugin({ id: 'typescript' }), '@ctxo/lang-typescript'),
      makeDiscovered(
        makePlugin({ id: 'go', name: 'Go', tier: 'syntax', extensions: ['.go'] }),
        '@ctxo/lang-go',
      ),
    ];
    const info = gatherVersionInfo(discovered);
    expect(info.plugins).toHaveLength(2);
    expect(info.plugins.every((p) => p.compatible)).toBe(true);
    expect(info.plugins.map((p) => p.id)).toEqual(['typescript', 'go']);
  });

  it('marks plugins with mismatched apiVersion as incompatible', () => {
    const future = { apiVersion: '3' } as unknown as Partial<CtxoLanguagePlugin>;
    const discovered = [makeDiscovered(makePlugin(future), '@ctxo/lang-future')];
    const info = gatherVersionInfo(discovered);
    expect(info.plugins[0]!.compatible).toBe(false);
    expect(info.plugins[0]!.apiVersion).toBe('3');
  });

  it('carries runtime-declared plugin version and npm specifier distinctly', () => {
    const discovered = [
      makeDiscovered(
        makePlugin({ id: 'kotlin', name: 'Kotlin', version: '1.2.3', extensions: ['.kt'], tier: 'syntax' }),
        'ctxo-lang-kotlin',
      ),
    ];
    const info = gatherVersionInfo(discovered);
    expect(info.plugins[0]!.name).toBe('ctxo-lang-kotlin');
    expect(info.plugins[0]!.id).toBe('kotlin');
    expect(info.plugins[0]!.version).toBe('1.2.3');
  });
});

describe('formatShort', () => {
  it('prints "ctxo <version>" on a single line', () => {
    const info: VersionInfo = {
      ctxo: '0.7.0-alpha.0',
      pluginApiVersion: '2',
      pluginApiVersions: ['1', '2'],
      modules: [],
      plugins: [],
      runtime: { node: 'v20.0.0', platform: 'linux', arch: 'x64' },
    };
    expect(formatShort(info)).toBe('ctxo 0.7.0-alpha.0');
  });
});

describe('formatVerbose', () => {
  it('emits stable header lines when no plugins installed', () => {
    const info: VersionInfo = {
      ctxo: '0.7.0-alpha.0',
      pluginApiVersion: '2',
      pluginApiVersions: ['1', '2'],
      modules: [],
      plugins: [],
      runtime: { node: 'v20.0.0', platform: 'linux', arch: 'x64' },
    };
    const out = formatVerbose(info);
    const lines = out.split('\n');
    expect(lines[0]).toBe('ctxo 0.7.0-alpha.0');
    expect(lines[1]).toBe('Plugin API: 1, 2');
    expect(lines[2]).toBe('Runtime:    Node v20.0.0 on linux/x64');
    expect(lines).toContain('Plugins:    (none installed)');
  });

  it('renders a plugin table when plugins are present', () => {
    const info: VersionInfo = {
      ctxo: '0.7.0-alpha.0',
      pluginApiVersion: '2',
      pluginApiVersions: ['1', '2'],
      modules: [],
      plugins: [
        {
          name: '@ctxo/lang-typescript',
          id: 'typescript',
          version: '0.7.0-alpha.0',
          apiVersion: '1',
          compatible: true,
        },
      ],
      runtime: { node: 'v20.0.0', platform: 'linux', arch: 'x64' },
    };
    const out = formatVerbose(info);
    expect(out).toContain('Plugins:    1 installed');
    expect(out).toMatch(/NAME\s+VERSION\s+API\s+STATUS/);
    expect(out).toContain('@ctxo/lang-typescript');
    expect(out).toContain('OK');
  });

  it('flags incompatible plugins in the status column', () => {
    const info: VersionInfo = {
      ctxo: '0.7.0-alpha.0',
      pluginApiVersion: '2',
      pluginApiVersions: ['1', '2'],
      modules: [],
      plugins: [
        {
          name: '@ctxo/lang-future',
          id: 'future',
          version: '1.0.0',
          apiVersion: '2',
          compatible: false,
        },
      ],
      runtime: { node: 'v20.0.0', platform: 'linux', arch: 'x64' },
    };
    const out = formatVerbose(info);
    expect(out).toMatch(/incompatible \(core supports 1, 2\)/);
  });
});

describe('formatJson', () => {
  it('emits the PRD schema shape', () => {
    const info: VersionInfo = {
      ctxo: '0.7.0-alpha.0',
      pluginApiVersion: '2',
      pluginApiVersions: ['1', '2'],
      modules: [],
      plugins: [
        {
          name: '@ctxo/lang-typescript',
          id: 'typescript',
          version: '0.7.0-alpha.0',
          apiVersion: '1',
          compatible: true,
        },
      ],
      runtime: { node: 'v20.0.0', platform: 'linux', arch: 'x64' },
    };
    const parsed = JSON.parse(formatJson(info));
    expect(parsed).toMatchObject({
      ctxo: '0.7.0-alpha.0',
      pluginApiVersion: '2',
      pluginApiVersions: ['1', '2'],
      modules: [],
      runtime: { node: 'v20.0.0', platform: 'linux', arch: 'x64' },
      plugins: [
        {
          name: '@ctxo/lang-typescript',
          id: 'typescript',
          version: '0.7.0-alpha.0',
          apiVersion: '1',
          compatible: true,
        },
      ],
    });
  });

  it('is pretty-printed (multi-line)', () => {
    const info: VersionInfo = {
      ctxo: '0.7.0-alpha.0',
      pluginApiVersion: '2',
      pluginApiVersions: ['1', '2'],
      modules: [],
      plugins: [],
      runtime: { node: 'v20.0.0', platform: 'linux', arch: 'x64' },
    };
    expect(formatJson(info).split('\n').length).toBeGreaterThan(1);
  });
});

describe('gatherVersionInfo performance', () => {
  it('runs in well under 200ms for a realistic plugin count', () => {
    const discovered: DiscoveredPlugin[] = [
      makeDiscovered(makePlugin({ id: 'typescript' }), '@ctxo/lang-typescript'),
      makeDiscovered(
        makePlugin({ id: 'go', name: 'Go', tier: 'syntax', extensions: ['.go'] }),
        '@ctxo/lang-go',
      ),
      makeDiscovered(
        makePlugin({ id: 'csharp', name: 'C#', extensions: ['.cs'] }),
        '@ctxo/lang-csharp',
      ),
    ];

    const start = process.hrtime.bigint();
    const info = gatherVersionInfo(discovered);
    formatVerbose(info);
    formatJson(info);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

    expect(elapsedMs).toBeLessThan(200);
    expect(info.plugins).toHaveLength(3);
  });
});

describe('modules in the version report', () => {
  const base = {
    ctxo: '1.2.3',
    pluginApiVersion: '2',
    pluginApiVersions: ['1', '2'],
    plugins: [],
    runtime: { node: 'v20.0.0', platform: 'linux' as const, arch: 'x64' },
  };

  it('gatherVersionInfo defaults modules to an empty list', () => {
    expect(gatherVersionInfo([]).modules).toEqual([]);
  });

  it('formatVerbose lists modules with their status', () => {
    const info: VersionInfo = {
      ...base,
      modules: [{ name: '@ctxo/domain', status: 'active', version: '1.2.0', source: 'project' }],
    };
    expect(formatVerbose(info)).toContain('Modules:    @ctxo/domain 1.2.0 (active)');
  });

  it('formatVerbose names a version mismatch and leaves out a module that is not installed', () => {
    const mismatch: VersionInfo = {
      ...base,
      modules: [{ name: '@ctxo/domain', status: 'version-mismatch', version: '1.3.0' }],
    };
    expect(formatVerbose(mismatch)).toContain('Modules:    @ctxo/domain 1.3.0 (version-mismatch)');
    const absent: VersionInfo = { ...base, modules: [{ name: '@ctxo/domain', status: 'not-installed' }] };
    expect(formatVerbose(absent)).not.toContain('Modules:');
  });

  it('the JSON output carries modules', () => {
    const info: VersionInfo = {
      ...base,
      modules: [{ name: '@ctxo/domain', status: 'active', version: '1.2.0', source: 'cli' }],
    };
    const parsed = JSON.parse(formatJson(info)) as VersionInfo;
    expect(parsed.modules).toEqual(info.modules);
  });
});

describe('collectModuleReports', () => {
  const dirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ctxo-version-modules-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('reports not-installed without building a module host when no copy exists', async () => {
    const hostModule = await import('../module-host.js');
    const createHost = vi.spyOn(hostModule, 'createModuleHost');

    const reports = await collectModuleReports(tempDir());

    expect(reports).toEqual([{ name: '@ctxo/domain', status: 'not-installed' }]);
    expect(createHost).not.toHaveBeenCalled();
  });

  it('reports load-failed instead of throwing when the module host cannot be built', async () => {
    const project = tempDir();
    writeStubDomainPackage(project, "export async function register() { return { id: 'domain' }; }\n");
    const hostModule = await import('../module-host.js');
    vi.spyOn(hostModule, 'createModuleHost').mockImplementation(() => {
      throw new Error('host exploded');
    });

    const reports = await collectModuleReports(project);

    expect(reports).toEqual([{ name: '@ctxo/domain', status: 'load-failed', reason: 'host exploded' }]);
  });
});
