import type { CtxoLanguagePlugin, PluginContext, ILanguageAdapter } from '@ctxo/plugin-api';
import { TsMorphAdapter } from './ts-morph-adapter.js';
import { readFactOptions } from './facts/fact-options.js';

export { TsMorphAdapter } from './ts-morph-adapter.js';

const VERSION = '0.7.0-alpha.0';

export const plugin: CtxoLanguagePlugin = {
  apiVersion: '1',
  id: 'typescript',
  name: 'TypeScript / JavaScript (ts-morph)',
  version: VERSION,
  extensions: ['.ts', '.tsx', '.js', '.jsx'],
  tier: 'full',
  createAdapter(ctx: PluginContext): ILanguageAdapter {
    const facts = ctx.capabilities?.facts === true ? readFactOptions(ctx.config) : undefined;
    return new TsMorphAdapter({
      sqlCallSites: ctx.capabilities?.sqlCallSites === true,
      projectRoot: ctx.projectRoot,
      ...(facts ? { facts } : {}),
    });
  },
};

export default plugin;
