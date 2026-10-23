import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Helpers for the PR 2B acceptance tests: copy a library-lending variant to a temp directory, make it a
 * git repository, link `@ctxo/domain` into its node_modules (a junction on Windows) and run the built CLI.
 */

export type Variant = 'csharp' | 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DOMAIN_DIR = join(HERE, '..', '..');
const FIXTURES = join(DOMAIN_DIR, 'test-fixtures', 'library-lending');

const cliPackageJson = createRequire(import.meta.url).resolve('@ctxo/cli/package.json');
export const CLI_BIN = join(dirname(cliPackageJson), (JSON.parse(readFileSync(cliPackageJson, 'utf-8')) as { bin: { ctxo: string } }).bin.ctxo);

const IDENTITY = ['-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@test.com'];
const BASE_TIME = 1_700_000_000;
const ISOLATED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_CONFIG_SYSTEM'];

const PLUGINS: Record<Variant, readonly string[]> = {
  csharp: ['@ctxo/lang-csharp', '@ctxo/lang-sql'],
  typescript: ['@ctxo/lang-typescript', '@ctxo/lang-sql'],
};

export interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const dirs: string[] = [];
let gitConfigPath: string | undefined;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** An empty global git config, so the developer's own config (signing, hooks, templates) never leaks in. */
function gitConfig(): string {
  if (gitConfigPath === undefined) {
    gitConfigPath = join(tempDir('ctxo-domain-acceptance-gitenv-'), 'gitconfig');
    writeFileSync(gitConfigPath, '');
  }
  return gitConfigPath;
}

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ISOLATED) delete env[key];
  delete env['DEBUG'];
  delete env['CI'];
  delete env['CTXO_HTTP_PORT'];
  env['GIT_CONFIG_GLOBAL'] = gitConfig();
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  return { ...env, ...extra };
}

export function assertBuilt(): void {
  if (!existsSync(CLI_BIN)) throw new Error(`Build @ctxo/cli first: ${CLI_BIN} is missing`);
  if (!existsSync(join(DOMAIN_DIR, 'dist', 'index.js'))) throw new Error('Build @ctxo/domain first: dist/index.js is missing');
}

export function cleanupWorkspaces(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  gitConfigPath = undefined;
}

export class SampleWorkspace {
  private commits = 0;

  /**
   * False when the last `index` ran C# on the syntax tier (no .NET SDK 8+): that tier does not resolve a
   * call or a type reference to a symbol in another file, so the sample has no cross-context edges to judge.
   */
  resolvesEdges = true;

  /**
   * With `CTXO_REQUIRE_DOTNET=1` (the CI job that sets up .NET) a C# run that fell back to the syntax tier is a
   * failure, not a skip: the Roslyn tier is what that job exists to cover.
   */
  requireEdges(): void {
    if (process.env['CTXO_REQUIRE_DOTNET'] === '1' && !this.resolvesEdges) {
      throw new Error('CTXO_REQUIRE_DOTNET=1, but C# was indexed on the syntax tier: install .NET SDK 8+ so the Roslyn tier resolves edges between files');
    }
  }

  private constructor(
    readonly dir: string,
    readonly variant: Variant,
  ) {}

  /** Copies the variant, makes it a git repository on `main` with one commit, and links `@ctxo/domain`. */
  static create(variant: Variant): SampleWorkspace {
    const dir = tempDir(`ctxo-domain-sample-${variant}-`);
    cpSync(join(FIXTURES, variant), dir, { recursive: true });
    const workspace = new SampleWorkspace(dir, variant);
    workspace.write(
      'package.json',
      `${JSON.stringify(
        { name: `library-lending-${variant}`, private: true, devDependencies: Object.fromEntries(PLUGINS[variant].map((name) => [name, '*'])) },
        null,
        2,
      )}\n`,
    );
    workspace.write('.gitignore', 'node_modules/\nbin/\nobj/\n.ctxo/.cache/\n.ctxo/index/\n');
    mkdirSync(join(dir, 'node_modules', '@ctxo'), { recursive: true });
    symlinkSync(DOMAIN_DIR, join(dir, 'node_modules', '@ctxo', 'domain'), 'junction');
    workspace.git('init', '-q', '-b', 'main');
    workspace.commit('init');
    return workspace;
  }

