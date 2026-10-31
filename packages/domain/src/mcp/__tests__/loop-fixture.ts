import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createModuleHost, type CtxoHost, type FileIndex, type IndexPassContext } from '@ctxo/cli/internal';
import { domainIndexPass } from '../../index-pass/domain-index-pass.js';

/**
 * A temp project for the loop tools: a registry with two contexts, a Lending card with a tested rule (LEND-03) and
 * an untested one (LEND-04), a LoanPolicy with a literal comparison found by the text scan, and the artifacts of the
 * domain index pass.
 */

export const REGISTRY = `version: 1
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

export const TEST_FILE = 'tests/Lending.Tests/LoanLimitTests.cs';
export const TEST_METHOD = `${TEST_FILE}::LoanLimitTests.RejectsTheSixthLoan::method`;
export const POLICY_FILE = 'src/Lending/LoanPolicy.ts';

export const CARD = [
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
  '### LEND-04 A loan lasts three weeks',
  '',
  'Three weeks, then a fine.',
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

const POLICY_TEXT = [
  'export class LoanPolicy {',
  '  canBorrow(loans: number[]): boolean {',
  '    if (loans.length >= 5) return false;',
  '    return true;',
  '  }',
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

const POLICY_INDEX: FileIndex = {
  file: POLICY_FILE,
  lastModified: 1_700_000_000,
  symbols: [
    { symbolId: `${POLICY_FILE}::LoanPolicy::class`, name: 'LoanPolicy', kind: 'class', startLine: 0, endLine: 5 },
    { symbolId: `${POLICY_FILE}::LoanPolicy.canBorrow::method`, name: 'LoanPolicy.canBorrow', kind: 'method', startLine: 1, endLine: 4 },
  ],
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

export interface LoopProject {
  readonly root: string;
  readonly ctxoRoot: string;
  write(path: string, text: string): void;
  /** Moves the file's mtime `seconds` into the past, out of the racy window. */
  age(path: string, seconds?: number): void;
  host(): CtxoHost;
  /** Writes the sources, runs the domain index pass and ages every input and artifact. */
  index(): Promise<void>;
  dispose(): void;
}

/** The fixture's `.ctxo/config.yaml`: a tracker prefix the fixture never uses, so the conventions are not at their defaults. */
export const FIXTURE_CONFIG = 'version: "1.0"\ndomain:\n  rules:\n    trackerPrefixes: [OPS]\n';

export const ARTIFACTS = ['graph.json', 'contexts.json', 'boundaries.json', 'shadow-candidates.json', 'maturity.json'] as const;

export function createLoopProject(): LoopProject {
  const root = mkdtempSync(join(tmpdir(), 'ctxo-domain-loop-'));
  const ctxoRoot = join(root, '.ctxo');
  const write = (path: string, text: string): void => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, 'utf-8');
  };
  const age = (path: string, seconds = 10): void => {
    const target = join(root, path);
    const next = new Date(statSync(target).mtimeMs - seconds * 1000);
    utimesSync(target, next, next);
  };
  return {
    root,
    ctxoRoot,
    write,
    age,
    host: () => createModuleHost({ cliVersion: '0.0.0', mode: 'mcp', projectRoot: root }),
    async index() {
      write('.ctxo/index/src/Lending/Loan.ts.json', JSON.stringify(CODE_INDEX, null, 2));
      write(`.ctxo/index/${POLICY_FILE}.json`, JSON.stringify(POLICY_INDEX, null, 2));
      write(`.ctxo/index/${TEST_FILE}.json`, JSON.stringify(TEST_INDEX, null, 2));
      write('src/Lending/Loan.ts', 'export class Loan {}\n');
      write(POLICY_FILE, POLICY_TEXT);
      write(TEST_FILE, TEST_TEXT);
      write('docs/domain/contexts.yaml', REGISTRY);
      write('docs/domain/lending/domain.md', CARD);
      // One convention off its default, so get_context_map gives no discover hint (#191); the hint tests replace it.
      write('.ctxo/config.yaml', FIXTURE_CONFIG);
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
      for (const path of ['docs/domain/contexts.yaml', 'docs/domain/lending/domain.md', '.ctxo/config.yaml']) age(path);
      for (const name of ARTIFACTS) age(`.ctxo/index/domain/${name}`);
    },
    dispose: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}
