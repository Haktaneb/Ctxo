import type { CtxoHost, ModuleCommand, ModuleCommandContext } from '@ctxo/cli/internal';
import { join } from 'node:path';
import { gatherDiscoveryInput, readConfigText, writeConfigText } from '../adapters/discovery-sources.js';
import { mergeDiscoveryProposal } from '../adapters/config-writer.js';
import { applyLoaderRules, loaderPlatforms, readExistingLoaderRules } from '../adapters/loader-rules-files.js';
import { readRegistry } from '../adapters/registry-reader.js';
import { discoverConventions, formatDiscovery, proposalAddsSomething, type DiscoveryProposal } from '../core/discovery.js';
import { resolveDomainConfig } from '../core/domain-config.js';
import { diffLoaderRules, renderLoaderRules } from '../core/loader-rules.js';
import type { ContextMapView } from '../core/context-map.js';
import { CANDIDATE_KINDS, type CandidateKind, type CandidateResolution } from '../core/shadow-candidates.js';
import { quoteFingerprint } from '../core/shadow-specs-file.js';
import { createDomainState, type DomainState } from '../mcp/domain-state.js';
import { createLoopState, type LoopSnapshot, type LoopStateFailure } from '../mcp/loop-state.js';
import { contextMapAnswer, shadowSpecsAnswer } from '../mcp/loop-tools.js';

const NAME = 'domain';

const USAGE = [
  'Usage: ctxo domain rules --write | --check',
  '       ctxo domain discover [--json] [--write]',
  '       ctxo domain map [--json]',
  '       ctxo domain shadow-specs <context> [--kinds <k,...>] [--all] [--json]',
  '',
  '  rules --write  Generate the path-scoped loader rules (.claude/rules, and .cursor/rules when .cursor/ exists)',
  '  rules --check  Exit 1 when a generated rule is missing, outdated or stale, or when a hand-written file blocks an expected path',
  '  discover       Propose the domain config from the repository: tracker prefixes, rule trait keys, test folders and test-kind markers (Trait or Category values, custom test attributes, *ContractTests file names); also reports external IDs (CWE, ISO, ...), GitHub #N issues and lowercase identifiers as evidence only. Run it first when adopting or tuning the domain config; --json prints the evidence and proposal, --write merges the proposal into .ctxo/config.yaml (adds values, removes none; remove a wrong value by hand)',
  '  map            The context map from the last "ctxo index": per context its rung, the suggested rung, rules with tests, open shadow-spec candidates and the rung criteria; --json prints the get_context_map body',
  `  shadow-specs   The shadow-spec candidates of one context with fingerprints and resolutions; --kinds <k,...> keeps these kinds (${CANDIDATE_KINDS.join(', ')}), --all adds resolved ones, --json prints the find_shadow_specs body`,
  '',
  'Exit codes (map, shadow-specs): 0 done (stale data, such as cards edited since the last index, prints a hint and still exits 0) or no registry, ' +
    '1 bad arguments or an unknown context, 2 registry problems, no index data or a graph built from another registry (run "ctxo index"), or an internal error.',
];

const HELP_LINES = [
  'ctxo domain rules --write|--check   Generate or check the path-scoped loader rules per context',
  'ctxo domain discover [--json] [--write]   Propose the domain config from the repository (run it first when adopting the domain layer)',
  'ctxo domain map   Context map: metrics, rungs and suggested rungs per context (--json)',
  'ctxo domain shadow-specs <context>   Shadow-spec candidates of a context (--kinds, --all, --json)',
];

const BLOCKED_NOTE = 'exists without the generated marker; rename it or delete it, then run --write';

