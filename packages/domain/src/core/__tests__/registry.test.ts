import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { CONTEXT_ID_PATTERN, RULE_PREFIX_PATTERN, RUNGS, parseRegistry, registryHash } from '../registry.js';

const SPEC_EXAMPLE = `version: 1
contexts:
  - id: lending                       # kebab-case, unique, permanent
    name: Lending
    card: docs/domain/lending/domain.md   # optional only while rung is fear
    paths: ["src/Lending/**", "src/Holds/**"]
    rung: pinned                      # fear | pinned | named | bounded | boring (owner sets)
    rulePrefix: LEND                  # optional; rule IDs in this card must use it
    contracts:                        # allowed crossings into other contexts
      billing: ["src/Billing/Api/IChargeService.cs"]
  - id: billing
    name: Billing
    paths: ["src/Billing/**"]
    rung: fear
unowned:
  allow: ["src/Host/**"]              # files allowed to belong to no context
glossary: docs/domain/glossary.md     # default
contextMap: docs/domain/context-map.md   # default
`;

const VALID_CONTEXT = `  - id: billing
    name: Billing
    paths: ["src/Billing/**"]
    rung: fear
`;

function registry(extraContexts: string, header = 'version: 1\n'): string {
  return `${header}contexts:\n${VALID_CONTEXT}${extraContexts}`;
}

describe('parseRegistry', () => {
  it('parses the spec example registry', () => {
    const { registry: parsed, problems } = parseRegistry(SPEC_EXAMPLE);

    expect(problems).toEqual([]);
    expect(parsed?.contexts.map((c) => c.id)).toEqual(['lending', 'billing']);
    expect(parsed?.contexts[0]).toMatchObject({
      name: 'Lending',
      card: 'docs/domain/lending/domain.md',
      paths: ['src/Lending/**', 'src/Holds/**'],
      rung: 'pinned',
      rulePrefix: 'LEND',
      contracts: { billing: ['src/Billing/Api/IChargeService.cs'] },
    });
    expect(parsed?.unownedAllow).toEqual(['src/Host/**']);
  });

  it.each([
    ['an id that is not kebab-case', '  - id: Lending\n    name: L\n    paths: [a]\n    rung: fear\n', 'contexts[1].id'],
    ['a duplicate id', '  - id: billing\n    name: B2\n    paths: [a]\n    rung: fear\n', 'contexts[1].id'],
    ['a misspelled rung', '  - id: lending\n    name: L\n    paths: [a]\n    rung: pinnned\n', 'contexts[1].rung'],
    ['empty paths', '  - id: lending\n    name: L\n    paths: []\n    rung: fear\n', 'contexts[1].paths'],
    [
      'a contract into an unknown context',
      '  - id: lending\n    name: L\n    paths: [a]\n    rung: fear\n    contracts:\n      shipping: [x]\n',
      'contexts[1].contracts.shipping',
    ],
    [
      'a contract into itself',
      '  - id: lending\n    name: L\n    paths: [a]\n    rung: fear\n    contracts:\n      lending: [x]\n',
      'contexts[1].contracts.lending',
    ],
    [
      'a duplicate rulePrefix',
      '  - id: lending\n    name: L\n    paths: [a]\n    rung: fear\n    rulePrefix: BILL\n',
      'contexts[1].rulePrefix',
    ],
    ['an unknown context key', '  - id: lending\n    name: L\n    paths: [a]\n    rung: fear\n    owner: me\n', 'contexts[1].owner'],
  ])('reports every problem with its path: %s', (_label, extra, path) => {
    const withPrefix = registry(extra).replace('rung: fear\n', 'rung: fear\n    rulePrefix: BILL\n');

    const { registry: parsed, problems } = parseRegistry(withPrefix);

    expect(parsed).toBeUndefined();
    expect(problems.map((p) => p.path)).toContain(path);
  });

  it('reports version 2 and an unknown top-level key by path', () => {
    const { problems } = parseRegistry(registry('', 'version: 2\nowner: me\n'));

    expect(problems.map((p) => p.path).sort()).toEqual(['owner', 'version']);
  });

  it('a YAML syntax error is one problem with its line', () => {
    const { registry: parsed, problems } = parseRegistry('version: 1\ncontexts: [unclosed\n  - x: : :\n');

    expect(parsed).toBeUndefined();
    expect(problems).toHaveLength(1);
    expect(problems[0]!.path).toBe('');
    expect(problems[0]!.message).toMatch(/line \d+/);
  });

  it('defaults glossary, contextMap and unowned.allow', () => {
    const { registry: parsed, problems } = parseRegistry(registry(''));

    expect(problems).toEqual([]);
    expect(parsed?.glossary).toBe('docs/domain/glossary.md');
    expect(parsed?.contextMap).toBe('docs/domain/context-map.md');
    expect(parsed?.unownedAllow).toEqual([]);
  });

  it('CRLF and a BOM parse like LF', () => {
    const lf = parseRegistry(SPEC_EXAMPLE);
    const crlf = parseRegistry(`﻿${SPEC_EXAMPLE.replace(/\n/g, '\r\n')}`);

    expect(crlf.problems).toEqual([]);
    expect(crlf.registry).toEqual(lf.registry);
  });

  it('allows an empty contexts array', () => {
    const { registry: parsed, problems } = parseRegistry('version: 1\ncontexts: []\n');

    expect(problems).toEqual([]);
    expect(parsed?.contexts).toEqual([]);
  });
});

describe('registryHash', () => {
  it('ignores CRLF and a BOM and changes with the text', () => {
    const hash = registryHash(SPEC_EXAMPLE);

    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(registryHash(`﻿${SPEC_EXAMPLE.replace(/\n/g, '\r\n')}`)).toBe(hash);
    expect(registryHash(`${SPEC_EXAMPLE}# x\n`)).not.toBe(hash);
  });
});

describe('contexts.schema.json', () => {
  it('agrees with the parser constants', () => {
    const schema = JSON.parse(readFileSync(new URL('../../../schema/contexts.schema.json', import.meta.url), 'utf-8'));
    const ctx = schema.properties.contexts.items.properties;

    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(ctx.rung.enum).toEqual([...RUNGS]);
    expect(ctx.id.pattern).toBe(CONTEXT_ID_PATTERN.source);
    expect(ctx.rulePrefix.pattern).toBe(RULE_PREFIX_PATTERN.source);
    expect(schema.properties.version.const).toBe(1);
  });
});
