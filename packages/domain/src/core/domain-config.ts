import type { FactDetectorOptions, TrivialLiteral } from '@ctxo/cli/internal';
import { RULE_PREFIX_PATTERN, RUNGS, type Rung } from './registry.js';
import { parseAnnotationMatcher } from './test-conventions.js';

export type BoundaryMode = 'by-rung' | 'report';

/** A K13a convention (spec 12.3): a test is of the kind when an annotation, a path glob or a name marker matches. */
export interface TestConvention {
  readonly annotations: readonly string[];
  readonly paths: readonly string[];
  readonly names: readonly string[];
}

export interface DomainConfig {
  readonly registry: string;
  readonly coverage: { readonly unowned: 'warn' | 'error' };
  readonly boundaries: { readonly enforce: BoundaryMode; readonly blockingRungs: readonly Rung[] };
  readonly rules: { readonly idPattern: string; readonly trackerPrefixes: readonly string[] };
  readonly tests: {
    readonly ruleTraitKeys: readonly string[];
    readonly characterization: TestConvention;
    readonly contract: TestConvention;
  };
  readonly rungs: { readonly pinnedCoverage: number };
  readonly facts: {
    readonly trivialLiterals: readonly TrivialLiteral[];
    readonly normalizationMethods: readonly string[];
    readonly textScanExtensions: readonly string[];
  };
  readonly guard: { readonly enabled: boolean; readonly base?: string; readonly subagents: boolean };
}

/** The extensions the text fallback scans in tracked files no plugin indexes (H2), in codepoint order. */
export const DEFAULT_TEXT_SCAN_EXTENSIONS: readonly string[] = [
  '.dart',
  '.ex',
  '.exs',
  '.groovy',
  '.kt',
  '.kts',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.scala',
  '.swift',
];

/**
 * A `normalizationMethods` entry: a method name, optionally qualified, with an optional trailing `*`.
 * The same expression as the plugins' `METHOD_PATTERN` (`src/facts/fact-options.ts` of each official plugin); a test pins it.
 */
export const NORMALIZATION_METHOD_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_$][A-Za-z0-9_$]*\*?$/;

const EXTENSION_PATTERN = /^\.[A-Za-z0-9]+$/;

/**
 * The spec 12.1 fact lists. A copy of the plugins' `DEFAULT_FACT_OPTIONS` (the domain cannot import a plugin);
 * a test pins both to the `defaults` block of `packages/plugin-api/conformance/fact-vectors.json`.
 */
const DEFAULT_TRIVIAL_LITERALS: readonly TrivialLiteral[] = [0, 1, -1, null, true, false, ''];
const DEFAULT_NORMALIZATION_METHODS: readonly string[] = [
  'ToLower*',
  'ToUpper*',
  'Trim*',
  'Normalize',
  'toLowerCase',
  'toUpperCase',
  'trim',
  'strings.ToLower',
  'strings.TrimSpace',
  'equalsIgnoreCase',
];

export const DEFAULT_DOMAIN_CONFIG: DomainConfig = {
  registry: 'docs/domain/contexts.yaml',
  coverage: { unowned: 'warn' },
  boundaries: { enforce: 'by-rung', blockingRungs: ['bounded', 'boring'] },
  rules: { idPattern: '^[A-Z][A-Z0-9]*-\\d+$', trackerPrefixes: [] },
  tests: {
    ruleTraitKeys: ['Rule'],
    characterization: {
      annotations: ['Trait:Kind=Characterization', 'Tag:characterization'],
      paths: ['**/Characterization/**'],
      names: ['[characterization]'],
    },
    contract: {
      annotations: ['Trait:Kind=Contract', 'Tag:contract'],
      paths: ['**/Contract/**', '**/Contracts.Tests/**'],
      names: ['[contract]'],
    },
  },
  rungs: { pinnedCoverage: 0.8 },
  facts: {
    trivialLiterals: DEFAULT_TRIVIAL_LITERALS,
    normalizationMethods: DEFAULT_NORMALIZATION_METHODS,
    textScanExtensions: DEFAULT_TEXT_SCAN_EXTENSIONS,
  },
  guard: { enabled: true, subagents: false },
};

/** The fact request's options (`indexCapabilities.factOptions`): the two lists the plugins' detectors read. */
export function toFactDetectorOptions(config: DomainConfig): FactDetectorOptions {
  return {
    trivialLiterals: [...config.facts.trivialLiterals],
    normalizationMethods: [...config.facts.normalizationMethods],
  };
}

function isTrivialLiteral(value: unknown): value is TrivialLiteral {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

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
  const convention = (key: 'characterization' | 'contract'): TestConvention => {
    const fallback = d.tests[key];
    const value = tests[key];
    if (value === undefined) return fallback;
    if (!isRecord(value)) {
      bad(`domain.tests.${key}`, 'must be a mapping');
      return fallback;
    }
    const path = `domain.tests.${key}`;
    return {
      annotations: stringArray(
        value['annotations'],
        `${path}.annotations`,
        fallback.annotations,
        (s) => parseAnnotationMatcher(s) !== undefined,
        'matchers of the form Name, Name:value or Name:key=value',
      ),
      paths: stringArray(value['paths'], `${path}.paths`, fallback.paths),
      names: stringArray(value['names'], `${path}.names`, fallback.names),
    };
  };
  const characterization = convention('characterization');
  const contract = convention('contract');

  const rungs = section('rungs');
  let pinnedCoverage = d.rungs.pinnedCoverage;
  if (rungs['pinnedCoverage'] !== undefined) {
    const v = rungs['pinnedCoverage'];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) pinnedCoverage = v;
    else bad('domain.rungs.pinnedCoverage', 'must be a number from 0 to 1');
  }

  const facts = section('facts');
  let trivialLiterals = d.facts.trivialLiterals;
  if (facts['trivialLiterals'] !== undefined) {
    const v = facts['trivialLiterals'];
    if (Array.isArray(v) && v.every(isTrivialLiteral)) trivialLiterals = [...(v as TrivialLiteral[])];
    else bad('domain.facts.trivialLiterals', 'must be an array of numbers, strings, booleans or null');
  }
  const normalizationMethods = stringArray(
    facts['normalizationMethods'],
    'domain.facts.normalizationMethods',
    d.facts.normalizationMethods,
    (s) => NORMALIZATION_METHOD_PATTERN.test(s),
    `method names matching ${NORMALIZATION_METHOD_PATTERN.source}`,
  );
  // Lower-cased, then deduplicated in first-seen order.
  const textScanExtensions = [
    ...new Set(
      stringArray(
        facts['textScanExtensions'],
        'domain.facts.textScanExtensions',
        d.facts.textScanExtensions,
        (s) => EXTENSION_PATTERN.test(s),
        `extensions matching ${EXTENSION_PATTERN.source}`,
      ).map((ext) => ext.toLowerCase()),
    ),
  ];

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
      tests: { ruleTraitKeys, characterization, contract },
      rungs: { pinnedCoverage },
      facts: { trivialLiterals, normalizationMethods, textScanExtensions },
      guard: { enabled, ...(base !== undefined ? { base } : {}), subagents },
    },
    problems,
  };
}
