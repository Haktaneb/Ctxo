import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { IHealthCheck, CheckContext, CheckResult } from '../../../core/diagnostics/types.js';
import { assessInstallCopies, mcpLauncherOf, type McpLauncher } from '../../../core/install/install-kind.js';
import { resolvePackageCandidates } from '../../language/plugin-discovery.js';
import { DOMAIN_MODULE_PACKAGE } from '../../modules/module-loader.js';

/*
 * install_copies: the MCP entries and the hooks of a project should start the same ctxo copy.
 * "npx -y @ctxo/cli" in the MCP config next to hooks that run "ctxo" from PATH is two copies, so a
 * package added to one (such as @ctxo/domain) is missing from the other. Only warns, never fails.
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

function mcpLaunchers(projectRoot: string): McpLauncher[] {
  const out: McpLauncher[] = [];
  for (const { file, keys } of MCP_FILES) {
    const json = readJson(join(projectRoot, file));
    if (!isRecord(json)) continue;
    for (const key of keys) {
      const servers = json[key];
      const launcher = isRecord(servers) ? mcpLauncherOf(servers['ctxo']) : undefined;
      if (launcher !== undefined) out.push(launcher);
    }
  }
  return out;
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

export class InstallCopiesCheck implements IHealthCheck {
  readonly id = 'install_copies';
  readonly title = 'Install copies';

  constructor(private readonly options: { readonly pathDirs?: readonly string[] } = {}) {}

  async run(ctx: CheckContext): Promise<CheckResult> {
    try {
      const pathDirs = this.options.pathDirs ?? (process.env['PATH'] ?? '').split(delimiter);
      const verdict = assessInstallCopies({
        launchers: mcpLaunchers(ctx.projectRoot),
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
