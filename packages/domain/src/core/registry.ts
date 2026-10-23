import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';

export const RUNGS = ['fear', 'pinned', 'named', 'bounded', 'boring'] as const;
export type Rung = (typeof RUNGS)[number];

export const CONTEXT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const RULE_PREFIX_PATTERN = /^[A-Z][A-Z0-9]*$/;

export const DEFAULT_GLOSSARY = 'docs/domain/glossary.md';
export const DEFAULT_CONTEXT_MAP = 'docs/domain/context-map.md';

export interface DomainContext {
  readonly id: string;
  readonly name: string;
  readonly card?: string;
  readonly paths: readonly string[];
  readonly rung: Rung;
  readonly rulePrefix?: string;
  readonly contracts: Readonly<Record<string, readonly string[]>>;
}

export interface DomainRegistry {
  readonly version: 1;
  readonly contexts: readonly DomainContext[];
  readonly unownedAllow: readonly string[];
  readonly glossary: string;
  readonly contextMap: string;
}

export interface RegistryProblem {
  readonly path: string;
  readonly message: string;
}

/** The registry file as read: pure data, so core checks can consume it without importing an adapter. */
export interface LoadedRegistry {
  readonly path: string;
  readonly text: string;
  readonly registry?: DomainRegistry;
  readonly problems: readonly RegistryProblem[];
}

export interface RegistryParseResult {
  readonly registry?: DomainRegistry;
  readonly problems: readonly RegistryProblem[];
}

function normalizeText(text: string): string {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return noBom.replace(/\r\n?/g, '\n');
}

export function registryHash(text: string): string {
  return createHash('sha256').update(normalizeText(text)).digest('hex').slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringList(
  value: unknown,
  path: string,
  problems: RegistryProblem[],
  requireNonEmptyList: boolean,
): string[] | undefined {
  if (!Array.isArray(value)) {
    problems.push({ path, message: 'must be an array of non-empty strings' });
    return undefined;
  }
  if (requireNonEmptyList && value.length === 0) {
    problems.push({ path, message: 'must not be empty' });
    return undefined;
  }
  const out: string[] = [];
  let ok = true;
  value.forEach((entry, i) => {
    if (isNonEmptyString(entry)) out.push(entry);
    else {
      ok = false;
      problems.push({ path: `${path}[${i}]`, message: 'must be a non-empty string' });
    }
  });
  return ok ? out : undefined;
}

function unknownKeys(obj: Record<string, unknown>, known: readonly string[], base: string, problems: RegistryProblem[]): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      problems.push({ path: base === '' ? key : `${base}.${key}`, message: `unknown key "${key}"` });
    }
  }
}

const TOP_KEYS = ['version', 'contexts', 'unowned', 'glossary', 'contextMap'] as const;
const CONTEXT_KEYS = ['id', 'name', 'card', 'paths', 'rung', 'rulePrefix', 'contracts'] as const;

