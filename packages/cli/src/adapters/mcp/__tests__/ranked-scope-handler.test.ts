import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { CODE_SCOPE, collectRankedScopes, withRankedScopes, type McpHandler } from '../ranked-scope-handler.js';
import { MaskingPipeline } from '../../../core/masking/masking-pipeline.js';
import type { CtxoModuleRegistration, LoadedModule, RankedContextScope } from '../../../ports/i-ctxo-module.js';

const masking = new MaskingPipeline();

function codeHandler(calls: Array<Record<string, unknown>>): McpHandler {
  return (args) => {
    calls.push(args);
    return { content: [{ type: 'text', text: JSON.stringify({ from: 'code' }) }] };
  };
}

function scope(name: string, search: RankedContextScope['search'], description = `"${name}": a stub scope.`): RankedContextScope {
  return { scope: name, description, search };
}

function scopesOf(...list: RankedContextScope[]): Map<string, RankedContextScope> {
  return new Map(list.map((s) => [s.scope, s]));
}

function moduleWith(name: string, registration: Omit<CtxoModuleRegistration, 'id'>): LoadedModule {
  return { name, version: '0.0.0', registration: { id: 'domain', ...registration } };
}

async function payloadOf(result: ReturnType<McpHandler>): Promise<Record<string, unknown>> {
  const resolved = await result;
  return JSON.parse(resolved.content[resolved.content.length - 1]!.text) as Record<string, unknown>;
}

describe('withRankedScopes', () => {
  it('without scopes the code handler is returned unchanged', () => {
    const code = codeHandler([]);

    expect(withRankedScopes(code, new Map(), masking)).toBe(code);
  });

  it('an absent scope and scope code use the code handler', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const search = vi.fn(() => ({ results: [] }));
    const handler = withRankedScopes(codeHandler(calls), scopesOf(scope('domain', search)), masking);

    expect(await payloadOf(handler({ query: 'loans' }))).toEqual({ from: 'code' });
    expect(await payloadOf(handler({ query: 'loans', scope: CODE_SCOPE }))).toEqual({ from: 'code' });
    expect(calls).toEqual([{ query: 'loans' }, { query: 'loans', scope: 'code' }]);
    expect(search).not.toHaveBeenCalled();
  });

  it('a module scope gets the query and budget and its result is wrapped and masked', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const seen: Array<{ query: string; tokenBudget: number }> = [];
    const handler = withRankedScopes(
      codeHandler(calls),
      scopesOf(
        scope('domain', (args) => {
          seen.push(args);
          return { results: [{ id: 'x' }], key: 'AKIAIOSFODNN7EXAMPLE' };
        }),
      ),
      masking,
    );

    const payload = await payloadOf(handler({ query: 'loans', scope: 'domain', strategy: 'importance' }));

    expect(seen).toEqual([{ query: 'loans', tokenBudget: 4000 }]);
    expect(calls).toEqual([]);
    expect(payload['results']).toEqual([{ id: 'x' }]);
    expect(payload['key']).toBe('[REDACTED:AWS_KEY]');
    expect(payload['_meta']).toMatchObject({ totalItems: 1, returnedItems: 1, truncated: false });
  });

  it('a module scope awaits an async search and passes the given budget', async () => {
    const seen: Array<{ query: string; tokenBudget: number }> = [];
    const handler = withRankedScopes(
      codeHandler([]),
      scopesOf(
        scope('domain', async (args) => {
          seen.push(args);
          return { results: [] };
        }),
      ),
      masking,
    );

    const payload = await payloadOf(handler({ query: 'loans', scope: 'domain', tokenBudget: 500 }));

    expect(seen).toEqual([{ query: 'loans', tokenBudget: 500 }]);
    expect(payload['results']).toEqual([]);
  });

  it('an unknown scope is an error', async () => {
    const handler = withRankedScopes(
      codeHandler([]),
      scopesOf(scope('zeta', () => ({})), scope('domain', () => ({}))),
      masking,
    );

    expect(await payloadOf(handler({ query: 'loans', scope: 'docs' }))).toEqual({
      error: true,
      message: 'Unknown scope "docs"; use one of: code, domain, zeta',
    });
  });

  it('an empty query is an error', async () => {
    const search = vi.fn(() => ({}));
    const handler = withRankedScopes(codeHandler([]), scopesOf(scope('domain', search)), masking);

    const empty = await payloadOf(handler({ query: '', scope: 'domain' }));
    const missing = await payloadOf(handler({ scope: 'domain' }));
    const lowBudget = await payloadOf(handler({ query: 'loans', scope: 'domain', tokenBudget: 99 }));

    for (const payload of [empty, missing, lowBudget]) {
      expect(payload['error']).toBe(true);
      expect(typeof payload['message']).toBe('string');
    }
    expect(search).not.toHaveBeenCalled();
  });

  it('a throwing scope becomes { error: true, message }', async () => {
    const handler = withRankedScopes(
      codeHandler([]),
      scopesOf(
        scope('domain', () => {
          throw new Error('graph missing AKIAIOSFODNN7EXAMPLE');
        }),
        scope('rejecting', () => Promise.reject(new Error('rejected'))),
        scope('empty', () => null as never),
      ),
      masking,
    );

    expect(await payloadOf(handler({ query: 'loans', scope: 'domain' }))).toEqual({
      error: true,
      message: 'graph missing [REDACTED:AWS_KEY]',
    });
    expect(await payloadOf(handler({ query: 'loans', scope: 'rejecting' }))).toEqual({ error: true, message: 'rejected' });
    expect((await payloadOf(handler({ query: 'loans', scope: 'empty' })))['error']).toBe(true);
  });
});