async function rules(args: readonly string[], host: CtxoHost, ctx: ModuleCommandContext): Promise<number> {
  const write = args.includes('--write');
  const check = args.includes('--check');
  const unknown = args.find((arg) => arg !== '--write' && arg !== '--check');
  if (unknown !== undefined || write === check) {
    if (unknown !== undefined) console.error(`[ctxo] Unknown domain rules argument: ${unknown}`);
    for (const line of USAGE) console.error(line);
    return 1;
  }

  const loaded = host.services.loadConfig(ctx.ctxoRoot);
  const { config: domainConfig, problems } = resolveDomainConfig((loaded.config as Record<string, unknown>)['domain']);
  for (const problem of problems) console.error(`[ctxo] ${problem.path}: ${problem.message}`);

  const registryFile = readRegistry(ctx.projectRoot, domainConfig.registry);
  if (registryFile === undefined) {
    console.error(`[ctxo] No domain registry at ${domainConfig.registry}. Create one with "ctxo init --domain".`);
    return 0;
  }
  if (registryFile.registry === undefined || registryFile.problems.length > 0) {
    console.error(`[ctxo] The domain registry at ${registryFile.path} has problems; run "ctxo verify-domain".`);
    return 2;
  }

  const expected = renderLoaderRules(registryFile.registry, loaderPlatforms(ctx.projectRoot));
  const diff = diffLoaderRules(expected, readExistingLoaderRules(ctx.projectRoot));

  if (write) {
    const results = applyLoaderRules(ctx.projectRoot, expected, diff);
    for (const result of results) {
      console.error(`  ${result.action}  ${result.file}${result.warning ? `  (${result.warning})` : ''}`);
    }
    for (const path of diff.blocked) console.error(`[ctxo] ${path} ${BLOCKED_NOTE}`);
    for (const path of diff.foreign) console.error(`  foreign (kept)  ${path}`);
    if (results.length === 0 && diff.blocked.length === 0) console.error('[ctxo] Loader rules are up to date.');
    return diff.blocked.length > 0 || results.some((result) => result.action === 'skipped') ? 1 : 0;
  }

  for (const path of diff.missing) console.error(`  missing   ${path}`);
  for (const path of diff.outdated) console.error(`  outdated  ${path}`);
  for (const path of diff.stale) console.error(`  stale     ${path}`);
  for (const path of diff.foreign) console.error(`  foreign   ${path}  (no generated marker; not checked)`);
  for (const path of diff.blocked) console.error(`[ctxo] ${path} ${BLOCKED_NOTE}`);
  const regenerable = diff.missing.length + diff.outdated.length + diff.stale.length;
  if (regenerable > 0) console.error('[ctxo] Loader rules are out of date; run "ctxo domain rules --write".');
  else if (diff.blocked.length > 0) console.error('[ctxo] Loader rules are blocked: rename the file or delete it, then run "ctxo domain rules --write".');
  else console.error('[ctxo] Loader rules are up to date.');
  return regenerable + diff.blocked.length > 0 ? 1 : 0;
}

