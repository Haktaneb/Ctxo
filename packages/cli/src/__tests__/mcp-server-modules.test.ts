import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../mcp-server.js';
import { SqliteStorageAdapter } from '../adapters/storage/sqlite-storage-adapter.js';
import { MaskingPipeline } from '../core/masking/masking-pipeline.js';
import { CORE_TOOL_NAMES } from '../adapters/mcp/module-tool-handler.js';
import type { LoadedModule } from '../adapters/modules/module-loader.js';
import type { CoreToolName, CtxoModuleRegistration, ModuleToolDefinition, ResponseEnricher } from '../ports/i-ctxo-module.js';
import type { IGitPort } from '../ports/i-git-port.js';
import type { FileIndex } from '../core/types.js';

/** a.ts::A calls b.ts::B. */
function buildIndices(): FileIndex[] {
  return [
    {
      file: 'src/a.ts',
      lastModified: 1,
      symbols: [{ symbolId: 'src/a.ts::A::function', name: 'A', kind: 'function', startLine: 1, endLine: 10 }],
      edges: [{ from: 'src/a.ts::A::function', to: 'src/b.ts::B::class', kind: 'calls' }],
      intent: [],
      antiPatterns: [],
    },
    {
      file: 'src/b.ts',
      lastModified: 1,
      symbols: [{ symbolId: 'src/b.ts::B::class', name: 'B', kind: 'class', startLine: 1, endLine: 30 }],
      edges: [],
      intent: [],
      antiPatterns: [],
    },
  ];
}

const git: IGitPort = {
  getCommitHistory: async () => [{ hash: 'abc', message: 'feat: add B', date: '2026-01-01', author: 'dev' }],
  getFileChurn: async (filePath: string) => ({ filePath, commitCount: 1 }),
  getChangedFiles: async () => ['src/b.ts'],
  isAvailable: async () => true,
};

/** A stub module tool that echoes its args, with a secret-like key and a two-entry list. */
function stubTool(seen: Array<Record<string, unknown>>): ModuleToolDefinition {
  return {
    name: 'domain_stub',
    description: 'Stub module tool',
    inputSchema: (zod) => ({ id: zod.string().describe('A context id') }),
    handler: (args) => {
      seen.push(args);
      return { results: [1, 2], key: 'AKIAIOSFODNN7EXAMPLE' };
    },
  };
}

function moduleWith(registration: Omit<CtxoModuleRegistration, 'id'>): LoadedModule {
  return { name: '@ctxo/domain', version: '0.0.0', registration: { id: 'domain', ...registration } };
}

