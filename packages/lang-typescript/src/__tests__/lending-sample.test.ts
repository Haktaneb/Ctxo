import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from 'ts-morph';
import type { GraphEdge } from '@ctxo/plugin-api';
import { TsMorphAdapter } from '../ts-morph-adapter.js';
import { DEFAULT_FACT_OPTIONS } from '../facts/fact-options.js';
import { readLendingSample, writeLendingSample } from './helpers/lending-sample.js';

describe('lending sample decorators', () => {
  it('the entity and the controller carry their decorators', async () => {
    const adapter = new TsMorphAdapter();
    const files = readLendingSample();

    const entity = await adapter.extractSymbols('src/loan.entity.ts', files.get('src/loan.entity.ts')!);
    const loan = entity.find((s) => s.name === 'Loan');
    expect(loan?.annotations).toEqual([
      { name: 'Entity', args: ['loans'] },
      { name: 'PrimaryGeneratedColumn', named: { member: 'id' } },
      { name: 'Column', named: { member: 'memberId', name: 'member_id' } },
    ]);
    expect(entity.some((s) => s.name === 'Loan.memberId' || s.name === 'Loan.note')).toBe(false);

    const controller = await adapter.extractSymbols('src/loan.controller.ts', files.get('src/loan.controller.ts')!);
    expect(controller.find((s) => s.name === 'LoanController')?.annotations).toEqual([
      { name: 'Controller', args: ['loans'] },
    ]);
    expect(controller.find((s) => s.name === 'LoanController.find')?.annotations).toEqual([
      { name: 'Get', args: [':id'] },
      { name: 'HttpCode' },
    ]);
  });
});

describe('lending sample test blocks', () => {
  it('the policy test yields test-block symbols with calls into the sample', async () => {
    const files = readLendingSample();
    const testFile = 'src/__tests__/loan-policy.test.ts';
    const adapter = new TsMorphAdapter();

    const policy = await adapter.extractSymbols('src/loan-policy.ts', files.get('src/loan-policy.ts')!);
    const blocks = await adapter.extractSymbols(testFile, files.get(testFile)!);

    expect(blocks.map((s) => s.name)).toEqual([
      'LoanPolicy',
      'LoanPolicy > LEND-03 a member holds at most five loans',
      'LoanPolicy > renewal',
      'LoanPolicy > renewal > extends by seven days',
    ]);
    expect(blocks.every((s) => s.kind === 'function' && s.annotations?.[0]?.name === 'test')).toBe(true);

    adapter.loadProjectSources(files);
    const edges = await adapter.extractEdges(testFile, files.get(testFile)!);
    const policyIds = new Set(policy.map((s) => s.symbolId));
    const blockIds = new Set(blocks.map((s) => s.symbolId));
    const calls = edges.filter((e) => e.kind === 'calls' && blockIds.has(e.from));

    expect(calls).toEqual([
      {
        from: `${testFile}::LoanPolicy > LEND-03 a member holds at most five loans::function`,
        to: 'src/loan-policy.ts::canBorrow::function',
        kind: 'calls',
      },
      {
        from: `${testFile}::LoanPolicy > renewal > extends by seven days::function`,
        to: 'src/loan-policy.ts::renewalDue::function',
        kind: 'calls',
      },
    ]);
    expect(calls.every((e) => policyIds.has(e.to))).toBe(true);
    expect(edges).toContainEqual({
      from: `${testFile}::LoanPolicy > LEND-03 a member holds at most five loans::function`,
      to: 'src/loan-policy.ts::MAX_LOANS::variable',
      kind: 'uses',
    });
  });
});

