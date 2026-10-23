import { describe, expect, it } from 'vitest';
import type { FileIndex } from '@ctxo/cli/internal';
import { parseCard } from '../card-parser.js';
import { discoverConventions, formatDiscovery, proposalAddsSomething, type DiscoveryInput } from '../discovery.js';
import { DEFAULT_DOMAIN_CONFIG } from '../domain-config.js';
import { parseRegistry } from '../registry.js';

const CARD = `# Lending

## Rules and invariants
### LEND-01 A member holds at most five loans
Untested: manual
### LEND-02 A hold expires
Untested: manual
`;

const BILL_CARD = `# Billing

## Rules and invariants
### BILL-01 Invoices are immutable
Untested: manual
`;

function index(file: string, annotations: { name: string; args?: string[] }[] = []): FileIndex {
  return {
    file,
    lastModified: 1,
    symbols: [
      {
        symbolId: `${file}::T::method`,
        name: 'T',
        kind: 'method',
        startLine: 0,
        endLine: 1,
        ...(annotations.length > 0 ? { annotations } : {}),
      },
    ],
    edges: [],
    intent: [],
    antiPatterns: [],
  } as FileIndex;
}

function input(overrides: Partial<DiscoveryInput> = {}): DiscoveryInput {
  return {
    cards: [],
    commitSubjects: [],
    branches: [],
    indices: [],
    trackedFiles: [],
    isPathTestFile: (path) => /\.Tests\//.test(path),
    config: DEFAULT_DOMAIN_CONFIG,
    indexTests: [],
    testFrameworkAnnotations: ['Fact', 'Theory', 'Test', 'TestMethod'],
    ...overrides,
  };
}

