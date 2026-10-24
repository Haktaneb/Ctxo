import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalRuleId, indexGraph } from '../domain-graph-query.js';
import { fingerprint, normalizeFingerprint } from '../fingerprint.js';
import type { ShadowCandidate } from '../shadow-candidates.js';
import {
  applyResolutions,
  parseShadowSpecs,
  SHADOW_SPECS_FILE,
  shadowSpecsPath,
  type ResolutionEntry,
} from '../shadow-specs-file.js';
import { buildFixtureGraph } from './lending-graph.fixture.js';

const SPEC_EXAMPLE = `- fingerprint: "literal-comparison | LoanPolicy.CanBorrow | loans.Count >= 5"
  resolution: { rule: LEND-03 }
- fingerprint: "retry-timeout | SmtpSender.Send | Timeout = 30s"
  resolution: { notARule: "transport timeout, not a business rule" }
`;

const INDEX = indexGraph(buildFixtureGraph());
const canonical = (raw: string): string | undefined => canonicalRuleId(INDEX, raw);

const FP_LIMIT = fingerprint('literal-comparison', 'LoanPolicy.CanBorrow', 'loans.Count >= 5');
const FP_RETRY = fingerprint('retry-timeout', 'SmtpSender.Send', 'Timeout = 30s');

function candidate(fp: string, line: number, extra: Partial<ShadowCandidate> = {}): ShadowCandidate {
  const [kind, , text] = fp.split(' | ');
  return {
    fingerprint: fp,
    kind: kind as ShadowCandidate['kind'],
    context: 'lending',
    file: 'src/Lending/LoanPolicy.cs',
    line,
    text: text!,
    source: 'native',
    ...extra,
  };
}

function entry(raw: string, resolution: ResolutionEntry['resolution'], line = 1): ResolutionEntry {
  return { fingerprint: normalizeFingerprint(raw)!, resolution, line };
}

