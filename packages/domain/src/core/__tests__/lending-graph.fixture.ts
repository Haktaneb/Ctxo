import { createModuleHost, type FileIndex } from '@ctxo/cli/internal';
import { parseCard, parseGlossary } from '../card-parser.js';
import { DEFAULT_DOMAIN_CONFIG } from '../domain-config.js';
import { buildDomainGraph, type CardInput, type DomainGraph } from '../domain-graph.js';
import { indexGraph, type DomainSnapshot } from '../domain-graph-query.js';
import { createOwnership } from '../ownership.js';
import { parseRegistry, registryHash, type DomainRegistry } from '../registry.js';
import type { RuleLinks, RuleRef } from '../rule-id-scan.js';

/**
 * A synthetic Lending and Billing graph for the enricher and card excerpt tests: graphs come from
 * `buildDomainGraph`, snapshots from `indexGraph`. Unit-level names (LoanPolicy, MemberHoldsAtMostFiveLoans).
 */

const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: process.cwd() });
const { splitIdentifier: split, dataResourceKinds, makeGlobMatcher } = host.services;

export const REGISTRY_PATH = 'docs/domain/contexts.yaml';
export const GLOSSARY_PATH = 'docs/domain/glossary.md';
export const LENDING_CARD = 'docs/domain/lending/domain.md';
export const BILLING_CARD = 'docs/domain/billing/domain.md';

export const POLICY_FILE = 'src/Lending/LoanPolicy.cs';
export const ROOT = `${POLICY_FILE}::LoanPolicy.CanBorrow::method`;
export const RENEW = `${POLICY_FILE}::LoanPolicy.Renew::method`;
export const FINES_FILE = 'src/Lending/Fines.cs';
export const FINES = `${FINES_FILE}::Fines::class`;
export const CHARGE = `${FINES_FILE}::Fines.Charge::method`;
export const TEST_FILE = 'tests/Lending.Tests/LoanLimitTests.cs';
export const TEST = `${TEST_FILE}::LoanLimitTests.MemberHoldsAtMostFiveLoans::method`;
export const INVOICE_FILE = 'src/Billing/Invoice.cs';
export const SEND = `${INVOICE_FILE}::Invoice.Send::method`;
export const LOOSE = 'src/Loose.cs::Loose::class';

export const REGISTRY_TEXT = `version: 1
contexts:
  - id: lending
    name: Lending
    card: ${LENDING_CARD}
    paths: ["src/Lending/**", "tests/Lending.Tests/**"]
    rung: bounded
    rulePrefix: LEND
    contracts:
      billing: ["src/Billing/Api/**"]
  - id: billing
    name: Billing
    card: ${BILLING_CARD}
    paths: ["src/Billing/**"]
    rung: named
    rulePrefix: BILL
`;

export const LENDING_TEXT = [
  '# Lending',
  '',
  '## Language',
  '- **Loan**: a book lent to a member',
  '- **Member account**: the record of a member',
  '',
  '## Rules and invariants',
  '### LEND-03 A member holds at most five loans',
  `Tests: \`${TEST}\``,
  `Code: \`${ROOT}\``,
  '',
  'Five is the limit.',
  '',
  '### LEND-04 A member with an unpaid fine cannot borrow',
  `Code: \`${FINES_FILE}\``,
  'Untested: covered by manual QA',
  '',
  '### LEND-05 A loan can be renewed twice',
  '',
  '## Boundary contracts',
  'Lending calls Billing only through `src/Billing/Api/`.',
  '',
  '## Decisions',
  '- 2026-09-12: LEND-03: loan limit raised from 3 to 5. [spec](../../specs/loan-limit.md), [ADR-007](../../adr/adr-007-loan-limit.md)',
  '- 2026-01-01: First decision.',
  '- 2026-02-01: Second decision.',
  '- 2026-03-01: Third decision.',
  '- 2026-04-01: Fourth decision.',
  '- 2026-05-01: Fifth decision.',
  '- 2025-01-01: LEND-03 set at three loans.',
  '',
].join('\n');

export const BILLING_TEXT = [
  '# Billing',
  '',
  '## Rules and invariants',
  '### BILL-01 An invoice is sent once',
  `Code: \`${SEND}\``,
  '',
  '## Decisions',
  '- 2026-01-01: Invoices are monthly.',
  '- 2026-02-01: Invoices are sent by mail.',
  '- 2026-03-01: BILL-01 holds for reminders too.',
  '',
].join('\n');

export const GLOSSARY_TEXT = '- **Fine** (context: lending): money owed for a late return\n- **Member**: a patron\n';

function fileIndex(file: string, symbols: [string, string][]): FileIndex {
  return {
    file,
    lastModified: 1,
    symbols: symbols.map(([name, kind], i) => ({
      symbolId: `${file}::${name}::${kind}`,
      name,
      kind,
      startLine: i * 10,
      endLine: i * 10 + 5,
    })) as FileIndex['symbols'],
    edges: [],
    intent: [],
    antiPatterns: [],
  };
}

