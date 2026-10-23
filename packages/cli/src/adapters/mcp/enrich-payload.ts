import type { CoreToolName, LoadedModule, ResponseEnricher } from '../../ports/i-ctxo-module.js';
import { createLogger } from '../../core/logger.js';
import { describeError } from '../../core/describe-error.js';

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
    if (!isPlainObject(enriched) || !isPlainData(enriched, new Set())) {
      log.warn(
        `The ${tool} enricher returned something other than a plain JSON payload object; its fields are left out of this response`,
      );
      return payload;
    }
    // The response is serialised with JSON; a value JSON cannot hold (a BigInt) is caught here, not later.
    JSON.stringify(enriched);
    return enriched;
  } catch (err) {
    log.warn(`The ${tool} enricher failed: ${describeError(err)}; its fields are left out of this response`);
    return payload;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Whether `value` holds only JSON data: strings, numbers, booleans, null, arrays and plain objects (an
 * `Object.prototype` or null prototype), nested to any depth and without a cycle. A Promise, Map, Set,
 * Date, class instance or function fails it.
 */
function isPlainData(value: unknown, path: Set<object>): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return true;
  if (type !== 'object') return false;
  const node = value as object;
  if (path.has(node)) return false;
  if (!Array.isArray(node) && !isPlainObject(node)) return false;
  path.add(node);
  try {
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      // JSON drops an undefined property; an undefined array slot becomes null. Both are harmless.
      if (child !== undefined && !isPlainData(child, path)) return false;
    }
  } finally {
    path.delete(node);
  }
  return true;
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
      log.warn(`${module.name} enrichers could not be read: ${describeError(err)}`);
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
