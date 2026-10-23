import { RULE_PREFIX_PATTERN, RUNGS, type Rung } from './registry.js';

export type BoundaryMode = 'by-rung' | 'report';

export interface DomainConfig {
  readonly registry: string;
  readonly coverage: { readonly unowned: 'warn' | 'error' };
  readonly boundaries: { readonly enforce: BoundaryMode; readonly blockingRungs: readonly Rung[] };
  readonly rules: { readonly idPattern: string; readonly trackerPrefixes: readonly string[] };
  readonly tests: { readonly ruleTraitKeys: readonly string[] };
  readonly guard: { readonly enabled: boolean; readonly base?: string; readonly subagents: boolean };
}

export const DEFAULT_DOMAIN_CONFIG: DomainConfig = {
  registry: 'docs/domain/contexts.yaml',
  coverage: { unowned: 'warn' },
  boundaries: { enforce: 'by-rung', blockingRungs: ['bounded', 'boring'] },
  rules: { idPattern: '^[A-Z][A-Z0-9]*-\\d+$', trackerPrefixes: [] },
  tests: { ruleTraitKeys: ['Rule'] },
  guard: { enabled: true, subagents: false },
};

export interface ConfigProblem {
  readonly path: string;
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Resolves the `domain:` section of `.ctxo/config.yaml`; each invalid key falls back to its default (D6). */
export function resolveDomainConfig(raw: unknown): { readonly config: DomainConfig; readonly problems: readonly ConfigProblem[] } {
  const d = DEFAULT_DOMAIN_CONFIG;
  const problems: ConfigProblem[] = [];
  if (raw === undefined || raw === null) return { config: d, problems };
  if (!isRecord(raw)) {
    problems.push({ path: 'domain', message: 'must be a mapping' });
    return { config: d, problems };
  }

  const bad = (path: string, message: string): void => {
    problems.push({ path, message });
  };
  const section = (key: string): Record<string, unknown> => {
    const value = raw[key];
    if (value === undefined) return {};
    if (!isRecord(value)) {
      bad(`domain.${key}`, 'must be a mapping');
      return {};
    }
    return value;
  };
  const stringArray = (
    value: unknown,
    path: string,
    fallback: readonly string[],
    check?: (s: string) => boolean,
    what = 'non-empty strings',
  ): readonly string[] => {
    if (value === undefined) return fallback;
    if (!Array.isArray(value) || !value.every((v) => nonEmpty(v) && (check ? check(v) : true))) {
      bad(path, `must be an array of ${what}`);
      return fallback;
    }
    return [...(value as string[])];
  };

  let registry = d.registry;
  if (raw['registry'] !== undefined) {
    if (nonEmpty(raw['registry'])) registry = raw['registry'];
    else bad('domain.registry', 'must be a non-empty string');
  }

  const coverage = section('coverage');
  let unowned = d.coverage.unowned;
  if (coverage['unowned'] !== undefined) {
    if (coverage['unowned'] === 'warn' || coverage['unowned'] === 'error') unowned = coverage['unowned'];
    else bad('domain.coverage.unowned', 'must be "warn" or "error"');
  }

  const boundaries = section('boundaries');
  let enforce = d.boundaries.enforce;
  if (boundaries['enforce'] !== undefined) {
    if (boundaries['enforce'] === 'by-rung' || boundaries['enforce'] === 'report') enforce = boundaries['enforce'];
    else bad('domain.boundaries.enforce', 'must be "by-rung" or "report"');
  }
  let blockingRungs: readonly Rung[] = d.boundaries.blockingRungs;
  if (boundaries['blockingRungs'] !== undefined) {
    const v = boundaries['blockingRungs'];
    if (Array.isArray(v) && v.every((r) => typeof r === 'string' && (RUNGS as readonly string[]).includes(r))) {
      blockingRungs = [...(v as Rung[])];
    } else bad('domain.boundaries.blockingRungs', `must be an array of ${RUNGS.join(', ')}`);
  }

  const rules = section('rules');
  let idPattern = d.rules.idPattern;
  if (rules['idPattern'] !== undefined) {
    let ok = false;
    if (nonEmpty(rules['idPattern'])) {
      try {
        new RegExp(rules['idPattern']);
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (ok) idPattern = rules['idPattern'] as string;
    else bad('domain.rules.idPattern', 'must be a valid regular expression');
  }
  const trackerPrefixes = stringArray(
    rules['trackerPrefixes'],
    'domain.rules.trackerPrefixes',
    d.rules.trackerPrefixes,
    (s) => RULE_PREFIX_PATTERN.test(s),
    `prefixes matching ${RULE_PREFIX_PATTERN.source}`,
  );

  const tests = section('tests');
  const ruleTraitKeys = stringArray(tests['ruleTraitKeys'], 'domain.tests.ruleTraitKeys', d.tests.ruleTraitKeys);

  const guard = section('guard');
  let enabled = d.guard.enabled;
  if (guard['enabled'] !== undefined) {
    if (typeof guard['enabled'] === 'boolean') enabled = guard['enabled'];
    else bad('domain.guard.enabled', 'must be a boolean');
  }
  let subagents = d.guard.subagents;
  if (guard['subagents'] !== undefined) {
    if (typeof guard['subagents'] === 'boolean') subagents = guard['subagents'];
    else bad('domain.guard.subagents', 'must be a boolean');
  }
  let base: string | undefined;
  if (guard['base'] !== undefined) {
    if (nonEmpty(guard['base']) && !guard['base'].startsWith('-')) base = guard['base'];
    else bad('domain.guard.base', 'must be a non-empty ref that does not start with "-"');
  }

  return {
    config: {
      registry,
      coverage: { unowned },
      boundaries: { enforce, blockingRungs },
      rules: { idPattern, trackerPrefixes },
      tests: { ruleTraitKeys },
      guard: { enabled, ...(base !== undefined ? { base } : {}), subagents },
    },
    problems,
  };
}
