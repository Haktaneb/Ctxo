import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createModuleHost, type FileIndex } from '@ctxo/cli/internal';
import {
  discoverConventions,
  EXTERNAL_ID_FAMILIES,
  EXTERNAL_ID_NOTE,
  formatDiscovery,
  proposalAddsSomething,
  type DiscoveryInput,
} from '../discovery.js';
import { DEFAULT_DOMAIN_CONFIG, type DomainConfig } from '../domain-config.js';

/** Issue #191: tracker kinds, GitHub issues, other identifiers and test-kind markers beyond folders. */

const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: process.cwd() });

type Annotation = { name: string; args?: string[] };

function index(file: string, methods: Annotation[][], classAnnotations: Annotation[] = []): FileIndex {
  return {
    file,
    lastModified: 1,
    symbols: [
      {
        symbolId: `${file}::C::class`,
        name: 'C',
        kind: 'class',
        startLine: 0,
        endLine: 100,
        ...(classAnnotations.length > 0 ? { annotations: classAnnotations } : {}),
      },
      ...methods.map((annotations, i) => ({
        symbolId: `${file}::C.M${i}::method`,
        name: `M${i}`,
        kind: 'method',
        startLine: i + 1,
        endLine: i + 1,
        ...(annotations.length > 0 ? { annotations } : {}),
      })),
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

const times = (n: number, make: (i: number) => string): string[] => Array.from({ length: n }, (_, i) => make(i));

describe('external ID families', () => {
  it('lists at least CWE, CVE, ADR, RFC, ISO, GHSA and OWASP in one constant', () => {
    for (const family of ['CWE', 'CVE', 'ADR', 'RFC', 'ISO', 'GHSA', 'OWASP']) expect(EXTERNAL_ID_FAMILIES).toContain(family);
  });

  it('reports CWE and ADR keys as external IDs, not as tracker keys, and proposes them to keep them from linking', () => {
    const { evidence, proposal } = discoverConventions(
      input({
        commitSubjects: [
          ...times(6, (i) => `fix: path traversal (CWE-${22 + i})`),
          'docs: ADR-017 data coupling',
          ...times(5, (i) => `LEND-${i + 1} hold expiry`),
        ],
      }),
    );
    expect(evidence.trackerKeys).toEqual([{ prefix: 'LEND', occurrences: 5, overlapsRulePrefix: false }]);
    expect(evidence.externalIds).toEqual([
      { prefix: 'CWE', occurrences: 6, note: EXTERNAL_ID_NOTE },
      { prefix: 'ADR', occurrences: 1, note: EXTERNAL_ID_NOTE },
    ]);
    expect(EXTERNAL_ID_NOTE).toBe('external IDs, kept from linking');
    expect(proposal.trackerPrefixes).toEqual(['ADR', 'CWE', 'LEND']);
    expect(proposal.externalIdPrefixes).toEqual(['ADR', 'CWE']);
  });

  it('a real tracker prefix still needs five subjects or branches', () => {
    const { proposal } = discoverConventions(input({ commitSubjects: times(4, (i) => `OPS-${i} tune`) }));
    expect(proposal.trackerPrefixes).toEqual([]);
    expect(proposal.externalIdPrefixes).toEqual([]);
  });

  it('prints external IDs with their label', () => {
    const { evidence, proposal } = discoverConventions(input({ commitSubjects: times(2, (i) => `CVE-2026-${1000 + i} patch`) }));
    const text = formatDiscovery(evidence, proposal, DEFAULT_DOMAIN_CONFIG);
    expect(text).toContain(`${'  external IDs:'.padEnd(22)}CVE in 2 commit subjects/branches   <- external IDs, kept from linking`);
    expect(text).toContain(`${'  tracker-like keys:'.padEnd(22)}none`);
  });
});

describe('GitHub issues (#N)', () => {
  it('counts #N in subjects, (#N) squash suffixes and type/N-slug branches', () => {
    const { evidence } = discoverConventions(
      input({
        commitSubjects: ['feat: holds (#164)', 'fix #12 overdue fees', 'Merge pull request #189 from someone/branch', 'chore: tidy', 'colour &#35;1 entity'],
        localBranches: ['feat/164-holds', 'fix/12-overdue-fees', 'release/2026-05', 'main'],
        remoteBranches: ['origin/feat/164-holds', 'origin/docs/201-site'],
      }),
    );
    expect(evidence.githubIssues).toEqual({ subjects: 3, squashSuffixes: 1, branches: 3 });
  });

  it('prints the GitHub tracker line when present and leaves it out otherwise', () => {
    const found = discoverConventions(input({ commitSubjects: ['feat: holds (#164)'], localBranches: ['feat/164-holds'] }));
    expect(formatDiscovery(found.evidence, found.proposal, DEFAULT_DOMAIN_CONFIG)).toContain(
      `${'  GitHub issues (#N):'.padEnd(22)}1 subjects, 1 branches`,
    );
    const none = discoverConventions(input());
    expect(none.evidence.githubIssues).toEqual({ subjects: 0, squashSuffixes: 0, branches: 0 });
    expect(formatDiscovery(none.evidence, none.proposal, DEFAULT_DOMAIN_CONFIG)).not.toContain('GitHub issues');
  });

  it('proposes no config key for them', () => {
    const { proposal } = discoverConventions(input({ commitSubjects: times(10, (i) => `fix (#${i + 1})`) }));
    expect(proposal.trackerPrefixes).toEqual([]);
    expect(proposalAddsSomething(proposal, DEFAULT_DOMAIN_CONFIG, [])).toBe(false);
  });
});

describe('other identifiers', () => {
  it('reports lowercase name-NN branch families seen in at least three branches, and proposes nothing', () => {
    const { evidence, proposal } = discoverConventions(
      input({
        localBranches: ['fix/acme-12', 'fix/acme-14-login', 'acme-15', 'fix/zeta-1', 'fix/zeta-2', 'deps/lib-1.2.3', 'deps/lib-1.4.0', 'deps/lib-2.0.0'],
        remoteBranches: ['origin/fix/acme-12'],
      }),
    );
    expect(evidence.otherIdentifiers).toEqual([{ prefix: 'acme', branches: 3 }]);
    expect(proposal.trackerPrefixes).toEqual([]);
    const text = formatDiscovery(evidence, proposal, DEFAULT_DOMAIN_CONFIG);
    expect(text).toContain(`${'  other identifiers:'.padEnd(22)}acme-NN in 3 branches   <- not a tracker key; not proposed`);
  });
});

describe('test-kind markers beyond folders', () => {
  const contractFile = index(
    'tests/Storage.Tests/BlobStoreContractTests.cs',
    [[{ name: 'StorageContractFact' }], [{ name: 'StorageContractTheory' }], [{ name: 'StorageContractFact' }]],
    [{ name: 'Trait', args: ['Category', 'StorageContract'] }],
  );
  const characterizationFile = index('tests/Lending.Tests/FeeCharacterizationTests.cs', [
    [{ name: 'Fact' }, { name: 'Category', args: ['FeeCharacterization'] }],
  ]);
  const plain = index('tests/Lending.Tests/LoanTests.cs', [[{ name: 'Fact' }, { name: 'Trait', args: ['Category', 'Slow'] }]]);
  const trackedFiles = [contractFile.file, characterizationFile.file, plain.file, 'src/Storage/BlobStore.cs'];

  it('reports Trait and Category values, custom attributes and file-name patterns per kind', () => {
    const { evidence } = discoverConventions(input({ indices: [contractFile, characterizationFile, plain], trackedFiles }));
    expect(evidence.testKindMarkers).toEqual({
      characterization: {
        annotationValues: [{ matcher: 'Category:FeeCharacterization', count: 1 }],
        attributes: [],
        fileNames: [{ glob: '**/*CharacterizationTests.cs', files: 1 }],
      },
      contract: {
        annotationValues: [{ matcher: 'Trait:Category=StorageContract', count: 1 }],
        attributes: [
          { name: 'StorageContractFact', count: 2 },
          { name: 'StorageContractTheory', count: 1 },
        ],
        fileNames: [{ glob: '**/*ContractTests.cs', files: 1 }],
      },
    });
  });

  it('proposes annotations and file-name globs as paths, keeping folder proposals', () => {
    const { proposal } = discoverConventions(
      input({ indices: [contractFile, characterizationFile, plain], trackedFiles: [...trackedFiles, 'tests/Contracts/X.cs'] }),
    );
    expect(proposal.contractAnnotations).toEqual(['StorageContractFact', 'StorageContractTheory', 'Trait:Category=StorageContract']);
    expect(proposal.characterizationAnnotations).toEqual(['Category:FeeCharacterization']);
    expect(proposal.contractPaths).toEqual(['**/*ContractTests.cs', 'tests/Contracts/**']);
    expect(proposal.characterizationPaths).toEqual(['**/*CharacterizationTests.cs']);
    expect(proposalAddsSomething(proposal, DEFAULT_DOMAIN_CONFIG, [])).toBe(true);
  });

  it('proposes nothing the configured convention already matches', () => {
    const config: DomainConfig = {
      ...DEFAULT_DOMAIN_CONFIG,
      tests: {
        ...DEFAULT_DOMAIN_CONFIG.tests,
        contract: {
          annotations: ['Trait:Kind=Contract', 'Trait:category=storagecontract', 'StorageContractFact', 'StorageContractTheory'],
          paths: ['**/*ContractTests.cs'],
          names: [],
        },
      },
    };
    const kindFile = index('tests/Storage.Tests/KindTests.cs', [[{ name: 'Fact' }, { name: 'Trait', args: ['Kind', 'Contract'] }]]);
    const { evidence, proposal } = discoverConventions(input({ config, indices: [contractFile, kindFile], trackedFiles: [contractFile.file] }));
    expect(evidence.testKindMarkers.contract.annotationValues).toEqual([
      { matcher: 'Trait:Category=StorageContract', count: 1 },
      { matcher: 'Trait:Kind=Contract', count: 1 },
    ]);
    expect(proposal.contractAnnotations).toEqual([]);
    expect(proposal.contractPaths).toEqual([]);
  });

  it('reads custom attributes in files outside the test globs, but values only in test files', () => {
    const outside = index('src/Storage/Probe.cs', [[{ name: 'StorageContractFact' }, { name: 'Trait', args: ['Category', 'OtherContract'] }]]);
    const { evidence } = discoverConventions(input({ indices: [outside] }));
    expect(evidence.testKindMarkers.contract.attributes).toEqual([{ name: 'StorageContractFact', count: 1 }]);
    // The custom test attribute makes the file a test file, so its Trait value counts too.
    expect(evidence.testKindMarkers.contract.annotationValues).toEqual([{ matcher: 'Trait:Category=OtherContract', count: 1 }]);
    const prod = index('src/Storage/Prod.cs', [[{ name: 'Trait', args: ['Category', 'ProdContract'] }]]);
    expect(discoverConventions(input({ indices: [prod] })).evidence.testKindMarkers.contract.annotationValues).toEqual([]);
  });

  it('prints the markers and a proposed config block that parses to the configured values plus the new ones', () => {
    const { evidence, proposal } = discoverConventions(input({ indices: [contractFile, characterizationFile], trackedFiles }));
    const text = formatDiscovery(evidence, proposal, DEFAULT_DOMAIN_CONFIG);
    expect(text).toContain('Test kind markers');
    expect(text).toContain('Trait:Category=StorageContract   <- not covered by domain.tests.contract.annotations');
    expect(text).toContain('**/*ContractTests.cs   <- not covered by domain.tests.contract.paths');
    const block = text.slice(text.indexOf('Proposed config (.ctxo/config.yaml)\n') + 'Proposed config (.ctxo/config.yaml)\n'.length);
    const parsed = parseYaml(block) as {
      domain: { tests: { contract: { annotations: string[]; paths: string[] }; characterization: { annotations: string[]; paths: string[] } } };
    };
    expect(parsed.domain.tests.contract.annotations).toEqual([...DEFAULT_DOMAIN_CONFIG.tests.contract.annotations, ...proposal.contractAnnotations]);
    expect(parsed.domain.tests.contract.paths).toEqual([...DEFAULT_DOMAIN_CONFIG.tests.contract.paths, ...proposal.contractPaths]);
    expect(parsed.domain.tests.characterization.annotations).toEqual([
      ...DEFAULT_DOMAIN_CONFIG.tests.characterization.annotations,
      ...proposal.characterizationAnnotations,
    ]);
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });

  it('says so when no marker beyond folders is found', () => {
    const { evidence, proposal } = discoverConventions(input({ indices: [plain], trackedFiles: [plain.file] }));
    expect(formatDiscovery(evidence, proposal, DEFAULT_DOMAIN_CONFIG)).toContain(`${'Test kind markers'.padEnd(22)}none beyond folders`);
  });
});
