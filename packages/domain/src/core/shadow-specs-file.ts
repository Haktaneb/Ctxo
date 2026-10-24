/**
 * `<registry folder>/<context>/shadow-specs.yaml` (spec 12.2, K13b): hand-written resolutions of shadow-spec
 * candidates by fingerprint. Parsing never throws: every problem carries a 1-based line, and a broken entry is
 * skipped while the valid ones still apply. Pure: the adapter reads the file.
 */

import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node as YamlNode } from 'yaml';
import { normalizeFingerprint } from './fingerprint.js';
import type { ShadowCandidate } from './shadow-candidates.js';

export const SHADOW_SPECS_FILE = 'shadow-specs.yaml';

export type Resolution = { readonly rule: string } | { readonly notARule: string };

export interface ResolutionEntry {
  /** Normalized (`normalizeFingerprint`), so it equals the `fingerprint` of the candidates it resolves. */
  readonly fingerprint: string;
  readonly resolution: Resolution;
  /** 1-based line of the list item. */
  readonly line: number;
}

/** A resolution entry that names a rule: what `applyResolutions` reports as an unknown rule. */
export type UnknownRuleEntry = ResolutionEntry & { readonly resolution: { readonly rule: string } };

export interface ShadowSpecsProblem {
  /** 1-based. */
  readonly line: number;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

export interface ParsedShadowSpecs {
  readonly entries: readonly ResolutionEntry[];
  readonly problems: readonly ShadowSpecsProblem[];
}

const ROOT_MESSAGE = 'the file must be a YAML list of { fingerprint, resolution } entries';
const ITEM_MESSAGE = 'an entry must be a map with fingerprint and resolution';
const FINGERPRINT_MESSAGE = 'fingerprint must read "<kind> | <symbol> | <text>"';
const RESOLUTION_MESSAGE = 'resolution must be { rule: <ID> } or { notARule: <reason> }';
const ITEM_KEYS: ReadonlySet<string> = new Set(['fingerprint', 'resolution']);

/** The 1-based line of a character offset (line 1 when unknown). */
function lineOf(counter: LineCounter, offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 1;
  const line = counter.linePos(Math.max(0, offset)).line;
  return line >= 1 ? line : 1;
}

function nodeLine(counter: LineCounter, node: unknown, fallback: number): number {
  const range = (node as { range?: readonly number[] } | null | undefined)?.range;
  return range === undefined ? fallback : lineOf(counter, range[0]);
}

/** A non-empty (after trim) string scalar, or undefined. */
function stringScalar(node: unknown): string | undefined {
  if (!isScalar(node) || typeof node.value !== 'string') return undefined;
  return node.value.trim() === '' ? undefined : node.value;
}

/** The resolution of a `resolution:` node, or undefined when it is not exactly one of `rule` or `notARule`. */
function resolutionOf(node: unknown): Resolution | undefined {
  if (!isMap(node) || node.items.length !== 1) return undefined;
  const pair = node.items[0]!;
  if (!isScalar(pair.key)) return undefined;
  const value = stringScalar(pair.value);
  if (value === undefined) return undefined;
  if (pair.key.value === 'rule') return { rule: value.trim() };
  if (pair.key.value === 'notARule') return { notARule: value.trim() };
  return undefined;
}

/** One list item: an entry, or the problem that skips it. */
function parseItem(item: unknown, counter: LineCounter): ResolutionEntry | ShadowSpecsProblem {
  const line = nodeLine(counter, item, 1);
  if (!isMap(item)) return { line, severity: 'error', message: ITEM_MESSAGE };
  let fingerprintNode: unknown;
  let resolutionNode: unknown;
  let fingerprintLine = line;
  let resolutionLine = line;
  const seen = new Set<string>();
  for (const pair of item.items) {
    const keyLine = nodeLine(counter, pair.key, line);
    const key = isScalar(pair.key) ? pair.key.value : undefined;
    if (typeof key !== 'string' || !ITEM_KEYS.has(key)) {
      const shown = typeof key === 'string' || typeof key === 'number' || typeof key === 'boolean' ? String(key) : '?';
      return { line: keyLine, severity: 'error', message: `unknown key "${shown}"; ${ITEM_MESSAGE}` };
    }
    // The document is parsed without `uniqueKeys`, so a repeated key skips only this item (M1).
    if (seen.has(key)) return { line: keyLine, severity: 'error', message: `repeated key "${key}"; ${ITEM_MESSAGE}` };
    seen.add(key);
    if (key === 'fingerprint') {
      fingerprintNode = pair.value;
      fingerprintLine = nodeLine(counter, pair.value, keyLine);
    } else {
      resolutionNode = pair.value;
      resolutionLine = nodeLine(counter, pair.value, keyLine);
    }
  }
  const raw = isScalar(fingerprintNode) && typeof fingerprintNode.value === 'string' ? fingerprintNode.value : undefined;
  const normalized = raw === undefined ? undefined : normalizeFingerprint(raw);
  if (normalized === undefined) return { line: fingerprintLine, severity: 'error', message: FINGERPRINT_MESSAGE };
  const resolution = resolutionOf(resolutionNode);
  if (resolution === undefined) return { line: resolutionLine, severity: 'error', message: RESOLUTION_MESSAGE };
  return { fingerprint: normalized, resolution, line };
}

function byLine(problems: ShadowSpecsProblem[]): ShadowSpecsProblem[] {
  return problems.map((problem, i) => ({ problem, i })).sort((a, b) => a.problem.line - b.problem.line || a.i - b.i).map((x) => x.problem);
}

/**
 * Parses `shadow-specs.yaml` (BOM stripped, CRLF read as LF). Empty text, comments only, a null document (`---`,
 * `~`, `null`) or `[]` give no entries; a root that is not a list or a YAML syntax error give one error; a broken
 * item (also one with a repeated key) is an error and is skipped; a repeated normalized fingerprint is a warning
 * and the first entry wins. Text is taken as given: invalid UTF-8 is the reader's concern. Never throws.
 */
export function parseShadowSpecs(text: string): ParsedShadowSpecs {
  try {
    return parseUnsafe(text);
  } catch (err) {
    return { entries: [], problems: [{ line: 1, severity: 'error', message: `cannot parse the file: ${(err as Error).message}` }] };
  }
}

function parseUnsafe(input: string): ParsedShadowSpecs {
  const text = (input.charCodeAt(0) === 0xfeff ? input.slice(1) : input).replace(/\r\n?/g, '\n');
  const problems: ShadowSpecsProblem[] = [];
  const counter = new LineCounter();
  // Repeated keys are checked per item (parseItem), so one bad item never discards the whole file.
  const doc = parseDocument(text, { lineCounter: counter, prettyErrors: false, uniqueKeys: false });
  if (doc.errors.length > 0) {
    const err = doc.errors[0]!;
    // An error at the end of the text (an unclosed flow collection) is reported on the last line that has text.
    const lastLine = Math.max(1, text.replace(/\n+$/, '').split('\n').length);
    problems.push({ line: Math.min(lineOf(counter, err.pos?.[0]), lastLine), severity: 'error', message: `YAML syntax error: ${err.message.split('\n')[0]}` });
    return { entries: [], problems: byLine(problems) };
  }
  const root = doc.contents as YamlNode | null;
  // No document, `---` alone, `~` or `null`: an empty file (M2).
  if (root === null || (isScalar(root) && root.value === null)) return { entries: [], problems: byLine(problems) };
  if (!isSeq(root)) {
    problems.push({ line: nodeLine(counter, root, 1), severity: 'error', message: ROOT_MESSAGE });
    return { entries: [], problems: byLine(problems) };
  }
  const entries: ResolutionEntry[] = [];
  const firstLine = new Map<string, number>();
  for (const item of root.items) {
    const parsed = parseItem(item, counter);
    if ('severity' in parsed) {
      problems.push(parsed);
      continue;
    }
    const earlier = firstLine.get(parsed.fingerprint);
    if (earlier !== undefined) {
      problems.push({ line: parsed.line, severity: 'warning', message: `duplicate fingerprint; the entry at line ${earlier} wins` });
      continue;
    }
    firstLine.set(parsed.fingerprint, parsed.line);
    entries.push(parsed);
  }
  return { entries, problems: byLine(problems) };
}

/** `<dirname(registryPath)>/<context>/shadow-specs.yaml`, posix (`config/domain/contexts.yaml` gives `config/domain/<context>/...`). */
export function shadowSpecsPath(registryPath: string, context: string): string {
  const slashed = registryPath.replace(/\\/g, '/');
  const cut = slashed.lastIndexOf('/');
  const folder = cut < 0 ? '' : slashed.slice(0, cut);
  return folder === '' || folder === '.' ? `${context}/${SHADOW_SPECS_FILE}` : `${folder}/${context}/${SHADOW_SPECS_FILE}`;
}

export interface AppliedResolutions {
  /** The input candidates in their order; open ones with a matching entry carry a `shadow-specs` resolution. */
  readonly candidates: readonly ShadowCandidate[];
  /** Entries whose fingerprint matches no candidate (automatically resolved ones count as matches), in entry order. */
  readonly stale: readonly ResolutionEntry[];
  /** Entries naming a rule that `canonicalRule` does not know, in entry order; they resolve nothing. */
  readonly unknownRules: readonly UnknownRuleEntry[];
}

/**
 * Applies `shadow-specs.yaml` entries to candidates by fingerprint (one entry resolves every candidate with its
 * fingerprint). A candidate that already has a resolution (rule link, `Untested:`) keeps it. A `rule` resolution is
 * canonicalized (`lend03` gives `LEND-03`); an unknown rule is reported and resolves nothing. The two reports are
 * independent: an entry with an unknown rule that matches no candidate is in both. Pure; the inputs are not changed.
 */
export function applyResolutions(
  candidates: readonly ShadowCandidate[],
  entries: readonly ResolutionEntry[],
  canonicalRule: (raw: string) => string | undefined,
): AppliedResolutions {
  const keyed = entries.map((entry) => ({ entry, key: normalizeFingerprint(entry.fingerprint) ?? entry.fingerprint }));
  const unknownRules: UnknownRuleEntry[] = [];
  const effective = new Map<string, NonNullable<ShadowCandidate['resolution']>>();
  for (const { entry, key } of keyed) {
    if (effective.has(key)) continue;
    const resolution = entry.resolution;
    if ('rule' in resolution) {
      const rule = canonicalRule(resolution.rule);
      if (rule === undefined) {
        unknownRules.push({ ...entry, resolution });
        continue;
      }
      effective.set(key, { by: 'shadow-specs', rule });
    } else {
      effective.set(key, { by: 'shadow-specs', notARule: resolution.notARule });
    }
  }
  const present = new Set<string>();
  const out = candidates.map((candidate) => {
    present.add(candidate.fingerprint);
    if (candidate.resolution !== undefined) return candidate;
    const resolution = effective.get(candidate.fingerprint);
    return resolution === undefined ? candidate : { ...candidate, resolution };
  });
  const stale = keyed.filter(({ key }) => !present.has(key)).map(({ entry }) => entry);
  return { candidates: out, stale, unknownRules };
}
