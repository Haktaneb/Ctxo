import type { CtxoHost, FileIndex, IGitPort, ModuleCommand, ModuleCommandContext } from '@ctxo/cli/internal';
import { GitChangeReader } from '../adapters/git-changes.js';
import { loaderPlatforms, readExistingLoaderRules } from '../adapters/loader-rules-files.js';
import { composeLoopInputs } from '../adapters/loop-inputs.js';
import { readRegistry } from '../adapters/registry-reader.js';
import { readCardText, readRepoText, repoFileExists, repoIsFile } from '../adapters/repo-files.js';
import { findOrphanShadowSpecs, readShadowSpecs } from '../adapters/shadow-specs-files.js';
import { computeBoundaries } from '../core/boundaries.js';
import { githubSlugs, parseMarkdownHeadings, type ParsedCard } from '../core/card-parser.js';
import { resolveDomainConfig, type BoundaryMode } from '../core/domain-config.js';
import type { UnresolvedRef } from '../core/domain-graph.js';
import { canonicalRuleId, indexGraph } from '../core/domain-graph-query.js';
import { diffLoaderRules, renderLoaderRules, type LoaderRulesDiff } from '../core/loader-rules.js';
import { createOwnership } from '../core/ownership.js';
import { registryHash } from '../core/registry.js';
import type { RuleLinks, RuleRef } from '../core/rule-id-scan.js';
import { candidatesOf } from '../core/shadow-candidates.js';
import { applyResolutions } from '../core/shadow-specs-file.js';
import { computeTouched, type TouchedReport } from '../core/touched.js';
import { runVerifyChecks, type CheckOutcome, type Finding, type ShadowSpecsCheckInput } from '../core/verify-checks.js';

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

  const warn = (message: string): void => services.createLogger('ctxo:domain').warn(message);

  // Tracked files listed here, before the composition: a git failure is exit 2 in this CI gate, never a fallback.
  const tracked = (await git?.listTrackedFiles?.()) ?? indexedFiles;

  // A registry with problems runs check 1 only; the composition needs a valid registry and is never built for it.
  let cards: ReadonlyMap<string, ParsedCard | undefined> = new Map();
  let ruleLinks: RuleLinks = { links: new Map(), unknown: [] };
  let cardRefProblems: readonly UnresolvedRef[] = [];
  let codeRuleRefs: readonly RuleRef[] = [];
  let shadowSpecs: ShadowSpecsCheckInput[] = [];
  let orphanShadowSpecs: string[] = [];
  let candidatesUnavailable: string | undefined;
  if (registry !== undefined) {
    // The composition logs the candidate failure last, right before it returns without candidates.
    let lastWarning: string | undefined;
    // W10, E5: the index pass's composition over the current index and repo; every card, test file and production
    // file is read once, and the stored graph and candidates are never read.
    const loop = await composeLoopInputs(host, {
      projectRoot,
      indices,
      isTestFile,
      registry,
      registryHash: registryHash(registryFile.text),
      config,
      ownership: createOwnership(registry, services.makeGlobMatcher),
      files: indexedFiles,
      tracked,
      warn: (message) => {
        lastWarning = message;
        warn(message);
      },
    });
    cards = loop.parsedCards;
    ruleLinks = loop.testRefs;
    codeRuleRefs = loop.codeRefs.unknown;
    // F3 and F4: the unresolved Tests: and Code: references of the graph (ruleTestLinks, then ruleSymbolLinks).
    cardRefProblems = loop.graph.unresolved;

    // Check 12 (H6): the current shadow-specs.yaml files against the current candidates.
    const contextIds = registry.contexts.map((context) => context.id);
    const graphIndex = indexGraph(loop.graph);
    const candidates = loop.candidates?.candidates;
    if (candidates === undefined) candidatesUnavailable = lastWarning ?? 'the shadow-spec candidates could not be built.';
    shadowSpecs = readShadowSpecs(projectRoot, registryFile.path, contextIds).map((spec) => {
      const applied = applyResolutions(candidatesOf(candidates ?? [], spec.context), spec.parsed?.entries ?? [], (raw) =>
        canonicalRuleId(graphIndex, raw),
      );
      return {
        ...spec,
        // Without candidates (a warning was logged) staleness is unknown: no entry is called stale.
        stale: candidates === undefined ? [] : applied.stale,
        unknownRules: applied.unknownRules,
      };
    });
    orphanShadowSpecs = findOrphanShadowSpecs(projectRoot, registryFile.path, contextIds);
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
    shadowSpecs,
    orphanShadowSpecs,
    ...(candidatesUnavailable !== undefined ? { candidatesUnavailable } : {}),
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
