import { describe, it, expect } from 'vitest';
import type { IWorkspace, PluginCapabilities, PluginContext } from '@ctxo/plugin-api';
import defaultPlugin, { plugin } from '../index.js';
import { JavaCompositeAdapter } from '../composite-adapter.js';

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

  it('the plugin keeps apiVersion 1', () => {
    expect(plugin.apiVersion).toBe('1');
    expect(plugin.id).toBe('java');
    expect(plugin.tier).toBe('full');
    expect(defaultPlugin).toBe(plugin);
  });
});