describe('parseShadowSpecs', () => {
  it('parses the spec example', () => {
    const parsed = parseShadowSpecs(SPEC_EXAMPLE);
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries).toEqual([
      { fingerprint: FP_LIMIT, resolution: { rule: 'LEND-03' }, line: 1 },
      { fingerprint: FP_RETRY, resolution: { notARule: 'transport timeout, not a business rule' }, line: 3 },
    ]);
  });

  it('CRLF and a BOM parse like LF', () => {
    const lf = parseShadowSpecs(SPEC_EXAMPLE);
    expect(parseShadowSpecs(SPEC_EXAMPLE.replace(/\n/g, '\r\n'))).toEqual(lf);
    expect(parseShadowSpecs(`\uFEFF${SPEC_EXAMPLE}`)).toEqual(lf);
    expect(parseShadowSpecs(`\uFEFF${SPEC_EXAMPLE.replace(/\n/g, '\r\n')}`)).toEqual(lf);
  });

  it.each([
    ['empty text', ''],
    ['whitespace only', '  \n\n'],
    ['comments only', '# nothing resolved yet\n'],
    ['an empty list', '[]\n'],
  ])('%s gives no entries and no problems', (_name, text) => {
    expect(parseShadowSpecs(text)).toEqual({ entries: [], problems: [] });
  });

  it.each([
    ['a mapping root', 'fingerprint: "a | b | c"\nresolution: { rule: LEND-03 }\n', 1, 'the file must be a YAML list of { fingerprint, resolution } entries'],
    ['a scalar root', '\n\nhello\n', 3, 'the file must be a YAML list of { fingerprint, resolution } entries'],
    ['a syntax error', '- fingerprint: "a | b | c"\n  resolution: { rule: LEND-03\n', 2, 'YAML syntax error'],
    ['a duplicate key', '- fingerprint: "a | b | c"\n  fingerprint: "a | b | d"\n  resolution: { rule: LEND-03 }\n', 2, 'YAML syntax error'],
    ['two documents', '- fingerprint: "a | b | c"\n  resolution: { rule: LEND-03 }\n---\n- x\n', 3, 'YAML syntax error'],
    ['an item that is not a map', '- just text\n', 1, 'an entry must be a map with fingerprint and resolution'],
    ['an unknown key', '- fingerprint: "a | b | c"\n  resolution: { rule: LEND-03 }\n  note: hi\n', 3, 'unknown key "note"'],
    ['a missing fingerprint', '- resolution: { rule: LEND-03 }\n', 1, 'fingerprint must read "<kind> | <symbol> | <text>"'],
    ['a bad fingerprint', '- fingerprint: "a | b"\n  resolution: { rule: LEND-03 }\n', 1, 'fingerprint must read "<kind> | <symbol> | <text>"'],
    ['an empty fingerprint part', '- resolution: { rule: LEND-03 }\n  fingerprint: "a |  | c"\n', 2, 'fingerprint must read "<kind> | <symbol> | <text>"'],
    ['a number fingerprint', '- fingerprint: 12\n  resolution: { rule: LEND-03 }\n', 1, 'fingerprint must read "<kind> | <symbol> | <text>"'],
    ['a missing resolution', '- fingerprint: "a | b | c"\n', 1, 'resolution must be { rule: <ID> } or { notARule: <reason> }'],
    ['a scalar resolution', '- fingerprint: "a | b | c"\n  resolution: LEND-03\n', 2, 'resolution must be { rule: <ID> } or { notARule: <reason> }'],
    ['a resolution with both keys', '- fingerprint: "a | b | c"\n  resolution: { rule: LEND-03, notARule: "x" }\n', 2, 'resolution must be { rule: <ID> } or { notARule: <reason> }'],
    ['a resolution with neither key', '- fingerprint: "a | b | c"\n  resolution: {}\n', 2, 'resolution must be { rule: <ID> } or { notARule: <reason> }'],
    ['an unknown resolution key', '- fingerprint: "a | b | c"\n  resolution: { rule: LEND-03, why: x }\n', 2, 'resolution must be { rule: <ID> } or { notARule: <reason> }'],
    ['an empty rule', '- fingerprint: "a | b | c"\n  resolution: { rule: "  " }\n', 2, 'resolution must be { rule: <ID> } or { notARule: <reason> }'],
    ['a list notARule', '- fingerprint: "a | b | c"\n  resolution:\n    notARule: [x]\n', 3, 'resolution must be { rule: <ID> } or { notARule: <reason> }'],
  ])('%s is an error with a 1-based line', (_name, text, line, message) => {
    const parsed = parseShadowSpecs(text);
    expect(parsed.entries).toEqual([]);
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]!.severity).toBe('error');
    expect(parsed.problems[0]!.line).toBe(line);
    expect(parsed.problems[0]!.message.startsWith(message)).toBe(true);
  });

  it('a duplicate fingerprint is a warning and the first entry wins', () => {
    const text = [
      '- fingerprint: "literal-comparison | LoanPolicy.CanBorrow | loans.Count >= 5"',
      '  resolution: { rule: LEND-03 }',
      '- fingerprint: "  literal-comparison|LoanPolicy.CanBorrow |  loans.Count   >= 5 "',
      '  resolution: { notARule: later }',
      '',
    ].join('\n');
    const parsed = parseShadowSpecs(text);
    expect(parsed.entries).toEqual([{ fingerprint: FP_LIMIT, resolution: { rule: 'LEND-03' }, line: 1 }]);
    expect(parsed.problems).toEqual([{ line: 3, severity: 'warning', message: 'duplicate fingerprint; the entry at line 1 wins' }]);
  });

  it('valid entries apply although others are broken', () => {
    const text = [
      '- fingerprint: "a | b"',
      '  resolution: { rule: LEND-03 }',
      '- fingerprint: "literal-comparison | LoanPolicy.CanBorrow | loans.Count >= 5"',
      '  resolution: { rule: LEND-03 }',
      '- 42',
      '- fingerprint: "retry-timeout | SmtpSender.Send | Timeout = 30s"',
      '  resolution: { notARule: "transport timeout, not a business rule" }',
      '',
    ].join('\n');
    const parsed = parseShadowSpecs(text);
    expect(parsed.entries.map((e) => [e.fingerprint, e.line])).toEqual([
      [FP_LIMIT, 3],
      [FP_RETRY, 6],
    ]);
    expect(parsed.problems.map((p) => [p.line, p.severity])).toEqual([
      [1, 'error'],
      [5, 'error'],
    ]);
    const applied = applyResolutions([candidate(FP_LIMIT, 12)], parsed.entries, canonical);
    expect(applied.candidates[0]!.resolution).toEqual({ by: 'shadow-specs', rule: 'LEND-03' });
  });

  it('a non-UTF-8 byte (decoded as U+FFFD) is an error at its line; the other entries still parse', () => {
    const text = SPEC_EXAMPLE.replace('transport timeout', 'transport \uFFFD timeout');
    const parsed = parseShadowSpecs(text);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.problems).toEqual([{ line: 4, severity: 'error', message: 'the file is not valid UTF-8 (U+FFFD on this line)' }]);
  });

  it('never throws on hostile input', () => {
    const inputs = [
      '- &a { fingerprint: "a | b | c", resolution: { rule: X-1 } }\n- *a\n',
      '- fingerprint: !!binary aGVsbG8=\n  resolution: { rule: X-1 }\n',
      '- ? [complex, key]\n  : value\n',
      '\0\0\0',
      '- '.repeat(5000),
      '['.repeat(2000),
      `- fingerprint: "${'a | '.repeat(10000)}"\n  resolution: { notARule: x }\n`,
    ];
    for (const text of inputs) {
      const parsed = parseShadowSpecs(text);
      for (const problem of parsed.problems) expect(problem.line).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('applyResolutions', () => {
  it('entries match candidates whatever the spacing', () => {
    const parsed = parseShadowSpecs(
      '- fingerprint: "  literal-comparison|LoanPolicy.CanBorrow|loans.Count    >= 5  "\n  resolution: { notARule: limit check }\n',
    );
    const applied = applyResolutions([candidate(FP_LIMIT, 12)], parsed.entries, canonical);
    expect(applied.candidates[0]!.resolution).toEqual({ by: 'shadow-specs', notARule: 'limit check' });
    expect(applied.stale).toEqual([]);
  });

  it('entries match encoded symbol parts', () => {
    const fp = fingerprint('data-resource', 'dbo.status|history', 'table dbo.status|history');
    const parsed = parseShadowSpecs('- fingerprint: "data-resource | dbo.status%7chistory | table dbo.status|history"\n  resolution: { notARule: audit }\n');
    expect(parsed.problems).toEqual([]);
    const applied = applyResolutions([candidate(fp, 3)], parsed.entries, canonical);
    expect(applied.candidates[0]!.resolution).toEqual({ by: 'shadow-specs', notARule: 'audit' });
  });

  it('a lower-case %7c matches %7C; a decoded | in the symbol part matches nothing and is stale', () => {
    const encoded = fingerprint('data-resource', 'dbo.status|history', 'table dbo.status|history');
    const neighbour = fingerprint('data-resource', 'dbo.status', 'table dbo.status');
    expect(encoded).toBe('data-resource | dbo.status%7Chistory | table dbo.status|history');
    const parsed = parseShadowSpecs(
      [
        '- fingerprint: "data-resource | dbo.status%7chistory | table dbo.status|history"',
        '  resolution: { notARule: audit }',
        '- fingerprint: "data-resource | dbo.status|history | table dbo.status|history"',
        '  resolution: { notARule: decoded }',
        '',
      ].join('\n'),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries.map((e) => e.fingerprint)).toEqual([encoded, 'data-resource | dbo.status | history | table dbo.status|history']);
    const applied = applyResolutions([candidate(encoded, 3), candidate(neighbour, 9)], parsed.entries, canonical);
    expect(applied.candidates.map((c) => c.resolution)).toEqual([{ by: 'shadow-specs', notARule: 'audit' }, undefined]);
    expect(applied.stale).toEqual([parsed.entries[1]]);
  });

  it('rule resolutions accept ID variants', () => {
    const applied = applyResolutions([candidate(FP_LIMIT, 12)], [entry(FP_LIMIT, { rule: 'lend03' })], canonical);
    expect(applied.candidates[0]!.resolution).toEqual({ by: 'shadow-specs', rule: 'LEND-03' });
    expect(applied.unknownRules).toEqual([]);
  });

  it('an unknown rule leaves the candidate open and is reported', () => {
    const bad = entry(FP_LIMIT, { rule: 'LEND-99' }, 4);
    const applied = applyResolutions([candidate(FP_LIMIT, 12)], [bad], canonical);
    expect(applied.candidates[0]!.resolution).toBeUndefined();
    expect(applied.unknownRules).toEqual([bad]);
    expect(applied.stale).toEqual([]);
  });

  it('entries matching no candidate are stale', () => {
    const gone = entry('literal-comparison | LoanPolicy.CanBorrow | loans.Count >= 3', { rule: 'LEND-03' }, 1);
    const kept = entry(FP_RETRY, { notARule: 'transport' }, 3);
    const applied = applyResolutions([candidate(FP_RETRY, 7)], [gone, kept], canonical);
    expect(applied.stale).toEqual([gone]);
    expect(applied.candidates[0]!.resolution).toEqual({ by: 'shadow-specs', notARule: 'transport' });
  });

  it('an automatic resolution wins and its entry is not stale', () => {
    const auto = candidate(FP_LIMIT, 12, { symbolId: 'src/Lending/LoanPolicy.cs::LoanPolicy.CanBorrow::method', resolution: { by: 'rule-link', rules: ['LEND-03'] } });
    const applied = applyResolutions([auto], [entry(FP_LIMIT, { notARule: 'x' })], canonical);
    expect(applied.candidates[0]).toEqual(auto);
    expect(applied.stale).toEqual([]);
  });

  it('one entry resolves every candidate with its fingerprint', () => {
    const list = [candidate(FP_LIMIT, 12), candidate(FP_RETRY, 20), candidate(FP_LIMIT, 40, { file: 'src/Lending/Other.cs' })];
    const applied = applyResolutions(list, [entry(FP_LIMIT, { rule: 'LEND-03' })], canonical);
    expect(applied.candidates.map((c) => c.resolution)).toEqual([
      { by: 'shadow-specs', rule: 'LEND-03' },
      undefined,
      { by: 'shadow-specs', rule: 'LEND-03' },
    ]);
    expect(applied.stale).toEqual([]);
  });

  it('keeps candidate order and does not mutate its inputs', () => {
    const list = [candidate(FP_RETRY, 20), candidate(FP_LIMIT, 12)];
    const before = JSON.stringify(list);
    const applied = applyResolutions(list, [entry(FP_LIMIT, { rule: 'LEND-03' })], canonical);
    expect(applied.candidates.map((c) => c.fingerprint)).toEqual([FP_RETRY, FP_LIMIT]);
    expect(JSON.stringify(list)).toBe(before);
  });
});

describe('shadowSpecsPath', () => {
  it('shadowSpecsPath follows the registry folder', () => {
    expect(shadowSpecsPath('config/domain/contexts.yaml', 'lending')).toBe('config/domain/lending/shadow-specs.yaml');
    expect(shadowSpecsPath('docs/domain/contexts.yaml', 'billing')).toBe('docs/domain/billing/shadow-specs.yaml');
    expect(shadowSpecsPath('config\\domain\\contexts.yaml', 'lending')).toBe('config/domain/lending/shadow-specs.yaml');
    expect(shadowSpecsPath('contexts.yaml', 'lending')).toBe('lending/shadow-specs.yaml');
    expect(SHADOW_SPECS_FILE).toBe('shadow-specs.yaml');
  });
});

describe('shadow-specs.schema.json', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const schema = JSON.parse(readFileSync(join(here, '../../../schema/shadow-specs.schema.json'), 'utf-8')) as Record<string, any>;

  it('the JSON Schema agrees with the parser', () => {
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema['type']).toBe('array');
    const item = schema['items'];
    expect(item.type).toBe('object');
    expect(item.additionalProperties).toBe(false);
    expect([...item.required].sort()).toEqual(['fingerprint', 'resolution']);
    expect(Object.keys(item.properties).sort()).toEqual(['fingerprint', 'resolution']);
    expect(item.properties.fingerprint.type).toBe('string');
    const oneOf = item.properties.resolution.oneOf as Record<string, any>[];
    expect(oneOf).toHaveLength(2);
    expect(oneOf.map((o) => o.required)).toEqual([['rule'], ['notARule']]);
    for (const option of oneOf) {
      expect(option.type).toBe('object');
      expect(option.additionalProperties).toBe(false);
      const key = option.required[0] as string;
      expect(Object.keys(option.properties)).toEqual([key]);
      expect(option.properties[key].type).toBe('string');
    }

    // The fingerprint pattern accepts exactly what normalizeFingerprint accepts.
    const pattern = new RegExp(item.properties.fingerprint.pattern as string, 'u');
    for (const raw of ['a | b | c', 'a|b|c', ' a | b | c | d ', 'a | b', 'a |  | c', ' | b | c', 'a | b |  ', 'abc', '', 'a%7C | b | c', 'a | b |\n c', 'a\n | b | \n']) {
      expect([raw, pattern.test(raw)]).toEqual([raw, normalizeFingerprint(raw) !== undefined]);
    }
    // A rule or reason of spaces only is rejected by both.
    for (const option of oneOf) {
      const key = option.required[0] as string;
      const value = new RegExp(option.properties[key].pattern as string, 'u');
      expect(value.test('LEND-03')).toBe(true);
      expect(value.test('   ')).toBe(false);
      expect(value.test('')).toBe(false);
      const parsed = parseShadowSpecs(`- fingerprint: "a | b | c"\n  resolution: { ${key}: "   " }\n`);
      expect(parsed.entries).toEqual([]);
    }
  });
});
