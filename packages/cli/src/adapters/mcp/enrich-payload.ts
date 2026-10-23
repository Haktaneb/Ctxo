import type { CoreToolName, LoadedModule, ResponseEnricher, TokenReservation } from '../../ports/i-ctxo-module.js';
import { createLogger } from '../../core/logger.js';
import { describeError } from '../../core/describe-error.js';

const log = createLogger('ctxo:modules');

/**
 * The response enricher seam (ADR-018): a module adds fields to a core tool's payload before the
 * `_meta` envelope, truncation and masking see it, so all three treat the added fields like the core's.
 */

/**
 * `payload` with the fields `enrich` adds, for a synchronous tool. The enricher works on a copy, so a
 * throwing enricher, or one that returns something other than an object, leaves the response exactly as
 * the core built it; either case logs one warning for the call. An enricher that returns a Promise is not
 * waited for: its result is dropped, a rejection is swallowed, and the call logs one warning. Without an
 * enricher the payload itself is returned.
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
    if (isThenable(enriched)) {
      // Handled, so a rejection never becomes an unhandled one.
      Promise.resolve(enriched).catch(() => undefined);
      log.warn(`${tool} enricher returned a Promise; a synchronous tool cannot wait for it`);
      return payload;
    }
    return accepted(enriched, payload, tool);
  } catch (err) {
    return failed(err, payload, tool);
  }
}

/**
 * `payload` with the fields `enrich` adds, for an asynchronous tool: a Promise result is awaited, then
 * checked exactly as `applyEnricher` checks a synchronous one. A throw, a rejection or a result that is not
 * a plain JSON payload object keeps the payload and logs one warning for the call. Never rejects.
 *
 * @param args - the tool's validated arguments
 */
export async function applyEnricherAsync(
  enrich: ResponseEnricher | undefined,
  payload: Record<string, unknown>,
  args: Readonly<Record<string, unknown>>,
  tool: CoreToolName,
): Promise<Record<string, unknown>> {
  if (enrich === undefined) return payload;
  try {
    const enriched: unknown = await enrich(structuredClone(payload), args);
    return accepted(enriched, payload, tool);
  } catch (err) {
    return failed(err, payload, tool);
  }
}

/** `enriched` when it is a plain JSON payload object, else `payload` with a warning. Throws on a value JSON cannot hold. */
function accepted(enriched: unknown, payload: Record<string, unknown>, tool: CoreToolName): Record<string, unknown> {
  if (!isPlainObject(enriched) || !isPlainData(enriched, new Set())) {
    log.warn(
      `The ${tool} enricher returned something other than a plain JSON payload object; its fields are left out of this response`,
    );
    return payload;
  }
  // The response is serialised with JSON; a value JSON cannot hold (a BigInt) is caught here, not later.
  JSON.stringify(enriched);
  return enriched;
}

function failed(err: unknown, payload: Record<string, unknown>, tool: CoreToolName): Record<string, unknown> {
  log.warn(`The ${tool} enricher failed: ${describeError(err)}; its fields are left out of this response`);
  return payload;
}

/** Whether `value` has a callable `then`: a Promise or any other thenable. Reading `then` may throw. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  return typeof (value as { then?: unknown }).then === 'function';
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
 * throws drops only its own fields. Once a link returns a Promise the chain turns asynchronous: the next
 * link runs on its resolved value, and the composed enricher returns a Promise that never rejects. A
 * module whose `enrich` cannot be read contributes nothing.
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
    enrichers.set(tool, chain.length === 1 ? chain[0]! : composeChain(chain, tool));
  }
  return enrichers;
}

/** The links of `chain` in order, synchronous until a link returns a thenable, then awaited link by link. */
function composeChain(chain: readonly ResponseEnricher[], tool: CoreToolName): ResponseEnricher {
  return (payload, args) => {
    let current = payload;
    for (let i = 0; i < chain.length; i++) {
      try {
        const enriched: unknown = chain[i]!(structuredClone(current), args);
        if (isThenable(enriched)) return finishAsync(chain.slice(i + 1), enriched, current, args, tool);
        current = accepted(enriched, current, tool);
      } catch (err) {
        current = failed(err, current, tool);
      }
    }
    return current;
  };
}

async function finishAsync(
  rest: readonly ResponseEnricher[],
  pending: PromiseLike<unknown>,
  before: Record<string, unknown>,
  args: Readonly<Record<string, unknown>>,
  tool: CoreToolName,
): Promise<Record<string, unknown>> {
  let current: Record<string, unknown>;
  try {
    current = accepted(await pending, before, tool);
  } catch (err) {
    current = failed(err, before, tool);
  }
  for (const enrich of rest) current = await applyEnricherAsync(enrich, current, args, tool);
  return current;
}

/**
 * The token reservation of the loaded modules for `get_context_for_task`: the sum of each module's
 * `reserveTaskContextTokens`, undefined when no module reserves any. The handler caps and guards the sum
 * (`reservedTokens`). A module whose reservation cannot be read contributes nothing.
 */
export function collectTaskContextReservation(modules: readonly LoadedModule[]): TokenReservation | undefined {
  const reservations: TokenReservation[] = [];
  for (const module of modules) {
    let reserve: unknown;
    try {
      reserve = module.registration.reserveTaskContextTokens;
    } catch (err) {
      log.warn(`${module.name} token reservation could not be read: ${describeError(err)}`);
      continue;
    }
    if (typeof reserve === 'function') reservations.push(reserve as TokenReservation);
  }
  if (reservations.length === 0) return undefined;
  if (reservations.length === 1) return reservations[0]!;
  return (args) => reservations.reduce((sum, reserve) => sum + reserve(args), 0);
}
