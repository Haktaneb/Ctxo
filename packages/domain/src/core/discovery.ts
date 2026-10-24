import type { FileIndex } from '@ctxo/cli/internal';
import type { ParsedCard } from './card-parser.js';
import { DEFAULT_DOMAIN_CONFIG, type DomainConfig } from './domain-config.js';
import type { GlobMatcherFactory } from './ownership.js';
import type { DomainRegistry } from './registry.js';

/** Tracker-like keys: Jira, Linear and YouTrack ids such as `LEND-456`. */
export const TRACKER_KEY_PATTERN = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;
/** Commits and branches a prefix must appear in before it is proposed as a tracker prefix. */
export const TRACKER_PREFIX_MIN = 5;

export interface FolderCount {
  readonly folder: string;
  readonly files: number;
}

export interface DiscoveryEvidence {
  readonly cardPrefixes: readonly { prefix: string; rules: number }[];
  readonly trackerKeys: readonly { prefix: string; occurrences: number; overlapsRulePrefix: boolean }[];
  readonly traitKeys: readonly { key: string; count: number; idLikeValues: number }[];
  readonly uncoveredTestFolders: readonly FolderCount[];
  readonly characterizationFolders: readonly FolderCount[];
  readonly contractFolders: readonly FolderCount[];
  readonly provenanceFolders: readonly FolderCount[];
}

export interface DiscoveryProposal {
  readonly trackerPrefixes: readonly string[];
  readonly ruleTraitKeys: readonly string[];
  readonly indexTests: readonly string[];
  /** Characterization folders no `domain.tests.characterization.paths` glob covers, as `<folder>/**` (H17). */
  readonly characterizationPaths: readonly string[];
  /** Contract folders no `domain.tests.contract.paths` glob covers, as `<folder>/**` (H17). */
  readonly contractPaths: readonly string[];
}

export interface DiscoveryInput {
  readonly cards: readonly ParsedCard[];
  readonly registry?: DomainRegistry;
  readonly commitSubjects: readonly string[];
  /** Local branch names (`GitRefs.localBranches`). */
  readonly localBranches: readonly string[];
  /** Remote-tracking branches as `<remote>/<name>` (`GitRefs.remoteBranches`). */
  readonly remoteBranches: readonly string[];
  readonly indices: readonly FileIndex[];
  readonly trackedFiles: readonly string[];
  readonly isPathTestFile: (path: string) => boolean;
  readonly config: DomainConfig;
  readonly indexTests: readonly string[];
  /** The host's test-framework annotation names (`host.services.testFrameworkAnnotations`). */
  readonly testFrameworkAnnotations: readonly string[];
  /** The host's glob matcher (`host.services.makeGlobMatcher`), for the configured test convention paths. */
  readonly makeGlobMatcher: GlobMatcherFactory;
}

const CHARACTERIZATION_NAMES: ReadonlySet<string> = new Set(['Characterization']);
const CONTRACT_NAMES: ReadonlySet<string> = new Set(['Contract', 'Contracts', 'Contracts.Tests']);
const PROVENANCE_NAMES: ReadonlySet<string> = new Set(['adr', 'adrs', 'decisions', 'spec', 'specs', 'rfc', 'rfcs']);
const MARKDOWN_FILE = /\.md$/i;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const norm = (path: string): string => path.replace(/\\/g, '/');

function sortedUnion(...lists: readonly (readonly string[])[]): string[] {
  return [...new Set(lists.flat())].sort(compare);
}

function idRegExp(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    return new RegExp(DEFAULT_DOMAIN_CONFIG.rules.idPattern);
  }
}

function prefixOf(id: string): string {
  const dash = id.indexOf('-');
  return dash < 0 ? id : id.slice(0, dash);
}

function hasTestAnnotation(index: FileIndex, names: ReadonlySet<string>): boolean {
  return index.symbols.some((symbol) => symbol.annotations?.some((annotation) => names.has(annotation.name)));
}

/**
 * One entry per distinct branch name: the local names, plus each remote-tracking ref with exactly its first
 * segment (the remote name) removed. A local branch named `origin/x` keeps that name.
 */
