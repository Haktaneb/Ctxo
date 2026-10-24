import { createRequire } from 'node:module';
import type { CtxoLanguagePlugin, PluginContext, ILanguageAdapter } from '@ctxo/plugin-api';
import { CSharpCompositeAdapter } from './composite-adapter.js';
import { readFactOptions } from './facts/fact-options.js';

export { CSharpCompositeAdapter } from './composite-adapter.js';
export { CSharpAdapter } from './csharp-adapter.js';
export { RoslynAdapter } from './roslyn/roslyn-adapter.js';
export { TreeSitterAdapter } from './tree-sitter-adapter.js';

// package.json sits one level above both src/ and dist/, so the same path resolves in dev and when published.
const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

export const plugin: CtxoLanguagePlugin = {
  apiVersion: '1',
  id: 'csharp',
  name: 'C# (Roslyn full tier, tree-sitter fallback)',
  version: VERSION,
  extensions: ['.cs'],
  // Plugin advertises full-tier capability; the composite adapter downgrades to
  // syntax at runtime when .NET SDK 8+ is unavailable.
  tier: 'full',
  createAdapter(ctx: PluginContext): ILanguageAdapter {
    // SQL call-site edges only when a SQL plugin is loaded (protocol v2 capability; absent on v1 cores).
    // Facts only when the host asks for them; their options come from the host-reserved `config.facts`.
    const facts = ctx.capabilities?.facts === true ? readFactOptions(ctx.config) : undefined;
    return new CSharpCompositeAdapter({ sqlCallSites: ctx.capabilities?.sqlCallSites === true, ...(facts ? { facts } : {}) });
  },
};

export default plugin;
