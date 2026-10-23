import type { CtxoHost, CtxoModuleRegister, CtxoModuleRegistration, LoadedModule } from '../../ports/i-ctxo-module.js';
import { createLogger } from '../../core/logger.js';
import { resolvePackageCandidates, type ResolvedPackage } from '../language/plugin-discovery.js';

const log = createLogger('ctxo:modules');

export const DOMAIN_MODULE_PACKAGE = '@ctxo/domain';

export type ModuleStatus = 'active' | 'inactive' | 'version-mismatch' | 'load-failed' | 'not-installed';

export interface ModuleReport {
  readonly name: string;
  readonly status: ModuleStatus;
  readonly version?: string;
  readonly source?: 'project' | 'cli';
  readonly reason?: string;
}

export type { LoadedModule };

export interface ModuleLoadResult {
  readonly modules: readonly LoadedModule[];
  readonly reports: readonly ModuleReport[];
}

export interface LoadCtxoModulesOptions {
  /** Resolve again instead of returning the memoized result. */
  readonly refresh?: boolean;
  /** A directory standing in for the CLI's location (tests); defaults to the running CLI. */
  readonly cliAnchor?: string;
}

/**
 * Whether two versions share a numeric major and minor. A module runs only against the CLI minor it was
 * built for (ADR-018 Decision 3). `@ctxo/domain` carries its own copy of this rule, on purpose: it cannot
 * import the CLI at runtime.
 */
export function sameMinor(a: string, b: string): boolean {
  const pa = /^(\d+)\.(\d+)/.exec(a);
  const pb = /^(\d+)\.(\d+)/.exec(b);
  if (!pa || !pb) return false;
  return Number(pa[1]) === Number(pb[1]) && Number(pa[2]) === Number(pb[2]);
}

const memo = new Map<string, Promise<ModuleLoadResult>>();

type Outcome =
  | { readonly kind: 'active'; readonly loaded: LoadedModule; readonly report: ModuleReport }
  | { readonly kind: 'stop'; readonly report: ModuleReport };

async function loadCandidate(candidate: ResolvedPackage, host: CtxoHost): Promise<Outcome> {
  const base = { name: DOMAIN_MODULE_PACKAGE, version: candidate.version, source: candidate.source } as const;
  const failed = (reason: string): Outcome => {
    log.warn(`${DOMAIN_MODULE_PACKAGE} failed to load: ${reason}; domain features are off.`);
    return { kind: 'stop', report: { ...base, status: 'load-failed', reason } };
  };
  try {
    const mod = (await import(candidate.entryUrl)) as { register?: unknown };
    if (typeof mod.register !== 'function') return failed('missing register export');
    const registration: CtxoModuleRegistration | undefined = await (mod.register as CtxoModuleRegister)(host);
    if (registration === undefined) {
      return { kind: 'stop', report: { ...base, status: 'inactive' } };
    }
    if (registration === null || typeof registration !== 'object' || registration.id !== 'domain') {
      return failed('register returned a registration with an unexpected id');
    }
    return {
      kind: 'active',
      loaded: { name: DOMAIN_MODULE_PACKAGE, version: candidate.version, registration },
      report: { ...base, status: 'active' },
    };
  } catch (err) {
    return failed((err as Error).message);
  }
}

async function resolveModules(host: CtxoHost, cliAnchor: string | undefined): Promise<ModuleLoadResult> {
  const candidates = resolvePackageCandidates(DOMAIN_MODULE_PACKAGE, host.projectRoot, cliAnchor);
  if (candidates.length === 0) {
    return { modules: [], reports: [{ name: DOMAIN_MODULE_PACKAGE, status: 'not-installed' }] };
  }
  let firstMismatch: ResolvedPackage | undefined;
  for (const candidate of candidates) {
    if (!sameMinor(candidate.version, host.cliVersion)) {
      firstMismatch ??= candidate;
      continue;
    }
    const outcome = await loadCandidate(candidate, host);
    if (outcome.kind === 'active') {
      return { modules: [outcome.loaded], reports: [outcome.report] };
    }
    return { modules: [], reports: [outcome.report] };
  }
  const mismatch = firstMismatch!;
  log.warn(
    `${DOMAIN_MODULE_PACKAGE} ${mismatch.version} does not match @ctxo/cli ${host.cliVersion}; domain features are off. ` +
      `Install ${DOMAIN_MODULE_PACKAGE}@${host.cliVersion} next to the CLI you run.`,
  );
  return {
    modules: [],
    reports: [
      {
        name: DOMAIN_MODULE_PACKAGE,
        status: 'version-mismatch',
        version: mismatch.version,
        source: mismatch.source,
        reason: `cli ${host.cliVersion}`,
      },
    ],
  };
}

/**
 * Finds `@ctxo/domain` (the project's copy, then the copy next to the CLI), checks that its major.minor
 * equals the CLI's and calls its `register(host)`. Never throws: every failure is a report plus a warning.
 * Memoized per project root and mode; `refresh` resolves again (after an install).
 */
export function loadCtxoModules(host: CtxoHost, options: LoadCtxoModulesOptions = {}): Promise<ModuleLoadResult> {
  const key = `${host.projectRoot}|${host.mode}|${options.cliAnchor ?? ''}`;
  if (!options.refresh) {
    const cached = memo.get(key);
    if (cached) return cached;
  }
  const pending = resolveModules(host, options.cliAnchor).catch((err: unknown): ModuleLoadResult => {
    const reason = (err as Error).message;
    log.warn(`${DOMAIN_MODULE_PACKAGE} failed to load: ${reason}; domain features are off.`);
    return { modules: [], reports: [{ name: DOMAIN_MODULE_PACKAGE, status: 'load-failed', reason }] };
  });
  memo.set(key, pending);
  return pending;
}
