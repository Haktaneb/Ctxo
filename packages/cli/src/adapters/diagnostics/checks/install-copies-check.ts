import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { IHealthCheck, CheckContext, CheckResult } from '../../../core/diagnostics/types.js';
import { assessInstallCopies, mcpLauncherOf, mcpNpxPin, type McpLauncher } from '../../../core/install/install-kind.js';
import { resolvePackageCandidates } from '../../language/plugin-discovery.js';
import { DOMAIN_MODULE_PACKAGE } from '../../modules/module-loader.js';

/*
 * install_copies: the MCP entries and the hooks of a project should start the same ctxo copy.
 * An unpinned "npx -y @ctxo/cli" runs the global copy when it satisfies the spec, so it is one copy with
 * hooks that run "ctxo" from PATH. A pinned "npx -y @ctxo/cli@<version>" that differs from the global
 * version is two copies, so a package added to one (such as @ctxo/domain) is missing from the other.
 * Only warns, never fails.
 */

/** Client files that register the ctxo MCP server, and the key that holds their server map. */
const MCP_FILES: ReadonlyArray<{ readonly file: string; readonly keys: readonly string[] }> = [
  { file: '.mcp.json', keys: ['mcpServers'] },
  { file: '.vscode/mcp.json', keys: ['servers'] },
  { file: '.gemini/settings.json', keys: ['mcpServers'] },
  { file: '.amazonq/mcp.json', keys: ['mcpServers'] },
  { file: '.continue/mcpServers/ctxo.json', keys: ['mcpServers'] },
];

const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parsed JSON of a file, read once; undefined when it cannot be read or parsed. */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

function mcpLaunchers(projectRoot: string): { launchers: McpLauncher[]; npxPins: string[] } {
  const out: McpLauncher[] = [];
  const npxPins: string[] = [];
  for (const { file, keys } of MCP_FILES) {
    const json = readJson(join(projectRoot, file));
    if (!isRecord(json)) continue;
    for (const key of keys) {
      const servers = json[key];
      const launcher = isRecord(servers) ? mcpLauncherOf(servers['ctxo']) : undefined;
      if (launcher !== undefined) out.push(launcher);
      const pin = isRecord(servers) ? mcpNpxPin(servers['ctxo']) : undefined;
      if (pin !== undefined) npxPins.push(pin);
    }
  }
  return { launchers: out, npxPins };
}

/** True when any `command` string under a settings file's `hooks` starts with `ctxo `. */
function hookCallsCtxo(node: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (Array.isArray(node)) return node.some((child) => hookCallsCtxo(child, depth + 1));
  if (!isRecord(node)) return false;
  const command = node['command'];
  if (typeof command === 'string' && command.trimStart().startsWith('ctxo ')) return true;
  return Object.values(node).some((child) => hookCallsCtxo(child, depth + 1));
}

function anyHookCallsCtxo(projectRoot: string): boolean {
  return SETTINGS_FILES.some((file) => {
    const json = readJson(join(projectRoot, file));
    return isRecord(json) && hookCallsCtxo(json['hooks']);
  });
}

function binaryOnPath(dirs: readonly string[]): boolean {
  const names = process.platform === 'win32' ? ['ctxo.cmd', 'ctxo.exe'] : ['ctxo'];
  return dirs.some((dir) => dir !== '' && names.some((name) => existsSync(join(dir, name))));
}

/** Version of the `@ctxo/cli` behind the `ctxo` binary found in `dirs`; undefined when it cannot be found. */
function globalCliVersion(dirs: readonly string[]): string | undefined {
  const names = process.platform === 'win32' ? ['ctxo.cmd', 'ctxo.exe'] : ['ctxo'];
  for (const dir of dirs) {
    const found = dir === '' ? undefined : names.find((name) => existsSync(join(dir, name)));
    if (found === undefined) continue;
    const candidates = [
      join(dir, 'node_modules', '@ctxo', 'cli', 'package.json'), // Windows npm prefix, a global bin dir with its own node_modules
      join(dir, '..', 'lib', 'node_modules', '@ctxo', 'cli', 'package.json'), // unix npm prefix/bin
    ];
    try {
      candidates.push(join(realpathSync(join(dir, found)), '..', '..', 'package.json')); // symlink to <pkg>/dist/<file>
    } catch {
      // not a link ctxo can follow
    }
    for (const file of candidates) {
      const json = readJson(file);
      if (isRecord(json) && json['name'] === '@ctxo/cli' && typeof json['version'] === 'string') return json['version'];
    }
  }
  return undefined;
}

export class InstallCopiesCheck implements IHealthCheck {
  readonly id = 'install_copies';
  readonly title = 'Install copies';

  constructor(private readonly options: { readonly pathDirs?: readonly string[] } = {}) {}

  async run(ctx: CheckContext): Promise<CheckResult> {
    try {
      const pathDirs = this.options.pathDirs ?? (process.env['PATH'] ?? '').split(delimiter);
      const { launchers, npxPins } = mcpLaunchers(ctx.projectRoot);
      const globalVersion = globalCliVersion(pathDirs);
      const verdict = assessInstallCopies({
        launchers,
        npxPins,
        ...(globalVersion !== undefined ? { globalCliVersion: globalVersion } : {}),
        hooksCallCtxo: anyHookCallsCtxo(ctx.projectRoot),
        ctxoOnPath: binaryOnPath(pathDirs),
        domainInstalled: resolvePackageCandidates(DOMAIN_MODULE_PACKAGE, ctx.projectRoot).length > 0,
      });
      return { id: this.id, title: this.title, ...verdict };
    } catch (err) {
      return {
        id: this.id,
        title: this.title,
        status: 'pass',
        message: `could not be checked: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