const subjects = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}-${100 + i} fix thing`);

describe('discoverConventions', () => {
  it('proposes trackerPrefixes [LEND] from five commit subjects', () => {
    const { evidence, proposal } = discoverConventions(input({ commitSubjects: subjects('LEND', 5) }));
    expect(evidence.trackerKeys).toEqual([{ prefix: 'LEND', occurrences: 5, overlapsRulePrefix: false }]);
    expect(proposal.trackerPrefixes).toEqual(['LEND']);
  });

  it('four occurrences are not enough', () => {
    const { evidence, proposal } = discoverConventions(input({ commitSubjects: subjects('LEND', 4) }));
    expect(evidence.trackerKeys[0]?.occurrences).toBe(4);
    expect(proposal.trackerPrefixes).toEqual([]);
  });

  it('counts a prefix once per subject, however many keys the subject holds', () => {
    const { evidence } = discoverConventions(input({ commitSubjects: ['LEND-1 LEND-2 LEND-3', 'OPS-1 and LEND-9'] }));
    expect(evidence.trackerKeys).toEqual([
      { prefix: 'LEND', occurrences: 2, overlapsRulePrefix: false },
      { prefix: 'OPS', occurrences: 1, overlapsRulePrefix: false },
    ]);
  });

  it('branch names count', () => {
    const { proposal } = discoverConventions(
      input({ commitSubjects: subjects('OPS', 3), branches: ['feature/OPS-12-thing', 'fix/OPS-13'] }),
    );
    expect(proposal.trackerPrefixes).toEqual(['OPS']);
  });

  it('counts a local branch and its remote-tracking copy once', () => {
    const local = ['feature/OPS-1', 'feature/OPS-2', 'feature/OPS-3'];
    const branches = [...local, ...local.map((b) => `origin/${b}`)];
    const { evidence, proposal } = discoverConventions(input({ branches }));
    expect(evidence.trackerKeys).toEqual([{ prefix: 'OPS', occurrences: 3, overlapsRulePrefix: false }]);
    expect(proposal.trackerPrefixes).toEqual([]);
  });

  it('counts a remote-only branch once, by its name without the remote', () => {
    const branches = ['feature/OPS-1', 'origin/feature/OPS-1', 'origin/OPS-2', 'upstream/OPS-2', 'origin/OPS-3', 'origin/OPS-4', 'origin/OPS-5'];
    const { evidence, proposal } = discoverConventions(input({ branches }));
    expect(evidence.trackerKeys[0]).toEqual({ prefix: 'OPS', occurrences: 5, overlapsRulePrefix: false });
    expect(proposal.trackerPrefixes).toEqual(['OPS']);
  });

  it('unites the proposal with the configured prefixes', () => {
    const config = { ...DEFAULT_DOMAIN_CONFIG, rules: { ...DEFAULT_DOMAIN_CONFIG.rules, trackerPrefixes: ['ZED'] } };
    const { proposal } = discoverConventions(input({ config, commitSubjects: subjects('LEND', 5) }));
    expect(proposal.trackerPrefixes).toEqual(['LEND', 'ZED']);
  });

  it('flags a tracker prefix that overlaps a rule prefix', () => {
    const registry = parseRegistry(
      'version: 1\ncontexts:\n  - id: billing\n    name: Billing\n    paths: ["src/Billing/**"]\n    rung: named\n    rulePrefix: INV\n',
    ).registry;
    const { evidence } = discoverConventions(
      input({
        cards: [parseCard(CARD), parseCard(BILL_CARD)],
        ...(registry !== undefined ? { registry } : {}),
        commitSubjects: [...subjects('LEND', 6), ...subjects('INV', 5), ...subjects('OPS', 2)],
      }),
    );
    expect(evidence.cardPrefixes).toEqual([
      { prefix: 'LEND', rules: 2 },
      { prefix: 'BILL', rules: 1 },
      { prefix: 'INV', rules: 0 },
    ]);
    expect(evidence.trackerKeys).toEqual([
      { prefix: 'LEND', occurrences: 6, overlapsRulePrefix: true },
      { prefix: 'INV', occurrences: 5, overlapsRulePrefix: true },
      { prefix: 'OPS', occurrences: 2, overlapsRulePrefix: false },
    ]);
  });

  it('proposes ruleTraitKeys from Trait keys with ID-like values', () => {
    const indices = [
      index('src/Lending.Tests/A.cs', [{ name: 'Fact' }, { name: 'Trait', args: ['Rule', 'LEND-03'] }]),
      index('src/Lending.Tests/B.cs', [{ name: 'Fact' }, { name: 'Trait', args: ['Category', 'Slow'] }]),
      index('src/Lending.Tests/C.cs', [{ name: 'Fact' }, { name: 'Trait', args: ['Category', 'Fast'] }, { name: 'Trait', args: ['Req', 'REQ-7'] }]),
      index('src/Lending/Prod.cs', [{ name: 'Trait', args: ['Rule', 'LEND-09'] }]),
    ];
    const { evidence, proposal } = discoverConventions(input({ indices }));
    expect(evidence.traitKeys).toEqual([
      { key: 'Category', count: 2, idLikeValues: 0 },
      { key: 'Req', count: 1, idLikeValues: 1 },
      { key: 'Rule', count: 1, idLikeValues: 1 },
    ]);
    expect(proposal.ruleTraitKeys).toEqual(['Req', 'Rule']);
  });

  it('annotated test files outside the path globs become index.tests globs', () => {
    const indices = [
      index('src/Lending.Tests/Ok.cs', [{ name: 'Fact' }]),
      index('spec/Loans/A.cs', [{ name: 'Fact' }]),
      index('spec/Loans/Deep/B.cs', [{ name: 'Test' }]),
      index('spec/Loans/Plain.cs'),
      index('qa/C.cs', [{ name: 'TestMethod' }]),
    ];
    const { evidence, proposal } = discoverConventions(input({ indices }));
    expect(evidence.uncoveredTestFolders).toEqual([
      { folder: 'qa/**', files: 1 },
      { folder: 'spec/Loans/**', files: 2 },
    ]);
    expect(proposal.indexTests).toEqual(['qa/**', 'spec/Loans/**']);
  });

  it('counts provenance, characterization and contract folders', () => {
    const trackedFiles = [
      'docs/adr/adr-001.md',
      'docs/adr/adr-002.MD',
      'docs/adr/notes.txt',
      'docs/Specs/loan.md',
      'docs/rfcs/a/b.md',
      'src/Lending/Characterization/A.cs',
      'src/Lending/Characterization/B.cs',
      'src/Lending/Contracts/I.cs',
      'src/Billing/Contract/J.cs',
      'src/Billing/Contracts.Tests/K.cs',
    ];
    const { evidence } = discoverConventions(input({ trackedFiles }));
    expect(evidence.provenanceFolders).toEqual([
      { folder: 'docs/Specs', files: 1 },
      { folder: 'docs/adr', files: 2 },
      { folder: 'docs/rfcs', files: 1 },
    ]);
    expect(evidence.characterizationFolders).toEqual([{ folder: 'src/Lending/Characterization', files: 2 }]);
    expect(evidence.contractFolders).toEqual([
      { folder: 'src/Billing/Contract', files: 1 },
      { folder: 'src/Billing/Contracts.Tests', files: 1 },
      { folder: 'src/Lending/Contracts', files: 1 },
    ]);
  });
});

describe('formatDiscovery', () => {
  it('matches the spec layout', () => {
    const { evidence, proposal } = discoverConventions(
      input({
        cards: [parseCard(CARD)],
        commitSubjects: [...subjects('LEND', 6), ...subjects('OPS', 2)],
        indices: [index('src/Lending.Tests/A.cs', [{ name: 'Fact' }, { name: 'Trait', args: ['Rule', 'LEND-03'] }])],
        trackedFiles: ['docs/adr/a.md'],
      }),
    );
    const text = formatDiscovery(evidence, proposal);
    for (const label of ['Rule IDs', 'card prefixes:', 'tracker-like keys:', 'Test tagging', 'Test folders', 'Provenance folders', 'Proposed config']) {
      expect(text).toContain(label);
    }
    expect(text).toContain('LEND (2 rules)');
    expect(text).toContain('LEND in 6 commit subjects/branches');
    expect(text).toContain('<- overlaps a rule prefix');
    expect(text).toContain('OPS  in 2 commit subjects/branches');
    expect(text).toContain('Rule (1)');
    expect(text).toContain('docs/adr (1)');
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('proposalAddsSomething', () => {
  it('is false when every proposed value is already configured', () => {
    const { proposal } = discoverConventions(input());
    expect(proposalAddsSomething(proposal, DEFAULT_DOMAIN_CONFIG, [])).toBe(false);
  });

  it('is true for a new prefix, trait key or test glob', () => {
    const base = { trackerPrefixes: [], ruleTraitKeys: ['Rule'], indexTests: [] };
    expect(proposalAddsSomething({ ...base, trackerPrefixes: ['LEND'] }, DEFAULT_DOMAIN_CONFIG, [])).toBe(true);
    expect(proposalAddsSomething({ ...base, ruleTraitKeys: ['Rule', 'Req'] }, DEFAULT_DOMAIN_CONFIG, [])).toBe(true);
    expect(proposalAddsSomething({ ...base, indexTests: ['qa/**'] }, DEFAULT_DOMAIN_CONFIG, [])).toBe(true);
    expect(proposalAddsSomething({ ...base, indexTests: ['qa/**'] }, DEFAULT_DOMAIN_CONFIG, ['qa/**'])).toBe(false);
  });
});
