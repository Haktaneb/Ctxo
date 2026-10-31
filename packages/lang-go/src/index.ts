import { createRequire } from 'node:module';
import type { CtxoLanguagePlugin, PluginContext, ILanguageAdapter } from '@ctxo/plugin-api';
import { GoCompositeAdapter } from './composite-adapter.js';
import { readFactOptions } from './facts/fact-options.js';

export { GoAdapter } from './go-adapter.js';
export { GoAnalyzerAdapter } from './analyzer/analyzer-adapter.js';
export { GoCompositeAdapter } from './composite-adapter.js';
export { TreeSitterAdapter } from './tree-sitter-adapter.js';

// package.json sits one level above both src/ and dist/, so the same path resolves in dev and when published.
const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

export const plugin: CtxoLanguagePlugin = {
  apiVersion: '1',
  id: 'go',
  name: 'Go (ctxo-go-analyzer + tree-sitter)',
  version: VERSION,
  extensions: ['.go'],
  tier: 'full',
  createAdapter(ctx: PluginContext): ILanguageAdapter {
    const facts = ctx.capabilities?.facts === true ? readFactOptions(ctx.config) : undefined;
    return new GoCompositeAdapter({ sqlCallSites: ctx.capabilities?.sqlCallSites === true, ...(facts ? { facts } : {}) });
  },
};

export default plugin;