describe('lending sample SQL call sites', () => {
  const REPOSITORY = 'src/loan.repository.ts';
  const method = (name: string): string => `${REPOSITORY}::LoanRepository.${name}::method`;
  const EXPECTED: GraphEdge[] = [
    { from: method('active'), to: 'dbo.loans::table', kind: 'reads' },
    { from: method('active'), to: 'dbo.members::table', kind: 'reads' },
    { from: method('archive'), to: 'dbo.loans::table', kind: 'reads' },
    { from: method('archive'), to: 'dbo.loanarchive::table', kind: 'writes' },
    { from: method('close'), to: 'dbo.usp_closeloan::procedure', kind: 'executes' },
  ];

  const dataEdges = (edges: GraphEdge[]): GraphEdge[] =>
    edges.filter((e) => e.kind === 'reads' || e.kind === 'writes' || e.kind === 'executes');
  /** The files the adapter's in-memory project holds (the test reaches the private field on purpose). */
  const projectFiles = (adapter: TsMorphAdapter): string[] =>
    (adapter as unknown as { project: Project }).project
      .getSourceFiles()
      .map((f) => f.getFilePath())
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  it('repository methods read, write and execute as in the sample table', async () => {
    const files = readLendingSample();
    const adapter = new TsMorphAdapter({ sqlCallSites: true });
    adapter.loadProjectSources(files);

    const edges = await adapter.extractEdges(REPOSITORY, files.get(REPOSITORY)!);

    expect(dataEdges(edges)).toEqual(EXPECTED);
    // byMember interpolates a parameter: counted as non-constant, no edge.
    expect(dataEdges(edges).some((e) => e.from === method('byMember'))).toBe(false);
    expect(adapter.getSqlStats()).toEqual({ constant: 3, nonConstant: 1 });
  });

  it('a run with only the repository preloaded gives the same SQL edges', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ctxo-lending-sql-'));
    try {
      writeLendingSample(tmp);
      const source = readLendingSample().get(REPOSITORY)!;

      // The post-commit hook and --files preload only the touched files.
      const partial = new TsMorphAdapter({ sqlCallSites: true, projectRoot: tmp });
      partial.loadProjectSources(new Map([[REPOSITORY, source]]));
      expect(dataEdges(await partial.extractEdges(REPOSITORY, source))).toEqual(EXPECTED);
      expect(projectFiles(partial)).toEqual([`/${REPOSITORY}`]);

      // Watch preloads nothing.
      const watch = new TsMorphAdapter({ sqlCallSites: true, projectRoot: tmp });
      expect(dataEdges(await watch.extractEdges(REPOSITORY, source))).toEqual(EXPECTED);
      expect(projectFiles(watch)).toEqual([]);

      // Without projectRoot the imported pool and SQL constant cannot resolve.
      const blind = new TsMorphAdapter({ sqlCallSites: true });
      blind.loadProjectSources(new Map([[REPOSITORY, source]]));
      const blindEdges = dataEdges(await blind.extractEdges(REPOSITORY, source));
      expect(blindEdges.filter((e) => e.from === method('active'))).toEqual([]);
      expect(blindEdges).toEqual([{ from: method('close'), to: 'dbo.usp_closeloan::procedure', kind: 'executes' }]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('lending sample facts', () => {
  const RULES = 'src/facts/loan-rules.ts';
  const GOLDEN = join(import.meta.dirname, 'fixtures', 'lending-sample-facts-off.golden.json');
  const projectFiles = (adapter: TsMorphAdapter): unknown[] =>
    (adapter as unknown as { project: Project }).project.getSourceFiles();

  it('a run with only loan-rules.ts preloaded gives the same facts', async () => {
    const files = readLendingSample();
    const source = files.get(RULES)!;
    const full = new TsMorphAdapter({ facts: DEFAULT_FACT_OPTIONS });
    full.loadProjectSources(files);
    const expected = await full.extractFacts(RULES, source);
    expect(expected.length).toBeGreaterThan(0);

    const tmp = mkdtempSync(join(tmpdir(), 'ctxo-lending-facts-'));
    try {
      writeLendingSample(tmp);
      const partial = new TsMorphAdapter({ facts: DEFAULT_FACT_OPTIONS, projectRoot: tmp });
      partial.loadProjectSources(new Map([[RULES, source]]));
      expect(await partial.extractFacts(RULES, source)).toEqual(expected);

      const watch = new TsMorphAdapter({ facts: DEFAULT_FACT_OPTIONS, projectRoot: tmp });
      expect(await watch.extractFacts(RULES, source)).toEqual(expected);
      expect(projectFiles(watch)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('a run with only http.ts and no projectRoot still traces express through the import', async () => {
    const file = 'src/facts/http.ts';
    const source = readLendingSample().get(file)!;
    const watch = new TsMorphAdapter({ facts: DEFAULT_FACT_OPTIONS });
    expect((await watch.extractFacts(file, source)).map((f) => f.text)).toEqual(['GET /holds/:id']);
  });

  it('without facts extractFacts returns [] and leaves the project as it was', async () => {
    const files = readLendingSample();
    const adapter = new TsMorphAdapter();
    expect(adapter.facts).toBeUndefined();
    expect(await adapter.extractFacts(RULES, files.get(RULES)!)).toEqual([]);
    expect(projectFiles(adapter)).toEqual([]);
  });

  it('with facts off or on, symbols, complexity and edges of the pre-facts sample equal the tip golden', async () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf-8')) as Record<string, Record<string, unknown>>;
    const files = new Map([...readLendingSample()].filter(([path]) => Object.prototype.hasOwnProperty.call(golden['default'], path)));
    expect([...files.keys()]).toEqual(Object.keys(golden['default']!));

    for (const facts of [undefined, DEFAULT_FACT_OPTIONS]) {
      for (const sqlCallSites of [false, true]) {
        const adapter = new TsMorphAdapter({ sqlCallSites, ...(facts ? { facts } : {}) });
        const perFile: Record<string, { symbols: unknown; complexity: unknown; edges?: unknown }> = {};
        for (const [path, source] of files) {
          perFile[path] = { symbols: await adapter.extractSymbols(path, source), complexity: await adapter.extractComplexity(path, source) };
        }
        adapter.loadProjectSources(files);
        for (const [path, source] of files) perFile[path]!.edges = await adapter.extractEdges(path, source);
        adapter.clearProjectSources();
        expect(JSON.stringify(perFile, null, 2)).toBe(JSON.stringify(golden[sqlCallSites ? 'sqlCallSites' : 'default'], null, 2));
      }
    }
  });
});