  path(file: string): string {
    return join(this.dir, file);
  }

  write(file: string, text: string): void {
    const full = this.path(file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf-8');
  }

  read(file: string): string {
    return readFileSync(this.path(file), 'utf-8');
  }

  exists(file: string): boolean {
    return existsSync(this.path(file));
  }

  remove(file: string): void {
    rmSync(this.path(file), { recursive: true, force: true });
  }

  /** Replaces `from` with `to` in a file; throws when `from` is not there. */
  replace(file: string, from: string, to: string): void {
    // A checkout with core.autocrlf=true holds the fixtures with CRLF; compare and write LF.
    const text = this.read(file).replace(/\r\n/g, '\n');
    if (!text.includes(from)) throw new Error(`${file} does not contain ${JSON.stringify(from)}`);
    this.write(file, text.replace(from, to));
  }

  /** A git call with a fixed identity and a commit time that grows by a minute per call, so SHAs repeat. */
  git(...args: string[]): string {
    this.commits += 1;
    const when = `${BASE_TIME + this.commits * 60} +0000`;
    return execFileSync('git', args, {
      cwd: this.dir,
      encoding: 'utf-8',
      env: childEnv({ GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  commit(message: string, ...extra: string[]): void {
    this.git('add', '-A');
    this.git(...IDENTITY, 'commit', '-q', '-m', message, ...extra);
  }

  /** Runs the built CLI in the workspace. */
  cli(args: readonly string[], extraEnv: Record<string, string> = {}): CliResult {
    const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
      cwd: this.dir,
      encoding: 'utf-8',
      env: childEnv(extraEnv),
      timeout: 240_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  /** `ctxo domain-guard-hook` with a simulated Claude Code hook event on stdin. */
  guardHook(event: Record<string, unknown>): CliResult {
    const result = spawnSync(process.execPath, [CLI_BIN, 'domain-guard-hook'], {
      cwd: this.dir,
      input: JSON.stringify({ cwd: this.dir, ...event }),
      encoding: 'utf-8',
      env: childEnv(),
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  /** `ctxo index`, which must succeed. */
  index(...extra: string[]): CliResult {
    const result = this.cli(['index', ...extra]);
    if (result.status !== 0) throw new Error(`ctxo index failed (${result.status}): ${result.stderr}`);
    this.resolvesEdges = this.variant !== 'csharp' || /C#: .*\(full tier\)/.test(result.stderr);
    return result;
  }

  /** The sample with its generated loader rules committed, as a team that ran `ctxo domain rules --write` has it. */
  commitLoaderRules(): void {
    const result = this.cli(['domain', 'rules', '--write']);
    if (result.status !== 0) throw new Error(`ctxo domain rules --write failed: ${result.stderr}`);
    this.commit('chore: generated loader rules');
  }

  /** Starts the built MCP server over stdio in the workspace. */
  async connect(): Promise<McpSession> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(childEnv())) if (value !== undefined) env[key] = value;
    const client = new Client({ name: 'domain-acceptance', version: '0.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI_BIN], cwd: this.dir, env, stderr: 'ignore' }));
    return new McpSession(client);
  }
}

export class McpSession {
  constructor(private readonly client: Client) {}

  /** Calls a tool and returns the parsed JSON text of its response. */
  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = (await this.client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[] };
    return JSON.parse(response.content[0]!.text) as Record<string, unknown>;
  }

  /** The names of the tools the server lists. */
  async listTools(): Promise<string[]> {
    return (await this.client.listTools()).tools.map((tool) => tool.name);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/** Every object key anywhere in a parsed JSON value. */
export function allKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      allKeys(child, into);
    }
  }
  return into;
}
