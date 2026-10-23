import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CodeFact, ILanguageAdapter } from '@ctxo/plugin-api';
import { extractFileFacts, pluginFactRequest } from '../index-facts.js';
import type { CtxoConfig } from '../../core/config/config-schema.js';
import type { CtxoModuleRegistration, FactDetectorOptions, LoadedModule } from '../../ports/i-ctxo-module.js';

const FACT: CodeFact = { kind: 'endpoint', symbolId: 'src/a.fake::run::function', line: 3, text: 'GET /loans' };

function adapter(extra: Partial<ILanguageAdapter>): ILanguageAdapter {
  return {
    extractSymbols: async () => [],
    extractEdges: async () => [],
    extractComplexity: async () => [],
    isSupported: () => true,
    ...extra,
  };
}

describe('extractFileFacts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns undefined for an adapter without extractFacts', async () => {
    expect(await extractFileFacts(adapter({}), 'src/a.fake', 'x')).toBeUndefined();
    expect(await extractFileFacts(adapter({ extractFacts: async () => [FACT] }), 'src/a.fake', 'x')).toEqual([FACT]);
  });

  it('returns [] for an adapter whose extractFacts finds nothing', async () => {
    expect(await extractFileFacts(adapter({ extractFacts: async () => [] }), 'src/a.fake', 'x')).toEqual([]);
  });

  it('returns undefined and reports a throwing adapter', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await extractFileFacts(
      adapter({ extractFacts: async () => { throw new Error('boom'); } }),
      'src/a.fake',
      'x',
    );
    expect(result).toBeUndefined();
    expect(err).toHaveBeenCalledWith('[ctxo] Fact extraction failed for src/a.fake: boom');
  });
});

const O: FactDetectorOptions = { trivialLiterals: [0, 1, '', true, null], normalizationMethods: ['trim', 'toLowerCase'] };
const P: FactDetectorOptions = { trivialLiterals: [], normalizationMethods: ['normalize'] };

function mod(indexCapabilities: CtxoModuleRegistration['indexCapabilities']): LoadedModule {
  return { name: '@ctxo/domain', version: '0.0.0', registration: { id: 'domain', indexCapabilities } };
}

describe('pluginFactRequest', () => {
  const noConfig: CtxoConfig = {} as CtxoConfig;
  const factsOn = { index: { facts: true } } as unknown as CtxoConfig;

  it.each([
    ['no config, no modules', noConfig, [], { facts: false }],
    ['index.facts: true', factsOn, [], { facts: true }],
    ['a module with facts and options', noConfig, [mod({ facts: true, factOptions: O })], { facts: true, factOptions: O }],
    ['two modules with options', noConfig, [mod({ facts: true, factOptions: O }), mod({ facts: true, factOptions: P })], { facts: true, factOptions: O }],
    ['a module with options but no facts', noConfig, [mod({ factOptions: O })], { facts: false }],
  ] as const)('pluginFactRequest combines index.facts with module requests: %s', (_name, config, modules, expected) => {
    expect(pluginFactRequest(config, modules)).toStrictEqual(expected);
  });
});