async function discover(args: readonly string[], host: CtxoHost, ctx: ModuleCommandContext): Promise<number> {
  const unknown = args.find((arg) => arg !== '--json' && arg !== '--write');
  if (unknown !== undefined) {
    console.error(`[ctxo] Unknown domain discover argument: ${unknown}`);
    for (const line of USAGE) console.error(line);
    return 1;
  }
  const json = args.includes('--json');
  const write = args.includes('--write');

  try {
    const loaded = host.services.loadConfig(ctx.ctxoRoot);
    const { config, problems } = resolveDomainConfig((loaded.config as Record<string, unknown>)['domain']);
    for (const problem of problems) console.error(`[ctxo] ${problem.path}: ${problem.message}`);

    const input = await gatherDiscoveryInput(host, ctx.projectRoot, ctx.ctxoRoot, loaded, config);
    const { evidence, proposal } = discoverConventions(input);

    if (json) process.stdout.write(`${JSON.stringify({ evidence, proposal }, null, 2)}\n`);
    else console.error(formatDiscovery(evidence, proposal, config));

    if (!write) {
      if (proposalAddsSomething(proposal, config, input.indexTests)) {
        console.error('[ctxo] Nothing was written. Run "ctxo domain discover --write" to add the proposal to .ctxo/config.yaml.');
      }
      return 0;
    }
    if (!proposalAddsSomething(proposal, config, input.indexTests)) {
      console.error('[ctxo] .ctxo/config.yaml already holds the proposal; nothing to add.');
      return 0;
    }

    const path = join(ctx.ctxoRoot, 'config.yaml');
    const merged = mergeDiscoveryProposal(readConfigText(path) ?? '', proposal);
    if (!merged.changed) {
      console.error('[ctxo] .ctxo/config.yaml already holds the proposal; nothing to add.');
      return 0;
    }
    writeConfigText(path, merged.text);
    console.error(`[ctxo] Updated ${path}:`);
    printAdded('domain.rules.trackerPrefixes', proposal.trackerPrefixes, config.rules.trackerPrefixes);
    printAdded('domain.tests.ruleTraitKeys', proposal.ruleTraitKeys, config.tests.ruleTraitKeys);
    printAdded('index.tests', proposal.indexTests, input.indexTests);
    printAdded('domain.tests.characterization.paths', proposal.characterizationPaths, config.tests.characterization.paths);
    printAdded('domain.tests.contract.paths', proposal.contractPaths, config.tests.contract.paths);
    printAdded('domain.tests.characterization.annotations', proposal.characterizationAnnotations, config.tests.characterization.annotations);
    printAdded('domain.tests.contract.annotations', proposal.contractAnnotations, config.tests.contract.annotations);
    return 0;
  } catch (err) {
    console.error(`[ctxo] domain discover failed: ${(err as Error).message}`);
    return 2;
  }
}

const NO_MAP_HINT = '[ctxo] No context map yet; run "ctxo index".';
const NO_SHADOW_DATA_HINT = '[ctxo] No shadow-spec data yet; run "ctxo index".';
const KIND_SET: ReadonlySet<string> = new Set(CANDIDATE_KINDS);

function printUsage(): void {
  for (const line of USAGE) console.error(line);
}

/** The exit code of a load that failed (H15): no registry is no error; registry problems and missing data are 2. */
const FAILURE_EXIT: Readonly<Record<LoopStateFailure, number>> = { 'no-registry': 0, 'registry-problems': 2, 'no-artifacts': 2 };

/**
 * The loop snapshot the MCP tools answer from (C26: same state, same bodies), or the exit code after the hint.
 * Missing data prints `noData`; a graph built from another registry prints the state's stale-registry hint; the
 * other failures print the state's own hint.
 */
function loadLoop(host: CtxoHost, noData: string): LoopSnapshot | number {
  const state: DomainState = createDomainState(host);
  const loaded = createLoopState(host, state).load();
  if (loaded.ok) return loaded.snapshot;
  if (loaded.reason !== 'no-artifacts') console.error(`[ctxo] ${loaded.hint}`);
  else {
    // The domain state is cached, so this reads nothing again; its reason tells a stale graph from missing data.
    const domain = state.load();
    console.error(!domain.ok && domain.reason === 'stale-registry' ? `[ctxo] ${domain.hint}` : noData);
  }
  return FAILURE_EXIT[loaded.reason];
}

/** Like `discover`: an unexpected failure is an internal error (2), never bad arguments (1). */
async function guarded(name: string, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (err) {
    console.error(`[ctxo] domain ${name} failed: ${(err as Error).message}`);
    return 2;
  }
}

const mark = (met: boolean): string => (met ? '✓' : '✗');

function printHint(body: Record<string, unknown>): void {
  if (typeof body['hint'] === 'string') console.error(`[ctxo] ${body['hint']}`);
}

async function map(args: readonly string[], host: CtxoHost): Promise<number> {
  return guarded('map', () => mapBody(args, host));
}

