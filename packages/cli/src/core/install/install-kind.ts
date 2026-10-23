/*
 * How the running CLI was installed, and what MCP and hook entries say about the copy they start.
 * Pure: no file or process access, so it is unit-testable on any platform.
 */

export type CliInstallKind = 'project' | 'npx' | 'global';

/** Forward-slash form of a path; lower-cased on win32, whose paths ignore case. */
function normalizePath(path: string, platform: NodeJS.Platform): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/** Package-runner caches: `npx` (`_npx`), `pnpm dlx` (`dlx`), `bunx` (`bunx-`, the bun install cache). */
const RUNNER_CACHE = /\/(_npx|dlx)\/|\/bunx-[^/]*\/|\/\.bun\/install\/cache\//;

/**
 * Where the running CLI lives: inside a package-runner cache (`npx`, `pnpm dlx`, `bunx`), in a
 * `node_modules` of the project (or one of its ancestors, as a workspace hoists it: `project`), or
 * anywhere else (`global`). D12.
 */
export function cliInstallKind(
  cliPackageRoot: string,
  projectRoot: string,
  platform: NodeJS.Platform = process.platform,
): CliInstallKind {
  const cli = normalizePath(cliPackageRoot, platform);
  if (RUNNER_CACHE.test(`${cli}/`)) return 'npx';
  const marker = '/node_modules/';
  const at = cli.indexOf(marker);
  if (at >= 0) {
    const owner = cli.slice(0, at);
    const project = normalizePath(projectRoot, platform);
    if (project === owner || project.startsWith(`${owner}/`)) return 'project';
  }
  return 'global';
}

export type McpLauncher = 'npx' | 'path-binary' | 'other';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `npx.cmd`, `C:\\x\\ctxo.exe` and `/usr/bin/ctxo` reduce to `npx`, `ctxo`, `ctxo`. */
function commandName(command: string): string {
  const base = command.replace(/\\/g, '/').split('/').pop() ?? command;
  return base.toLowerCase().replace(/\.(cmd|exe|bat)$/, '');
}

function launcherOfCommand(command: string, args: readonly string[]): McpLauncher {
  const name = commandName(command);
  if (name === 'npx') return args.includes('@ctxo/cli') ? 'npx' : 'other';
  if (name === 'ctxo') return 'path-binary';
  return 'other';
}

/**
 * Which launcher an MCP server entry uses: `npx` (or `cmd /c npx`) with `@ctxo/cli`, `path-binary`
 * for `ctxo` (or `cmd /c ctxo`), `other` for anything else. `undefined` when the value is not an
 * entry object with a command.
 */
export function mcpLauncherOf(entry: unknown): McpLauncher | undefined {
  if (!isRecord(entry) || typeof entry['command'] !== 'string') return undefined;
  const args = Array.isArray(entry['args']) ? entry['args'].filter((a): a is string => typeof a === 'string') : [];
  if (commandName(entry['command']) === 'cmd') {
    const run = args.findIndex((a) => a.toLowerCase() === '/c');
    const inner = run >= 0 ? args[run + 1] : undefined;
    return inner === undefined ? 'other' : launcherOfCommand(inner, args.slice(run + 2));
  }
  return launcherOfCommand(entry['command'], args);
}

export interface InstallCopiesFacts {
  readonly launchers: readonly McpLauncher[];
  readonly hooksCallCtxo: boolean;
  readonly ctxoOnPath: boolean;
  /** `@ctxo/domain` is installed; only then does a warning name it. */
  readonly domainInstalled?: boolean;
}

export type InstallCopiesVerdict =
  | { readonly status: 'pass'; readonly message: string }
  | { readonly status: 'warn'; readonly message: string; readonly fix: string };

/**
 * Compares the copy the MCP entries start with the copy the hooks run. The PATH warning comes
 * first (hooks that can never run), then the two-copies warning, then the pass messages.
 */
export function assessInstallCopies(facts: InstallCopiesFacts): InstallCopiesVerdict {
  if (facts.hooksCallCtxo && !facts.ctxoOnPath) {
    return {
      status: 'warn',
      message: 'hooks call "ctxo" but no ctxo is on PATH, so they never run',
      fix: 'Install @ctxo/cli globally ("npm i -g @ctxo/cli")',
    };
  }
  if (facts.hooksCallCtxo && facts.launchers.includes('npx')) {
    return facts.domainInstalled === true
      ? {
          status: 'warn',
          message:
            'MCP starts "npx -y @ctxo/cli" while hooks run "ctxo" from PATH: two copies, and @ctxo/domain installed in one is missing from the other',
          fix: 'Install once globally ("npm i -g @ctxo/cli @ctxo/domain"), then run "ctxo init --only mcp" from that install',
        }
      : {
          status: 'warn',
          message:
            'MCP starts "npx -y @ctxo/cli" while hooks run "ctxo" from PATH: two copies, and a package installed in one is missing from the other',
          fix: 'Install once globally ("npm i -g @ctxo/cli"), then run "ctxo init --only mcp" from that install',
        };
  }
  if (facts.hooksCallCtxo && facts.launchers.includes('path-binary')) {
    return { status: 'pass', message: 'one copy: MCP and hooks run ctxo from PATH' };
  }
  return { status: 'pass', message: 'nothing to compare (no ctxo hooks or no MCP entry)' };
}
