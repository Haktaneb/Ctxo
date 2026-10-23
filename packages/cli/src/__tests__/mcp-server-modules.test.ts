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
import { handleGetRankedContext } from '../adapters/mcp/get-ranked-context.js';
import type {
  CoreToolName,
  CtxoModuleRegistration,
  ModuleToolDefinition,
  RankedContextScope,
  ResponseEnricher,
} from '../ports/i-ctxo-module.js';
import type { IGitPort } from '../ports/i-git-port.js';
import type { ISessionRecorderPort, SessionEvent } from '../ports/i-session-recorder-port.js';
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

/** get_ranked_context as the tip before ranked scopes lists it, byte for byte. */
const RANKED_CONTEXT_TOOL_WITHOUT_SCOPES =
  "{\"name\":\"get_ranked_context\",\"description\":\"Search and rank symbols by relevance to a natural language query, packed within a token budget. Uses BM25 text matching + PageRank importance scoring. Results include `_meta` with truncation info. Use this when you have a question or topic but do not know which specific symbol to look at. For exact symbol name search, use search_symbols instead.\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\",\"minLength\":1,\"description\":\"Search query (matches symbol names)\"},\"tokenBudget\":{\"default\":4000,\"description\":\"Max tokens for results (default 4000)\",\"type\":\"number\"},\"strategy\":{\"default\":\"combined\",\"description\":\"Ranking strategy\",\"type\":\"string\",\"enum\":[\"combined\",\"dependency\",\"importance\"]},\"searchMode\":{\"default\":\"fts\",\"description\":\"\\\"fts\\\" (default): BM25 ranking with camelCase splitting, trigram fallback and typo correction; \\\"legacy\\\": substring matching; strategy \\\"importance\\\" always uses legacy matching\",\"type\":\"string\",\"enum\":[\"fts\",\"legacy\"]}},\"required\":[\"query\"],\"$schema\":\"http://json-schema.org/draft-07/schema#\"},\"annotations\":{\"readOnlyHint\":true,\"destructiveHint\":false,\"idempotentHint\":true,\"openWorldHint\":false},\"execution\":{\"taskSupport\":\"forbidden\"}}";

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

  async function connect(modules?: readonly LoadedModule[], recorder: ISessionRecorderPort | null = null): Promise<Client> {
    const server = new McpServer({ name: 'ctxo', version: '0.0.0' });
    registerTools(server, storage, new MaskingPipeline(), git, undefined, recorder, tempDir, undefined, undefined, modules);
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

  it('a module tool call is recorded in the session stats like a core tool call (R23)', async () => {
    const events: SessionEvent[] = [];
    const recorder: ISessionRecorderPort = {
      record: (event) => events.push(event),
      queryStats: () => ({ totalCalls: 0, totalTokensServed: 0, topTools: [], topSymbols: [], detailLevelDistribution: [] }),
      clear: () => undefined,
    };
    const client = await connect([moduleWith({ registerTools: (registrar) => registrar.registerTool(stubTool([])) })], recorder);

    await call(client, 'domain_stub', { id: 'lending' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: 'domain_stub', truncated: false });
    expect(events[0]!.responseBytes).toBeGreaterThan(0);
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

  it('module enrichers reach the seven core tools they name', async () => {
    const SEVEN: readonly CoreToolName[] = [
      'search_symbols',
      'get_blast_radius',
      'find_importers',
      'get_logic_slice',
      'get_pr_impact',
      'get_why_context',
      'get_context_for_task',
    ];
    const enrich: Partial<Record<CoreToolName, ResponseEnricher>> = {};
    for (const tool of SEVEN) enrich[tool] = (payload) => ({ ...payload, enrichedBy: tool });
    const client = await connect([moduleWith({ enrich })]);

    const calls: Record<(typeof SEVEN)[number], Record<string, unknown>> = {
      search_symbols: { pattern: 'B' },
      get_blast_radius: { symbolId: 'src/b.ts::B::class' },
      find_importers: { symbolId: 'src/b.ts::B::class' },
      get_logic_slice: { symbolId: 'src/a.ts::A::function' },
      get_pr_impact: {},
      get_why_context: { symbolId: 'src/a.ts::A::function' },
      get_context_for_task: { symbolId: 'src/a.ts::A::function', taskType: 'understand' },
    };
    for (const tool of SEVEN) {
      const payload = await call(client, tool, calls[tool]);
      expect(payload['error'], tool).toBeUndefined();
      expect(payload['enrichedBy'], tool).toBe(tool);
      expect(payload['_meta'], tool).toBeDefined();
    }
  });

  it('get_context_for_task receives the module reservation and enricher', async () => {
    const reserveArgs: Array<Readonly<Record<string, unknown>>> = [];
    const client = await connect([
      moduleWith({
        reserveTaskContextTokens: (args) => {
          reserveArgs.push(args);
          return 200;
        },
        enrich: { get_context_for_task: (payload) => ({ ...payload, enrichedBy: 'get_context_for_task' }) },
      }),
    ]);

    const payload = await call(client, 'get_context_for_task', { symbolId: 'src/a.ts::A::function', taskType: 'understand' });

    expect(payload['error']).toBeUndefined();
    expect(payload['enrichedBy']).toBe('get_context_for_task');
    expect(payload['tokenBudget']).toBe(4000);
    expect(payload['_meta']).toBeDefined();
    expect(reserveArgs).toEqual([{ symbolId: 'src/a.ts::A::function', taskType: 'understand', tokenBudget: 4000 }]);
  });

  it('get_ranked_context registers scope only when a module provides one', async () => {
    const seen: Array<{ query: string; tokenBudget: number }> = [];
    const domain: RankedContextScope = {
      scope: 'domain',
      description: '"domain": card sections from a stub.',
      search: (args) => {
        seen.push(args);
        return { query: args.query, scope: 'domain', results: [{ id: 'card:lending' }] };
      },
    };
    const without = await connect();
    const withScope = await connect([moduleWith({ rankedContextScopes: [domain] })]);

    const rankedOf = async (client: Client) => (await client.listTools()).tools.find((t) => t.name === 'get_ranked_context')!;
    const plainProps = (await rankedOf(without)).inputSchema.properties as Record<string, unknown>;
    const scopedProps = (await rankedOf(withScope)).inputSchema.properties as Record<string, Record<string, unknown>>;

    expect(plainProps['scope']).toBeUndefined();
    expect(scopedProps['scope']).toMatchObject({
      enum: ['code', 'domain'],
      default: 'code',
      description: 'Where to search. "code" (default): rank symbols. "domain": card sections from a stub.',
    });

    const payload = await call(withScope, 'get_ranked_context', { query: 'loans', scope: 'domain' });
    expect(seen).toEqual([{ query: 'loans', tokenBudget: 4000 }]);
    expect(payload['results']).toEqual([{ id: 'card:lending' }]);
    expect(payload['scope']).toBe('domain');
    expect(payload['_meta']).toMatchObject({ totalItems: 1, returnedItems: 1, truncated: false });

    // scope "code" (the default) still ranks symbols.
    const code = await call(withScope, 'get_ranked_context', { query: 'B' });
    expect(code['query']).toBe('B');
    expect(code['scope']).toBeUndefined();
  });

  it('get_ranked_context lists several scopes in name order', async () => {
    const stub = (scope: string): RankedContextScope => ({ scope, description: `"${scope}": stub.`, search: () => ({}) });
    const client = await connect([moduleWith({ rankedContextScopes: [stub('zeta'), stub('domain')] })]);

    const ranked = (await client.listTools()).tools.find((t) => t.name === 'get_ranked_context')!;
    const scopeProp = (ranked.inputSchema.properties as Record<string, Record<string, unknown>>)['scope'];

    expect(scopeProp).toMatchObject({
      enum: ['code', 'domain', 'zeta'],
      description: 'Where to search. "code" (default): rank symbols. "domain": stub. "zeta": stub.',
    });
  });

  it('without a module scope get_ranked_context lists and answers exactly as before', async () => {
    const plain = await connect();
    const noScopes = await connect([moduleWith({ enrich: { search_symbols: (payload) => payload } })]);

    for (const client of [plain, noScopes]) {
      const ranked = (await client.listTools()).tools.find((t) => t.name === 'get_ranked_context');
      expect(JSON.stringify(ranked)).toBe(RANKED_CONTEXT_TOOL_WITHOUT_SCOPES);

      const args = { query: 'B', tokenBudget: 4000, strategy: 'combined', searchMode: 'fts' };
      const served = await client.callTool({ name: 'get_ranked_context', arguments: args });
      const direct = handleGetRankedContext(storage, new MaskingPipeline(), undefined, tempDir)(args);
      // Byte for byte except the measured search latency (and the byte count its digits change).
      const stable = (content: Array<{ type: string; text: string }>) =>
        content.map((c) => ({
          ...c,
          text: c.text.replace(/"latencyMs":[0-9.e+-]+/, '"latencyMs":0').replace(/"totalBytes":\d+/, '"totalBytes":0'),
        }));
      expect(stable((served as { content: Array<{ type: string; text: string }> }).content)).toEqual(stable(direct.content));
    }
  });
});
