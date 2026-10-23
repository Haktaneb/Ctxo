import { isAbsolute, relative } from 'node:path';
import type { CtxoHost, ModuleToolDefinition } from '@ctxo/cli/internal';
import { canonicalRuleId, type DomainSnapshot } from '../core/domain-graph-query.js';
import { contextForPath, contextsOverview, contextView, ruleView } from '../core/domain-views.js';
import { STALE_CARDS_HINT, type DomainState } from './domain-state.js';

/**
 * The MCP tools of `@ctxo/domain` (spec 11.4, designer call F14). Registered whenever the module is loaded; without a
 * registry or a graph they answer `{ found: false, hint }`. The CLI adds `_meta`, truncation and masking
 * (`handleModuleTool`); the handlers never throw.
 */

export const GET_DOMAIN_CONTEXT = 'get_domain_context';
export const GET_RULE = 'get_rule';

type Payload = Record<string, unknown>;

const DOMAIN_CONTEXT_DESCRIPTION =
  'Get the domain card of the named context that owns a symbol or file: the context (id, name, rung, card), its Language terms, its rules with linked tests and code, boundary contracts, decisions with provenance, and open questions. Use this BEFORE changing code in a named context, or to learn the business rules behind it. Pass symbolId or path; with neither, it lists every context. Large results are truncated with _meta.hint. For one rule and its tests, use get_rule. Needs a domain registry (docs/domain/contexts.yaml).';

const RULE_DESCRIPTION =
  "Get one domain rule by ID (for example LEND-03): its text, context and card, the tests linked to it with the source of each link (test annotations, test names, rule comments, the card's Tests: line), the symbols that implement it, and the decisions and provenance that mention it. Use this when a change may affect a business rule, or to find the tests that pin it. For a whole context, use get_domain_context.";

/** The file of a canonical `<file>::<name>::<kind>` symbol ID; undefined for IDs that name no file. */
function fileOfSymbolId(id: string): string | undefined {
  const parts = id.split('::');
  return parts.length >= 3 && parts[0] !== '' ? parts[0] : undefined;
}

/** Backslashes become `/`, an absolute path inside the project becomes repo-relative, a leading `./` is dropped. */
function repoPath(projectRoot: string, raw: string): string {
  const trimmed = raw.trim();
  let path = isAbsolute(trimmed) ? relative(projectRoot, trimmed) : trimmed;
  path = path.replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  return path;
}

/** Stale cards add `stale: true` and the stale hint (after any hint of the view itself). */
function withStale(snapshot: DomainSnapshot, body: Payload): Payload {
  if (!snapshot.staleCards) return body;
  const hint = typeof body['hint'] === 'string' ? `${body['hint']} ${STALE_CARDS_HINT}` : STALE_CARDS_HINT;
  return { ...body, stale: true, hint };
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined);

/** Runs a view over the loaded snapshot; a not-ok state or an unexpected failure gives `{ found: false, hint }`. */
function answer(state: DomainState, view: (snapshot: DomainSnapshot) => Payload): Payload {
  try {
    const loaded = state.load();
    if (!loaded.ok) return { found: false, hint: loaded.hint };
    return withStale(loaded.snapshot, view(loaded.snapshot));
  } catch (err) {
    return { found: false, hint: `The domain graph could not be read: ${(err as Error).message}` };
  }
}

export function domainTools(host: CtxoHost, state: DomainState): ModuleToolDefinition[] {
  const domainContext: ModuleToolDefinition = {
    name: GET_DOMAIN_CONTEXT,
    description: DOMAIN_CONTEXT_DESCRIPTION,
    inputSchema: (z) => ({
      symbolId: z.string().optional().describe('Symbol ID (format: file::name::kind); its file selects the context'),
      path: z.string().optional().describe("Repo-relative file path, or a context's card path"),
    }),
    handler: (args) =>
      answer(state, (snapshot) => {
        const symbolId = text(args['symbolId']);
        const path = text(args['path']);
        let target: string;
        if (symbolId !== undefined) {
          const file = fileOfSymbolId(symbolId.trim());
          if (file === undefined) {
            return { found: false, hint: `${symbolId} names no file; pass a symbol ID of the form file::name::kind, or a path.` };
          }
          target = repoPath(host.projectRoot, file);
        } else if (path !== undefined) {
          target = repoPath(host.projectRoot, path);
        } else {
          return contextsOverview(snapshot);
        }
        const lookup = contextForPath(snapshot, target);
        return 'hint' in lookup ? { found: false, hint: lookup.hint } : contextView(snapshot, lookup.context);
      }),
  };

  const rule: ModuleToolDefinition = {
    name: GET_RULE,
    description: RULE_DESCRIPTION,
    inputSchema: (z) => ({
      ruleId: z.string().min(1).describe('Rule ID as written in the card, e.g. LEND-03 (LEND03, Lend03 and lend_03 also match)'),
    }),
    handler: (args) =>
      answer(state, (snapshot) => {
        const raw = typeof args['ruleId'] === 'string' ? args['ruleId'] : '';
        const ruleId = canonicalRuleId(snapshot.index, raw);
        return ruleId === undefined ? { found: false, hint: `No rule ${raw} in any card.` } : ruleView(snapshot, ruleId);
      }),
  };

  return [domainContext, rule];
}
