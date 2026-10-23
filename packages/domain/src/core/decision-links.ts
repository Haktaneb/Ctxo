import { posix } from 'node:path';
import type { CardDecision } from './card-parser.js';
import { ruleNodeId, type DecisionNode, type DomainLink, type Location } from './domain-graph.js';

/**
 * Decision links (spec 11.2, designer call F6): a decision line links to its provenance (files in the repository,
 * external strings) and to the rule IDs written in it. Pure: the only disk question goes through `fileExists`,
 * and external provenance is a string that is stored, never fetched (ADR-004).
 */

export type ResolvedTarget =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'external'; readonly value: string }
  | { readonly kind: 'anchor' }
  /** The repository root or a path written as a folder (`dir/`): not provenance. */
  | { readonly kind: 'directory' };

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const TRACKER_KEY = /\b([A-Z][A-Z0-9]{1,9})-\d+\b/g;
const RULE_ID = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]*-\d+(?![A-Za-z0-9])/g;

/** The same test as `leavesProject` (adapters/repo-files.ts), on a posix-normalised path; core cannot import it. */
export function leavesRepository(rel: string): boolean {
  return rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel);
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Where a card link points: a repo-relative file, an external string kept as written, or an anchor in the card. */
export function resolveProvenanceTarget(cardPath: string, target: string): ResolvedTarget {
  if (SCHEME.test(target) || target.startsWith('//')) return { kind: 'external', value: target };
  if (target.startsWith('#')) return { kind: 'anchor' };
  const cut = target.search(/[#?]/);
  const raw = decode(cut === -1 ? target : target.slice(0, cut)).replace(/\\/g, '/');
  if (raw === '') return { kind: 'anchor' };
  const path = raw.startsWith('/')
    ? posix.normalize(raw.replace(/^\/+/, ''))
    : posix.normalize(posix.join(posix.dirname(cardPath), raw));
  if (leavesRepository(path)) return { kind: 'external', value: target };
  if (path === '.' || path.endsWith('/')) return { kind: 'directory' };
  return { kind: 'file', path };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
}

interface Placed {
  readonly index: number;
  readonly link: DomainLink;
}

function linksOf(
  node: DecisionNode,
  decision: CardDecision,
  input: {
    readonly ruleIds: ReadonlySet<string>;
    readonly trackerPrefixes: ReadonlySet<string>;
    readonly fileExists: (repoPath: string) => boolean;
    readonly isDirectory?: (repoPath: string) => boolean;
  },
): DomainLink[] {
  const at: Location = { file: node.card, line: node.line };
  const text = decision.text;
  const placed: Placed[] = [];
  // Link targets and bare URLs are blanked so text inside them gives no tracker key, rule ID or position.
  let masked = text;

  let cursor = 0;
  for (const link of decision.links) {
    const found = text.indexOf(link.target, cursor);
    const index = found === -1 ? text.length : found;
    if (found !== -1) {
      masked = blank(masked, found, found + link.target.length);
      cursor = found + link.target.length;
    }
    const resolved = resolveProvenanceTarget(node.card, link.target);
    if (resolved.kind === 'anchor' || resolved.kind === 'directory') continue;
    if (resolved.kind === 'file' && input.isDirectory?.(resolved.path) === true) continue;
    const to =
      resolved.kind === 'file'
        ? { kind: 'file' as const, path: resolved.path, exists: input.fileExists(resolved.path) }
        : { kind: 'external' as const, value: resolved.value };
    placed.push({ index, link: { kind: 'decision-provenance', from: node.id, to, source: 'card-link', at, label: link.label } });
  }

  for (const value of decision.externalRefs) {
    const match = new RegExp(`${escapeRegExp(value)}(?![A-Za-z0-9])`).exec(masked);
    const index = match ? match.index : text.length;
    if (match && SCHEME.test(value)) masked = blank(masked, match.index, match.index + value.length);
    placed.push({
      index,
      link: { kind: 'decision-provenance', from: node.id, to: { kind: 'external', value }, source: 'card-text', at },
    });
  }

  for (const match of masked.matchAll(TRACKER_KEY)) {
    if (!input.trackerPrefixes.has(match[1]!) || input.ruleIds.has(match[0])) continue;
    placed.push({
      index: match.index,
      link: { kind: 'decision-provenance', from: node.id, to: { kind: 'external', value: match[0] }, source: 'card-text', at },
    });
  }

  for (const match of masked.matchAll(RULE_ID)) {
    if (!input.ruleIds.has(match[0])) continue;
    placed.push({ index: match.index, link: { kind: 'decision-rule', from: node.id, to: ruleNodeId(match[0]), source: 'card-text', at } });
  }

  // Text order; equal positions keep the order above. A repeated reference gives one link.
  placed.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const links: DomainLink[] = [];
  for (const { link } of placed) {
    const key = JSON.stringify(link);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link);
  }
  return links;
}

/**
 * Per decision in the given order: inline links, external references, tracker keys and rule IDs, in text order.
 * `fileExists` should be a file-only check; a link to the repository root, to a path written as a folder, or to a
 * path `isDirectory` accepts is not provenance and gives no link.
 */
export function decisionLinks(input: {
  readonly decisions: readonly DecisionNode[];
  readonly parsed: ReadonlyMap<string, CardDecision>;
  readonly ruleIds: ReadonlySet<string>;
  readonly trackerPrefixes: ReadonlySet<string>;
  readonly fileExists: (repoPath: string) => boolean;
  readonly isDirectory?: (repoPath: string) => boolean;
}): DomainLink[] {
  const links: DomainLink[] = [];
  for (const node of input.decisions) {
    const decision = input.parsed.get(node.id);
    if (decision) links.push(...linksOf(node, decision, input));
  }
  return links;
}
