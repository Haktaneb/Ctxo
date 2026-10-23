import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from 'ts-morph';
import type { GraphEdge } from '@ctxo/plugin-api';
import { TsMorphAdapter } from '../ts-morph-adapter.js';
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