export function branchNames(localBranches: readonly string[], remoteBranches: readonly string[]): string[] {
  const names = new Set(localBranches);
  for (const ref of remoteBranches) {
    const slash = ref.indexOf('/');
    names.add(slash > 0 ? ref.slice(slash + 1) : ref);
  }
  return [...names].sort(compare);
}

function cardPrefixes(input: DiscoveryInput): DiscoveryEvidence['cardPrefixes'] {
  const counts = new Map<string, number>();
  for (const card of input.cards) {
    for (const rule of card.rules) counts.set(prefixOf(rule.id), (counts.get(prefixOf(rule.id)) ?? 0) + 1);
  }
  for (const context of input.registry?.contexts ?? []) {
    if (context.rulePrefix !== undefined && !counts.has(context.rulePrefix)) counts.set(context.rulePrefix, 0);
  }
  return [...counts.entries()]
    .map(([prefix, rules]) => ({ prefix, rules }))
    .sort((a, b) => b.rules - a.rules || compare(a.prefix, b.prefix));
}

function trackerKeys(input: DiscoveryInput, rulePrefixes: ReadonlySet<string>): DiscoveryEvidence['trackerKeys'] {
  const counts = new Map<string, number>();
  for (const text of [...input.commitSubjects, ...branchNames(input.localBranches, input.remoteBranches)]) {
    const seen = new Set<string>();
    for (const match of text.matchAll(TRACKER_KEY_PATTERN)) seen.add(prefixOf(match[0]));
    for (const prefix of seen) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([prefix, occurrences]) => ({ prefix, occurrences, overlapsRulePrefix: rulePrefixes.has(prefix) }))
    .sort((a, b) => b.occurrences - a.occurrences || compare(a.prefix, b.prefix));
}

function traitKeys(input: DiscoveryInput, idPattern: RegExp, annotated: ReadonlySet<string>): DiscoveryEvidence['traitKeys'] {
  const stats = new Map<string, { count: number; idLikeValues: number }>();
  for (const index of input.indices) {
    if (!input.isPathTestFile(index.file) && !hasTestAnnotation(index, annotated)) continue;
    for (const symbol of index.symbols) {
      for (const annotation of symbol.annotations ?? []) {
        const key = annotation.name === 'Trait' ? annotation.args?.[0] : undefined;
        if (key === undefined) continue;
        const entry = stats.get(key) ?? { count: 0, idLikeValues: 0 };
        entry.count++;
        const value = annotation.args?.[1];
        if (value !== undefined && idPattern.test(value.trim())) entry.idLikeValues++;
        stats.set(key, entry);
      }
    }
  }
  return [...stats.entries()]
    .map(([key, entry]) => ({ key, ...entry }))
    .sort((a, b) => compare(a.key, b.key));
}

/** Directories of annotated test files that the path check rejects; nested ones fold into their topmost listed parent. */
function uncoveredTestFolders(input: DiscoveryInput, annotated: ReadonlySet<string>): FolderCount[] {
  const perDir = new Map<string, number>();
  for (const index of input.indices) {
    const file = norm(index.file);
    if (input.isPathTestFile(file) || !hasTestAnnotation(index, annotated)) continue;
    const slash = file.lastIndexOf('/');
    if (slash <= 0) continue;
    const dir = file.slice(0, slash);
    perDir.set(dir, (perDir.get(dir) ?? 0) + 1);
  }
  const dirs = [...perDir.keys()].sort(compare);
  const tops: { dir: string; files: number }[] = [];
  for (const dir of dirs) {
    const top = tops.find((t) => dir === t.dir || dir.startsWith(`${t.dir}/`));
    if (top !== undefined) top.files += perDir.get(dir)!;
    else tops.push({ dir, files: perDir.get(dir)! });
  }
  return tops.map((t) => ({ folder: `${t.dir}/**`, files: t.files }));
}

