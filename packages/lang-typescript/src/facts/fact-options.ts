// Shared fact options (PR 4, issue #156). Copied unchanged into every official language plugin and
// @ctxo/domain; only import paths may differ.
import type { FactOptions, TrivialLiteral } from './fact-types.js';

/** The spec 12.1 lists: trivial literals and normalization methods, in spec order. */
export const DEFAULT_FACT_OPTIONS: FactOptions = {
  trivialLiterals: [0, 1, -1, null, true, false, ''],
  normalizationMethods: [
    'ToLower*',
    'ToUpper*',
    'Trim*',
    'Normalize',
    'toLowerCase',
    'toUpperCase',
    'trim',
    'strings.ToLower',
    'strings.TrimSpace',
    'equalsIgnoreCase',
  ],
};

const METHOD_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_$][A-Za-z0-9_$]*\*?$/;

function isTrivialLiteralValue(value: unknown): value is TrivialLiteral {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Reads `config.facts` (the host-reserved key of `PluginContext.config`). Each field falls back to
 * its default on its own when absent or invalid.
 */
export function readFactOptions(config: Readonly<Record<string, unknown>> | undefined): FactOptions {
  const raw = config?.['facts'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_FACT_OPTIONS;
  const facts = raw as Readonly<Record<string, unknown>>;

  const literals = facts['trivialLiterals'];
  const methods = facts['normalizationMethods'];
  return {
    trivialLiterals: Array.isArray(literals) && literals.every(isTrivialLiteralValue)
      ? [...(literals as TrivialLiteral[])]
      : DEFAULT_FACT_OPTIONS.trivialLiterals,
    normalizationMethods: Array.isArray(methods) && methods.every(m => typeof m === 'string' && METHOD_PATTERN.test(m))
      ? [...(methods as string[])]
      : DEFAULT_FACT_OPTIONS.normalizationMethods,
  };
}

/** The analyzer `--facts=` value: standard base64 of the UTF-8 JSON `{"normalizationMethods":[...]}`. */
export function encodeFactOptions(options: FactOptions): string {
  return Buffer.from(JSON.stringify({ normalizationMethods: [...options.normalizationMethods] }), 'utf8').toString('base64');
}
