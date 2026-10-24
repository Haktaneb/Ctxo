import type { CodeFact, CtxoHost, FileIndex, TestFileCheck } from '@ctxo/cli/internal';
import { parseCard, parseGlossary, type ParsedCard } from '../core/card-parser.js';
import type { DomainConfig } from '../core/domain-config.js';
import { buildDomainGraph, cardsHash, type CardInput, type DomainGraph } from '../core/domain-graph.js';
import { indexGraph } from '../core/domain-graph-query.js';
import type { Ownership } from '../core/ownership.js';
import type { DomainRegistry } from '../core/registry.js';
import { buildScanOptions, resolveRuleRefs, scanRuleComments, scanTestFiles, type RuleLinks } from '../core/rule-id-scan.js';
import { buildShadowCandidates, type ShadowCandidate } from '../core/shadow-candidates.js';
import { readCardText, readRepoTexts, repoFileExists, repoIsFile, SOURCE_SCAN_MAX_BYTES } from './repo-files.js';
import { readTestFiles, type TestFileText } from './test-file-source.js';
import { scanTargetTexts, textScanTargets } from './text-fact-sources.js';

/** What `composeLoopInputs` reads from: a valid registry over the current index. */
export interface LoopInputsRequest {
  readonly projectRoot: string;
  readonly indices: readonly FileIndex[];
  readonly isTestFile: TestFileCheck;
  readonly registry: DomainRegistry;
  readonly registryHash: string;
  readonly config: DomainConfig;
  readonly ownership: Ownership;
  /** The indexed files, forward slashes, codepoint order. */
  readonly files: readonly string[];
  /**
   * The tracked files, when the caller listed them itself (verify-domain: a git failure is exit 2 there, never a
   * fallback). Absent: `listTrackedFiles`, else `files`.
   */
  readonly tracked?: readonly string[];
  /** The `ctxo:domain` logger's warning. */
  readonly warn: (message: string) => void;
}

/** The shadow-spec half of the composition. */
export interface CandidateInputs {
  /** Text-scan facts per repo path (H2): indexed files without a `facts` key, and listed unindexed extensions. */
  readonly textFacts: ReadonlyMap<string, readonly CodeFact[]>;
  /** Effective facts per repo path: the index `facts` when the key exists, else the text facts. */
  readonly facts: ReadonlyMap<string, readonly CodeFact[]>;
  /** `buildShadowCandidates` output, automatic resolutions applied, in `compareCandidates` order. */
  readonly candidates: readonly ShadowCandidate[];
}

export interface LoopInputs {
  readonly graph: DomainGraph;
  /** The registry's cards in registry order (contexts without a card left out), as `buildDomainGraph` got them. */
  readonly cards: readonly CardInput[];
  /** Each card path the registry names, parsed once; undefined for a card that is missing or was skipped (I2). */
  readonly parsedCards: ReadonlyMap<string, ParsedCard | undefined>;
  /** The tracked test files' texts, read once; `scanTestTitles` reads these, never the files again. */
  readonly testTexts: readonly TestFileText[];
  /** The resolved rule references of the test files (K6: annotations, `rule:` comments, titles, mentions). */
  readonly testRefs: RuleLinks;
  /** The resolved `rule:` comments of the indexed production files; `codeRefs.unknown` holds the unknown IDs. */
  readonly codeRefs: RuleLinks;
  /** Undefined when the candidates could not be built (a warning was logged); the graph is still good. */
  readonly candidates?: CandidateInputs;
}

const norm = (path: string): string => path.replace(/\\/g, '/');

/**
 * W10: the one composition of the domain graph (spec 11.2), the test texts and the shadow-spec candidates
 * (spec 12.2), shared by the index pass and `verify-domain`, so both see the same graph and the same candidates.
 *
 * - Cards and the glossary go through the checked repo reader (I2); the rule references of the test files and of
 *   the production `rule:` comments are composed by `buildDomainGraph`. External provenance is never fetched.
 * - Tracked files come from the request, else `listTrackedFiles`, else the indexed paths; they feed both the
 *   test-file read and the text scan targets.
 * - Every card, test file and production file is read once per call: the text scan reuses the production texts of
 *   the `rule:` comment scan, and the result carries the cards and both rule-reference sets, so verify-domain needs
 *   no read of its own.
 * - A failure building the graph throws. A failure after it (text scan, candidates) is a warning, and the result
 *   carries the graph without `candidates`. A text scan error in one file is a warning; that file gives no facts.
 */
