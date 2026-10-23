import type { CtxoHost, FileIndex, IGitPort, ModuleCommand, ModuleCommandContext } from '@ctxo/cli/internal';
import { GitChangeReader } from '../adapters/git-changes.js';
import { loaderPlatforms, readExistingLoaderRules } from '../adapters/loader-rules-files.js';
import { readRegistry } from '../adapters/registry-reader.js';
import { readCardText, readRepoText, readRepoTexts, repoFileExists, repoIsFile } from '../adapters/repo-files.js';
import { readTestFiles } from '../adapters/test-file-source.js';
import { computeBoundaries } from '../core/boundaries.js';
import { githubSlugs, parseCard, parseMarkdownHeadings, type ParsedCard } from '../core/card-parser.js';
import { resolveDomainConfig, type BoundaryMode } from '../core/domain-config.js';
import { diffLoaderRules, renderLoaderRules, type LoaderRulesDiff } from '../core/loader-rules.js';
import { createOwnership } from '../core/ownership.js';
import { buildGraphNodes, type UnresolvedRef } from '../core/domain-graph.js';
import { buildScanOptions, resolveRuleRefs, scanRuleComments, scanTestFiles, type RuleRef } from '../core/rule-id-scan.js';
import { ruleSymbolLinks } from '../core/rule-symbol-links.js';
import { ruleTestLinks, type RefLookup } from '../core/rule-test-links.js';
import { computeTouched, type TouchedReport } from '../core/touched.js';
import { runVerifyChecks, type CheckOutcome, type Finding } from '../core/verify-checks.js';

const NAME = 'verify-domain';

const USAGE = [
  'Usage: ctxo verify-domain [--since <ref>] [--boundaries by-rung|report] [--json]',
  '',
  '  --since <ref>        Also check that every context changed since the merge base of <ref> and HEAD has a card change or a trailer (check 11)',
  '  --boundaries <mode>  by-rung or report; overrides domain.boundaries.enforce for this run',
  '  --json               Print the checks and the summary as JSON on stdout',
  '',
  'Exit codes: 0 no errors, 1 errors, 2 missing index, git failure or an internal error.',
];

const HELP_LINE = 'ctxo verify-domain        CI gate for the registry, cards, rule IDs and boundaries (--since, --boundaries, --json)';

const GLYPH: Record<CheckOutcome['status'], string> = { pass: '✓', warn: '⚠', fail: '✗', skipped: '-' };

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sha7 = (sha: string): string => sha.slice(0, 7);
const EMPTY_DIFF: LoaderRulesDiff = { missing: [], outdated: [], stale: [], foreign: [], blocked: [] };

interface Options {
  since?: string;
  boundaries?: BoundaryMode;
  json: boolean;
}

function parseArgs(args: readonly string[]): Options | { readonly error: string } | 'help' {
  const options: Options = { json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--json') options.json = true;
    else if (arg === '--since') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) return { error: '[ctxo] --since needs a ref' };
      options.since = value;
      i++;
    } else if (arg === '--boundaries') {
      const value = args[i + 1];
      if (value !== 'by-rung' && value !== 'report') return { error: '[ctxo] --boundaries must be "by-rung" or "report"' };
      options.boundaries = value;
      i++;
    } else return { error: `[ctxo] Unknown verify-domain flag: ${arg}` };
  }
  return options;
}

function printUsage(): void {
  for (const line of USAGE) console.error(line);
}

function location(finding: Finding): string {
  if (finding.file === undefined) return '';
  return finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
}

function printHuman(outcomes: readonly CheckOutcome[], errors: number, warnings: number): void {
  for (const outcome of outcomes) {
    console.error(`[ctxo] ${GLYPH[outcome.status]} ${outcome.id} ${outcome.title}`);
    for (const finding of outcome.findings) {
      const where = location(finding);
      console.error(`    ${finding.severity} ${where === '' ? '' : `${where} `}${finding.message}`);
    }
  }
  console.error(`[ctxo] verify-domain: ${errors} errors, ${warnings} warnings`);
}

