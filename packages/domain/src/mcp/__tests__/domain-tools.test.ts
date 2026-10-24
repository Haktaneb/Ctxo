import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModuleHost, type CtxoHost, type FileIndex, type IndexPassContext, type ModuleToolDefinition } from '@ctxo/cli/internal';
import { register } from '../../index.js';
import { domainIndexPass } from '../../index-pass/domain-index-pass.js';
import { domainVersion } from '../../version.js';
import { createDomainState, STALE_CARDS_HINT } from '../domain-state.js';
import { domainTools, GET_DOMAIN_CONTEXT, GET_RULE } from '../domain-tools.js';

const REGISTRY = `version: 1
contexts:
  - id: lending
    name: Lending
    card: docs/domain/lending/domain.md
    paths: ["src/Lending/**", "tests/Lending.Tests/**"]
    rung: bounded
    rulePrefix: LEND
  - id: billing
    name: Billing
    paths: ["src/Billing/**"]
    rung: pinned
`;

const TEST_FILE = 'tests/Lending.Tests/LoanLimitTests.cs';
const TEST_METHOD = `${TEST_FILE}::LoanLimitTests.RejectsTheSixthLoan::method`;

const CARD = [
  '# Lending',
  '',
  '## Language',
  '- **Loan**: a book lent to a member',
  '',
  '## Rules and invariants',
  '### LEND-03 A member holds at most five loans',
  `Tests: \`${TEST_METHOD}\``,
  'Code: `src/Lending/Loan.ts`',
  '',
  'Five is the limit.',
  '',
].join('\n');

const TEST_TEXT = [
  'public class LoanLimitTests',
  '{',
  '    [Fact]',
  '    [Trait("Rule", "LEND-03")]',
  '    public void RejectsTheSixthLoan()',
  '    {',
  '    }',
  '}',
  '',
].join('\n');

const CODE_INDEX: FileIndex = {
  file: 'src/Lending/Loan.ts',
  lastModified: 1_700_000_000,
  symbols: [{ symbolId: 'src/Lending/Loan.ts::Loan::class', name: 'Loan', kind: 'class', startLine: 0, endLine: 3 }],
  edges: [],
  intent: [],
  antiPatterns: [],
};

const TEST_INDEX: FileIndex = {
  file: TEST_FILE,
  lastModified: 1_700_000_000,
  symbols: [
    { symbolId: `${TEST_FILE}::LoanLimitTests::class`, name: 'LoanLimitTests', kind: 'class', startLine: 0, endLine: 7 },
    {
      symbolId: TEST_METHOD,
      name: 'LoanLimitTests.RejectsTheSixthLoan',
      kind: 'method',
      startLine: 2,
      endLine: 6,
      annotations: [{ name: 'Fact' }, { name: 'Trait', args: ['Rule', 'LEND-03'] }],
    },
  ],
  edges: [],
  intent: [],
  antiPatterns: [],
} as FileIndex;

let root: string;
let ctxoRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctxo-domain-tools-'));
  ctxoRoot = join(root, '.ctxo');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function write(path: string, text: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, 'utf-8');
}

function touch(path: string, seconds = 10): void {
  const stat = statSync(path);
  const next = new Date(stat.mtimeMs - seconds * 1000);
  utimesSync(path, next, next);
}

const newHost = (cliVersion = '0.0.0'): CtxoHost => createModuleHost({ cliVersion, mode: 'mcp', projectRoot: root });

async function setUp(): Promise<void> {
  write('.ctxo/index/src/Lending/Loan.ts.json', JSON.stringify(CODE_INDEX, null, 2));
  write(`.ctxo/index/${TEST_FILE}.json`, JSON.stringify(TEST_INDEX, null, 2));
  write('src/Lending/Loan.ts', 'export class Loan {}\n');
  write(TEST_FILE, TEST_TEXT);
  write('docs/domain/contexts.yaml', REGISTRY);
  write('docs/domain/lending/domain.md', CARD);
  const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: root });
  const { services } = host;
  const indices = services.readIndex(ctxoRoot);
  const config = services.loadConfig(ctxoRoot).config;
  const ctx: IndexPassContext = {
    projectRoot: root,
    ctxoRoot,
    config,
    indices,
    graph: () => services.buildGraph(indices),
    isTestFile: services.createTestFileCheck(config, indices),
  };
  await domainIndexPass(host)(ctx);
  // Older than the racy window, so the state caches its stamps.
  for (const path of ['docs/domain/contexts.yaml', 'docs/domain/lending/domain.md', '.ctxo/index/domain/graph.json']) touch(join(root, path));
}