export async function composeLoopInputs(host: CtxoHost, request: LoopInputsRequest): Promise<LoopInputs> {
  const { projectRoot, registry, config, indices, isTestFile, warn } = request;

  // Cards: each path read and parsed once, even when two contexts share it.
  const texts = new Map<string, string | undefined>();
  const parsed = new Map<string, ParsedCard | undefined>();
  const cards: CardInput[] = [];
  // I2: read like provenance files (real path inside the repo, no-follow open, 1 MiB cap); a skip is a missing card.
  const readText = (path: string): string | undefined => {
    if (!texts.has(path)) texts.set(path, readCardText(projectRoot, path, warn));
    return texts.get(path);
  };
  for (const context of registry.contexts) {
    if (context.card === undefined) continue;
    if (!parsed.has(context.card)) {
      const text = readText(context.card);
      parsed.set(context.card, text === undefined ? undefined : parseCard(text));
    }
    const card = parsed.get(context.card);
    cards.push(card === undefined ? { context, path: context.card } : { context, path: context.card, card });
  }
  const glossaryText = readText(registry.glossary);
  const glossary = glossaryText === undefined ? undefined : { path: registry.glossary, items: parseGlossary(glossaryText) };
  const hashOfCards = cardsHash([...texts].map(([path, text]) => (text === undefined ? { path } : { path, text })));

  const ruleIds = cards.flatMap((c) => (c.card?.rules ?? []).map((rule) => rule.id));
  const scanOptions = buildScanOptions(config, ruleIds, registry);

  // Test refs (P15: the shared scan), from the tracked files, else the indexed ones.
  let tracked = request.tracked;
  if (tracked === undefined) {
    try {
      tracked = await host.services.createGit(projectRoot).listTrackedFiles?.();
    } catch {
      tracked = undefined;
    }
  }
  const trackedFiles = tracked ?? request.files;
  const testTexts = readTestFiles(projectRoot, trackedFiles, isTestFile, indices);
  const testRefs = resolveRuleRefs(scanTestFiles(testTexts, indices, isTestFile, scanOptions), scanOptions);

  // Code refs: the `rule:` comments of the indexed production files.
  const byFile = new Map(indices.map((index) => [norm(index.file), index]));
  const production = request.files.filter((file) => !isTestFile(file));
  const productionTexts = readRepoTexts(projectRoot, production);
  const commentRefs = productionTexts.flatMap(({ file, text }) => scanRuleComments(file, text, byFile.get(file), scanOptions));
  const codeRefs = resolveRuleRefs(commentRefs, scanOptions);

  const dataResourceKinds = host.services.dataResourceKinds;
  const graph = buildDomainGraph({
    registry,
    registryHash: request.registryHash,
    config,
    cards,
    ...(glossary === undefined ? {} : { glossary }),
    cardsHash: hashOfCards,
    indices,
    isTestFile,
    ownership: request.ownership,
    testRefs,
    codeRefs,
    fileExists: (path) => repoIsFile(projectRoot, path),
    // Exists but is no regular file: a directory, never provenance.
    isDirectory: (path) => repoFileExists(projectRoot, path) && !repoIsFile(projectRoot, path),
    split: (name) => host.services.splitIdentifier(name),
    dataResourceKinds,
    warn,
  });

  const composed = { graph, cards, parsedCards: parsed, testTexts, testRefs, codeRefs };
  try {
    const targets = textScanTargets({
      indices,
      tracked: trackedFiles,
      ownership: request.ownership,
      isTestFile,
      extensions: config.facts.textScanExtensions,
    });
    const options = { trivialLiterals: config.facts.trivialLiterals, normalizationMethods: config.facts.normalizationMethods };
    // The scan reuses the production texts read for the `rule:` comments (same reader, same 1 MiB cap); only the
    // unindexed targets are read here, so no file is read twice. Same scan as `readTextFacts` (`scanTargetTexts`).
    const scanTexts = new Map(productionTexts.map(({ file, text }) => [file, text] as const));
    const attempted = new Set(production);
    const unread = targets.filter((target) => !attempted.has(target.file)).map((target) => target.file);
    for (const { file, text } of readRepoTexts(projectRoot, unread, SOURCE_SCAN_MAX_BYTES)) scanTexts.set(file, text);
    const textFacts = scanTargetTexts(targets, (file) => scanTexts.get(file), options, (file, error) =>
      warn(`The text scan of ${file} failed: ${error instanceof Error ? error.message : String(error)}; the file gives no facts.`),
    );
    const candidates = buildShadowCandidates({
      registry,
      ownership: request.ownership,
      isTestFile,
      indices,
      textFacts,
      graph: indexGraph(graph),
      dataResourceKinds,
    });
    return { ...composed, candidates: { textFacts, facts: effectiveFacts(indices, textFacts), candidates } };
  } catch (err) {
    warn(`The shadow-spec candidates could not be built: ${(err as Error).message}.`);
    return composed;
  }
}

/** Per repo path: the index `facts` when the key exists (native), else the text facts; files without facts are absent. */
export function effectiveFacts(
  indices: readonly FileIndex[],
  textFacts: ReadonlyMap<string, readonly CodeFact[]>,
): Map<string, readonly CodeFact[]> {
  const out = new Map<string, readonly CodeFact[]>();
  const native = new Set<string>();
  for (const index of indices) {
    if (index.facts === undefined) continue;
    const file = norm(index.file);
    native.add(file);
    if (index.facts.length > 0) out.set(file, [...(out.get(file) ?? []), ...index.facts]);
  }
  for (const [file, facts] of textFacts) if (!native.has(norm(file))) out.set(norm(file), facts);
  return out;
}
