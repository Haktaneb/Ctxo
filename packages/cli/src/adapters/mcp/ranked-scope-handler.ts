import { z } from 'zod';
import type { IMaskingPort } from '../../ports/i-masking-port.js';
import type { LoadedModule, RankedContextScope } from '../../ports/i-ctxo-module.js';
import type { McpToolResult } from './module-tool-handler.js';
import { wrapResponse } from '../../core/response-envelope.js';
import { compareCodepoint } from '../../core/compare-codepoint.js';
import { createLogger } from '../../core/logger.js';
import { describeError } from '../../core/describe-error.js';

const log = createLogger('ctxo:modules');

/** The built-in scope of `get_ranked_context`: the symbol ranking. A module scope may not take this name. */
export const CODE_SCOPE = 'code';

export type McpHandler = (args: Record<string, unknown>) => McpToolResult | Promise<McpToolResult>;

/** What a module scope accepts; `strategy` and `searchMode` belong to the code scope only. */
const ScopeInputSchema = z.object({
  query: z.string().min(1),
  tokenBudget: z.number().min(100).optional().default(4000),
});

/**
 * The `get_ranked_context` scopes of the loaded modules, by scope name in load order. `code` and a name an
 * earlier scope took are skipped with a warning, and so is a scope without a name, a description or a
 * `search` function. A module whose scopes cannot be read contributes nothing.
 */
export function collectRankedScopes(modules: readonly LoadedModule[]): Map<string, RankedContextScope> {
  const scopes = new Map<string, RankedContextScope>();
  for (const module of modules) {
    let list: unknown;
    try {
      list = module.registration.rankedContextScopes;
    } catch (err) {
      log.warn(`${module.name} ranked-context scopes could not be read: ${describeError(err)}`);
      continue;
    }
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      log.warn(`${module.name} rankedContextScopes is not a list; it was ignored`);
      continue;
    }
    for (const entry of list as unknown[]) {
      const candidate = entry as Partial<RankedContextScope> | null | undefined;
      const name = candidate?.scope;
      if (
        typeof name !== 'string' ||
        name.length === 0 ||
        typeof candidate?.description !== 'string' ||
        typeof candidate.search !== 'function'
      ) {
        log.warn(`${module.name} registered a ranked-context scope without a name, a description or a search; it was ignored`);
      } else if (name === CODE_SCOPE) {
        log.warn(`${module.name} scope "${name}" is skipped: reserved`);
      } else if (scopes.has(name)) {
        log.warn(`${module.name} scope "${name}" is skipped: already registered`);
      } else {
        scopes.set(name, candidate as RankedContextScope);
      }
    }
  }
  return scopes;
}

/** The scope names in codepoint order: the order of the `scope` enum and its description. */
export function rankedScopeNames(scopes: ReadonlyMap<string, RankedContextScope>): string[] {
  return [...scopes.keys()].sort(compareCodepoint);
}

/** The `scope` parameter description: the code scope's sentence, then each scope's in name order. */
export function rankedScopeDescription(scopes: ReadonlyMap<string, RankedContextScope>): string {
  return ['Where to search. "code" (default): rank symbols.', ...rankedScopeNames(scopes).map((name) => scopes.get(name)!.description)].join(' ');
}

function errorResult(message: string, masking: IMaskingPort): McpToolResult {
  // A module's error text is not the core's: it is masked like its payloads.
  return { content: [{ type: 'text', text: masking.mask(JSON.stringify({ error: true, message })) }] };
}

/**
 * `get_ranked_context` with module scopes. Without scopes it is `code` itself. An absent `scope`, or
 * `"code"`, goes to `code` unchanged; a module scope gets the validated query and budget, and its result
 * goes through the `_meta` envelope and masking. Never throws: an unknown scope, invalid arguments, a
 * throwing search or a result that is not an object gives `{ error: true, message }`.
 */
export function withRankedScopes(
  code: McpHandler,
  scopes: ReadonlyMap<string, RankedContextScope>,
  masking: IMaskingPort,
): McpHandler {
  if (scopes.size === 0) return code;
  const names = rankedScopeNames(scopes);

  return (args: Record<string, unknown>) => {
    const requested = args['scope'];
    if (requested === undefined || requested === CODE_SCOPE) return code(args);

    const scope = typeof requested === 'string' ? scopes.get(requested) : undefined;
    if (scope === undefined) {
      return errorResult(`Unknown scope "${String(requested)}"; use one of: ${[CODE_SCOPE, ...names].join(', ')}`, masking);
    }
    const parsed = ScopeInputSchema.safeParse(args);
    if (!parsed.success) return errorResult(parsed.error.message, masking);

    return (async (): Promise<McpToolResult> => {
      try {
        const result: unknown = await scope.search({ query: parsed.data.query, tokenBudget: parsed.data.tokenBudget });
        if (result === null || typeof result !== 'object' || Array.isArray(result)) {
          throw new Error(`Scope ${scope.scope} returned no payload object`);
        }
        return { content: [{ type: 'text', text: masking.mask(JSON.stringify(wrapResponse(result as Record<string, unknown>))) }] };
      } catch (err) {
        return errorResult(describeError(err), masking);
      }
    })();
  };
}
