import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { wrapResponse } from '../response-envelope.js';

describe('wrapResponse', () => {
  const originalEnv = process.env['CTXO_RESPONSE_LIMIT'];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['CTXO_RESPONSE_LIMIT'];
    } else {
      process.env['CTXO_RESPONSE_LIMIT'] = originalEnv;
    }
  });

  it('adds _meta to small responses without truncation', () => {
    const data = {
      symbolId: 'src/foo.ts::bar::function',
      impactScore: 2,
      impactedSymbols: [
        { symbolId: 'a', name: 'a', kind: 'function' },
        { symbolId: 'b', name: 'b', kind: 'class' },
      ],
    };

    const result = wrapResponse(data);

    expect(result._meta).toBeDefined();
    const meta = result._meta as Record<string, unknown>;
    expect(meta.truncated).toBe(false);
    expect(meta.totalItems).toBe(2);
    expect(meta.returnedItems).toBe(2);
    expect(meta.totalBytes).toBeGreaterThan(0);
    expect(meta.hint).toBeUndefined();
    // Original data preserved
    expect(result.symbolId).toBe('src/foo.ts::bar::function');
    expect((result.impactedSymbols as unknown[]).length).toBe(2);
  });

  it('truncates large impactedSymbols array when over threshold', () => {
    process.env['CTXO_RESPONSE_LIMIT'] = '500';

    const symbols = Array.from({ length: 100 }, (_, i) => ({
      symbolId: `src/file${i}.ts::Sym${i}::class`,
      name: `Sym${i}`,
      kind: 'class',
      file: `src/file${i}.ts`,
      depth: 1,
      confidence: 'confirmed',
      riskScore: 1.0,
    }));

    const data = {
      symbolId: 'src/foo.ts::bar::function',
      impactScore: 100,
      impactedSymbols: symbols,
    };

    const result = wrapResponse(data);
    const meta = result._meta as Record<string, unknown>;

    expect(meta.truncated).toBe(true);
    expect(meta.totalItems).toBe(100);
    expect(meta.returnedItems).toBeLessThan(100);
    expect(meta.returnedItems).toBeGreaterThan(0);
    expect(meta.hint).toContain('search_symbols');
    expect((result.impactedSymbols as unknown[]).length).toBe(meta.returnedItems);

    // Verify the truncated response fits within threshold
    const json = JSON.stringify(result);
    expect(Buffer.byteLength(json, 'utf-8')).toBeLessThanOrEqual(500);
  });

  it('truncates importers array', () => {
    process.env['CTXO_RESPONSE_LIMIT'] = '300';

    const data = {
      symbolId: 'src/types.ts::SymbolNode::type',
      importerCount: 50,
      importers: Array.from({ length: 50 }, (_, i) => ({
        symbolId: `src/f${i}.ts::X${i}::class`,
        name: `X${i}`,
        kind: 'class',
        file: `src/f${i}.ts`,
        edgeKind: 'imports',
        depth: 1,
      })),
    };

    const result = wrapResponse(data);
    const meta = result._meta as Record<string, unknown>;

    expect(meta.truncated).toBe(true);
    expect(meta.totalItems).toBe(50);
    expect(meta.hint).toContain('find_importers');
  });

  it('truncates deadSymbols array', () => {
    process.env['CTXO_RESPONSE_LIMIT'] = '400';

    const data = {
      totalSymbols: 200,
      reachableSymbols: 100,
      deadCodePercentage: 50,
      deadSymbols: Array.from({ length: 100 }, (_, i) => ({
        symbolId: `src/dead${i}.ts::Dead${i}::function`,
        name: `Dead${i}`,
        kind: 'function',
        file: `src/dead${i}.ts`,
        confidence: 1.0,
        reason: 'Zero importers',
      })),
      deadFiles: [],
      unusedExports: [],
      scaffolding: [],
    };

    const result = wrapResponse(data);
    const meta = result._meta as Record<string, unknown>;

    expect(meta.truncated).toBe(true);
    expect(meta.totalItems).toBe(100);
    expect(meta.hint).toContain('search_symbols');
  });

  it('does not truncate when no truncatable array field exists', () => {
    process.env['CTXO_RESPONSE_LIMIT'] = '10';

    const data = {
      someField: 'a'.repeat(100),
      nonTruncatable: [1, 2, 3],
    };

    const result = wrapResponse(data);
    const meta = result._meta as Record<string, unknown>;

    expect(meta.truncated).toBe(false);
    expect(meta.totalItems).toBe(0);
  });

  it('respects CTXO_RESPONSE_LIMIT env variable', () => {
    process.env['CTXO_RESPONSE_LIMIT'] = '200';

    const data = {
      impactedSymbols: Array.from({ length: 50 }, (_, i) => ({
        symbolId: `src/f${i}.ts::S${i}::class`,
      })),
    };

    const result = wrapResponse(data);
    const meta = result._meta as Record<string, unknown>;
    expect(meta.truncated).toBe(true);
  });

  it('uses default threshold when env is not set', () => {
    delete process.env['CTXO_RESPONSE_LIMIT'];

    const data = {
      symbolId: 'src/foo.ts::bar::function',
      impactedSymbols: [{ symbolId: 'a', name: 'a' }],
    };

    const result = wrapResponse(data);
    const meta = result._meta as Record<string, unknown>;
    expect(meta.truncated).toBe(false);
    // Default is 8192, our tiny payload is well under
  });

  it('picks the largest truncatable array when multiple exist', () => {
    process.env['CTXO_RESPONSE_LIMIT'] = '300';

    const data = {
      deadSymbols: Array.from({ length: 50 }, (_, i) => ({
        symbolId: `dead${i}`,
        name: `Dead${i}`,
      })),
      unusedExports: Array.from({ length: 5 }, (_, i) => ({
        symbolId: `unused${i}`,
      })),
      deadFiles: [],
    };

    const result = wrapResponse(data);
    const meta = result._meta as Record<string, unknown>;

    // Should truncate deadSymbols (50 items) not unusedExports (5 items)
    expect(meta.totalItems).toBe(50);
    expect(meta.truncated).toBe(true);
  });

  it('returns at least 1 item when truncating', () => {
    process.env['CTXO_RESPONSE_LIMIT'] = '50'; // Very small

    const data = {
      impactedSymbols: Array.from({ length: 10 }, (_, i) => ({
        symbolId: `src/very-long-path/file${i}.ts::VeryLongSymbolName${i}::class`,
      })),
    };

    const result = wrapResponse(data);
    const meta = result._meta as Record<string, unknown>;
    expect((meta.returnedItems as number)).toBeGreaterThanOrEqual(1);
  });

  it('handles invalid CTXO_RESPONSE_LIMIT values gracefully', () => {
    process.env['CTXO_RESPONSE_LIMIT'] = 'not-a-number';

    const data = {
      symbolId: 'test',
      impactedSymbols: [{ symbolId: 'a' }],
    };

    const result = wrapResponse(data);
    const meta = result._meta as Record<string, unknown>;
    // Should fall back to default (8192), so small payload is not truncated
    expect(meta.truncated).toBe(false);
  });

  it('handles zero CTXO_RESPONSE_LIMIT by falling back to default', () => {
    process.env['CTXO_RESPONSE_LIMIT'] = '0';

    const data = {
      symbolId: 'test',
      impactedSymbols: [{ symbolId: 'a' }],
    };

    const result = wrapResponse(data);
    const meta = result._meta as Record<string, unknown>;
    expect(meta.truncated).toBe(false);
  });

  it('handles negative CTXO_RESPONSE_LIMIT by falling back to default', () => {
    process.env['CTXO_RESPONSE_LIMIT'] = '-100';

    const data = {
      symbolId: 'test',
      impactedSymbols: [{ symbolId: 'a' }],
    };

    const result = wrapResponse(data);
    const meta = result._meta as Record<string, unknown>;
    expect(meta.truncated).toBe(false);
  });

  it('does not truncate single-element array even when over threshold', () => {
    process.env['CTXO_RESPONSE_LIMIT'] = '10';

    const data = {
      impactedSymbols: [{ symbolId: 'src/very-long-name.ts::VeryLongSymbol::class', extra: 'a'.repeat(200) }],
    };

    const result = wrapResponse(data);
    const meta = result._meta as Record<string, unknown>;
    // Single item array can't be truncated further
    expect(meta.returnedItems).toBe(1);
  });

  it('preserves non-array fields when truncating', () => {
    process.env['CTXO_RESPONSE_LIMIT'] = '400';

    const data = {
      symbolId: 'src/foo.ts::bar::function',
      impactScore: 50,
      overallRiskScore: 0.85,
      impactedSymbols: Array.from({ length: 50 }, (_, i) => ({
        symbolId: `src/f${i}.ts::S${i}::class`,
        name: `S${i}`,
        kind: 'class',
      })),
    };

    const result = wrapResponse(data);

    expect(result.symbolId).toBe('src/foo.ts::bar::function');
    expect(result.impactScore).toBe(50);
    expect(result.overallRiskScore).toBe(0.85);
  });
  it('two arrays in one response: the primary array is truncated, the capped additive array is not', () => {
    process.env['CTXO_RESPONSE_LIMIT'] = '2048';
    const violation = (i: number) => ({
      from: { symbolId: `src/a${i}.ts::A${i}::class`, file: `src/a${i}.ts`, context: 'lending' },
      to: { symbolId: `src/b${i}.ts::B${i}::class`, file: `src/b${i}.ts`, context: 'billing' },
      edgeKind: 'imports',
      severity: 'error',
    });
    const data = {
      files: Array.from({ length: 300 }, (_, i) => ({ file: `src/f${i}.ts`, symbols: [] })),
      contextBoundaryViolations: Array.from({ length: 50 }, (_, i) => violation(i)),
      contextBoundaryViolationsTotal: 80,
    };

    const result = wrapResponse(data);

    const meta = result._meta as Record<string, unknown>;
    expect(meta.truncated).toBe(true);
    expect(meta.totalItems).toBe(300);
    expect(String(meta.hint)).toContain('get_changed_symbols');
    expect((result.files as unknown[]).length).toBeLessThan(300);
    expect((result.contextBoundaryViolations as unknown[]).length).toBe(50);
    expect(result.contextBoundaryViolationsTotal).toBe(80);
  });

  it('contextBoundaryViolations alone is never truncated', () => {
    process.env['CTXO_RESPONSE_LIMIT'] = '2048';
    const data = {
      contextBoundaryViolations: Array.from({ length: 300 }, (_, i) => ({ symbolId: `src/a${i}.ts::A${i}::class` })),
    };

    const result = wrapResponse(data);

    const meta = result._meta as Record<string, unknown>;
    expect(meta.truncated).toBe(false);
    expect((result.contextBoundaryViolations as unknown[]).length).toBe(300);
  });
});

