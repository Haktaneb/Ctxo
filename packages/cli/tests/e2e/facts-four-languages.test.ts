import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexCommand } from '../../src/cli/index-command.js';
import { JsonIndexReader } from '../../src/adapters/storage/json-index-reader.js';
import type { FileIndex } from '../../src/core/types.js';
import { isolateGitEnv, type IsolatedGitEnv } from '../../src/cli/__tests__/git-test-env.js';
import { cleanupTempProjects, createProject, type TempProject } from '../../src/cli/__tests__/helpers/temp-project.js';

/**
 * Native facts in TypeScript, C#, Java and Go (PR 4, #156, spec 12.4 and 13.1), end to end through
 * `ctxo index`: the same `n >= 5` comparison in a small synthetic library-lending project gives the same
 * `literal-comparison` fact in every language, only when facts are requested, and the same facts twice.
 * Plugins are discovered from the project's package.json and resolved through the CLI's own install.
 *
 * Opt-in: it runs the JDT analyzer, builds the Go analyzer and (with a .NET 8+ SDK) the Roslyn helper, so it
 * runs only with CTXO_PARITY_E2E=1, and CI runs it in the plugin-tests job only. Each language runs in the
 * tier the machine allows: Java needs a JRE and a built analyzer JAR for the full tier, Go a Go toolchain,
 * C# a .NET SDK; otherwise the plugin's syntax tier answers, which gives the same facts (Tasks 4, 7, 9).
 * To run it locally after `pnpm -r build`:
 *
 *   bash:        CTXO_PARITY_E2E=1 pnpm --filter @ctxo/cli test:e2e tests/e2e/facts-four-languages.test.ts
 *   PowerShell:  $env:CTXO_PARITY_E2E = '1'; pnpm --filter @ctxo/cli test:e2e tests/e2e/facts-four-languages.test.ts
 */
const ENABLED = process.env['CTXO_PARITY_E2E'] === '1';

const here = dirname(fileURLToPath(import.meta.url));
const JAR_DIR = resolve(here, '../../../lang-java-analyzer/jar');
const ROSLYN_CSPROJ = resolve(here, '../../../lang-csharp/tools/ctxo-roslyn/ctxo-roslyn.csproj');