const MARKDOWN = /\.(?:md|markdown)$/i;

/** `ctxo verify-domain`: the CI gate for the registry, the cards, rule IDs, generated rules and boundaries (spec 10.5). */
export function verifyDomainCommand(host: CtxoHost): ModuleCommand {
  return {
    name: NAME,
    help: [HELP_LINE],
    usage: USAGE,
    async run(args: readonly string[], ctx: ModuleCommandContext): Promise<number> {
      const parsed = parseArgs(args);
      if (parsed === 'help') {
        printUsage();
        return 0;
      }
      if ('error' in parsed) {
        console.error(parsed.error);
        printUsage();
        return 1;
      }
      try {
        return await verify(host, ctx, parsed);
      } catch (err) {
        console.error(`[ctxo] verify-domain failed: ${(err as Error).message}`);
        return 2;
      }
    },
  };
}

async function verify(host: CtxoHost, ctx: ModuleCommandContext, options: Options): Promise<number> {
  const services = host.services;
  const projectRoot = ctx.projectRoot;

  const loaded = services.loadConfig(ctx.ctxoRoot);
  const { config, problems: configProblems } = resolveDomainConfig((loaded.config as Record<string, unknown>)['domain']);

  const registryFile = readRegistry(projectRoot, config.registry);
  if (registryFile === undefined) {
    console.error(`[ctxo] No domain registry at ${config.registry}. Create one with "ctxo init --domain".`);
    return 0;
  }

  const indices: FileIndex[] = services.readIndex(ctx.ctxoRoot);
  if (indices.length === 0) {
    console.error('[ctxo] No index found; run "ctxo index" first.');
    return 2;
  }
  const isTestFile = services.createTestFileCheck(loaded.config, indices);
  const indexedFiles = [...new Set(indices.map((index) => index.file.replace(/\\/g, '/')))].sort(compare);
  const registry = registryFile.registry !== undefined && registryFile.problems.length === 0 ? registryFile.registry : undefined;

  let git: IGitPort | undefined;
  try {
    git = services.createGit(projectRoot);
  } catch {
    git = undefined;
  }

  // Cards: only the ones the registry names, parsed once.
  const cards = new Map<string, ParsedCard | undefined>();
  for (const context of registry?.contexts ?? []) {
    if (context.card === undefined || cards.has(context.card)) continue;
    // Read like the index pass reads cards (I2), so check 7 and graph.json see the same text.
    const text = readCardText(projectRoot, context.card, (message) => services.createLogger('ctxo:domain').warn(message));
    cards.set(context.card, text === undefined ? undefined : parseCard(text));
  }

  // K6: rule IDs in tests, by file text and by indexed annotations.
  const ruleIds = [...cards.values()].flatMap((card) => (card?.rules ?? []).map((rule) => rule.id));
  const scanOptions = buildScanOptions(config, ruleIds, registry);
  const tracked = (await git?.listTrackedFiles?.()) ?? indexedFiles;
  const refs =
    registry !== undefined ? scanTestFiles(readTestFiles(projectRoot, tracked, isTestFile, indices), indices, isTestFile, scanOptions) : [];
  const ruleLinks = resolveRuleRefs(refs, scanOptions);

  // F3 and F4: card Tests: and Code: references and production rule: comments, from the current index and the repo
  // through the same functions as the index pass (E5); the stored graph is never read.
  let cardRefProblems: UnresolvedRef[] = [];
  let codeRuleRefs: RuleRef[] = [];
  if (registry !== undefined) {
    const byFile = new Map(indices.map((index) => [index.file.replace(/\\/g, '/'), index]));
    const symbolNames = new Map(indices.flatMap((index) => index.symbols.map((symbol) => [symbol.symbolId, symbol.name] as const)));
    const lookup: RefLookup = {
      hasSymbol: (symbolId) => symbolNames.has(symbolId),
      symbolName: (symbolId) => symbolNames.get(symbolId),
      fileExists: (path) => repoIsFile(projectRoot, path),
    };
    const { cardRefs } = buildGraphNodes({
      registry,
      cards: registry.contexts.flatMap((context) => {
        if (context.card === undefined) return [];
        const card = cards.get(context.card);
        return [{ context, path: context.card, ...(card === undefined ? {} : { card }) }];
      }),
    });
    const production = indexedFiles.filter((file) => !isTestFile(file));
    const commentRefs = readRepoTexts(projectRoot, production).flatMap(({ file, text }) =>
      scanRuleComments(file, text, byFile.get(file), scanOptions),
    );
    const codeRefs = resolveRuleRefs(commentRefs, scanOptions);
    codeRuleRefs = [...codeRefs.unknown];
    cardRefProblems = [
      ...ruleTestLinks({ cardRefs, testRefs: ruleLinks, lookup }).unresolved,
      ...ruleSymbolLinks({ cardRefs, codeRefs, lookup }).unresolved,
    ];
  }

  // Generated loader rules against disk, and the context map.
  const loaderDiff = registry
    ? diffLoaderRules(renderLoaderRules(registry, loaderPlatforms(projectRoot)), readExistingLoaderRules(projectRoot))
    : EMPTY_DIFF;
  const contextMapText = registry !== undefined ? readRepoText(projectRoot, registry.contextMap) : undefined;

  // Boundaries from the current registry and the current graph; the stored artifacts are never read.
  const makeMatcher = services.makeGlobMatcher;
  const boundaries = registry
    ? computeBoundaries(services.buildGraph(indices).allEdges(), {
        registry,
        ownership: createOwnership(registry, makeMatcher),
        isTestFile,
        mode: options.boundaries ?? config.boundaries.enforce,
        blockingRungs: config.boundaries.blockingRungs,
      })
    : { crossEdges: [], violations: [], perContext: new Map() };

  let touched: TouchedReport | undefined;
  if (options.since !== undefined && registry !== undefined) {
    const hint = `[ctxo] Cannot find the merge base of ${options.since} and HEAD. In CI, fetch the base branch with full history (actions/checkout fetch-depth: 0).`;
    if (git === undefined) {
      console.error(hint);
      return 2;
    }
    const reader = new GitChangeReader(git);
    const resolved = await reader.resolveBase(options.since);
    if ('error' in resolved) {
      console.error(hint);
      return 2;
    }
    const commits = await reader.committed([resolved.base]);
    if (commits === undefined) {
      console.error('[ctxo] Cannot read the commits of the range from git.');
      return 2;
    }
    touched = computeTouched({
      registry,
      ownership: createOwnership(registry, makeMatcher),
      isTestFile,
      indexedFiles: new Set(indexedFiles),
      commits,
      workingTree: [],
      mode: 'committed',
      since: options.since,
      base: sha7(resolved.base),
      head: sha7(resolved.head),
    });
  }

  const outcomes = runVerifyChecks({
    registry: registryFile,
    config,
    configProblems,
    indexedFiles,
    isTestFile,
    makeMatcher,
    cards,
    fileExists: (path) => repoFileExists(projectRoot, path),
    isRepoFile: (path) => repoIsFile(projectRoot, path),
    headingSlugs: (path) => {
      if (!MARKDOWN.test(path)) return undefined;
      const text = readCardText(projectRoot, path);
      return text === undefined ? undefined : githubSlugs(parseMarkdownHeadings(text));
    },
    ruleLinks,
    cardRefProblems,
    codeRuleRefs,
    loaderDiff,
    ...(contextMapText !== undefined ? { contextMapText } : {}),
    boundaries,
    ...(touched !== undefined ? { touched } : {}),
  });

  const findings = outcomes.flatMap((outcome) => outcome.findings);
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.length - errors;
  const exitCode = errors > 0 ? 1 : 0;

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ registry: registryFile.path, checks: outcomes, summary: { errors, warnings }, exitCode }, null, 2)}\n`);
  } else {
    printHuman(outcomes, errors, warnings);
  }
  return exitCode;
}
