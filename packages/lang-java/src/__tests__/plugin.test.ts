import { describe, it, expect } from 'vitest';
import type { IWorkspace, PluginCapabilities, PluginContext } from '@ctxo/plugin-api';
import defaultPlugin, { plugin } from '../index.js';
import { JavaCompositeAdapter } from '../composite-adapter.js';
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

describe('java plugin', () => {
  it('createAdapter enables SQL call sites only when capabilities.sqlCallSites is true', () => {
    const adapters = [context(), context({ sqlCallSites: false }), context({ sqlCallSites: true })].map((ctx) =>
      plugin.createAdapter(ctx),
    );

    for (const adapter of adapters) expect(adapter).toBeInstanceOf(JavaCompositeAdapter);
    expect(adapters.map((adapter) => (adapter as JavaCompositeAdapter).sqlCallSites)).toEqual([false, false, true]);
  });

  it('createAdapter enables facts only with capabilities.facts', () => {
    const facts = (ctx: PluginContext) => (plugin.createAdapter(ctx) as JavaCompositeAdapter).facts;
    const withConfig = (capabilities: PluginCapabilities | undefined, config: Record<string, unknown>): PluginContext => ({
      ...context(capabilities),
      config,
    });

    expect(facts(context())).toBeUndefined();
    expect(facts(context({ facts: false }))).toBeUndefined();
    expect(facts(withConfig({ facts: false }, { facts: { trivialLiterals: [5] } }))).toBeUndefined();
    expect(facts(context({ facts: true }))).toEqual(DEFAULT_FACT_OPTIONS);
    expect(facts(withConfig({ facts: true }, { facts: { trivialLiterals: [5], normalizationMethods: ['trim'] } }))).toEqual({
      trivialLiterals: [5],
      normalizationMethods: ['trim'],
    });
    expect(facts(withConfig({ facts: true, sqlCallSites: true }, { facts: { trivialLiterals: 'x' } }))).toEqual(DEFAULT_FACT_OPTIONS);
    expect((plugin.createAdapter(context({ facts: true, sqlCallSites: true })) as JavaCompositeAdapter).sqlCallSites).toBe(true);
  });

  it('the plugin keeps apiVersion 1', () => {
    expect(plugin.apiVersion).toBe('1');
    expect(plugin.id).toBe('java');
    expect(plugin.tier).toBe('full');
    expect(defaultPlugin).toBe(plugin);
  });
});