describe('wrapResponse: domain fields', () => {
  const originalEnv = process.env['CTXO_RESPONSE_LIMIT'];
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['CTXO_RESPONSE_LIMIT'];
    } else {
      process.env['CTXO_RESPONSE_LIMIT'] = originalEnv;
    }
  });

  const items = (count: number) => Array.from({ length: count }, (_, i) => `item-${String(i).padStart(3, '0')}-`.padEnd(40, 'x'));

  it.each([
    ['rules', "Use get_rule with a ruleId for one rule's tests, code and decisions."],
    ['contexts', "Use get_domain_context with a symbolId or path for one context's card."],
    ['terms', `Read the card's Language section, or use get_ranked_context with scope "domain".`],
    ['openQuestions', "Read the card's Open questions section for the full list."],
    ['tests', "Use search_symbols with a test file path as filePattern to list one file's tests."],
    ['symbols', 'Use get_blast_radius on one linked symbol for its impact.'],
    ['provenance', 'Open the linked files directly; external references are never fetched.'],
    ['unresolved', 'Run "ctxo verify-domain --json" for every unresolved card reference.'],
    ['shadowSpecs', 'Use find_shadow_specs with kinds to narrow the list, or run "ctxo domain shadow-specs <context> --json" for every candidate.'],
    ['contextMap', 'Run "ctxo domain map --json" for the full context map.'],
    ['staleResolutions', 'Run "ctxo verify-domain --json" for every stale resolution in shadow-specs.yaml.'],
    ['unknownRules', 'Run "ctxo verify-domain --json" for every resolution that names an unknown rule.'],
    ['resolutionProblems', 'Run "ctxo verify-domain --json" for every problem in shadow-specs.yaml.'],
  ])("the new tools' arrays are truncatable with their hints: %s", (field, hint) => {
    process.env['CTXO_RESPONSE_LIMIT'] = '1024';

    const result = wrapResponse({ [field]: items(100) });

    const meta = result._meta as Record<string, unknown>;
    expect(meta.truncated).toBe(true);
    expect(meta.totalItems).toBe(100);
    expect(meta.hint).toBe(hint);
    expect((result[field] as unknown[]).length).toBeLessThan(100);
  });

  it.each(['rulesAffected', 'cardsToUpdate', 'decisions', 'contextsTouched', 'cardsChanged', 'rulesWithoutTests'])(
    'the additive domain fields are not truncatable: %s',
    (field) => {
      process.env['CTXO_RESPONSE_LIMIT'] = '1024';

      const result = wrapResponse({ [field]: items(100) });

      const meta = result._meta as Record<string, unknown>;
      expect(meta.truncated).toBe(false);
      expect((result[field] as unknown[]).length).toBe(100);
    },
  );

  it('two arrays in one response: the primary array is truncated, the capped additive array is not', () => {
    process.env['CTXO_RESPONSE_LIMIT'] = '2048';
    const rulesAffected = items(50);

    const result = wrapResponse({ impactedSymbols: items(200), rulesAffected, rulesAffectedTotal: 80 });

    const meta = result._meta as Record<string, unknown>;
    expect(meta.truncated).toBe(true);
    expect(meta.totalItems).toBe(200);
    expect(String(meta.hint)).toContain('get_blast_radius with a confidence filter');
    expect((result.impactedSymbols as unknown[]).length).toBeLessThan(200);
    expect(result.rulesAffected).toEqual(rulesAffected);
    expect(result.rulesAffectedTotal).toBe(80);
  });
});