function tools(host = newHost()): Map<string, ModuleToolDefinition> {
  return new Map(domainTools(host, createDomainState(host)).map((tool) => [tool.name, tool]));
}

type Obj = Record<string, unknown>;

async function call(tool: ModuleToolDefinition | undefined, args: Obj): Promise<Obj> {
  return (await tool!.handler(args)) as Obj;
}

describe('domain tools', () => {
  it('names the two tools with their descriptions', () => {
    const all = domainTools(newHost(), createDomainState(newHost()));

    expect(all.map((tool) => tool.name)).toEqual([GET_DOMAIN_CONTEXT, GET_RULE]);
    expect(GET_DOMAIN_CONTEXT).toBe('get_domain_context');
    expect(GET_RULE).toBe('get_rule');
    expect(all[0]!.description).toBe(
      'Get the domain card of the named context that owns a symbol or file: the context (id, name, rung, card), its Language terms, its rules with linked tests and code, boundary contracts, decisions with provenance, and open questions. Use this BEFORE changing code in a named context, or to learn the business rules behind it. Pass symbolId or path; with neither, it lists every context. Large results are truncated with _meta.hint. For one rule and its tests, use get_rule. Needs a domain registry (docs/domain/contexts.yaml).',
    );
    expect(all[1]!.description).toBe(
      'Get one domain rule by ID (for example LEND-03): its text, context and card, the tests linked to it with the source of each link (test annotations, test names, rule comments, the card\'s Tests: line), the symbols that implement it, and the decisions and provenance that mention it. Use this when a change may affect a business rule, or to find the tests that pin it. For a whole context, use get_domain_context.',
    );
  });

  it('register adds the four domain tools whenever the module is loaded', async () => {
    const registration = await register(newHost(domainVersion()));
    const names: string[] = [];
    registration!.registerTools!({ registerTool: (tool) => names.push(tool.name) });

    // The two PR 3 tools, then the two loop tools (W12): 14 core tools plus these give 18.
    expect(names).toEqual(['get_domain_context', 'get_rule', 'find_shadow_specs', 'get_context_map']);
  });

  it('get_domain_context answers by symbolId, by path and with neither', async () => {
    await setUp();
    const tool = tools().get(GET_DOMAIN_CONTEXT);

    const bySymbol = await call(tool, { symbolId: 'src/Lending/Loan.ts::Loan::class' });
    expect(bySymbol['context']).toMatchObject({ id: 'lending', name: 'Lending', rung: 'bounded', card: 'docs/domain/lending/domain.md' });
    expect((bySymbol['rules'] as Obj[]).map((r) => r['ruleId'])).toEqual(['LEND-03']);

    for (const path of ['src/Lending/Loan.ts', '.\\src\\Lending\\Loan.ts', './src/Lending/Loan.ts', join(root, 'src', 'Lending', 'Loan.ts'), 'docs/domain/lending/domain.md']) {
      expect(await call(tool, { path }), path).toEqual(bySymbol);
    }
    expect(await call(tool, { path: 'README.md' })).toEqual({ found: false, hint: 'No named context owns README.md.' });

    const overview = await call(tool, {});
    expect((overview['contexts'] as Obj[]).map((c) => c['id'])).toEqual(['lending', 'billing']);
    expect((overview['contexts'] as Obj[])[0]).toMatchObject({ ruleCount: 1, rulesWithTests: 1, termCount: 1, decisionCount: 0 });
  });

  it('symbolId wins over path', async () => {
    await setUp();
    const tool = tools().get(GET_DOMAIN_CONTEXT);

    // The symbol need not exist: its file part selects the context.
    const view = await call(tool, { symbolId: 'src/Billing/Invoice.ts::Nope::function', path: 'src/Lending/Loan.ts' });
    expect(view['context']).toMatchObject({ id: 'billing' });
    expect(await call(tool, { symbolId: 'dbo.loans::table' })).toEqual({
      found: false,
      hint: 'dbo.loans::table names no file; pass a symbol ID of the form file::name::kind, or a path.',
    });
  });

  it('get_rule accepts LEND03, lend_03 and the rule:LEND-03 id of a domain-scope hit (I3)', async () => {
    await setUp();
    const tool = tools().get(GET_RULE);

    const canonical = await call(tool, { ruleId: 'LEND-03' });
    expect(canonical['rule']).toMatchObject({ ruleId: 'LEND-03', text: 'Five is the limit.', context: { id: 'lending', name: 'Lending', rung: 'bounded' } });
    for (const raw of ['LEND03', 'lend_03', 'Lend03', ' lend-03 ', 'rule:LEND-03']) expect(await call(tool, { ruleId: raw }), raw).toEqual(canonical);
  });

  it('get_rule returns the Trait-linked test with source annotation and the card Tests: link', async () => {
    await setUp();
    const view = await call(tools().get(GET_RULE), { ruleId: 'LEND-03' });

    const tests = view['tests'] as Obj[];
    expect(tests).toHaveLength(1);
    expect(tests[0]).toMatchObject({ file: TEST_FILE, symbolId: TEST_METHOD, testName: 'LoanLimitTests.RejectsTheSixthLoan' });
    const sources = tests[0]!['sources'] as Obj[];
    expect(sources.find((s) => s['source'] === 'annotation')).toEqual({ source: 'annotation', annotation: 'Trait', file: TEST_FILE, line: 3 });
    expect(sources.find((s) => s['source'] === 'card-tests')).toEqual({ source: 'card-tests', file: 'docs/domain/lending/domain.md', line: 8 });
    expect(view['symbols']).toEqual([{ file: 'src/Lending/Loan.ts', sources: [{ source: 'card-code', file: 'docs/domain/lending/domain.md', line: 9 }] }]);
  });

  it('an unknown rule gives a graceful hint', async () => {
    await setUp();
    const tool = tools().get(GET_RULE);

    expect(await call(tool, { ruleId: 'LEND-99' })).toEqual({ found: false, hint: 'No rule LEND-99 in any card.' });
    expect(await call(tool, { ruleId: 'not a rule' })).toEqual({ found: false, hint: 'No rule not a rule in any card.' });
  });

  it('no registry gives found false with the hint, never an error', async () => {
    const all = tools();
    const hint = 'No domain registry at docs/domain/contexts.yaml. Create one with "ctxo init --domain".';

    expect(await call(all.get(GET_DOMAIN_CONTEXT), {})).toEqual({ found: false, hint });
    expect(await call(all.get(GET_DOMAIN_CONTEXT), { path: 'src/Lending/Loan.ts' })).toEqual({ found: false, hint });
    expect(await call(all.get(GET_RULE), { ruleId: 'LEND-03' })).toEqual({ found: false, hint });

    // A registry without a graph: the graph hint.
    write('docs/domain/contexts.yaml', REGISTRY);
    expect(await call(all.get(GET_RULE), { ruleId: 'LEND-03' })).toEqual({ found: false, hint: 'No domain graph yet; run "ctxo index".' });
  });

  it('an unexpected failure is an error, not a miss', async () => {
    const throwing = { load: () => { throw new Error('disk on fire'); } };
    const all = new Map(domainTools(newHost(), throwing).map((tool) => [tool.name, tool]));
    const expected = { error: true, message: 'The domain graph could not be read: disk on fire' };

    expect(await call(all.get(GET_DOMAIN_CONTEXT), { path: 'src/Lending/Loan.ts' })).toEqual(expected);
    expect(await call(all.get(GET_RULE), { ruleId: 'LEND-03' })).toEqual(expected);
  });

  it('a path outside the project gets its own hint, and a trailing slash still matches', async () => {
    await setUp();
    const tool = tools().get(GET_DOMAIN_CONTEXT);
    const outside = join(dirname(root), 'elsewhere', 'Loan.ts');

    expect(await call(tool, { path: '../other/Loan.ts' })).toEqual({ found: false, hint: '../other/Loan.ts is outside the project.' });
    expect(await call(tool, { path: '..\\other\\Loan.ts' })).toEqual({ found: false, hint: '..\\other\\Loan.ts is outside the project.' });
    expect(await call(tool, { path: outside })).toEqual({ found: false, hint: `${outside} is outside the project.` });
    expect(await call(tool, { symbolId: '../other/Loan.ts::Loan::class' })).toEqual({ found: false, hint: '../other/Loan.ts is outside the project.' });
    if (process.platform === 'win32') {
      const otherDrive = `${root[0]!.toUpperCase() === 'Z' ? 'Y' : 'Z'}:\\elsewhere\\Loan.ts`;
      expect(await call(tool, { path: otherDrive })).toEqual({ found: false, hint: `${otherDrive} is outside the project.` });
    }

    for (const path of ['src/Lending/', 'src\\Lending\\','./src/Lending//']) {
      expect((await call(tool, { path }))['context'], path).toMatchObject({ id: 'lending' });
    }
  });

  it('get_rule adds stale and the hint after a card edit', async () => {
    await setUp();
    const all = tools();
    const rule = all.get(GET_RULE);

    const fresh = await call(rule, { ruleId: 'LEND-03' });
    expect(fresh['stale']).toBeUndefined();
    expect(fresh['hint']).toBeUndefined();

    write('docs/domain/lending/domain.md', `${CARD}\nAn edit after indexing.\n`);
    touch(join(root, 'docs/domain/lending/domain.md'), 5);

    const stale = await call(rule, { ruleId: 'LEND-03' });
    expect(stale['stale']).toBe(true);
    expect(stale['hint']).toBe(STALE_CARDS_HINT);
    expect(stale['rule']).toEqual(fresh['rule']);
    const context = await call(all.get(GET_DOMAIN_CONTEXT), { path: 'src/Lending/Loan.ts' });
    expect(context['stale']).toBe(true);
    expect(context['hint']).toBe(STALE_CARDS_HINT);
  });

  it('the same call twice gives identical payloads', async () => {
    await setUp();
    const first = tools();
    const second = tools();

    for (const [name, args] of [
      [GET_DOMAIN_CONTEXT, {}],
      [GET_DOMAIN_CONTEXT, { path: 'src/Lending/Loan.ts' }],
      [GET_RULE, { ruleId: 'LEND-03' }],
    ] as const) {
      const a = JSON.stringify(await call(first.get(name), args));
      expect(JSON.stringify(await call(first.get(name), args))).toBe(a);
      expect(JSON.stringify(await call(second.get(name), args))).toBe(a);
    }
  });

  it('input schemas are built with the host\'s zod', () => {
    const calls: string[] = [];
    const chain = (label: string): Obj =>
      new Proxy(
        {},
        {
          get: (_target, prop) => (...args: unknown[]) => {
            calls.push(`${label}.${String(prop)}(${args.map((a) => JSON.stringify(a)).join(',')})`);
            return chain(label);
          },
        },
      );
    const zod = new Proxy({}, { get: (_target, prop) => () => chain(String(prop)) }) as never;

    const all = domainTools(newHost(), createDomainState(newHost()));
    expect(Object.keys(all[0]!.inputSchema(zod))).toEqual(['symbolId', 'path']);
    expect(Object.keys(all[1]!.inputSchema(zod))).toEqual(['ruleId']);
    expect(calls).toEqual([
      'string.optional()',
      'string.describe("Symbol ID (format: file::name::kind); its file selects the context")',
      'string.optional()',
      'string.describe("Repo-relative file path, or a context\'s card path")',
      'string.min(1)',
      'string.describe("Rule ID as written in the card, e.g. LEND-03 (LEND03, Lend03, lend_03 and a domain-scope hit id such as rule:LEND-03 also match)")',
    ]);
  });
});