/** Counts tracked files under the topmost directory whose name is in `names`; `accept` filters the files. */
function folderCounts(files: readonly string[], names: ReadonlySet<string>, caseInsensitive: boolean, accept: (file: string) => boolean): FolderCount[] {
  const counts = new Map<string, number>();
  for (const raw of files) {
    const file = norm(raw);
    if (!accept(file)) continue;
    const segments = file.split('/');
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = caseInsensitive ? segments[i]!.toLowerCase() : segments[i]!;
      if (!names.has(segment)) continue;
      const folder = segments.slice(0, i + 1).join('/');
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
      break;
    }
  }
  return [...counts.entries()].map(([folder, n]) => ({ folder, files: n })).sort((a, b) => compare(a.folder, b.folder));
}

/** `<folder>/**` for each folder no configured glob covers; the probe path is `<folder>/x` (H17). */
function uncoveredConventionPaths(folders: readonly FolderCount[], globs: readonly string[], makeMatcher: GlobMatcherFactory): string[] {
  // The host matcher takes a mutable string[] (PF26): hand it a copy of the readonly list.
  const covered = globs.length > 0 ? makeMatcher([...globs]) : () => false;
  return folders
    .filter((f) => !covered(`${f.folder}/x`))
    .map((f) => `${f.folder}/**`)
    .sort(compare);
}

/** Reads conventions from the repository (spec 10.9): tracker prefixes, test tag keys, test folders and doc folders. */
export function discoverConventions(input: DiscoveryInput): { readonly evidence: DiscoveryEvidence; readonly proposal: DiscoveryProposal } {
  const idPattern = idRegExp(input.config.rules.idPattern);
  const cards = cardPrefixes(input);
  const rulePrefixes = new Set(cards.map((c) => c.prefix));
  const tracker = trackerKeys(input, rulePrefixes);
  const annotated = new Set(input.testFrameworkAnnotations);
  const traits = traitKeys(input, idPattern, annotated);
  const uncovered = uncoveredTestFolders(input, annotated);
  const tracked = [...new Set(input.trackedFiles)];

  const evidence: DiscoveryEvidence = {
    cardPrefixes: cards,
    trackerKeys: tracker,
    traitKeys: traits,
    uncoveredTestFolders: uncovered,
    characterizationFolders: folderCounts(tracked, CHARACTERIZATION_NAMES, false, () => true),
    contractFolders: folderCounts(tracked, CONTRACT_NAMES, false, () => true),
    provenanceFolders: folderCounts(tracked, PROVENANCE_NAMES, true, (file) => MARKDOWN_FILE.test(file)),
  };
  const proposal: DiscoveryProposal = {
    trackerPrefixes: sortedUnion(
      input.config.rules.trackerPrefixes,
      tracker.filter((t) => t.occurrences >= TRACKER_PREFIX_MIN).map((t) => t.prefix),
    ),
    ruleTraitKeys: sortedUnion(
      input.config.tests.ruleTraitKeys,
      traits.filter((t) => t.idLikeValues >= 1).map((t) => t.key),
    ),
    indexTests: sortedUnion(input.indexTests, uncovered.map((f) => f.folder)),
    characterizationPaths: uncoveredConventionPaths(
      evidence.characterizationFolders,
      input.config.tests.characterization.paths,
      input.makeGlobMatcher,
    ),
    contractPaths: uncoveredConventionPaths(evidence.contractFolders, input.config.tests.contract.paths, input.makeGlobMatcher),
  };
  return { evidence, proposal };
}

const LABEL_WIDTH = 22;
const row = (label: string, value: string): string => `${label.padEnd(LABEL_WIDTH)}${value}`;
const folderList = (folders: readonly FolderCount[]): string => folders.map((f) => `${f.folder} (${f.files})`).join(', ');
/**
 * A YAML flow list with each value as a JSON string, which is a valid YAML double-quoted scalar (D-I2): an unquoted
 * glob would start an alias at `*` and make the pasted block unparsable.
 */
