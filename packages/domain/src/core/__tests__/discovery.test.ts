import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createModuleHost, type FileIndex } from '@ctxo/cli/internal';
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

const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: process.cwd() });

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
    localBranches: [],
    remoteBranches: [],
    indices: [],
    trackedFiles: [],
    isPathTestFile: (path) => /\.Tests\//.test(path),
    config: DEFAULT_DOMAIN_CONFIG,
    indexTests: [],
    testFrameworkAnnotations: ['Fact', 'Theory', 'Test', 'TestMethod'],
    makeGlobMatcher: host.services.makeGlobMatcher,
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
      input({ commitSubjects: subjects('OPS', 3), localBranches: ['feature/OPS-12-thing', 'fix/OPS-13'] }),
    );
    expect(proposal.trackerPrefixes).toEqual(['OPS']);
  });

  it('counts a local branch and its remote-tracking copy once', () => {
    const local = ['feature/OPS-1', 'feature/OPS-2', 'feature/OPS-3'];
    const { evidence, proposal } = discoverConventions(
      input({ localBranches: local, remoteBranches: local.map((b) => `origin/${b}`) }),
    );
    expect(evidence.trackerKeys).toEqual([{ prefix: 'OPS', occurrences: 3, overlapsRulePrefix: false }]);
    expect(proposal.trackerPrefixes).toEqual([]);
  });

  it('counts the same branch on two remotes once, whatever the remotes are called', () => {
    const { evidence } = discoverConventions(input({ remoteBranches: ['fork/OPS-7', 'origin/OPS-7'] }));
    expect(evidence.trackerKeys).toEqual([{ prefix: 'OPS', occurrences: 1, overlapsRulePrefix: false }]);
  });

  it('counts local chore/OPS-12 and OPS-12 as two branches', () => {
    const { evidence } = discoverConventions(input({ localBranches: ['chore/OPS-12', 'OPS-12'] }));
    expect(evidence.trackerKeys).toEqual([{ prefix: 'OPS', occurrences: 2, overlapsRulePrefix: false }]);
  });

  it('keeps a local branch literally named origin/x as it is', () => {
    const { evidence } = discoverConventions(input({ localBranches: ['origin/OPS-1'], remoteBranches: ['origin/OPS-1'] }));
    // local 'origin/OPS-1' and the remote-tracking 'origin/OPS-1' (name 'OPS-1') are two distinct branches
    expect(evidence.trackerKeys).toEqual([{ prefix: 'OPS', occurrences: 2, overlapsRulePrefix: false }]);
  });

  it('counts a remote-only branch once, by its name without the remote', () => {
    const { proposal } = discoverConventions(
      input({
        localBranches: ['feature/OPS-1'],
        remoteBranches: ['origin/feature/OPS-1', 'origin/OPS-2', 'upstream/OPS-2', 'origin/OPS-3', 'origin/OPS-4', 'origin/OPS-5'],
      }),
    );
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

  it('proposes a Contracts folder the default contract paths miss', () => {
    const { proposal } = discoverConventions(input({ trackedFiles: ['tests/Contracts/ChargeTests.cs'] }));
    expect(proposal.contractPaths).toEqual(['tests/Contracts/**']);
    expect(proposal.characterizationPaths).toEqual([]);
    expect(proposalAddsSomething(proposal, DEFAULT_DOMAIN_CONFIG, [])).toBe(true);
  });

  it('covered folders propose nothing', () => {
    const { proposal } = discoverConventions(
      input({ trackedFiles: ['tests/Billing.Tests/Contract/X.cs', 'tests/Lending/Characterization/Y.cs'] }),
    );
    expect(proposal.contractPaths).toEqual([]);
    expect(proposal.characterizationPaths).toEqual([]);
    expect(proposalAddsSomething(proposal, DEFAULT_DOMAIN_CONFIG, [])).toBe(false);
  });

  it('checks the configured globs, not the defaults', () => {
    const config = {
      ...DEFAULT_DOMAIN_CONFIG,
      tests: {
        ...DEFAULT_DOMAIN_CONFIG.tests,
        characterization: { ...DEFAULT_DOMAIN_CONFIG.tests.characterization, paths: ['golden/**'] },
        contract: { ...DEFAULT_DOMAIN_CONFIG.tests.contract, paths: ['tests/Contracts/**'] },
      },
    };
    const { proposal } = discoverConventions(
      input({ config, trackedFiles: ['tests/Contracts/A.cs', 'src/Characterization/B.cs'] }),
    );
    expect(proposal.contractPaths).toEqual([]);
    expect(proposal.characterizationPaths).toEqual(['src/Characterization/**']);
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
    const text = formatDiscovery(evidence, proposal, DEFAULT_DOMAIN_CONFIG);
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

  it('prints uncovered Characterization and Contract folders under the test folders line', () => {
    const { evidence, proposal } = discoverConventions(
      input({ trackedFiles: ['tests/Contracts/ChargeTests.cs', 'src/Golden/Characterization/A.cs'] }),
    );
    const lines = formatDiscovery(evidence, proposal, DEFAULT_DOMAIN_CONFIG).split('\n');
    const at = lines.findIndex((line) => line.startsWith('Test folders'));
    expect(lines[at + 1]).toBe(`${' '.repeat(22)}tests/Contracts/**   <- not covered by domain.tests.contract.paths`);
    expect(lines.some((line) => line.includes('<- not covered by domain.tests.characterization.paths'))).toBe(false);
    expect(lines).toContain('      contract:');
    // The configured globs plus the new ones: the list --write writes, so a hand-pasted block keeps the defaults.
    expect(lines).toContain('        paths: ["**/Contract/**", "**/Contracts.Tests/**", "tests/Contracts/**"]');
    expect(lines.some((line) => line.trim() === 'characterization:')).toBe(false);
  });

  it('prints the configured characterization globs with the new ones, in the order --write keeps', () => {
    const config = {
      ...DEFAULT_DOMAIN_CONFIG,
      tests: {
        ...DEFAULT_DOMAIN_CONFIG.tests,
        characterization: { ...DEFAULT_DOMAIN_CONFIG.tests.characterization, paths: ['zz/**', 'golden/**'] },
      },
    };
    const { evidence, proposal } = discoverConventions(input({ config, trackedFiles: ['src/Characterization/B.cs'] }));
    const lines = formatDiscovery(evidence, proposal, config).split('\n');
    expect(lines).toContain('        paths: ["zz/**", "golden/**", "src/Characterization/**"]');
  });

  it('prints a proposed config block that parses as YAML to the proposal (D-I2)', () => {
    const config = {
      ...DEFAULT_DOMAIN_CONFIG,
      tests: {
        ...DEFAULT_DOMAIN_CONFIG.tests,
        characterization: { ...DEFAULT_DOMAIN_CONFIG.tests.characterization, paths: ['**/Golden/**'] },
      },
    };
    const { evidence, proposal } = discoverConventions(
      input({
        config,
        commitSubjects: [...subjects('LEND', 6)],
        indices: [index('qa/Lending.Specs/A.cs', [{ name: 'Fact' }, { name: 'Trait', args: ['Req', 'LEND-03'] }])],
        trackedFiles: ['src/Characterization/A.cs', 'tests/Contracts/B.cs'],
      }),
    );
    expect(proposal.characterizationPaths.length).toBeGreaterThan(0);
    expect(proposal.contractPaths.length).toBeGreaterThan(0);
    const text = formatDiscovery(evidence, proposal, config);
    const block = text.slice(text.indexOf('Proposed config (.ctxo/config.yaml)\n') + 'Proposed config (.ctxo/config.yaml)\n'.length);
    const parsed = parseYaml(block) as {
      domain: { rules: { trackerPrefixes: string[] }; tests: { ruleTraitKeys: string[]; characterization: { paths: string[] }; contract: { paths: string[] } } };
      index: { tests: string[] };
    };
    expect(parsed.domain.rules.trackerPrefixes).toEqual(proposal.trackerPrefixes);
    expect(parsed.domain.tests.ruleTraitKeys).toEqual(proposal.ruleTraitKeys);
    expect(parsed.domain.tests.characterization.paths).toEqual([...config.tests.characterization.paths, ...proposal.characterizationPaths]);
    expect(parsed.domain.tests.contract.paths).toEqual([...DEFAULT_DOMAIN_CONFIG.tests.contract.paths, ...proposal.contractPaths]);
    expect(parsed.index.tests).toEqual(proposal.indexTests);
  });
});

describe('proposalAddsSomething', () => {
  it('is false when every proposed value is already configured', () => {
    const { proposal } = discoverConventions(input());
    expect(proposalAddsSomething(proposal, DEFAULT_DOMAIN_CONFIG, [])).toBe(false);
  });

  it('is true for a new prefix, trait key or test glob', () => {
    const base = {
      trackerPrefixes: [],
      externalIdPrefixes: [],
      ruleTraitKeys: ['Rule'],
      indexTests: [],
      characterizationPaths: [],
      contractPaths: [],
      characterizationAnnotations: [],
      contractAnnotations: [],
    };
    expect(proposalAddsSomething({ ...base, contractAnnotations: ['StorageContractFact'] }, DEFAULT_DOMAIN_CONFIG, [])).toBe(true);
    expect(proposalAddsSomething({ ...base, characterizationAnnotations: ['Tag:characterization'] }, DEFAULT_DOMAIN_CONFIG, [])).toBe(false);
    expect(proposalAddsSomething({ ...base, trackerPrefixes: ['LEND'] }, DEFAULT_DOMAIN_CONFIG, [])).toBe(true);
    expect(proposalAddsSomething({ ...base, ruleTraitKeys: ['Rule', 'Req'] }, DEFAULT_DOMAIN_CONFIG, [])).toBe(true);
    expect(proposalAddsSomething({ ...base, indexTests: ['qa/**'] }, DEFAULT_DOMAIN_CONFIG, [])).toBe(true);
    expect(proposalAddsSomething({ ...base, indexTests: ['qa/**'] }, DEFAULT_DOMAIN_CONFIG, ['qa/**'])).toBe(false);
  });
});
