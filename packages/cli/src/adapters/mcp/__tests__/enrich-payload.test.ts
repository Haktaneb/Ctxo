import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { applyEnricher, applyEnricherAsync, collectEnrichers, collectTaskContextReservation } from '../enrich-payload.js';
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

describe('applyEnricher guard', () => {
  it('applyEnricher rejects a Promise, a Map, a Date and a value with a cycle', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    const bads: unknown[] = [Promise.resolve({}), new Map(), new Date(), cyclic];
    for (const bad of bads) {
      const payload = { results: [1] };
      const enrich = (() => bad) as unknown as ResponseEnricher;
      expect(applyEnricher(enrich, payload, {}, 'search_symbols')).toBe(payload);
    }
    expect(warnings()).toHaveLength(4);
  });

  it('applyEnricher rejects a nested Map, Date or function inside an otherwise plain payload', () => {
    for (const bad of [{ a: { b: new Map() } }, { a: [new Date()] }, { a: () => 1 }, { a: 1n }]) {
      const payload = { results: [] };
      const enrich = (() => bad) as unknown as ResponseEnricher;
      expect(applyEnricher(enrich, payload, {}, 'search_symbols')).toBe(payload);
    }
    expect(warnings()).toHaveLength(4);
  });

  it('applyEnricher accepts plain objects, arrays and null-prototype objects', () => {
    const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { x: [{ y: null }] });
    const enrich = ((payload) => ({ ...payload, extra: nullProto, list: [1, 'a', true, null] })) as ResponseEnricher;

    const result = applyEnricher(enrich, { results: [] }, {}, 'search_symbols');

    expect(result['list']).toEqual([1, 'a', true, null]);
    expect(warnings()).toEqual([]);
  });

  it('applyEnricher logs a thrown string and a null-prototype throw without throwing itself', () => {
    const payload = { results: [] };
    const nullProto = Object.create(null) as object;
    for (const thrown of ['plain text failure', nullProto]) {
      const enrich: ResponseEnricher = () => {
        throw thrown;
      };
      expect(applyEnricher(enrich, payload, {}, 'search_symbols')).toBe(payload);
    }
    expect(warnings()).toHaveLength(2);
    expect(warnings()[0]).toContain('plain text failure');
    expect(warnings().some((line) => line.includes('undefined'))).toBe(false);
  });
});

