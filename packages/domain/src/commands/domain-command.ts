import type { CtxoHost, ModuleCommand, ModuleCommandContext } from '@ctxo/cli/internal';
import { join } from 'node:path';
import { gatherDiscoveryInput, readConfigText, writeConfigText } from '../adapters/discovery-sources.js';
import { mergeDiscoveryProposal } from '../adapters/config-writer.js';
import { applyLoaderRules, loaderPlatforms, readExistingLoaderRules } from '../adapters/loader-rules-files.js';
import { readRegistry } from '../adapters/registry-reader.js';
import { discoverConventions, formatDiscovery, proposalAddsSomething, type DiscoveryProposal } from '../core/discovery.js';
import { resolveDomainConfig } from '../core/domain-config.js';
import { diffLoaderRules, renderLoaderRules } from '../core/loader-rules.js';

const NAME = 'domain';

const USAGE = [
  'Usage: ctxo domain rules --write | --check',
  '       ctxo domain discover [--json] [--write]',
  '',
  '  rules --write  Generate the path-scoped loader rules (.claude/rules, and .cursor/rules when .cursor/ exists)',
  '  rules --check  Exit 1 when a generated rule is missing, outdated or stale, or when a hand-written file blocks an expected path',
  '  discover       Propose tracker prefixes, rule trait keys and test folders from the repository; --json prints them, --write merges them into .ctxo/config.yaml',
];

const HELP_LINES = [
  '  ctxo domain rules --write|--check   Generate or check the path-scoped loader rules per context',
  '  ctxo domain discover [--json] [--write]   Propose domain conventions found in the repository',
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
    else console.error(formatDiscovery(evidence, proposal));

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
    return 0;
  } catch (err) {
    console.error(`[ctxo] domain discover failed: ${(err as Error).message}`);
    return 2;
  }
}

function printAdded(key: string, proposed: DiscoveryProposal[keyof DiscoveryProposal], configured: readonly string[]): void {
  const have = new Set(configured);
  const added = proposed.filter((value) => !have.has(value));
  if (added.length > 0) console.error(`  ${key}: added ${added.join(', ')}`);
}

/** `ctxo domain`: the domain subcommands,`rules` and `discover`. */
export function domainCommand(host: CtxoHost): ModuleCommand {
  return {
    name: NAME,
    help: HELP_LINES,
    async run(args: readonly string[], ctx: ModuleCommandContext): Promise<number> {
      const [sub, ...rest] = args;
      if (sub === '--help' || sub === '-h' || (sub !== undefined && rest.some((a) => a === '--help' || a === '-h'))) {
        for (const line of USAGE) console.error(line);
        return 0;
      }
      if (sub === 'rules') return rules(rest, host, ctx);
      if (sub === 'discover') return discover(rest, host, ctx);
      if (sub !== undefined) console.error(`[ctxo] Unknown domain subcommand: ${sub}`);
      for (const line of USAGE) console.error(line);
      return 1;
    },
  };
}
