import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * What each route of the built CLI can load (ADR-018). The entry (`dist/index.js`) and the internal API
 * (`dist/internal.js`) must never load the MCP SDK, the MCP composition root or the CLI router through
 * their static imports, and the fast hook route (`ctxo domain-guard-hook`) must not reach them through
 * the dynamic imports it makes either. Read from the built chunks: their `import` statements and, to name
 * the source a chunk holds, its source map.
 */

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');

const STATIC_IMPORT = /(?:^|[\n;])\s*(?:import|export)\s*(?:[\w$*{}\s,]*?\s*from\s*)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

interface Closure {
  /** dist files reached, as file names. */
  readonly files: Set<string>;
  /** Package specifiers imported by those files (`node:` builtins left out). */
  readonly packages: Set<string>;
}

function importsOf(file: string, pattern: RegExp): string[] {
  const text = readFileSync(join(DIST, file), 'utf-8');
  return [...text.matchAll(pattern)].map((match) => match[1]!);
}

/** The files reached from `entry`. Static imports are always followed, dynamic ones from the files `followDynamic` names. */
function closure(entry: string, followDynamic: (file: string) => boolean): Closure {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.has(file)) continue;
    files.add(file);
    const specifiers = [
      ...importsOf(file, STATIC_IMPORT),
      ...(followDynamic(file) ? importsOf(file, DYNAMIC_IMPORT) : []),
    ];
    for (const specifier of specifiers) {
      if (specifier.startsWith('./')) queue.push(specifier.slice(2));
      else if (!specifier.startsWith('node:')) packages.add(specifier);
    }
  }
  return { files, packages };
}

/** The source files a dist chunk was built from, from its source map (empty for a re-export stub). */
function sourcesOf(file: string): string[] {
  const map = join(DIST, `${file}.map`);
  if (!existsSync(map)) return [];
  const sources = (JSON.parse(readFileSync(map, 'utf-8')) as { sources?: string[] }).sources ?? [];
  return sources.map((source) => source.replace(/\\/g, '/'));
}

const FORBIDDEN_SOURCES = ['src/cli/cli-router.ts', 'src/mcp-server.ts', 'src/adapters/transport/http-server-transport.ts'];

function forbiddenIn(reached: Closure): string[] {
  const found: string[] = [];
  for (const pkg of reached.packages) {
    if (pkg.startsWith('@modelcontextprotocol/')) found.push(pkg);
  }
  for (const file of reached.files) {
    if (/^(cli-router|mcp-server)-/.test(file)) found.push(file);
    for (const source of sourcesOf(file)) {
      if (FORBIDDEN_SOURCES.some((forbidden) => source.endsWith(forbidden))) found.push(`${file} (${source})`);
    }
  }
  return found;
}

describe('built entry import closure', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('the checks see the MCP stack where it is: the router and the server are dynamic imports of the entry', () => {
    expect(readdirSync(DIST)).toContain('index.js');
    const dynamicTargets = importsOf('index.js', DYNAMIC_IMPORT).map((specifier) => specifier.slice(2));
    expect(dynamicTargets.some((file) => file.startsWith('cli-router-'))).toBe(true);
    expect(dynamicTargets.some((file) => file.startsWith('mcp-server-'))).toBe(true);
    // Followed, those imports do reach the SDK: the checks below would catch them.
    const everything = closure('index.js', () => true);
    expect(forbiddenIn(everything)).toEqual(expect.arrayContaining([expect.stringMatching(/^@modelcontextprotocol\//)]));
    expect(forbiddenIn(everything).some((found) => found.includes('src/cli/cli-router.ts'))).toBe(true);
  });

  it('dist/index.js loads neither the MCP SDK, the MCP server nor the CLI router statically', () => {
    expect(forbiddenIn(closure('index.js', () => false))).toEqual([]);
  });

  it('dist/internal.js loads neither the MCP SDK, the MCP server nor the CLI router', () => {
    // internal.js makes no route choice, so its dynamic imports count too.
    const reached = closure('internal.js', () => true);
    expect(reached.files.size).toBeGreaterThan(1);
    expect(forbiddenIn(reached)).toEqual([]);
  });

  it('the fast hook route reaches the module host and the loader, but neither the MCP stack nor the router', () => {
    // Everything the entry loads statically, plus every dynamic import made past the entry: a superset of
    // what `ctxo domain-guard-hook` can load (the entry's own dynamic imports pick the router or the server).
    const reached = closure('index.js', (file) => file !== 'index.js');
    const sources = [...reached.files].flatMap(sourcesOf);
    expect(sources.some((source) => source.endsWith('src/cli/module-commands.ts'))).toBe(true);
    expect(sources.some((source) => source.endsWith('src/cli/module-host.ts'))).toBe(true);
    expect(sources.some((source) => source.endsWith('src/adapters/modules/module-loader.ts'))).toBe(true);
    expect(forbiddenIn(reached)).toEqual([]);
  });

  it('ctxo domain-guard-hook without @ctxo/domain exits 0 and prints nothing', { timeout: 30_000 }, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ctxo-fast-route-'));
    dirs.push(cwd);
    const result = spawnSync(process.execPath, [join(DIST, 'index.js'), 'domain-guard-hook'], {
      cwd,
      input: '{"hook_event_name":"Stop","session_id":"s1"}',
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});
