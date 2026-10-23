import type { SearchDocument, SearchResponse } from '@ctxo/cli/internal';
import type { DomainGraph } from './domain-graph.js';
import { estimateTokens } from './token-estimate.js';

/**
 * The documents of the `domain` scope of `get_ranked_context` (spec 11.4, designer calls F12 and F13) and the packing
 * of its hits. Pure: provenance texts come in already read. Card sections and glossary entries come from graph.json.
 */

export const EXCERPT_MAX_CHARS = 300;

export interface ProvenanceText {
  readonly path: string;
  readonly title: string;
  readonly text: string;
}

/**
 * A search document. `id` is the search key: the node id, joined with the context for nodes that have one, so the
 * sections of a card two contexts share do not shadow each other. `nodeId` is the graph node id a hit reports.
 */
export interface DomainDocument extends SearchDocument {
  readonly nodeId: string;
  readonly context?: string;
  readonly line?: number;
}

export interface DomainHit {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly context?: string;
  readonly path: string;
  readonly line?: number;
  readonly excerpt: string;
  readonly relevanceScore: number;
  readonly tokens: number;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Joins a node id and its context into a search key; NUL sorts the keys of one node id together, by context. */
const KEY_SEP = '\u0000';

function contextual(
  kind: string,
  nodeId: string,
  context: string,
  title: string,
  path: string,
  line: number,
  text: string,
): DomainDocument {
  return { id: `${nodeId}${KEY_SEP}${context}`, nodeId, kind, title, path, text, context, line };
}

/** The repo paths of the `decision-provenance` file links whose file existed at index time, codepoint order, each once. */
export function provenancePaths(graph: DomainGraph): string[] {
  const paths = new Set<string>();
  for (const link of graph.links) {
    if (link.kind === 'decision-provenance' && link.to.kind === 'file' && link.to.exists) paths.add(link.to.path);
  }
  return [...paths].sort(compare);
}

/**
 * One document per rule (`<ID> <title>`, its text), term (the term, its definitions), decision (`<date> decision`,
 * its line), section (its heading and text) and readable provenance file (`file:<path>`, kind `provenance`) that an
 * existing `decision-provenance` file link names. In codepoint order of `id`, the order the search index needs.
 */
export function buildSearchDocuments(graph: DomainGraph, provenance: readonly ProvenanceText[]): DomainDocument[] {
  const docs: DomainDocument[] = [];
  for (const rule of graph.rules) {
    docs.push(contextual('rule', rule.id, rule.context, `${rule.ruleId} ${rule.title}`, rule.card, rule.line, rule.text));
  }
  for (const term of graph.terms) {
    const first = term.definitions[0];
    if (first === undefined) continue;
    docs.push(contextual('term', term.id, term.context, term.term, first.at.file, first.at.line, term.definitions.map((d) => d.text).join('\n')));
  }
  for (const decision of graph.decisions) {
    docs.push(contextual('decision', decision.id, decision.context, `${decision.date} decision`, decision.card, decision.line, decision.text));
  }
  for (const section of graph.sections) {
    docs.push(contextual('section', section.id, section.context, section.heading, section.card, section.line, section.text));
  }
  const linked = new Set(provenancePaths(graph));
  const seen = new Set<string>();
  for (const file of provenance) {
    if (!linked.has(file.path) || seen.has(file.path)) continue;
    seen.add(file.path);
    const id = `file:${file.path}`;
    docs.push({ id, nodeId: id, kind: 'provenance', title: file.title, path: file.path, text: file.text });
  }
  return docs.sort((a, b) => compare(a.id, b.id));
}

/** The text with whitespace runs collapsed to one space, cut at `EXCERPT_MAX_CHARS` with `...`. */
export function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_MAX_CHARS ? `${flat.slice(0, EXCERPT_MAX_CHARS - 3)}...` : flat;
}

/** The hit with `tokens` set to its own measured size: `estimateTokens(hit) === hit.tokens`. */
function measured(body: Omit<DomainHit, 'tokens'>): DomainHit {
  let tokens = 0;
  for (let i = 0; i < 8; i++) {
    const size = estimateTokens({ ...body, tokens });
    if (size === tokens) break;
    tokens = Math.max(tokens, size);
  }
  return { ...body, tokens };
}

/**
 * The hits by score, highest first, equal scores in codepoint order of their search key, as domain hits, packed
 * greedily into `tokenBudget`: a hit that does not fit is skipped and the next ones are tried. A hit whose key is not
 * in `documents` is skipped.
 */
export function packDomainHits(
  response: SearchResponse,
  documents: ReadonlyMap<string, DomainDocument>,
  tokenBudget: number,
): { readonly results: DomainHit[]; readonly totalTokens: number } {
  const results: DomainHit[] = [];
  let totalTokens = 0;
  const ordered = [...response.results].sort((a, b) => b.relevanceScore - a.relevanceScore || compare(a.symbolId, b.symbolId));
  for (const result of ordered) {
    const doc = documents.get(result.symbolId);
    if (doc === undefined) continue;
    const hit = measured({
      id: doc.nodeId,
      kind: doc.kind,
      title: doc.title,
      ...(doc.context === undefined ? {} : { context: doc.context }),
      path: doc.path,
      ...(doc.line === undefined ? {} : { line: doc.line }),
      excerpt: excerptOf(doc.text),
      relevanceScore: Math.round(result.relevanceScore * 1000) / 1000,
    });
    if (totalTokens + hit.tokens > tokenBudget) continue;
    totalTokens += hit.tokens;
    results.push(hit);
  }
  return { results, totalTokens };
}