/** Lets pending promise jobs and the unhandled-rejection check of the current turn run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('applyEnricher and a Promise', () => {
  it('applyEnricher drops a Promise result and warns', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const payload = { results: [1] };
      const resolving = (() => Promise.resolve({ ...payload, enrichedBy: 'async' })) as ResponseEnricher;
      const rejecting = (() => Promise.reject(new Error('async exploded'))) as ResponseEnricher;

      expect(applyEnricher(resolving, payload, {}, 'search_symbols')).toBe(payload);
      expect(applyEnricher(rejecting, payload, {}, 'get_context_for_task')).toBe(payload);
      await settle();

      expect(warnings()).toHaveLength(2);
      expect(warnings()[0]).toContain('search_symbols enricher returned a Promise; a synchronous tool cannot wait for it');
      expect(warnings()[1]).toContain('get_context_for_task enricher returned a Promise; a synchronous tool cannot wait for it');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('applyEnricherAsync', () => {
  it('applyEnricherAsync awaits an async enricher', async () => {
    const payload: Record<string, unknown> = { impactedSymbols: [{ symbolId: 'src/a.ts::A::function' }] };
    const enrich: ResponseEnricher = async (draft, args) => ({ ...draft, enrichedBy: 'async', seen: args['symbolId'] });

    const result = await applyEnricherAsync(enrich, payload, { symbolId: 'x' }, 'get_blast_radius');

    expect(result).toEqual({ impactedSymbols: [{ symbolId: 'src/a.ts::A::function' }], enrichedBy: 'async', seen: 'x' });
    expect(payload).toEqual({ impactedSymbols: [{ symbolId: 'src/a.ts::A::function' }] });
    expect(warnings()).toEqual([]);
  });

  it('applyEnricherAsync takes a synchronous enricher too, and returns the payload itself without one', async () => {
    const payload = { files: [] };
    expect(await applyEnricherAsync(undefined, payload, {}, 'get_pr_impact')).toBe(payload);
    expect(await applyEnricherAsync((p) => ({ ...p, sync: true }), payload, {}, 'get_pr_impact')).toEqual({ files: [], sync: true });
    expect(warnings()).toEqual([]);
  });

  it('applyEnricherAsync keeps the payload when the enricher rejects', async () => {
    const payload: Record<string, unknown> = { commitHistory: [] };
    // Writes into its copy, then rejects: none of that may reach the response.
    const rejecting: ResponseEnricher = async (draft) => {
      draft['half'] = 'done';
      throw new Error('async exploded');
    };
    const throwing: ResponseEnricher = () => {
      throw new Error('sync exploded');
    };

    expect(await applyEnricherAsync(rejecting, payload, {}, 'get_why_context')).toBe(payload);
    expect(await applyEnricherAsync(throwing, payload, {}, 'get_why_context')).toBe(payload);

    expect(payload).toEqual({ commitHistory: [] });
    expect(warnings()).toHaveLength(2);
    expect(warnings()[0]).toContain('get_why_context');
    expect(warnings()[0]).toContain('async exploded');
    expect(warnings()[1]).toContain('sync exploded');
  });

  it('applyEnricherAsync runs the plain-data guard on the resolved value', async () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    const bads: unknown[] = [new Date(), new Map(), { a: { b: new Date() } }, { a: 1n }, cyclic, [1], null];
    for (const bad of bads) {
      const payload = { results: [] };
      const enrich = (async () => bad) as unknown as ResponseEnricher;
      expect(await applyEnricherAsync(enrich, payload, {}, 'get_blast_radius')).toBe(payload);
    }
    expect(warnings()).toHaveLength(bads.length);
    expect(warnings().every((line) => line.includes('get_blast_radius'))).toBe(true);
  });
});

describe('collectEnrichers', () => {
  it('collectEnrichers chains an async enricher', async () => {
    const first = moduleWith({ get_blast_radius: async (payload) => ({ ...payload, first: true }) });
    // The second enricher sees the first one's field, resolved.
    const second = moduleWith({ get_blast_radius: (payload) => ({ ...payload, second: payload['first'] === true }) });
    const third = moduleWith({ get_blast_radius: async (payload) => ({ ...payload, third: payload['second'] === true }) });

    const enrich = collectEnrichers([first, second, third]).get('get_blast_radius');

    expect(await applyEnricherAsync(enrich, { impactedSymbols: [] }, {}, 'get_blast_radius')).toEqual({
      impactedSymbols: [],
      first: true,
      second: true,
      third: true,
    });
    expect(warnings()).toEqual([]);
  });

  it('collectEnrichers keeps the fields of earlier async links when a later one rejects', async () => {
    const first = moduleWith({ get_pr_impact: async (payload) => ({ ...payload, first: true }) });
    const second = moduleWith({
      get_pr_impact: async () => {
        throw new Error('second rejected');
      },
    });
    const third = moduleWith({ get_pr_impact: (payload) => ({ ...payload, third: payload['first'] === true }) });

    const enrich = collectEnrichers([first, second, third]).get('get_pr_impact');

    expect(await applyEnricherAsync(enrich, { files: [] }, {}, 'get_pr_impact')).toEqual({ files: [], first: true, third: true });
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('second rejected');
  });

  it('a synchronous chain stays synchronous', () => {
    const first = moduleWith({ search_symbols: (payload) => ({ ...payload, first: true }) });
    const second = moduleWith({ search_symbols: (payload) => ({ ...payload, second: true }) });

    const result = collectEnrichers([first, second]).get('search_symbols')!({ results: [] }, {});

    expect(result).toEqual({ results: [], first: true, second: true });
  });

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

describe('collectTaskContextReservation', () => {
  function reserving(reserveTaskContextTokens: unknown): LoadedModule {
    return {
      name: '@ctxo/domain',
      version: '0.0.0',
      registration: { id: 'domain', reserveTaskContextTokens } as unknown as CtxoModuleRegistration,
    };
  }

  it('is undefined when no module reserves tokens', () => {
    expect(collectTaskContextReservation([])).toBeUndefined();
    expect(collectTaskContextReservation([moduleWith(undefined), reserving('not a function')])).toBeUndefined();
  });

  it('sums the reservations of the modules and passes the args', () => {
    const seen: Array<Readonly<Record<string, unknown>>> = [];
    const reserve = collectTaskContextReservation([
      reserving((args: Readonly<Record<string, unknown>>) => {
        seen.push(args);
        return 200;
      }),
      reserving(() => 50),
    ]);

    expect(reserve!({ symbolId: 'x', tokenBudget: 4000 })).toBe(250);
    expect(seen).toEqual([{ symbolId: 'x', tokenBudget: 4000 }]);
  });

  it('skips a module whose reservation cannot be read', () => {
    const exploding: LoadedModule = {
      name: '@ctxo/domain',
      version: '0.0.0',
      registration: {
        id: 'domain',
        get reserveTaskContextTokens(): CtxoModuleRegistration['reserveTaskContextTokens'] {
          throw new Error('getter exploded');
        },
      },
    };

    const reserve = collectTaskContextReservation([exploding, reserving(() => 80)]);

    expect(reserve!({})).toBe(80);
    expect(warnings().some((line) => line.includes('getter exploded'))).toBe(true);
  });
});
