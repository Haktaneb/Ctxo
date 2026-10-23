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

/** An `npx` argument naming ctxo: `@ctxo/cli`, `@ctxo/cli@latest` or `@ctxo/cli@0.13.0`. */
const CTXO_SPEC = /^@ctxo\/cli(@|$)/;

function launcherOfCommand(command: string, args: readonly string[]): McpLauncher {
  const name = commandName(command);
  if (name === 'npx') return args.some((a) => CTXO_SPEC.test(a)) ? 'npx' : 'other';
  if (name === 'ctxo') return 'path-binary';
  return 'other';
}

/** The command and args that run, looking through a `cmd /c` wrapper; undefined when not an entry object. */
function innerCommand(entry: unknown): { command: string; args: string[] } | undefined {
  if (!isRecord(entry) || typeof entry['command'] !== 'string') return undefined;
  const args = Array.isArray(entry['args']) ? entry['args'].filter((a): a is string => typeof a === 'string') : [];
  if (commandName(entry['command']) === 'cmd') {
    const run = args.findIndex((a) => a.toLowerCase() === '/c');
    const inner = run >= 0 ? args[run + 1] : undefined;
    return inner === undefined ? { command: 'cmd', args: [] } : { command: inner, args: args.slice(run + 2) };
  }
  return { command: entry['command'], args };
}

/**
 * Which launcher an MCP server entry uses: `npx` (or `cmd /c npx`) with `@ctxo/cli` (pinned or not),
 * `path-binary` for `ctxo` (or `cmd /c ctxo`), `other` for anything else. `undefined` when the value
 * is not an entry object with a command.
 */
export function mcpLauncherOf(entry: unknown): McpLauncher | undefined {
  const inner = innerCommand(entry);
  return inner === undefined ? undefined : launcherOfCommand(inner.command, inner.args);
}

/** The version an `npx` entry pins (`@ctxo/cli@0.12.0`); undefined when unpinned, `@latest`, or not an npx entry. */
export function mcpNpxPin(entry: unknown): string | undefined {
  const inner = innerCommand(entry);
  if (inner === undefined || launcherOfCommand(inner.command, inner.args) !== 'npx') return undefined;
  const spec = inner.args.find((a) => CTXO_SPEC.test(a));
  const version = spec?.startsWith('@ctxo/cli@') ? spec.slice('@ctxo/cli@'.length) : '';
  return version !== '' && version !== 'latest' ? version : undefined;
}

export interface InstallCopiesFacts {
  readonly launchers: readonly McpLauncher[];
  readonly hooksCallCtxo: boolean;
  readonly ctxoOnPath: boolean;
  /** Versions pinned by the npx entries (`@ctxo/cli@0.12.0`); an unpinned or `@latest` entry adds none. */
  readonly npxPins?: readonly string[];
  /** Version of the global `@ctxo/cli` behind the `ctxo` on PATH, when it can be found. */
  readonly globalCliVersion?: string;
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
    // npx runs the global copy when it satisfies the spec, so an unpinned entry shares the copy on PATH.
    // Only a pin that differs from the global version starts a second copy (no known version: no claim).
    const global = facts.globalCliVersion;
    const differing = global === undefined ? undefined : (facts.npxPins ?? []).find((pin) => pin !== global);
    if (differing !== undefined) {
      const start = `MCP starts "npx -y @ctxo/cli@${differing}" while hooks run "ctxo" ${global} from PATH: two copies`;
      return facts.domainInstalled === true
        ? {
            status: 'warn',
            message: `${start}, and @ctxo/domain installed in one is missing from the other`,
            fix: 'Install once globally ("npm i -g @ctxo/cli @ctxo/domain"), then run "ctxo init --only mcp" from that install',
          }
        : {
            status: 'warn',
            message: `${start}, so a package installed next to one is not seen by the other`,
            fix: 'Install once globally ("npm i -g @ctxo/cli"), then run "ctxo init --only mcp" from that install',
          };
    }
    return { status: 'pass', message: 'one copy: MCP and hooks run ctxo from PATH' };
  }
  if (facts.hooksCallCtxo && facts.launchers.includes('path-binary')) {
    return { status: 'pass', message: 'one copy: MCP and hooks run ctxo from PATH' };
  }
  return { status: 'pass', message: 'nothing to compare (no ctxo hooks or no MCP entry)' };
}