export const INDICES: FileIndex[] = [
  fileIndex(POLICY_FILE, [
    ['LoanPolicy', 'class'],
    ['LoanPolicy.CanBorrow', 'method'],
    ['LoanPolicy.Renew', 'method'],
  ]),
  fileIndex(FINES_FILE, [
    ['Fines', 'class'],
    ['Fines.Charge', 'method'],
  ]),
  fileIndex(TEST_FILE, [
    ['LoanLimitTests', 'class'],
    ['LoanLimitTests.MemberHoldsAtMostFiveLoans', 'method'],
  ]),
  fileIndex(INVOICE_FILE, [
    ['Invoice', 'class'],
    ['Invoice.Send', 'method'],
  ]),
];

const ref = (over: Partial<RuleRef> & Pick<RuleRef, 'file' | 'line' | 'kind' | 'id'>): RuleRef => ({ raw: over.id, ...over });

function links(refs: readonly RuleRef[]): RuleLinks {
  const map = new Map<string, RuleRef[]>();
  for (const r of refs) map.set(r.id, [...(map.get(r.id) ?? []), r]);
  return { links: map, unknown: [] };
}

export function parsedRegistry(text: string): DomainRegistry {
  const parsed = parseRegistry(text);
  if (parsed.registry === undefined || parsed.problems.length > 0) {
    throw new Error(`fixture registry has problems: ${JSON.stringify(parsed.problems)}`);
  }
  return parsed.registry;
}

export interface FixtureInput {
  readonly registryText: string;
  /** Card path to card text. */
  readonly cards: Readonly<Record<string, string>>;
  readonly glossaryText?: string;
  readonly indices?: readonly FileIndex[];
  readonly codeRefs?: RuleLinks;
}

export const LENDING_FIXTURE: FixtureInput = {
  registryText: REGISTRY_TEXT,
  cards: { [LENDING_CARD]: LENDING_TEXT, [BILLING_CARD]: BILLING_TEXT },
  glossaryText: GLOSSARY_TEXT,
  indices: INDICES,
  codeRefs: links([ref({ id: 'LEND-05', file: POLICY_FILE, line: 19, kind: 'rule-comment', symbolId: RENEW })]),
};

export function buildFixtureGraph(input: FixtureInput = LENDING_FIXTURE): DomainGraph {
  const registry = parsedRegistry(input.registryText);
  const cards: CardInput[] = registry.contexts
    .filter((context) => context.card !== undefined)
    .map((context) => {
      const text = input.cards[context.card!];
      return text === undefined ? { context, path: context.card! } : { context, path: context.card!, card: parseCard(text) };
    });
  const indices = input.indices ?? [];
  const files = new Set(indices.map((index) => index.file));
  return buildDomainGraph({
    registry,
    registryHash: registryHash(input.registryText),
    config: DEFAULT_DOMAIN_CONFIG,
    cards,
    ...(input.glossaryText === undefined ? {} : { glossary: { path: GLOSSARY_PATH, items: parseGlossary(input.glossaryText) } }),
    cardsHash: 'fedcba9876543210',
    indices,
    isTestFile: (path) => path.startsWith('tests/'),
    ownership: createOwnership(registry, makeGlobMatcher),
    testRefs: links([]),
    codeRefs: input.codeRefs ?? links([]),
    fileExists: (path) => files.has(path),
    split,
    dataResourceKinds,
    warn: () => undefined,
  });
}

/** A snapshot without I/O, as `createDomainState` would load it. */
export function fixtureSnapshot(input: FixtureInput = LENDING_FIXTURE): DomainSnapshot {
  const registry = parsedRegistry(input.registryText);
  const graph = buildFixtureGraph(input);
  return {
    registry,
    registryPath: REGISTRY_PATH,
    config: DEFAULT_DOMAIN_CONFIG,
    ownership: createOwnership(registry, makeGlobMatcher),
    graph,
    index: indexGraph(graph),
    staleCards: false,
    generation: 1,
  };
}

/** `count` one-rule contexts `c1`..`c<count>`, each rule linked to `codeSymbol` through its card's `Code:` line. */
export function manyContextsFixture(count: number, codeSymbol: string, indices: readonly FileIndex[]): FixtureInput {
  const lines = ['version: 1', 'contexts:'];
  const cards: Record<string, string> = {};
  for (let i = 1; i <= count; i++) {
    const card = `docs/domain/c${i}/domain.md`;
    lines.push(`  - id: c${i}`, `    name: C${i}`, `    card: ${card}`, `    paths: ["src/c${i}/**"]`, '    rung: named', `    rulePrefix: R${i}`);
    cards[card] = ['# C', '', '## Rules and invariants', `### R${i}-01 Rule ${i}`, `Code: \`${codeSymbol}\``, ''].join('\n');
  }
  return { registryText: `${lines.join('\n')}\n`, cards, indices };
}
