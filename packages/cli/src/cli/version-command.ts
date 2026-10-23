import { SUPPORTED_API_VERSIONS } from '@ctxo/plugin-api';
import type { CtxoLanguagePlugin } from '@ctxo/plugin-api';
import { getVersion } from './cli-paths.js';
import { discoverPlugins, resolvePackageCandidates, type DiscoveredPlugin } from '../adapters/language/plugin-discovery.js';
import { loadManifestPath } from './plugin-loader.js';
import { DOMAIN_MODULE_PACKAGE, loadCtxoModules, type ModuleReport } from '../adapters/modules/module-loader.js';

const NEWEST_API_VERSION: string = SUPPORTED_API_VERSIONS[SUPPORTED_API_VERSIONS.length - 1]!;

export interface PluginVersionInfo {
  /** npm package name, e.g. "@ctxo/lang-typescript" or community "ctxo-lang-kotlin" */
  name: string;
  /** Plugin id from the runtime declaration, e.g. "typescript" */
  id: string;
  /** Runtime-declared plugin version */
  version: string;
  /** Plugin protocol version declared by the plugin */
  apiVersion: string;
  /** True when apiVersion is one of the core's SUPPORTED_API_VERSIONS */
  compatible: boolean;
}

export interface RuntimeInfo {
  node: string;
  platform: NodeJS.Platform;
  arch: string;
}

export interface VersionInfo {
  ctxo: string;
  /** The newest protocol version the core supports. */
  pluginApiVersion: string;
  /** Every protocol version the core loads. */
  pluginApiVersions: readonly string[];
  plugins: PluginVersionInfo[];
  /** Opt-in modules such as @ctxo/domain; one report per module the loader looked for. */
  modules: readonly ModuleReport[];
  runtime: RuntimeInfo;
}

/**
 * Produce VersionInfo from already-discovered plugins. Pure function; safe to
 * call without I/O once plugins are in hand. Used by both CLI printers and tests.
 */
export function gatherVersionInfo(
  discovered: readonly DiscoveredPlugin[],
  modules: readonly ModuleReport[] = [],
): VersionInfo {
  const plugins: PluginVersionInfo[] = discovered.map(({ plugin, specifier }) => ({
    name: specifier,
    id: plugin.id,
    version: plugin.version,
    apiVersion: plugin.apiVersion,
    compatible: (SUPPORTED_API_VERSIONS as readonly string[]).includes(plugin.apiVersion),
  }));

  return {
    ctxo: getVersion(),
    pluginApiVersion: NEWEST_API_VERSION,
    pluginApiVersions: SUPPORTED_API_VERSIONS,
    plugins,
    modules,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
}

export function formatShort(info: VersionInfo): string {
  return `ctxo ${info.ctxo}`;
}

export function formatVerbose(info: VersionInfo): string {
  const lines: string[] = [];
  lines.push(`ctxo ${info.ctxo}`);
  lines.push(`Plugin API: ${info.pluginApiVersions.join(', ')}`);
  lines.push(`Runtime:    Node ${info.runtime.node} on ${info.runtime.platform}/${info.runtime.arch}`);
  lines.push('');
  // A module that is not installed is the common case and stays out of the report.
  for (const m of info.modules.filter((x) => x.status !== 'not-installed')) {
    const label = m.version === undefined ? m.name : `${m.name} ${m.version}`;
    lines.push(`Modules:    ${label} (${m.status})`);
  }
  if (info.modules.some((x) => x.status !== 'not-installed')) lines.push('');
  if (info.plugins.length === 0) {
    lines.push('Plugins:    (none installed)');
    lines.push('');
    lines.push('Install a language plugin, e.g. "npm i -D @ctxo/lang-typescript"');
    return lines.join('\n');
  }

  const nameCol = Math.max(7, ...info.plugins.map((p) => p.name.length));
  const verCol = Math.max(7, ...info.plugins.map((p) => p.version.length));
  const apiCol = Math.max(3, ...info.plugins.map((p) => p.apiVersion.length));

  lines.push(`Plugins:    ${info.plugins.length} installed`);
  lines.push(
    `  ${'NAME'.padEnd(nameCol)}  ${'VERSION'.padEnd(verCol)}  ${'API'.padEnd(apiCol)}  STATUS`,
  );
  for (const p of info.plugins) {
    const status = p.compatible ? 'OK' : `incompatible (core supports ${info.pluginApiVersions.join(', ')})`;
    lines.push(
      `  ${p.name.padEnd(nameCol)}  ${p.version.padEnd(verCol)}  ${p.apiVersion.padEnd(apiCol)}  ${status}`,
    );
  }

  return lines.join('\n');
}

export function formatJson(info: VersionInfo): string {
  return JSON.stringify(info, null, 2);
}

/**
 * What the module loader reports for this project. Without any copy of the module it is `not-installed`
 * and the host is never built; otherwise the host is imported on demand. Never throws:
 * a failure while loading is reported as `load-failed`.
 */
export async function collectModuleReports(projectRoot: string): Promise<readonly ModuleReport[]> {
  try {
    if (resolvePackageCandidates(DOMAIN_MODULE_PACKAGE, projectRoot).length === 0) {
      return [{ name: DOMAIN_MODULE_PACKAGE, status: 'not-installed' }];
    }
    const { createModuleHost } = await import('./module-host.js');
    const { reports } = await loadCtxoModules(createModuleHost({ projectRoot, mode: 'cli' }));
    return reports;
  } catch (err) {
    return [{ name: DOMAIN_MODULE_PACKAGE, status: 'load-failed', reason: (err as Error).message }];
  }
}

export interface VersionOptions {
  verbose?: boolean;
  json?: boolean;
}

/**
 * CLI entry. Keeps I/O scoped to plugin-discovery metadata reads; no adapter
 * instantiation, no network. Verbose and JSON modes target sub-200ms even with
 * several plugins installed because discovery only reads package.json plus a
 * single dynamic import() per plugin module (no createAdapter call).
 */
export class VersionCommand {
  constructor(private readonly projectRoot: string) {}

  async run(options: VersionOptions = {}): Promise<void> {
    const info = await this.collect();
    if (options.json) {
      process.stdout.write(formatJson(info) + '\n');
      return;
    }
    if (options.verbose) {
      process.stdout.write(formatVerbose(info) + '\n');
      return;
    }
    process.stdout.write(formatShort(info) + '\n');
  }

  private async collect(): Promise<VersionInfo> {
    const modules = await collectModuleReports(this.projectRoot);
    const manifestPath = loadManifestPath(this.projectRoot);
    if (!manifestPath) {
      return gatherVersionInfo([], modules);
    }
    const { plugins } = await discoverPlugins({ manifestPath });
    return gatherVersionInfo(plugins, modules);
  }
}

/**
 * Treat a CtxoLanguagePlugin-shaped object directly (escape hatch for callers
 * that have plugins in memory, e.g. indexCommand after wiring the registry).
 */
export function gatherFromLivePlugins(
  live: ReadonlyArray<{ plugin: CtxoLanguagePlugin; specifier: string }>,
): VersionInfo {
  return gatherVersionInfo(live);
}