const flow = (values: readonly string[]): string => `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;

/** The human report in the spec 10.9 layout, followed by the proposed config; `config` is the resolved domain config. */
export function formatDiscovery(evidence: DiscoveryEvidence, proposal: DiscoveryProposal, config: DomainConfig): string {
  const lines: string[] = ['Rule IDs'];
  lines.push(
    row(
      '  card prefixes:',
      evidence.cardPrefixes.length === 0
        ? 'none'
        : evidence.cardPrefixes.map((c) => `${c.prefix} (${c.rules} ${c.rules === 1 ? 'rule' : 'rules'})`).join(', '),
    ),
  );
  if (evidence.trackerKeys.length === 0) {
    lines.push(row('  tracker-like keys:', 'none'));
  } else {
    const width = Math.max(...evidence.trackerKeys.map((t) => t.prefix.length));
    evidence.trackerKeys.forEach((t, i) => {
      const text = `${t.prefix.padEnd(width)} in ${t.occurrences} commit subjects/branches${t.overlapsRulePrefix ? '   <- overlaps a rule prefix' : ''}`;
      lines.push(row(i === 0 ? '  tracker-like keys:' : '', text).trimEnd());
    });
  }

  lines.push(
    row(
      'Test tagging',
      evidence.traitKeys.length === 0
        ? 'no xUnit Trait keys in use'
        : `xUnit Trait keys in use: ${[...evidence.traitKeys]
            .sort((a, b) => b.count - a.count || compare(a.key, b.key))
            .map((t) => `${t.key} (${t.count})`)
            .join(', ')}`,
    ),
  );

  const folderParts: string[] = [];
  if (evidence.uncoveredTestFolders.length > 0) folderParts.push(`annotated tests outside the default globs: ${folderList(evidence.uncoveredTestFolders)}`);
  folderParts.push(
    evidence.characterizationFolders.length > 0 ? `Characterization: ${folderList(evidence.characterizationFolders)}` : 'no Characterization folders',
  );
  folderParts.push(evidence.contractFolders.length > 0 ? `Contract: ${folderList(evidence.contractFolders)}` : 'no Contract folders');
  lines.push(row('Test folders', folderParts.join('; ')));
  for (const path of proposal.characterizationPaths) lines.push(row('', `${path}   <- not covered by domain.tests.characterization.paths`));
  for (const path of proposal.contractPaths) lines.push(row('', `${path}   <- not covered by domain.tests.contract.paths`));
  lines.push(row('Provenance folders', evidence.provenanceFolders.length > 0 ? folderList(evidence.provenanceFolders) : 'none'));

  lines.push('', 'Proposed config (.ctxo/config.yaml)');
  lines.push('  domain:', '    rules:', `      trackerPrefixes: ${flow(proposal.trackerPrefixes)}`);
  lines.push('    tests:', `      ruleTraitKeys: ${flow(proposal.ruleTraitKeys)}`);
  // The configured globs first, then the new ones: the list `--write` leaves, so a hand-pasted block keeps the defaults.
  const withConfigured = (configured: readonly string[], added: readonly string[]): string[] => [...new Set([...configured, ...added])];
  if (proposal.characterizationPaths.length > 0) {
    const paths = withConfigured(config.tests.characterization.paths, proposal.characterizationPaths);
    lines.push('      characterization:', `        paths: ${flow(paths)}`);
  }
  if (proposal.contractPaths.length > 0) {
    lines.push('      contract:', `        paths: ${flow(withConfigured(config.tests.contract.paths, proposal.contractPaths))}`);
  }
  lines.push('  index:', `    tests: ${flow(proposal.indexTests)}`);
  return lines.join('\n');
}

/** True when the proposal holds a value the current config does not. */
export function proposalAddsSomething(proposal: DiscoveryProposal, config: DomainConfig, indexTests: readonly string[]): boolean {
  const missing = (proposed: readonly string[], configured: readonly string[]): boolean => {
    const have = new Set(configured);
    return proposed.some((value) => !have.has(value));
  };
  return (
    missing(proposal.trackerPrefixes, config.rules.trackerPrefixes) ||
    missing(proposal.ruleTraitKeys, config.tests.ruleTraitKeys) ||
    missing(proposal.indexTests, indexTests) ||
    missing(proposal.characterizationPaths, config.tests.characterization.paths) ||
    missing(proposal.contractPaths, config.tests.contract.paths)
  );
}
