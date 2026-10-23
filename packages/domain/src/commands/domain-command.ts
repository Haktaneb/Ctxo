import type { CtxoHost, ModuleCommand, ModuleCommandContext } from '@ctxo/cli/internal';
import { applyLoaderRules, loaderPlatforms, readExistingLoaderRules } from '../adapters/loader-rules-files.js';
import { readRegistry } from '../adapters/registry-reader.js';
import { resolveDomainConfig } from '../core/domain-config.js';
import { diffLoaderRules, renderLoaderRules } from '../core/loader-rules.js';

const NAME = 'domain';

const USAGE = [
  'Usage: ctxo domain rules --write | --check',
  '',
  '  rules --write  Generate the path-scoped loader rules (.claude/rules, and .cursor/rules when .cursor/ exists)',
  '  rules --check  Exit 1 when a generated rule is missing, outdated or stale',
];

const HELP_LINES = ['  ctxo domain rules --write|--check   Generate or check the path-scoped loader rules per context'];

const STALE_NOTE = 'deleted (stale)';

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
      if (result.warning === STALE_NOTE) console.error(`  deleted  ${result.file}`);
      else console.error(`  ${result.action}  ${result.file}${result.warning ? `  (${result.warning})` : ''}`);
    }
    for (const path of diff.foreign) console.error(`  foreign (kept)  ${path}`);
    if (results.length === 0) console.error('[ctxo] Loader rules are up to date.');
    return results.some((result) => result.action === 'skipped') ? 1 : 0;
  }

  for (const path of diff.missing) console.error(`  missing   ${path}`);
  for (const path of diff.outdated) console.error(`  outdated  ${path}`);
  for (const path of diff.stale) console.error(`  stale     ${path}`);
  for (const path of diff.foreign) console.error(`  foreign   ${path}  (no generated marker; not checked)`);
  const failing = diff.missing.length + diff.outdated.length + diff.stale.length > 0;
  if (failing) console.error('[ctxo] Loader rules are out of date; run "ctxo domain rules --write".');
  else console.error('[ctxo] Loader rules are up to date.');
  return failing ? 1 : 0;
}

/** `ctxo domain`: the domain subcommands. `rules` is here; `discover` joins in a later task. */
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
      if (sub !== undefined) console.error(`[ctxo] Unknown domain subcommand: ${sub}`);
      for (const line of USAGE) console.error(line);
      return 1;
    },
  };
}