describe('collectRankedScopes', () => {
  let errorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function warnings(): string[] {
    return errorSpy.mock.calls.map((args) => args.map(String).join(' ')).filter((line) => line.includes('WARN'));
  }

  it('is empty without modules or scopes', () => {
    expect(collectRankedScopes([]).size).toBe(0);
    expect(collectRankedScopes([moduleWith('@ctxo/domain', {})]).size).toBe(0);
  });

  it('collectRankedScopes skips code and duplicates with a warning', () => {
    const first = scope('domain', () => ({ first: true }));
    const second = scope('domain', () => ({ second: true }));
    const docs = scope('docs', () => ({}));
    const reserved = scope('code', () => ({}));

    const scopes = collectRankedScopes([
      moduleWith('@ctxo/domain', { rankedContextScopes: [first, reserved, docs] }),
      moduleWith('@acme/other', { rankedContextScopes: [second] }),
    ]);

    expect([...scopes.keys()]).toEqual(['domain', 'docs']);
    expect(scopes.get('domain')).toBe(first);
    expect(warnings().some((line) => line.includes('@ctxo/domain scope "code" is skipped: reserved'))).toBe(true);
    expect(warnings().some((line) => line.includes('@acme/other scope "domain" is skipped: already registered'))).toBe(true);
  });

  it('skips a malformed scope and a module whose scopes cannot be read', () => {
    const exploding: LoadedModule = {
      name: '@ctxo/broken',
      version: '0.0.0',
      registration: {
        id: 'domain',
        get rankedContextScopes(): CtxoModuleRegistration['rankedContextScopes'] {
          throw new Error('getter exploded');
        },
      },
    };
    const malformed = [{ scope: 'nosearch', description: 'x' }, { scope: '', description: 'x', search: () => ({}) }] as unknown as RankedContextScope[];

    const scopes = collectRankedScopes([
      exploding,
      moduleWith('@ctxo/domain', { rankedContextScopes: [...malformed, scope('domain', () => ({}))] }),
      moduleWith('@ctxo/odd', { rankedContextScopes: 'not a list' as never }),
    ]);

    expect([...scopes.keys()]).toEqual(['domain']);
    expect(warnings().some((line) => line.includes('getter exploded'))).toBe(true);
    expect(warnings().filter((line) => line.includes('@ctxo/domain') && line.includes('without a name'))).toHaveLength(2);
    expect(warnings().some((line) => line.includes('@ctxo/odd'))).toBe(true);
  });
});