describe('registerTools with modules', () => {
  let tempDir: string;
  let storage: SqliteStorageAdapter;
  let errorSpy: MockInstance<typeof console.error>;
  const clients: Client[] = [];

  beforeEach(async () => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'ctxo-mcp-modules-'));
    storage = new SqliteStorageAdapter(tempDir);
    await storage.initEmpty();
    storage.bulkWrite(buildIndices());
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    storage.close();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function connect(modules?: readonly LoadedModule[]): Promise<Client> {
    const server = new McpServer({ name: 'ctxo', version: '0.0.0' });
    registerTools(server, storage, new MaskingPipeline(), git, undefined, null, tempDir, undefined, undefined, modules);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'mcp-server-modules-test', version: '0.0.0' });
    await client.connect(clientTransport);
    clients.push(client);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }> };
    return JSON.parse(result.content[result.content.length - 1]!.text) as Record<string, unknown>;
  }

  function warnings(): string[] {
    return errorSpy.mock.calls.map((args) => args.map(String).join(' ')).filter((line) => line.includes('WARN'));
  }

  it('registerTools without modules registers exactly the 14 core tools', async () => {
    const client = await connect();

    const names = (await client.listTools()).tools.map((t) => t.name);

    expect(names).toHaveLength(14);
    expect([...names].sort()).toEqual([...CORE_TOOL_NAMES].sort());
  });

  it('registerTools adds module tools and skips one named like a core tool', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const shadow: ModuleToolDefinition = {
      name: 'get_logic_slice',
      description: 'Shadows a core tool',
      inputSchema: () => ({}),
      handler: () => ({ shadowed: true }),
    };
    const client = await connect([
      moduleWith({
        registerTools: (registrar) => {
          registrar.registerTool(stubTool(seen));
          registrar.registerTool(shadow);
        },
      }),
    ]);

    const tools = (await client.listTools()).tools;

    expect(tools.map((t) => t.name).sort()).toEqual([...CORE_TOOL_NAMES, 'domain_stub'].sort());
    expect(warnings().some((line) => line.includes('"get_logic_slice"') && line.includes('core tool'))).toBe(true);
    // The core tool keeps its own description, and the module tool gets the core annotations.
    expect(tools.find((t) => t.name === 'get_logic_slice')!.description).toMatch(/^Retrieve a symbol and all its transitive dependencies/);
    const stub = tools.find((t) => t.name === 'domain_stub')!;
    expect(stub.description).toBe('Stub module tool');
    expect(stub.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(Object.keys((stub.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})).toEqual(['id']);

    // Calling the stub returns its payload wrapped in _meta and masked.
    const payload = await call(client, 'domain_stub', { id: 'lending' });
    expect(seen).toEqual([{ id: 'lending' }]);
    expect(payload['results']).toEqual([1, 2]);
    expect(payload['key']).toBe('[REDACTED:AWS_KEY]');
    expect(payload['_meta']).toMatchObject({ totalItems: 2, returnedItems: 2, truncated: false });

    // The shadowing handler never runs: get_logic_slice is still the core tool.
    const slice = await call(client, 'get_logic_slice', { symbolId: 'src/a.ts::A::function' });
    expect(slice['shadowed']).toBeUndefined();
    expect((slice['root'] as { symbolId: string }).symbolId).toBe('src/a.ts::A::function');
  });

  it('a module tool whose input schema cannot be built is skipped and the server still starts', async () => {
    const broken: ModuleToolDefinition = {
      name: 'domain_broken',
      description: 'Broken schema',
      inputSchema: () => {
        throw new Error('schema exploded');
      },
      handler: () => ({}),
    };
    // Not zod types: registering it would only fail later, when a client lists the tools.
    const notZod = {
      name: 'domain_not_zod',
      description: 'Plain object schema',
      inputSchema: () => ({ id: 'string' }),
      handler: () => ({}),
    } as unknown as ModuleToolDefinition;
    const client = await connect([
      moduleWith({
        registerTools: (registrar) => {
          registrar.registerTool(broken);
          registrar.registerTool(notZod);
          registrar.registerTool(stubTool([]));
        },
      }),
    ]);

    const names = (await client.listTools()).tools.map((t) => t.name);

    expect(names).toHaveLength(15);
    expect(names).toContain('domain_stub');
    expect(names).not.toContain('domain_broken');
    expect(names).not.toContain('domain_not_zod');
    expect(warnings().some((line) => line.includes('domain_broken') && line.includes('schema exploded'))).toBe(true);
    expect(warnings().some((line) => line.includes('domain_not_zod') && line.includes('zod types'))).toBe(true);
  });

  it('module enrichers reach the six core tools they name', async () => {
    const SIX: readonly CoreToolName[] = [
      'search_symbols',
      'get_blast_radius',
      'find_importers',
      'get_logic_slice',
      'get_pr_impact',
      'get_why_context',
    ];
    const enrich: Partial<Record<CoreToolName, ResponseEnricher>> = {};
    for (const tool of SIX) enrich[tool] = (payload) => ({ ...payload, enrichedBy: tool });
    const client = await connect([moduleWith({ enrich })]);

    const calls: Record<(typeof SIX)[number], Record<string, unknown>> = {
      search_symbols: { pattern: 'B' },
      get_blast_radius: { symbolId: 'src/b.ts::B::class' },
      find_importers: { symbolId: 'src/b.ts::B::class' },
      get_logic_slice: { symbolId: 'src/a.ts::A::function' },
      get_pr_impact: {},
      get_why_context: { symbolId: 'src/a.ts::A::function' },
    };
    for (const tool of SIX) {
      const payload = await call(client, tool, calls[tool]);
      expect(payload['error'], tool).toBeUndefined();
      expect(payload['enrichedBy'], tool).toBe(tool);
      expect(payload['_meta'], tool).toBeDefined();
    }
  });
});
