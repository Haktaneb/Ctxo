import { describe, it, expect } from 'vitest';
import { createModuleHost } from '@ctxo/cli/internal';
import { parseCard, type ParsedCard } from '../card-parser.js';
import { DEFAULT_DOMAIN_CONFIG, type DomainConfig } from '../domain-config.js';
import type { UnresolvedRef } from '../domain-graph.js';
import { parseRegistry, type LoadedRegistry } from '../registry.js';
import type { RuleRef } from '../rule-id-scan.js';
import { contextMapRows, runVerifyChecks, VERIFY_CHECKS, type CheckOutcome, type VerifyCheckId, type VerifyInput } from '../verify-checks.js';

const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: process.cwd() });

const GOOD_CARD = `# Lending

## Language

Loan: a thing.

## Rules and invariants

### LEND-01 A loan has one borrower
Tests: \`src/Lending/Loan.test.ts\`

## Boundary contracts

## Decisions

## Open questions
`;

const REGISTRY = `version: 1
contexts:
  - id: lending
    name: Lending
    card: docs/domain/lending/domain.md
    paths: ["src/Lending/**"]
    rung: pinned
    rulePrefix: LEND
  - id: reporting
    name: Reporting
    paths: ["src/Reporting/**"]
    rung: fear
unowned:
  allow: ["src/Host/**"]
`;

const CONTEXT_MAP = `# Context map

| Context | Rung |
|---|---|
| Lending | pinned |
| reporting | fear |
`;

const BAD_REGISTRY = 'version: 2\ncontexts: []\n';

function loaded(text: string): LoadedRegistry {
  const parsed = parseRegistry(text);
  return { path: 'docs/domain/contexts.yaml', text, ...(parsed.registry ? { registry: parsed.registry } : {}), problems: parsed.problems };
}

function base(over: Partial<VerifyInput> = {}): VerifyInput {
  const cards = new Map<string, ParsedCard | undefined>([['docs/domain/lending/domain.md', parseCard(GOOD_CARD)]]);
  const existing = new Set(['src/Lending/Loan.test.ts', 'docs/domain/lending/domain.md', 'docs/other.md']);
  return {
    registry: loaded(REGISTRY),
    config: DEFAULT_DOMAIN_CONFIG,
    configProblems: [],
    indexedFiles: ['src/Lending/Loan.ts', 'src/Lending/Loan.test.ts', 'src/Reporting/R.ts', 'src/Host/Main.ts'],
    isTestFile: (p) => p.endsWith('.test.ts'),
    makeMatcher: host.services.makeGlobMatcher,
    cards,
    fileExists: (p) => existing.has(p),
    headingSlugs: (p) => (p === 'docs/other.md' ? new Set(['intro', 'café-menu']) : undefined),
    ruleLinks: { links: new Map([['LEND-01', []]]), unknown: [] },
    loaderDiff: { missing: [], outdated: [], stale: [], foreign: [], blocked: [] },
    contextMapText: CONTEXT_MAP,
    boundaries: { crossEdges: [], violations: [], perContext: new Map() },
    ...over,
  };
}

function outcome(input: VerifyInput, id: VerifyCheckId): CheckOutcome {
  const found = runVerifyChecks(input).find((o) => o.id === id);
  if (!found) throw new Error(`no outcome ${id}`);
  return found;
}

const withCard = (text: string): Partial<VerifyInput> => ({ cards: new Map([['docs/domain/lending/domain.md', parseCard(text)]]) });
const withConfig = (patch: Partial<DomainConfig>): Partial<VerifyInput> => ({ config: { ...DEFAULT_DOMAIN_CONFIG, ...patch } });

