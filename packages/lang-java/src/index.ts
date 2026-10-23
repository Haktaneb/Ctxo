import type { CtxoLanguagePlugin, PluginContext, ILanguageAdapter } from '@ctxo/plugin-api';
import { JavaCompositeAdapter } from './composite-adapter.js';
import { readFactOptions } from './facts/fact-options.js';

export { JavaAdapter } from './java-adapter.js';
export { JavaCompositeAdapter } from './composite-adapter.js';
export { TreeSitterAdapter } from './tree-sitter-adapter.js';

const VERSION = '0.8.0-alpha.0';

export const plugin: CtxoLanguagePlugin = {
  apiVersion: '1',
  id: 'java',
  name: 'Java (ctxo-jdt-analyzer + tree-sitter)',
  version: VERSION,
  extensions: ['.java'],
  tier: 'full',
  createAdapter(ctx: PluginContext): ILanguageAdapter {
    const facts = ctx.capabilities?.facts === true ? readFactOptions(ctx.config) : undefined;
    return new JavaCompositeAdapter({ sqlCallSites: ctx.capabilities?.sqlCallSites === true, ...(facts ? { facts } : {}) });
  },
};

export default plugin;
