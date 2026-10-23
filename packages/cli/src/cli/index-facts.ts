import type { CodeFact, ILanguageAdapter } from '@ctxo/plugin-api';
import type { CtxoConfig } from '../core/config/config-schema.js';
import { factsRequested } from '../core/config/load-config.js';
import type { FactDetectorOptions, LoadedModule } from '../ports/i-ctxo-module.js';

/** The fact request `ctxo index` and `ctxo watch` hand to the plugins. */
export interface PluginFactRequest {
  readonly facts: boolean;
  readonly factOptions?: FactDetectorOptions;
}

/**
 * Facts are requested by `index.facts: true` or by a loaded module that asks for them. The detector options
 * come from the first module (load order) that declares them, and only when facts are requested.
 */
export function pluginFactRequest(config: CtxoConfig, modules: readonly LoadedModule[]): PluginFactRequest {
  const facts = factsRequested(config) || modules.some((module) => module.registration.indexCapabilities?.facts === true);
  if (!facts) return { facts };
  const factOptions = modules.find((module) => module.registration.indexCapabilities?.factOptions !== undefined)
    ?.registration.indexCapabilities?.factOptions;
  return factOptions ? { facts, factOptions } : { facts };
}

/**
 * The facts one adapter extracts from one file. `[]` when the adapter has `extractFacts` and finds nothing;
 * `undefined` when the adapter has no `extractFacts` or when it throws (the failure is reported and indexing
 * carries on without facts).
 */
export async function extractFileFacts(
  adapter: ILanguageAdapter,
  relativePath: string,
  source: string,
): Promise<CodeFact[] | undefined> {
  if (typeof adapter.extractFacts !== 'function') return undefined;
  try {
    return await adapter.extractFacts(relativePath, source);
  } catch (err) {
    console.error(`[ctxo] Fact extraction failed for ${relativePath}: ${(err as Error).message}`);
    return undefined;
  }
}