async function mapBody(args: readonly string[], host: CtxoHost): Promise<number> {
  const unknown = args.find((arg) => arg !== '--json');
  if (unknown !== undefined) {
    console.error(`[ctxo] Unknown domain map argument: ${unknown}`);
    printUsage();
    return 1;
  }
  const snapshot = loadLoop(host, NO_MAP_HINT);
  if (typeof snapshot === 'number') return snapshot;
  const body = contextMapAnswer(host.projectRoot, snapshot);
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return 0;
  }
  const view = body as unknown as ContextMapView;
  console.error(`[ctxo] Context map: ${view.summary.contexts} contexts (${view.summary.agree} agree with the suggested rung)`);
  for (const entry of view.contextMap) {
    const { pinned, named, bounded, boring } = entry.criteria;
    console.error(
      `  ${entry.id}  rung ${entry.rung}  suggested ${entry.suggestedRung}  rules ${entry.rules.count} (${entry.rules.withTests} tested)` +
        `  open candidates ${entry.shadowSpecs.open}  pinned ${mark(pinned.met)} named ${mark(named.met)} bounded ${mark(bounded.met)} boring ${mark(boring.met)}`,
    );
  }
  printHint(body);
  return 0;
}

interface ShadowSpecsArgs {
  readonly context: string;
  readonly kinds: readonly CandidateKind[];
  readonly all: boolean;
  readonly json: boolean;
}

/** The arguments, or the exit code after the message (1). */
function parseShadowSpecsArgs(args: readonly string[]): ShadowSpecsArgs | number {
  let context: string | undefined;
  const kinds = new Set<string>();
  let all = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--all') all = true;
    else if (arg === '--json') json = true;
    else if (arg === '--kinds') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        console.error('[ctxo] --kinds needs a comma-separated list of kinds');
        printUsage();
        return 1;
      }
      i++;
      // Repeated --kinds add up; an empty list adds nothing, so no kind at all means every kind, as on the MCP tool.
      const listed = value.split(',').map((kind) => kind.trim()).filter((kind) => kind !== '');
      const bad = listed.find((kind) => !KIND_SET.has(kind));
      if (bad !== undefined) {
        console.error(`[ctxo] Unknown kind "${bad}"; use one of: ${CANDIDATE_KINDS.join(', ')}`);
        return 1;
      }
      for (const kind of listed) kinds.add(kind);
    } else if (arg.startsWith('-') || context !== undefined) {
      console.error(`[ctxo] Unknown domain shadow-specs argument: ${arg}`);
      printUsage();
      return 1;
    } else context = arg;
  }
  if (context === undefined || context.trim() === '') {
    printUsage();
    return 1;
  }
  return { context: context.trim(), kinds: CANDIDATE_KINDS.filter((kind) => kinds.has(kind)), all, json };
}

function resolutionText(resolution: CandidateResolution | undefined): string {
  if (resolution === undefined) return '';
  if (resolution.by === 'rule-link') return `  [linked: ${resolution.rules.join(', ')}]`;
  if (resolution.by === 'untested') return `  [untested: ${resolution.reason}]`;
  return 'rule' in resolution ? `  [rule ${resolution.rule}]` : `  [not a rule: ${resolution.notARule}]`;
}

/** A list the view capped (W28): the rest is counted, never listed. */
function printMore(body: Record<string, unknown>, name: string, shown: number, what: string): void {
  const total = body[`${name}Total`];
  if (typeof total === 'number' && total > shown) console.error(`  ... ${total - shown} more ${what}`);
}

interface ShadowSpecsBody {
  readonly counts: { readonly open: number; readonly resolved: number };
  readonly shadowSpecs: readonly {
    readonly fingerprint: string;
    readonly kind: string;
    readonly file: string;
    readonly line: number;
    readonly text: string;
    readonly resolution?: CandidateResolution;
  }[];
  readonly resolutionFile: string;
  readonly staleResolutions: readonly { readonly fingerprint: string; readonly line: number }[];
  readonly unknownRules: readonly { readonly fingerprint: string; readonly rule: string; readonly line: number }[];
  readonly resolutionProblems: readonly { readonly line: number; readonly severity: string; readonly message: string }[];
}

