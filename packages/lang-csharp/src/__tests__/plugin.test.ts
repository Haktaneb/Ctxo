import { describe, it, expect } from 'vitest';
import type { IWorkspace, PluginCapabilities, PluginContext } from '@ctxo/plugin-api';
import { plugin } from '../index.js';
import { CSharpCompositeAdapter } from '../composite-adapter.js';
import { DEFAULT_FACT_OPTIONS } from '../facts/fact-options.js';

function context(capabilities?: PluginCapabilities): PluginContext {
  const noop = (): void => {};
  return {
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    projectRoot: '/work/lending',
    workspace: {} as IWorkspace,
    config: {},
    ...(capabilities ? { capabilities } : {}),
  };
}

describe('csharp plugin', () => {
  it('createAdapter enables SQL call sites only when capabilities.sqlCallSites is true', () => {
    const adapters = [context(), context({ sqlCallSites: false }), context({ sqlCallSites: true })].map(
      (ctx) => plugin.createAdapter(ctx),
    );

    for (const adapter of adapters) expect(adapter).toBeInstanceOf(CSharpCompositeAdapter);
    expect(adapters.map((adapter) => (adapter as CSharpCompositeAdapter).sqlCallSites)).toEqual([false, false, true]);
  });

  it('createAdapter enables facts only with capabilities.facts and reads config.facts', async () => {
    const config = { facts: { normalizationMethods: ['Trim'] } };
    const off = [context(), context({ facts: false }), { ...context(), config }].map(
      (ctx) => plugin.createAdapter(ctx) as CSharpCompositeAdapter,
    );
    for (const adapter of off) {
      expect(adapter.facts).toBeUndefined();
      await expect(adapter.extractFacts('Loans/Key.cs', 'class Key {}')).resolves.toEqual([]);
    }

    const on = plugin.createAdapter({ ...context({ facts: true }), config }) as CSharpCompositeAdapter;
    expect(on.facts).toEqual({ trivialLiterals: DEFAULT_FACT_OPTIONS.trivialLiterals, normalizationMethods: ['Trim'] });

    const defaults = plugin.createAdapter(context({ facts: true })) as CSharpCompositeAdapter;
    expect(defaults.facts).toEqual(DEFAULT_FACT_OPTIONS);
  });
});
