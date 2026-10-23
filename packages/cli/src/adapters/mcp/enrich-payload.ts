import type { CoreToolName, ResponseEnricher } from '../../ports/i-ctxo-module.js';
import type { LoadedModule } from '../modules/module-loader.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('ctxo:modules');

/**
 * The response enricher seam (ADR-018): a module adds fields to a core tool's payload before the
 * `_meta` envelope, truncation and masking see it, so all three treat the added fields like the core's.
 */

/**
 * `payload` with the fields `enrich` adds. The enricher works on a copy, so a throwing enricher, or one
 * that returns something other than an object, leaves the response exactly as the core built it; either
 * case logs one warning for the call. Without an enricher the payload itself is returned.
 *
 * @param args - the tool's validated arguments
 */
export function applyEnricher(
  enrich: ResponseEnricher | undefined,
  payload: Record<string, unknown>,
  args: Readonly<Record<string, unknown>>,
  tool: CoreToolName,
): Record<string, unknown> {
  if (enrich === undefined) return payload;
  try {
    const enriched: unknown = enrich(structuredClone(payload), args);
    if (enriched === null || typeof enriched !== 'object' || Array.isArray(enriched)) {
      log.warn(`The ${tool} enricher returned no payload object; its fields are left out of this response`);
      return payload;
    }
    return enriched as Record<string, unknown>;
  } catch (err) {
    log.warn(`The ${tool} enricher failed: ${(err as Error).message}; its fields are left out of this response`);
    return payload;
  }
}

/**
 * The enricher for each core tool that a loaded module enriches. Several modules enriching one tool run in
 * load order, each on the previous one's output, and each is guarded on its own: a later enricher that
 * throws drops only its own fields. A module whose `enrich` cannot be read contributes nothing.
 */
export function collectEnrichers(modules: readonly LoadedModule[]): Map<CoreToolName, ResponseEnricher> {
  const chains = new Map<CoreToolName, ResponseEnricher[]>();
  for (const module of modules) {
    let entries: Array<[string, unknown]>;
    try {
      entries = Object.entries(module.registration.enrich ?? {});
    } catch (err) {
      log.warn(`${module.name} enrichers could not be read: ${(err as Error).message}`);
      continue;
    }
    for (const [tool, enrich] of entries) {
      if (typeof enrich !== 'function') continue;
      const chain = chains.get(tool as CoreToolName) ?? [];
      chain.push(enrich as ResponseEnricher);
      chains.set(tool as CoreToolName, chain);
    }
  }
  const enrichers = new Map<CoreToolName, ResponseEnricher>();
  for (const [tool, chain] of chains) {
    enrichers.set(
      tool,
      chain.length === 1
        ? chain[0]!
        : (payload, args) => chain.reduce((current, enrich) => applyEnricher(enrich, current, args, tool), payload),
    );
  }
  return enrichers;
}