function runs(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_GO = ENABLED && runs('go', ['version']);

const HAS_DOTNET = ENABLED && (() => {
  try {
    const version = execFileSync('dotnet', ['--version'], { encoding: 'utf-8' }).trim();
    return parseInt(version.split('.')[0]!, 10) >= 8;
  } catch {
    return false;
  }
})();

/** The JRE major version `java -version` reports, or undefined when java does not run. */
function javaMajor(): number | undefined {
  // java -version prints to stderr.
  const run = spawnSync('java', ['-version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (run.error || run.status !== 0) return undefined;
  const match = /version "(\d+)(?:\.(\d+))?/.exec(`${run.stderr}\n${run.stdout}`);
  if (!match) return undefined;
  const first = parseInt(match[1]!, 10);
  return first === 1 && match[2] ? parseInt(match[2], 10) : first;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The analyzer JAR this JRE can run (`-17` on 17 or later, which also runs `-11`). */
function analyzerJar(): string | undefined {
  const major = javaMajor();
  if (major === undefined) return undefined;
  for (const variant of major >= 17 ? ['17', '11'] : ['11']) {
    const jar = join(JAR_DIR, `ctxo-jdt-analyzer-${variant}.jar`);
    if (isFile(jar)) return jar;
  }
  return undefined;
}

const JDT_JAR = ENABLED ? analyzerJar() : undefined;
const CAN_RUN_JDT = JDT_JAR !== undefined;

const HOOK_TIMEOUT = 900_000;

const TS_FILE = 'src/policy.ts';
const TS_EMPTY_FILE = 'src/empty.ts';
const CS_FILE = 'src/LoanPolicy.cs';
const JAVA_FILE = 'src/main/java/parity/LoanPolicy.java';
const GO_FILE = 'loans/policy.go';

const FACT_FILES: Record<string, string> = {
  typescript: TS_FILE,
  csharp: CS_FILE,
  java: JAVA_FILE,
  go: GO_FILE,
};

const SOLUTION = [
  '',
  'Microsoft Visual Studio Solution File, Format Version 12.00',
  '# Visual Studio Version 17',
  'VisualStudioVersion = 17.0.31903.59',
  'MinimumVisualStudioVersion = 10.0.40219.1',
  'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Parity", "Parity.csproj", "{3B2F7A51-6C1D-4E8A-9F0B-2D4C6E8A1B3D}"',
  'EndProject',
  'Global',
  '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
  '\t\tDebug|Any CPU = Debug|Any CPU',
  '\tEndGlobalSection',
  '\tGlobalSection(ProjectConfigurationPlatforms) = postSolution',
  '\t\t{3B2F7A51-6C1D-4E8A-9F0B-2D4C6E8A1B3D}.Debug|Any CPU.ActiveCfg = Debug|Any CPU',
  '\t\t{3B2F7A51-6C1D-4E8A-9F0B-2D4C6E8A1B3D}.Debug|Any CPU.Build.0 = Debug|Any CPU',
  '\tEndGlobalSection',
  'EndGlobal',
  '',
].join('\r\n');

const SOURCES: Record<string, string> = {
  [TS_FILE]: 'export function canBorrow(n: number): boolean { if (n >= 5) return false; return true; }\n',
  [TS_EMPTY_FILE]: "export const label = 'x';\n",
  'Parity.csproj': [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup>',
    '    <TargetFramework>net8.0</TargetFramework>',
    '  </PropertyGroup>',
    '</Project>',
    '',
  ].join('\n'),
  'Parity.sln': SOLUTION,
  [CS_FILE]: 'namespace Parity; public class LoanPolicy { public bool CanBorrow(int n) { if (n >= 5) return false; return true; } }\n',
  [JAVA_FILE]: 'package parity; public class LoanPolicy { public boolean canBorrow(int n) { if (n >= 5) return false; return true; } }\n',
  'go.mod': ['module parity', '', 'go 1.22', ''].join('\n'),
  [GO_FILE]: ['package loans', '', 'func CanBorrow(n int) bool { if n >= 5 { return false }; return true }', ''].join('\n'),
  'package.json': `${JSON.stringify({
    name: 'parity',
    private: true,
    devDependencies: {
      '@ctxo/lang-csharp': '*',
      '@ctxo/lang-go': '*',
      '@ctxo/lang-java': '*',
      '@ctxo/lang-typescript': '*',
    },
  }, null, 2)}\n`,
};

const FACTS_CONFIG = ['version: "1.0"', 'index:', '  facts: true', ''].join('\n');

function dotnet(args: string[]): void {
  execFileSync('dotnet', [...args, '--nologo', '-v', 'q'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 600_000,
  });
}

/** The project with every file written before its one commit; `.ctxo/config.yaml` only with facts. */
function makeProject(withFacts: boolean): TempProject {
  const project = createProject();
  // The restore output stays out of the commit.
  appendFileSync(join(project.dir, '.git', 'info', 'exclude'), 'bin/\nobj/\n');
  for (const [file, content] of Object.entries(SOURCES)) project.write(file, content);
  if (withFacts) project.write('.ctxo/config.yaml', FACTS_CONFIG);
  // Restored so the framework types (int, bool) resolve in the Roslyn helper.
  if (HAS_DOTNET) dotnet(['restore', join(project.dir, 'Parity.csproj')]);
  project.commit('add the parity project');
  return project;
}

/** Runs `ctxo index` and returns what it wrote to stderr. */
async function index(dir: string): Promise<string> {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await new IndexCommand(dir).run({ skipHistory: true });
    return errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
  } finally {
    errorSpy.mockRestore();
  }
}

function readIndex(dir: string): FileIndex[] {
  return new JsonIndexReader(join(dir, '.ctxo')).readAll();
}

function entryFor(indices: readonly FileIndex[], file: string): FileIndex {
  const entry = indices.find((e) => e.file === file);
  if (!entry) throw new Error(`no index entry for ${file}`);
  return entry;
}

/** Every file's `facts` (undefined when the key is absent). */
function factsByFile(indices: readonly FileIndex[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of indices) out[entry.file] = entry.facts;
  return out;
}

/** The tier the index summary reports for a language (`C#`, `Go`, `Java`), or undefined. */
function tierOf(output: string, language: string): string | undefined {
  const escaped = language.replace(/[#]/g, '\\$&');
  return new RegExp(`\\[ctxo\\]\\s+${escaped}: \\d+ files? \\((full|syntax) tier`).exec(output)?.[1];
}

describe.skipIf(!ENABLED)('native facts in TypeScript, C#, Java and Go', () => {
  let gitEnv: IsolatedGitEnv;
  let withoutFacts: TempProject;
  let withFacts: TempProject;
  let factsOutput = '';

  beforeAll(async () => {
    // Built up front: the index's batch run has its own time limit, which a cold helper build can exceed.
    if (HAS_DOTNET) dotnet(['build', ROSLYN_CSPROJ]);
    gitEnv = isolateGitEnv();
    if (JDT_JAR) vi.stubEnv('CTXO_JDT_ANALYZER_JAR', JDT_JAR);
    withoutFacts = makeProject(false);
    withFacts = makeProject(true);
    await index(withoutFacts.dir);
    factsOutput = await index(withFacts.dir);
  }, HOOK_TIMEOUT);

  afterAll(() => {
    // Which tier answered for each language, for the run log (stderr, never stdout).
    process.stderr.write(
      `[facts-four-languages] tiers: C# ${tierOf(factsOutput, 'C#') ?? 'none'}, Java ${tierOf(factsOutput, 'Java') ?? 'none'}, Go ${tierOf(factsOutput, 'Go') ?? 'none'}\n`,
    );
    vi.unstubAllEnvs();
    gitEnv?.restore();
    cleanupTempProjects();
  });

  // In CI the toolchains must be there: a broken setup-java or setup-go must fail the job, not fall back.
  it.runIf(Boolean(process.env['CI']))('the Java, Go and .NET toolchains are available in CI', () => {
    expect({ go: HAS_GO, jdt: CAN_RUN_JDT, dotnet: HAS_DOTNET }).toEqual({ go: true, jdt: true, dotnet: true });
  });

  it('without a fact request no file has a facts key', () => {
    const indices = readIndex(withoutFacts.dir);
    for (const file of Object.values(FACT_FILES)) expect(indices.map((e) => e.file)).toContain(file);
    for (const entry of indices) expect(Object.keys(entry), entry.file).not.toContain('facts');
  });

  it.each(Object.entries(FACT_FILES))('with index.facts every language reports the n >= 5 comparison: %s', (_language, file) => {
    const entry = entryFor(readIndex(withFacts.dir), file);
    expect(entry.facts).toContainEqual(
      expect.objectContaining({ kind: 'literal-comparison', text: 'n >= 5', detail: { operator: '>=', literal: '5' } }),
    );
    // The fact belongs to a symbol of the same file (the method or function holding the comparison).
    const fact = entry.facts!.find((f) => f.text === 'n >= 5')!;
    expect(entry.symbols.map((s) => s.symbolId)).toContain(fact.symbolId);
  });

  it.skipIf(!HAS_DOTNET)('the C# facts come from the Roslyn tier', () => {
    expect(tierOf(factsOutput, 'C#')).toBe('full');
  });

  it.skipIf(!CAN_RUN_JDT)('the Java facts come from the JDT tier', () => {
    expect(tierOf(factsOutput, 'Java')).toBe('full');
  });

  it.skipIf(!HAS_GO)('the Go facts come from the analyzer tier', () => {
    expect(tierOf(factsOutput, 'Go')).toBe('full');
  });

  it('a file of a fact-capable plugin without facts carries facts: []', () => {
    expect(entryFor(readIndex(withFacts.dir), TS_EMPTY_FILE).facts).toEqual([]);
  });

  it('indexing the same commit twice gives deep-equal facts for every file', async () => {
    const first = factsByFile(readIndex(withFacts.dir));
    // .ctxo/config.yaml stays: only the index and the cache go.
    for (const part of ['index', '.cache']) {
      rmSync(join(withFacts.dir, '.ctxo', part), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    await index(withFacts.dir);
    const second = factsByFile(readIndex(withFacts.dir));

    expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort());
    expect(second).toEqual(first);
  }, HOOK_TIMEOUT);
});
