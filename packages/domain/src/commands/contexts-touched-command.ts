import type { CtxoHost, FileIndex, IGitPort, ModuleCommand, ModuleCommandContext } from '@ctxo/cli/internal';
import { GitChangeReader } from '../adapters/git-changes.js';
import { readRegistry } from '../adapters/registry-reader.js';
import { resolveDomainConfig } from '../core/domain-config.js';
import { createOwnership } from '../core/ownership.js';
import { computeTouched, type TouchedReport } from '../core/touched.js';

const NAME = 'contexts-touched';

const USAGE = [
  'Usage: ctxo contexts-touched [--since <ref>] [--committed | --staged] [--json] [--check]',
  '',
  '  --since <ref>  Compare against the merge base of <ref> and HEAD (default: the configured or detected base branch)',
  '  --committed    Only the commits of the range, not the working tree',
  '  --staged       Only the staged changes',
  '  --json         Print the report as JSON on stdout',
  '  --check        Exit 1 when a touched context has no card change and no Domain-Unchanged trailer',
];

const HELP_LINE = '  ctxo contexts-touched     Named contexts changed since a ref (--since, --committed, --staged, --json, --check)';

const sha7 = (sha: string): string => sha.slice(0, 7);

interface Options {
  since?: string;
  committed: boolean;
  staged: boolean;
  json: boolean;
  check: boolean;
}

function parseArgs(args: readonly string[]): Options | { readonly error: string } | 'help' {
  const options: Options = { committed: false, staged: false, json: false, check: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') return 'help';
    else if (arg === '--committed') options.committed = true;
    else if (arg === '--staged') options.staged = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--since') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) return { error: '[ctxo] --since needs a ref' };
      options.since = value;
      i++;
    } else return { error: `[ctxo] Unknown contexts-touched flag: ${arg}` };
  }
  if (options.committed && options.staged) return { error: '[ctxo] --committed and --staged cannot be combined' };
  return options;
}

function printHuman(report: TouchedReport): void {
  for (const context of report.contexts) {
    console.error(
      `  ${context.id}  ${context.status}  ${context.files.length} file(s)  card ${context.card ?? 'none'}`,
    );
  }
  for (const path of report.unowned) console.error(`  unowned  ${path}`);
  for (const warning of report.warnings) console.error(`[ctxo] ${warning}`);
  if (report.unresolved.length > 0) {
    const ids = report.unresolved.join(', ');
    console.error(`[ctxo] Unresolved: ${ids}. Update the card, or add "Domain-Unchanged: ${ids} (reason)" to a commit.`);
  }
}

/** `ctxo contexts-touched`: which named contexts the changes touched, and whether each is resolved (spec 10.3). */
export function contextsTouchedCommand(host: CtxoHost): ModuleCommand {
  return {
    name: NAME,
    help: [HELP_LINE],
    async run(args: readonly string[], ctx: ModuleCommandContext): Promise<number> {
      const parsed = parseArgs(args);
      if (parsed === 'help') {
        for (const line of USAGE) console.error(line);
        return 0;
      }
      if ('error' in parsed) {
        console.error(parsed.error);
        return 1;
      }
      const options = parsed;
      const services = host.services;

      const loaded = services.loadConfig(ctx.ctxoRoot);
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
      const registry = registryFile.registry;

      let git: IGitPort;
      try {
        git = services.createGit(ctx.projectRoot);
      } catch (err) {
        console.error(`[ctxo] Cannot read git: ${(err as Error).message}`);
        return 2;
      }
      const reader = new GitChangeReader(git);

      const mode: TouchedReport['mode'] = options.staged ? 'staged' : options.committed ? 'committed' : 'all';
      let since: string | undefined;
      let base: string | undefined;
      let head: string | undefined;
      let commits: Awaited<ReturnType<GitChangeReader['committed']>> = [];

      if (mode !== 'staged') {
        since = options.since ?? (await reader.defaultBase(domainConfig));
        if (since === undefined) {
          console.error('[ctxo] No base branch found (origin/HEAD, main or master); pass --since <ref>.');
          return 2;
        }
        const resolved = await reader.resolveBase(since);
        if ('error' in resolved) {
          console.error(
            `[ctxo] Cannot find the merge base of ${since} and HEAD. In CI, fetch the base branch with full history (actions/checkout fetch-depth: 0).`,
          );
          return 2;
        }
        base = sha7(resolved.base);
        head = sha7(resolved.head);
        commits = await reader.committed([resolved.base]);
        if (commits === undefined) {
          console.error('[ctxo] Cannot read the commits of the range from git.');
          return 2;
        }
      }

      let workingTree: Awaited<ReturnType<GitChangeReader['workingTree']>> = [];
      if (mode !== 'committed') {
        workingTree = await reader.workingTree(mode === 'staged' ? 'staged' : 'all');
        if (workingTree === undefined) {
          console.error('[ctxo] Cannot read the working tree changes from git.');
          return 2;
        }
      }

      let indices: FileIndex[] = [];
      try {
        indices = services.readIndex(ctx.ctxoRoot);
      } catch (err) {
        console.error(`[ctxo] Cannot read the index: ${(err as Error).message}`);
      }
      const isTestFile = services.createTestFileCheck(loaded.config, indices);
      const indexedFiles = indices.length > 0 ? new Set(indices.map((index) => index.file)) : undefined;

      const report = computeTouched({
        registry,
        ownership: createOwnership(registry, services.makeGlobMatcher),
        isTestFile,
        ...(indexedFiles !== undefined ? { indexedFiles } : {}),
        commits: commits ?? [],
        workingTree: workingTree ?? [],
        mode,
        ...(since !== undefined ? { since } : {}),
        ...(base !== undefined ? { base } : {}),
        ...(head !== undefined ? { head } : {}),
      });

      if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else printHuman(report);

      return options.check && report.unresolved.length > 0 ? 1 : 0;
    },
  };
}
