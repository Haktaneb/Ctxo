import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { MaskingPipeline } from '../../../core/masking/masking-pipeline.js';
import { z } from 'zod';
import { CORE_TOOL_NAMES, collectModuleTools, handleModuleTool, moduleInputShape } from '../module-tool-handler.js';
import type { LoadedModule } from '../../modules/module-loader.js';
import type { ModuleToolDefinition } from '../../../ports/i-ctxo-module.js';

function tool(name: string, handler: ModuleToolDefinition['handler']): ModuleToolDefinition {
  return { name, description: `${name} (stub)`, inputSchema: () => ({}), handler };
}

function moduleWithTools(tools: readonly ModuleToolDefinition[], name = '@ctxo/domain'): LoadedModule {
  return {
    name,
    version: '0.0.0',
    registration: {
      id: 'domain',
      registerTools: (registrar) => {
        for (const t of tools) registrar.registerTool(t);
      },
    },
  };
}

let errorSpy: MockInstance<typeof console.error>;

function warnings(): string[] {
  return errorSpy.mock.calls.map((args) => args.map(String).join(' ')).filter((line) => line.includes('WARN'));
}

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleModuleTool', () => {
  it('handleModuleTool wraps the result in _meta and masks it', async () => {
    const stub = tool('domain_stub', () => ({ results: [1, 2], key: 'AKIAIOSFODNN7EXAMPLE' }));

    const result = await handleModuleTool(stub, new MaskingPipeline(), undefined, () => [])({});

    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    expect(result.content[0]!.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.results).toEqual([1, 2]);
    expect(payload.key).toBe('[REDACTED:AWS_KEY]');
    expect(payload._meta).toMatchObject({ totalItems: 2, returnedItems: 2, truncated: false });
    expect(payload._meta.totalBytes).toEqual(expect.any(Number));
  });

  it('handleModuleTool awaits an async handler and passes the call args', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const stub = tool('domain_stub', async (args) => {
      seen.push(args);
      return { context: 'lending' };
    });

    const result = await handleModuleTool(stub, new MaskingPipeline(), undefined, () => [])({ id: 'lending' });

    expect(seen).toEqual([{ id: 'lending' }]);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ context: 'lending', _meta: { totalItems: 0 } });
  });

  it('handleModuleTool turns a thrown error into { error: true, message }', async () => {
    const throwing = tool('domain_stub', () => {
      throw new Error('registry exploded');
    });
    const rejecting = tool('domain_stub', async () => {
      throw new Error('registry rejected');
    });

    for (const [stub, message] of [[throwing, 'registry exploded'], [rejecting, 'registry rejected']] as const) {
      const result = await handleModuleTool(stub, new MaskingPipeline(), undefined, () => [])({});
      expect(result.content).toHaveLength(1);
      expect(JSON.parse(result.content[0]!.text)).toEqual({ error: true, message });
    }
  });

  it('handleModuleTool masks the message of a thrown error', async () => {
    const stub = tool('domain_stub', () => {
      throw new Error('bad key AKIAIOSFODNN7EXAMPLE');
    });

    const result = await handleModuleTool(stub, new MaskingPipeline(), undefined, () => [])({});

    expect(result.content[0]!.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(JSON.parse(result.content[0]!.text)).toEqual({ error: true, message: 'bad key [REDACTED:AWS_KEY]' });
  });

  it('handleModuleTool turns a result that is not an object into an error', async () => {
    for (const bad of [undefined, null, 'text', [1, 2]]) {
      const stub = tool('domain_stub', (() => bad) as unknown as ModuleToolDefinition['handler']);
      const payload = JSON.parse((await handleModuleTool(stub, new MaskingPipeline(), undefined, () => [])({})).content[0]!.text);
      expect(payload.error).toBe(true);
      expect(payload.message).toContain('domain_stub');
    }
  });

  it('prefixes the staleness warning when the index is stale', async () => {
    const checked: Array<readonly string[]> = [];
    const stale = {
      check: (files: readonly string[]) => {
        checked.push(files);
        return { message: 'Index stale' };
      },
    };
    const stub = tool('domain_stub', () => ({ results: [1] }));

    const result = await handleModuleTool(stub, new MaskingPipeline(), stale, () => ['src/a.ts'])({});

    expect(result.content).toHaveLength(2);
    expect(result.content[0]!.text).toContain('Index stale');
    expect(JSON.parse(result.content[1]!.text)._meta.totalItems).toBe(1);
    expect(checked).toEqual([['src/a.ts']]);

    const fresh = { check: () => undefined };
    const freshResult = await handleModuleTool(stub, new MaskingPipeline(), fresh, () => ['src/a.ts'])({});
    expect(freshResult.content).toHaveLength(1);
  });
});

