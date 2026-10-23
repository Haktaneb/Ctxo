import type { CtxoHost, DocumentSearch, RankedContextScope, SearchResponse } from '@ctxo/cli/internal';
import { provenanceStamp, readProvenanceTexts } from '../adapters/provenance-texts.js';
import { buildSearchDocuments, packDomainHits, provenancePaths, type DomainDocument } from '../core/domain-documents.js';
import { createRacyStamper, STALE_CARDS_HINT, type DomainState } from './domain-state.js';

/**
 * The `domain` scope of `get_ranked_context` (spec 11.4, designer calls F12 and F13): BM25 through the host's
 * `createDocumentSearch` over card sections, rules, glossary entries, decisions and in-repo provenance files.
 * Nodes come from graph.json; provenance texts are read at query time. The index is rebuilt only when the
 * snapshot generation or a provenance file's stamp changes. `strategy` and `searchMode` do not apply.
 */

export const DOMAIN_SCOPE = 'domain';

const DESCRIPTION = '"domain": card sections, glossary entries and in-repo provenance files from @ctxo/domain.';

/** How many hits the engine returns before packing. */
const SEARCH_LIMIT = 100;

const NO_METRICS: SearchResponse['metrics'] = { porterHits: 0, trigramHits: 0, phase2Activated: false, fuzzyApplied: false, latencyMs: 0 };

/**
 * The prose query without punctuation: the core query tokenizer keeps it (`loans?` is one token), so everything but
 * letters, digits, whitespace, `-` and `_` becomes a space. Rule IDs (`LEND-03`) and identifiers keep their shape.
 */
export function cleanQuery(query: string): string {
  return query.replace(/[^\p{L}\p{N}\s_-]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

type Logger = ReturnType<CtxoHost['services']['createLogger']>;

interface BuiltIndex {
  readonly key: string;
  readonly search: DocumentSearch;
  readonly documents: ReadonlyMap<string, DomainDocument>;
}

export interface DomainScopeOptions {
  /** The clock for the racy-stamp rule of provenance files; `Date.now` by default. */
  readonly now?: () => number;
}

export function domainRankedScope(host: CtxoHost, state: DomainState, options: DomainScopeOptions = {}): RankedContextScope {
  let built: BuiltIndex | undefined;
  // The same racy-stamp rule as the domain state: a provenance file edited within 2 s is re-read on the next search.
  const stamp = createRacyStamper(options.now);
  let logger: Logger | undefined;
  /** Each skip message once per scope: a racy file rebuilds the index on every search. */
  const warned = new Set<string>();
  const warn = (message: string): void => {
    if (warned.has(message)) return;
    warned.add(message);
    logger ??= host.services.createLogger('ctxo:domain');
    logger.warn(message);
  };

  function indexFor(generation: number, paths: readonly string[], build: () => DomainDocument[]): BuiltIndex {
    const key = [String(generation), ...paths.map((path) => `${path}|${provenanceStamp(host.projectRoot, path, stamp)}`)].join('\n');
    if (built !== undefined && built.key === key) return built;
    const documents = build();
    built = {
      key,
      // Documents in codepoint order of the search key; packing orders equal scores by that key too.
      search: host.services.createDocumentSearch(documents),
      documents: new Map(documents.map((doc) => [doc.id, doc] as const)),
    };
    return built;
  }

  return {
    scope: DOMAIN_SCOPE,
    description: DESCRIPTION,
    search({ query, tokenBudget }) {
      try {
        const loaded = state.load();
        if (!loaded.ok) return { found: false, hint: loaded.hint };
        const { snapshot } = loaded;
        const paths = provenancePaths(snapshot.graph);
        const index = indexFor(snapshot.generation, paths, () =>
          buildSearchDocuments(snapshot.graph, readProvenanceTexts(host.projectRoot, paths, { warn })),
        );
        const cleaned = cleanQuery(query);
        const response: SearchResponse =
          cleaned === '' ? { query, results: [], metrics: { ...NO_METRICS } } : index.search.search(cleaned, SEARCH_LIMIT);
        const { results, totalTokens } = packDomainHits(response, index.documents, tokenBudget);
        return {
          query,
          scope: DOMAIN_SCOPE,
          results,
          totalTokens,
          tokenBudget,
          searchMetrics: response.metrics,
          ...(response.fuzzyCorrection === undefined ? {} : { fuzzyCorrection: response.fuzzyCorrection }),
          ...(snapshot.staleCards ? { stale: true, hint: STALE_CARDS_HINT } : {}),
        };
      } catch (err) {
        return { error: true, message: `The domain graph could not be searched: ${(err as Error).message}` };
      }
    },
  };
}