async function shadowSpecs(args: readonly string[], host: CtxoHost): Promise<number> {
  return guarded('shadow-specs', () => shadowSpecsBody(args, host));
}

async function shadowSpecsBody(args: readonly string[], host: CtxoHost): Promise<number> {
  const parsed = parseShadowSpecsArgs(args);
  if (typeof parsed === 'number') return parsed;
  const snapshot = loadLoop(host, NO_SHADOW_DATA_HINT);
  if (typeof snapshot === 'number') return snapshot;
  const body = shadowSpecsAnswer(snapshot, { context: parsed.context, kinds: parsed.kinds, includeResolved: parsed.all });
  if (body['found'] === false) {
    console.error(`[ctxo] No context "${parsed.context}" in the registry.`);
    return 1;
  }
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return 0;
  }
  const view = body as unknown as ShadowSpecsBody;
  console.error(
    `[ctxo] ${parsed.context}: ${view.counts.open} open, ${view.counts.resolved} resolved shadow-spec candidates (${view.resolutionFile})`,
  );
  for (const candidate of view.shadowSpecs) {
    const state = candidate.resolution === undefined ? 'open' : 'resolved';
    console.error(`  ${state}  ${candidate.kind}  ${candidate.file}:${candidate.line}  ${candidate.text}${resolutionText(candidate.resolution)}`);
    console.error(`      ${quoteFingerprint(candidate.fingerprint)}`);
  }
  // Stale entries and unknown rules are separate reports, never summed (an entry can be in both).
  for (const entry of view.staleResolutions) console.error(`  stale  ${quoteFingerprint(entry.fingerprint)} (line ${entry.line})`);
  printMore(body, 'staleResolutions', view.staleResolutions.length, 'stale entries');
  for (const entry of view.unknownRules) console.error(`  unknown rule  ${entry.rule}  ${quoteFingerprint(entry.fingerprint)} (line ${entry.line})`);
  printMore(body, 'unknownRules', view.unknownRules.length, 'unknown rules');
  for (const problem of view.resolutionProblems) {
    console.error(`  ${problem.severity}  ${view.resolutionFile}:${problem.line} ${problem.message}`);
  }
  printMore(body, 'resolutionProblems', view.resolutionProblems.length, 'problems');
  printHint(body);
  return 0;
}

function printAdded(key: string, proposed: DiscoveryProposal[keyof DiscoveryProposal], configured: readonly string[]): void {
  const have = new Set(configured);
  const added = proposed.filter((value) => !have.has(value));
  if (added.length > 0) console.error(`  ${key}: added ${added.join(', ')}`);
}

/** `ctxo domain`: the domain subcommands `rules`, `discover`, `map` and `shadow-specs`. */
export function domainCommand(host: CtxoHost): ModuleCommand {
  return {
    name: NAME,
    help: HELP_LINES,
    usage: USAGE,
    async run(args: readonly string[], ctx: ModuleCommandContext): Promise<number> {
      const [sub, ...rest] = args;
      if (sub === '--help' || sub === '-h' || (sub !== undefined && rest.some((a) => a === '--help' || a === '-h'))) {
        for (const line of USAGE) console.error(line);
        return 0;
      }
      if (sub === 'rules') return rules(rest, host, ctx);
      if (sub === 'discover') return discover(rest, host, ctx);
      if (sub === 'map') return map(rest, host);
      if (sub === 'shadow-specs') return shadowSpecs(rest, host);
      if (sub !== undefined) console.error(`[ctxo] Unknown domain subcommand: ${sub}`);
      for (const line of USAGE) console.error(line);
      return 1;
    },
  };
}
