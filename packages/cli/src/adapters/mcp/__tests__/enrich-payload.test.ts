import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { applyEnricher, collectEnrichers } from '../enrich-payload.js';
import type { LoadedModule } from '../../modules/module-loader.js';
import type { CtxoModuleRegistration, ResponseEnricher } from '../../../ports/i-ctxo-module.js';

function moduleWith(enrich: CtxoModuleRegistration['enrich'], name = '@ctxo/domain'): LoadedModule {
  return { name, version: '0.0.0', registration: { id: 'domain', enrich } };
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

describe('applyEnricher', () => {
  it('applyEnricher returns the enriched payload', () => {
    const seen: Array<Readonly<Record<string, unknown>>> = [];
    const enrich: ResponseEnricher = (payload, args) => {
      seen.push(args);
      return { ...payload, enrichedBy: 'stub' };
    };

    const result = applyEnricher(enrich, { results: [1] }, { pattern: 'x' }, 'search_symbols');

    expect(result).toEqual({ results: [1], enrichedBy: 'stub' });
    expect(seen).toEqual([{ pattern: 'x' }]);
    expect(warnings()).toEqual([]);
  });

  it('applyEnricher returns the payload itself without an enricher', () => {
    const payload = { results: [] };
    expect(applyEnricher(undefined, payload, {}, 'search_symbols')).toBe(payload);
    expect(warnings()).toEqual([]);
  });

  it('applyEnricher keeps the original payload when the enricher throws', () => {
    const payload: Record<string, unknown> = { impactedSymbols: [{ symbolId: 'src/a.ts::A::function' }] };
    // Writes into the payload it was handed, then throws: none of that may reach the response.
    const enrich: ResponseEnricher = (draft) => {
      (draft['impactedSymbols'] as Array<Record<string, unknown>>)[0]!['context'] = 'half-done';
      draft['extra'] = 1;
      throw new Error('registry exploded');
    };

    const result = applyEnricher(enrich, payload, {}, 'get_blast_radius');

    expect(result).toBe(payload);
    expect(payload).toEqual({ impactedSymbols: [{ symbolId: 'src/a.ts::A::function' }] });
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('get_blast_radius');
    expect(warnings()[0]).toContain('registry exploded');
  });

  it('applyEnricher keeps the original payload when the enricher returns something that is not an object', () => {
    const payload = { results: [] };
    for (const bad of [undefined, null, 'text', [1, 2]]) {
      const enrich = (() => bad) as unknown as ResponseEnricher;
      expect(applyEnricher(enrich, payload, {}, 'find_importers')).toBe(payload);
    }
    expect(warnings()).toHaveLength(4);
    expect(warnings().every((line) => line.includes('find_importers'))).toBe(true);
  });
});

describe('collectEnrichers', () => {
  it('collectEnrichers composes several modules in load order', () => {
    const order: string[] = [];
    const first = moduleWith({
      search_symbols: (payload) => {
        order.push('first');
        return { ...payload, first: true };
      },
    });
    const second = moduleWith({
      search_symbols: (payload) => {
        order.push('second');
        // The second enricher sees what the first one added.
        return { ...payload, second: payload['first'] === true };
      },
      get_why_context: (payload) => ({ ...payload, why: true }),
    });

    const enrichers = collectEnrichers([first, second]);

    expect([...enrichers.keys()].sort()).toEqual(['get_why_context', 'search_symbols']);
    expect(applyEnricher(enrichers.get('search_symbols'), { results: [] }, {}, 'search_symbols')).toEqual({
      results: [],
      first: true,
      second: true,
    });
    expect(order).toEqual(['first', 'second']);
    expect(applyEnricher(enrichers.get('get_why_context'), {}, {}, 'get_why_context')).toEqual({ why: true });
  });

  it('collectEnrichers keeps the fields of earlier modules when a later enricher throws', () => {
    const first = moduleWith({ get_pr_impact: (payload) => ({ ...payload, first: true }) });
    const second = moduleWith({
      get_pr_impact: () => {
        throw new Error('second exploded');
      },
    });

    const enrich = collectEnrichers([first, second]).get('get_pr_impact');

    expect(applyEnricher(enrich, { files: [] }, {}, 'get_pr_impact')).toEqual({ files: [], first: true });
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('second exploded');
  });

  it('collectEnrichers ignores modules without enrich and entries that are not functions', () => {
    const none = moduleWith(undefined);
    const broken = moduleWith({ get_logic_slice: 'not a function' } as unknown as CtxoModuleRegistration['enrich']);

    expect(collectEnrichers([none, broken]).size).toBe(0);
    expect(collectEnrichers([]).size).toBe(0);
  });

  it('collectEnrichers skips a module whose enrich map cannot be read', () => {
    const exploding: LoadedModule = {
      name: '@ctxo/domain',
      version: '0.0.0',
      registration: {
        id: 'domain',
        get enrich(): CtxoModuleRegistration['enrich'] {
          throw new Error('getter exploded');
        },
      },
    };
    const working = moduleWith({ find_importers: (payload) => ({ ...payload, ok: true }) });

    const enrichers = collectEnrichers([exploding, working]);

    expect([...enrichers.keys()]).toEqual(['find_importers']);
    expect(warnings().some((line) => line.includes('getter exploded'))).toBe(true);
  });
});