describe('moduleInputShape', () => {
  it('builds the shape with the host zod and rejects one that is not an object of zod types', () => {
    const good: ModuleToolDefinition = { ...tool('domain_stub', () => ({})), inputSchema: (zod) => ({ id: zod.string() }) };
    expect(Object.keys(moduleInputShape(good, z))).toEqual(['id']);
    expect(moduleInputShape(tool('domain_empty', () => ({})), z)).toEqual({});

    const notZod = { ...good, inputSchema: () => ({ id: 'string' }) } as unknown as ModuleToolDefinition;
    const notObject = { ...good, inputSchema: () => null } as unknown as ModuleToolDefinition;
    const throwing = { ...good, inputSchema: () => { throw new Error('schema exploded'); } } as ModuleToolDefinition;
    expect(() => moduleInputShape(notZod, z)).toThrow(/zod types/);
    expect(() => moduleInputShape(notObject, z)).toThrow(/zod types/);
    expect(() => moduleInputShape(throwing, z)).toThrow('schema exploded');
  });
});

describe('collectModuleTools', () => {
  it('CORE_TOOL_NAMES holds the 14 core tools', () => {
    expect(CORE_TOOL_NAMES.size).toBe(14);
    expect(CORE_TOOL_NAMES.has('get_logic_slice')).toBe(true);
    expect(CORE_TOOL_NAMES.has('get_pr_impact')).toBe(true);
  });

  it('collects module tools in load order and skips one named like a core tool', () => {
    const stub = tool('domain_stub', () => ({}));
    const shadow = tool('get_logic_slice', () => ({}));
    const other = tool('domain_other', () => ({}));

    const tools = collectModuleTools([moduleWithTools([stub, shadow]), moduleWithTools([other])], CORE_TOOL_NAMES);

    expect(tools.map((t) => t.name)).toEqual(['domain_stub', 'domain_other']);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatch(/@ctxo\/domain[^\n]*"get_logic_slice"[^\n]*core tool/);
  });

  it('a second tool with the same name is skipped with a warning, the first one stays', () => {
    const first = tool('domain_stub', () => ({ first: true }));
    const second = tool('domain_stub', () => ({ second: true }));

    const tools = collectModuleTools([moduleWithTools([first, second])], CORE_TOOL_NAMES);

    expect(tools).toEqual([first]);
    expect(warnings()[0]).toContain('"domain_stub"');
  });

  it('skips a malformed tool and a module whose registerTools throws', () => {
    const malformed = { name: '', description: 'x', inputSchema: () => ({}), handler: () => ({}) } as ModuleToolDefinition;
    const noHandler = { name: 'domain_nohandler', description: 'x', inputSchema: () => ({}) } as unknown as ModuleToolDefinition;
    const broken: LoadedModule = {
      name: '@ctxo/domain',
      version: '0.0.0',
      registration: {
        id: 'domain',
        registerTools: () => {
          throw new Error('tools exploded');
        },
      },
    };
    const good = tool('domain_good', () => ({}));

    const tools = collectModuleTools([moduleWithTools([malformed, noHandler]), broken, moduleWithTools([good])], CORE_TOOL_NAMES);

    expect(tools.map((t) => t.name)).toEqual(['domain_good']);
    expect(warnings()).toHaveLength(3);
    expect(warnings().some((line) => line.includes('tools exploded'))).toBe(true);
  });

  it('returns no tools for modules without registerTools', () => {
    const plain: LoadedModule = { name: '@ctxo/domain', version: '0.0.0', registration: { id: 'domain' } };
    expect(collectModuleTools([plain], CORE_TOOL_NAMES)).toEqual([]);
    expect(collectModuleTools([], CORE_TOOL_NAMES)).toEqual([]);
  });
});