export function parseRegistry(text: string): RegistryParseResult {
  const doc = parseDocument(normalizeText(text));
  if (doc.errors.length > 0) {
    const err = doc.errors[0]!;
    const line = err.linePos?.[0]?.line;
    const where = line === undefined ? '' : ` (line ${line})`;
    return { problems: [{ path: '', message: `YAML syntax error${where}: ${err.message.split('\n')[0]}` }] };
  }
  const raw: unknown = doc.toJS();
  if (!isRecord(raw)) {
    return { problems: [{ path: '', message: 'the registry must be a mapping' }] };
  }

  const problems: RegistryProblem[] = [];
  unknownKeys(raw, TOP_KEYS, '', problems);

  if (raw['version'] !== 1) problems.push({ path: 'version', message: 'must be 1' });

  const contexts: DomainContext[] = [];
  const rawContexts = raw['contexts'];
  const ids = new Set<string>();
  const prefixes = new Set<string>();
  const contractChecks: { index: number; target: string; self: string }[] = [];

  if (!Array.isArray(rawContexts)) {
    problems.push({ path: 'contexts', message: 'must be an array' });
  } else {
    rawContexts.forEach((entry, index) => {
      const base = `contexts[${index}]`;
      if (!isRecord(entry)) {
        problems.push({ path: base, message: 'must be a mapping' });
        return;
      }
      unknownKeys(entry, CONTEXT_KEYS, base, problems);
      const before = problems.length;

      const id = entry['id'];
      if (typeof id !== 'string' || !CONTEXT_ID_PATTERN.test(id)) {
        problems.push({ path: `${base}.id`, message: `must match ${CONTEXT_ID_PATTERN.source}` });
      } else if (ids.has(id)) {
        problems.push({ path: `${base}.id`, message: `duplicate id "${id}"` });
      } else {
        ids.add(id);
      }

      if (!isNonEmptyString(entry['name'])) problems.push({ path: `${base}.name`, message: 'must be a non-empty string' });
      if (entry['card'] !== undefined && !isNonEmptyString(entry['card'])) {
        problems.push({ path: `${base}.card`, message: 'must be a non-empty string' });
      }
      const paths = stringList(entry['paths'], `${base}.paths`, problems, true);

      const rung = entry['rung'];
      if (typeof rung !== 'string' || !(RUNGS as readonly string[]).includes(rung)) {
        problems.push({ path: `${base}.rung`, message: `must be one of ${RUNGS.join(', ')}` });
      }

      const prefix = entry['rulePrefix'];
      if (prefix !== undefined) {
        if (typeof prefix !== 'string' || !RULE_PREFIX_PATTERN.test(prefix)) {
          problems.push({ path: `${base}.rulePrefix`, message: `must match ${RULE_PREFIX_PATTERN.source}` });
        } else if (prefixes.has(prefix)) {
          problems.push({ path: `${base}.rulePrefix`, message: `duplicate rulePrefix "${prefix}"` });
        } else {
          prefixes.add(prefix);
        }
      }

      const contracts: Record<string, readonly string[]> = {};
      const rawContracts = entry['contracts'];
      if (rawContracts !== undefined) {
        if (!isRecord(rawContracts)) {
          problems.push({ path: `${base}.contracts`, message: 'must be a mapping of context id to file globs' });
        } else {
          for (const target of Object.keys(rawContracts)) {
            const list = stringList(rawContracts[target], `${base}.contracts.${target}`, problems, true);
            if (list) contracts[target] = list;
            contractChecks.push({ index, target, self: typeof id === 'string' ? id : '' });
          }
        }
      }

      if (problems.length === before && typeof id === 'string' && paths) {
        contexts.push({
          id,
          name: entry['name'] as string,
          ...(entry['card'] !== undefined ? { card: entry['card'] as string } : {}),
          paths,
          rung: rung as Rung,
          ...(prefix !== undefined ? { rulePrefix: prefix as string } : {}),
          contracts,
        });
      }
    });
  }

  for (const { index, target, self } of contractChecks) {
    const path = `contexts[${index}].contracts.${target}`;
    if (target === self) problems.push({ path, message: 'a context cannot list a contract into itself' });
    else if (!ids.has(target)) problems.push({ path, message: `unknown context "${target}"` });
  }

  let unownedAllow: string[] = [];
  const unowned = raw['unowned'];
  if (unowned !== undefined) {
    if (!isRecord(unowned)) {
      problems.push({ path: 'unowned', message: 'must be a mapping' });
    } else {
      unknownKeys(unowned, ['allow'], 'unowned', problems);
      if (unowned['allow'] !== undefined) {
        unownedAllow = stringList(unowned['allow'], 'unowned.allow', problems, false) ?? [];
      }
    }
  }

  const glossary = raw['glossary'] ?? DEFAULT_GLOSSARY;
  if (!isNonEmptyString(glossary)) problems.push({ path: 'glossary', message: 'must be a non-empty string' });
  const contextMap = raw['contextMap'] ?? DEFAULT_CONTEXT_MAP;
  if (!isNonEmptyString(contextMap)) problems.push({ path: 'contextMap', message: 'must be a non-empty string' });

  if (problems.length > 0) return { problems };
  return {
    registry: { version: 1, contexts, unownedAllow, glossary: glossary as string, contextMap: contextMap as string },
    problems,
  };
}