describe('runVerifyChecks', () => {
  it('returns one outcome per check, in order, and a clean input does not fail', () => {
    const outcomes = runVerifyChecks(base());
    expect(outcomes.map((o) => o.id)).toEqual([...VERIFY_CHECKS]);
    expect(outcomes.filter((o) => o.status === 'fail').map((o) => o.id)).toEqual([]);
    expect(outcome(base(), '11').status).toBe('skipped');
    expect(outcome(base(), '4b').status).toBe('pass');
  });

  it.each([
    ['a config problem', { configProblems: [{ path: 'domain.registry', message: 'must be a string' }] }, 'domain.registry'],
    ['a registry problem', { registry: loaded(BAD_REGISTRY) }, ''],
  ])('check 1 fails on %s', (_name, over, needle) => {
    const out = outcome(base(over as Partial<VerifyInput>), '1');
    expect(out.status).toBe('fail');
    expect(out.findings.every((f) => f.severity === 'error')).toBe(true);
    expect(out.findings[0]!.message).toContain(needle);
  });

  it('check 1 passes on a clean input', () => {
    expect(outcome(base(), '1').status).toBe('pass');
  });

  it('registry problems skip checks 2 to 11', () => {
    const outcomes = runVerifyChecks(base({ registry: loaded(BAD_REGISTRY) }));
    expect(outcomes[0]!.status).toBe('fail');
    for (const o of outcomes.slice(1)) expect(o.status).toBe('skipped');
  });

  it('a non-fear context without a card fails check 2', () => {
    const registry = loaded(REGISTRY.replace('    card: docs/domain/lending/domain.md\n', ''));
    const out = outcome(base({ registry }), '2');
    expect(out.status).toBe('fail');
    expect(out.findings[0]!.message).toContain('lending');
  });

  it('a listed card that does not exist fails check 2; a fear context without a card passes', () => {
    const out = outcome(base({ cards: new Map([['docs/domain/lending/domain.md', undefined]]) }), '2');
    expect(out.status).toBe('fail');
    expect(out.findings[0]!.file).toBe('docs/domain/lending/domain.md');
    expect(outcome(base(), '2').status).toBe('pass');
  });

  it('a glob that matches nothing fails check 3', () => {
    const registry = loaded(REGISTRY.replace('src/Reporting/**', 'src/Nowhere/**'));
    const out = outcome(base({ registry }), '3');
    expect(out.status).toBe('fail');
    expect(out.findings[0]!.message).toBe('reporting: "src/Nowhere/**" matches no indexed file');
    expect(outcome(base(), '3').status).toBe('pass');
  });

  it('check 4a fails for a non-test file with two owners and ignores test files', () => {
    const registry = loaded(REGISTRY.replace('src/Reporting/**', 'src/**'));
    const out = outcome(base({ registry }), '4a');
    expect(out.status).toBe('fail');
    expect(out.findings.map((f) => f.file)).toContain('src/Lending/Loan.ts');
    expect(out.findings.map((f) => f.file)).not.toContain('src/Lending/Loan.test.ts');
    expect(outcome(base(), '4a').status).toBe('pass');
  });

  it('check 4b warns once with a capped list; allowlisted and test files are not unowned', () => {
    const many = Array.from({ length: 25 }, (_, i) => `src/Other/f${String(i).padStart(2, '0')}.ts`);
    const out = outcome(base({ indexedFiles: [...base().indexedFiles, ...many, 'src/Other/x.test.ts'] }), '4b');
    expect(out.status).toBe('warn');
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.message.startsWith('25 indexed files belong to no context: ')).toBe(true);
    expect(out.findings[0]!.message).toContain('src/Other/f19.ts');
    expect(out.findings[0]!.message).not.toContain('src/Other/f20.ts');
    expect(out.findings[0]!.message).not.toContain('src/Host/Main.ts');
  });

  it('domain.coverage.unowned: error turns 4b into an error', () => {
    const out = outcome(base({ ...withConfig({ coverage: { unowned: 'error' } }), indexedFiles: ['src/Other/a.ts'] }), '4b');
    expect(out.status).toBe('fail');
    expect(out.findings[0]!.severity).toBe('error');
  });

  it('check 5 reports heading order problems', () => {
    const out = outcome(base(withCard('# L\n\n## Language\n\n## Decisions\n')), '5');
    expect(out.status).toBe('fail');
    expect(out.findings.some((f) => f.message.includes('Rules and invariants'))).toBe(true);
    expect(out.findings[0]!.file).toBe('docs/domain/lending/domain.md');
    expect(outcome(base(), '5').status).toBe('pass');
  });

  const ruleCard = (rules: string): Partial<VerifyInput> => withCard(GOOD_CARD.replace(/### LEND-01[\s\S]*?(?=## Boundary)/, rules + '\n'));

  it.each([
    ['an id not matching idPattern', '### lend1 Bad\nUntested: later\n', 'does not match'],
    ['an id without the context prefix', '### OTHER-01 Wrong\nUntested: later\n', 'LEND-'],
    ['a Tests file that does not exist', '### LEND-01 X\nTests: `src/Nope.test.ts`\n', 'src/Nope.test.ts'],
    ['a rule with no link and no Untested', '### LEND-01 X\n', 'no test link'],
  ])('check 6 fails on %s', (_name, rules, needle) => {
    const out = outcome(base(ruleCard(rules)), '6');
    expect(out.status).toBe('fail');
    expect(out.findings.map((f) => f.message).join('\n')).toContain(needle);
  });

  it('check 6 passes with a Tests file, an Untested line, or a scanned link', () => {
    expect(outcome(base(), '6').status).toBe('pass');
    expect(outcome(base(ruleCard('### LEND-01 X\nUntested: not yet\n')), '6').status).toBe('pass');
    const ref = { file: 'a.test.ts', line: 1, raw: 'LEND-01', id: 'LEND-01', kind: 'annotation' as const };
    const links = { links: new Map([['LEND-01', [ref]]]), unknown: [] };
    expect(outcome(base({ ...ruleCard('### LEND-01 X\n'), ruleLinks: links }), '6').status).toBe('pass');
  });

  it('check 6 sorts unknown rule references by file, line and id', () => {
    const mk = (file: string, line: number, id: string) => ({ file, line, raw: id, id, kind: 'annotation' as const });
    const unknown = [mk('b.test.ts', 1, 'LEND-9'), mk('a.test.ts', 10, 'LEND-8'), mk('a.test.ts', 2, 'LEND-9'), mk('a.test.ts', 2, 'LEND-7'), mk('B.test.ts', 5, 'LEND-1')];
    const out = outcome(base({ ruleLinks: { links: new Map([['LEND-01', []]]), unknown } }), '6');
    expect(out.findings.map((f) => `${f.file}:${f.line}:${f.message.split(':')[0]}`)).toEqual([
      'B.test.ts:5:LEND-1',
      'a.test.ts:2:LEND-7',
      'a.test.ts:2:LEND-9',
      'a.test.ts:10:LEND-8',
      'b.test.ts:1:LEND-9',
    ]);
  });

  it('check 6 accepts a Tests value with a ::name suffix when the file exists', () => {
    const ok = outcome(base(ruleCard('### LEND-01 X\nTests: `src/Lending/Loan.test.ts::LEND-01`\n')), '6');
    expect(ok.status).toBe('pass');
    const missing = outcome(base(ruleCard('### LEND-01 X\nTests: `src/Nope.test.ts::LEND-01`\n')), '6');
    expect(missing.findings[0]!.message).toContain('"src/Nope.test.ts"');
  });

  it('check 6 fails on a duplicate id across cards', () => {
    const registry = loaded(REGISTRY.replace('rung: fear', 'rung: named\n    card: docs/domain/reporting.md\n    rulePrefix: REP'));
    const cards = new Map<string, ParsedCard | undefined>([
      ['docs/domain/lending/domain.md', parseCard(GOOD_CARD)],
      ['docs/domain/reporting.md', parseCard(GOOD_CARD)],
    ]);
    const out = outcome(base({ registry, cards }), '6');
    expect(out.findings.some((f) => f.message.includes('duplicate'))).toBe(true);
  });

  it('an unknown rule ID in a test fails check 6', () => {
    const ref = { file: 'src/Lending/Loan.test.ts', line: 7, raw: 'LEND-99', id: 'LEND-99', kind: 'annotation' as const };
    const out = outcome(base({ ruleLinks: { links: new Map(), unknown: [ref] } }), '6');
    expect(out.status).toBe('fail');
    const finding = out.findings.find((f) => f.message.includes('LEND-99'))!;
    expect(finding.file).toBe('src/Lending/Loan.test.ts');
    expect(finding.line).toBe(7);
  });

  const CARD_PATH = 'docs/domain/lending/domain.md';
  const problem = (field: 'Tests' | 'Code', value: string, reason: 'missing-file' | 'not-a-symbol', line = 11): UnresolvedRef => ({
    rule: 'LEND-01',
    field,
    value,
    at: { file: CARD_PATH, line },
    reason,
  });

  it('check 6 fails for a Code: or Tests: file that does not exist', () => {
    const card = ruleCard('### LEND-01 X\nTests: `src/Nope.test.ts`\nCode: `./src/Nope.ts::Nope::class`\n');
    const out = outcome(
      base({
        ...card,
        cardRefProblems: [problem('Tests', 'src/Nope.test.ts', 'missing-file', 10), problem('Code', './src/Nope.ts::Nope::class', 'missing-file')],
      }),
      '6',
    );
    expect(out.status).toBe('fail');
    expect(out.findings.map((f) => [f.severity, f.message, f.file, f.line, f.context])).toEqual([
      ['error', 'LEND-01: Tests file "src/Nope.test.ts" does not exist', CARD_PATH, 9, 'lending'],
      ['error', 'LEND-01: Code file "src/Nope.ts" does not exist', CARD_PATH, 11, 'lending'],
    ]);
  });

  it('check 6 fails once for a Tests: value that names a directory', () => {
    const card = ruleCard('### LEND-01 X\nTests: `src/Lending`\n');
    const input = base({
      ...card,
      fileExists: (p) => p === 'src/Lending' || p === 'docs/domain/lending/domain.md',
      isRepoFile: (p) => p === 'docs/domain/lending/domain.md',
      cardRefProblems: [problem('Tests', 'src/Lending', 'missing-file', 10)],
    });
    const out = outcome(input, '6');
    expect(out.status).toBe('fail');
    expect(out.findings.map((f) => [f.message, f.line])).toEqual([['LEND-01: Tests file "src/Lending" does not exist', 9]]);
  });

  it('check 6 warns for an unindexed symbol ID and accepts an indexed one', () => {
    const gone = 'src/Lending/Loan.ts::Loan.Gone::method';
    const test = 'src/Lending/Loan.test.ts::LoanTests.Gone::method';
    const card = ruleCard(`### LEND-01 X\nTests: \`${test}\`\nCode: \`src/Lending/Loan.ts::Loan::class\`, \`${gone}\`\n`);
    const warned = outcome(base({ ...card, cardRefProblems: [problem('Tests', test, 'not-a-symbol', 10), problem('Code', gone, 'not-a-symbol')] }), '6');
    expect(warned.status).toBe('warn');
    expect(warned.findings.map((f) => [f.severity, f.message, f.file, f.line])).toEqual([
      ['warning', `LEND-01: Tests: "${test}" is not an indexed symbol; it links to its file`, CARD_PATH, 10],
      ['warning', `LEND-01: Code: "${gone}" is not an indexed symbol; it links to its file`, CARD_PATH, 11],
    ]);
    expect(outcome(base({ ...card, cardRefProblems: [] }), '6').status).toBe('pass');
  });

  it('check 6 warns for a production rule: comment with a rule prefix and ignores other prefixes', () => {
    const mk = (file: string, line: number, id: string): RuleRef => ({ file, line, raw: id, id, kind: 'rule-comment' });
    const out = outcome(
      base({ codeRuleRefs: [mk('src/Lending/Loan.ts', 4, 'LEND-99'), mk('tools/lint.py', 2, 'E-501'), mk('src/Lending/Loan.ts', 4, 'LEND-99')] }),
      '6',
    );
    expect(out.status).toBe('warn');
    expect(out.findings.map((f) => [f.severity, f.message, f.file, f.line])).toEqual([
      ['warning', 'rule: comment names unknown rule LEND-99', 'src/Lending/Loan.ts', 4],
    ]);
  });

  it('check 7 skips external URLs and resolves URL-encoded paths and anchors', () => {
    const text =
      GOOD_CARD +
      `
[a](https://example.com/x) [b](mailto:a@b.c) [c](//cdn.example.com/x) [d](../../other.md#caf%C3%A9-menu) [e](/docs/other.md#intro)
[f](#language) [g](./nope.md) [h](/docs/other.md#missing) [i](#nowhere)
`;
    const out = outcome(base(withCard(text)), '7');
    const messages = out.findings.map((f) => f.message).join('\n');
    expect(out.status).toBe('fail');
    expect(out.findings).toHaveLength(3);
    expect(messages).toContain('nope.md');
    expect(messages).toContain('#missing');
    expect(messages).toContain('#nowhere');
    expect(messages).not.toContain('example.com');
    expect(out.findings.every((f) => f.line !== undefined)).toBe(true);
  });

  it('check 7 accepts a sibling path that starts with two dots and still rejects an escape from the repo', () => {
    const text = GOOD_CARD + '\n[a](/..hidden/x.md) [b](../../../../outside.md) [c](..\\..\\..\\..\\outside.md)\n';
    const out = outcome(base({ ...withCard(text), fileExists: (p) => p === '..hidden/x.md' || p === 'src/Lending/Loan.test.ts' || p === 'docs/domain/lending/domain.md' }), '7');
    const messages = out.findings.map((f) => f.message).join(' | ');
    expect(messages).not.toContain('..hidden');
    expect(out.findings).toHaveLength(2);
    expect(messages).toContain('outside.md');
  });

  it('check 7 passes on a card without bad links', () => {
    expect(outcome(base(), '7').status).toBe('pass');
  });

  it.each([
    ['missing', { missing: ['.claude/rules/ctxo-context-lending.md'] }],
    ['outdated', { outdated: ['.claude/rules/ctxo-context-lending.md'] }],
    ['stale', { stale: ['.claude/rules/ctxo-context-gone.md'] }],
    ['blocked', { blocked: ['.claude/rules/ctxo-context-lending.md'] }],
  ])('check 8 fails on a %s loader file', (name, patch) => {
    const out = outcome(base({ loaderDiff: { missing: [], outdated: [], stale: [], foreign: [], blocked: [], ...patch } }), '8');
    expect(out.status).toBe('fail');
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.file).toMatch(/ctxo-context-/);
    if (name === 'blocked') {
      expect(out.findings[0]!.message).toBe(
        '.claude/rules/ctxo-context-lending.md exists without the generated marker; rename it or delete it, then run --write',
      );
    }
  });

  it('check 8 ignores foreign files', () => {
    const loaderDiff = { missing: [], outdated: [], stale: [], foreign: ['.claude/rules/ctxo-context-x.md'], blocked: [] };
    expect(outcome(base({ loaderDiff }), '8').status).toBe('pass');
  });

  it('check 9 fails on a different rung, a missing context or a missing table; warns on an unknown row', () => {
    expect(outcome(base(), '9').status).toBe('pass');
    expect(outcome(base({ contextMapText: CONTEXT_MAP.replace('pinned', 'named') }), '9').status).toBe('fail');
    expect(outcome(base({ contextMapText: CONTEXT_MAP.replace('| reporting | fear |\n', '') }), '9').status).toBe('fail');
    expect(outcome(base({ contextMapText: '# no table here\n' }), '9').status).toBe('fail');
    const unknown = outcome(base({ contextMapText: CONTEXT_MAP + '| Ghost | named |\n' }), '9');
    expect(unknown.status).toBe('warn');
    expect(unknown.findings[0]!.severity).toBe('warning');
  });

  it('check 9 warns when the file is missing and a context exists', () => {
    expect(outcome(base({ contextMapText: undefined }), '9').status).toBe('warn');
  });

  it('the context map matches by id or name, case-insensitively, with markup stripped', () => {
    const text = `| **Context** | _Rung_ |\n|:--|--:|\n| [\`LENDING\`](x.md) | **Pinned** |\n| \`Reporting\` | FEAR |\n`;
    expect(outcome(base({ contextMapText: text }), '9').status).toBe('pass');
    expect(contextMapRows(text)!.size).toBe(2);
    expect(contextMapRows('no table')).toBeUndefined();
    expect(contextMapRows('| A | B |\n|---|---|\n| 1 | 2 |\n')).toBeUndefined();
  });

  it('check 10 maps each violation to its severity', () => {
    const end = (context: string) => ({ symbolId: `src/${context}/a.ts::a::function`, file: `src/${context}/a.ts`, context });
    const boundaries = {
      crossEdges: [],
      perContext: new Map(),
      violations: [
        { from: end('lending'), to: end('reporting'), edgeKind: 'imports', severity: 'error' as const },
        { from: end('reporting'), to: end('lending'), edgeKind: 'calls', severity: 'warning' as const },
      ],
    };
    const out = outcome(base({ boundaries }), '10');
    expect(out.status).toBe('fail');
    expect(out.findings.map((f) => f.severity)).toEqual(['error', 'warning']);
    expect(out.findings[0]!.file).toBe('src/lending/a.ts');
    expect(outcome(base(), '10').status).toBe('pass');
  });

  it('check 11 is skipped without --since, fails on unresolved contexts, passes when resolved', () => {
    const report = (unresolved: string[]) => ({ mode: 'committed' as const, since: 'main', contexts: [], unowned: [], unresolved, warnings: [] });
    expect(outcome(base(), '11').status).toBe('skipped');
    const failing = outcome(base({ touched: report(['lending']) }), '11');
    expect(failing.status).toBe('fail');
    expect(failing.findings[0]!.message).toContain('Domain-Unchanged: lending (reason)');
    expect(outcome(base({ touched: report([]) }), '11').status).toBe('pass');
  });

  it('day one: the init skeleton with indexed files has warnings only', () => {
    const registry = loaded('version: 1\ncontexts: []\n');
    const outcomes = runVerifyChecks(base({ registry, cards: new Map(), contextMapText: undefined, ruleLinks: { links: new Map(), unknown: [] } }));
    expect(outcomes.filter((o) => o.status === 'fail')).toEqual([]);
    expect(outcomes.find((o) => o.id === '4b')!.status).toBe('warn');
    expect(outcomes.find((o) => o.id === '9')!.status).toBe('pass');
  });
});
