import { afterEach, describe, it, expect, vi } from 'vitest';
import { parseCard } from '../card-parser.js';
import { leavesProject } from '../../adapters/repo-files.js';
import { decisionLinks, leavesRepository, resolveProvenanceTarget } from '../decision-links.js';
import { decisionNodeId, type DecisionNode, type DomainLink } from '../domain-graph.js';

const CARD = 'docs/domain/lending/domain.md';

function decision(text: string, card = CARD) {
  const parsed = parseCard(['# Lending', '', '## Decisions', '', `- 2026-09-12: ${text}`, ''].join('\n')).decisions[0]!;
  const node: DecisionNode = {
    id: decisionNodeId('lending', parsed.date, 1),
    context: 'lending',
    card,
    date: parsed.date,
    n: 1,
    line: parsed.line,
    text: parsed.text,
  };
  return { decisions: [node], parsed: new Map([[node.id, parsed]]) };
}

function links(
  text: string,
  options: { ruleIds?: string[]; trackerPrefixes?: string[]; fileExists?: (p: string) => boolean; isDirectory?: (p: string) => boolean } = {},
): DomainLink[] {
  return decisionLinks({
    ...decision(text),
    ruleIds: new Set(options.ruleIds ?? []),
    trackerPrefixes: new Set(options.trackerPrefixes ?? []),
    fileExists: options.fileExists ?? (() => true),
    ...(options.isDirectory ? { isDirectory: options.isDirectory } : {}),
  });
}

const FROM = decisionNodeId('lending', '2026-09-12', 1);
const AT = { file: CARD, line: 5 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveProvenanceTarget', () => {
  it("relative links resolve against the card's folder", () => {
    expect(resolveProvenanceTarget(CARD, '../../specs/loan-limit.md')).toEqual({ kind: 'file', path: 'docs/specs/loan-limit.md' });
    expect(resolveProvenanceTarget(CARD, './notes.md')).toEqual({ kind: 'file', path: 'docs/domain/lending/notes.md' });
    expect(resolveProvenanceTarget(CARD, '..\\..\\adr\\a.md')).toEqual({ kind: 'file', path: 'docs/adr/a.md' });
    const [link] = links('see [spec](../../specs/loan-limit.md)');
    expect(link).toEqual({
      kind: 'decision-provenance',
      from: FROM,
      to: { kind: 'file', path: 'docs/specs/loan-limit.md', exists: true },
      source: 'card-link',
      at: AT,
      offset: 11,
      label: 'spec',
    });
  });

  it('a leading slash starts at the repository root; anchors and queries are dropped and %20 is decoded', () => {
    expect(resolveProvenanceTarget(CARD, '/docs/adr/adr-007.md')).toEqual({ kind: 'file', path: 'docs/adr/adr-007.md' });
    expect(resolveProvenanceTarget(CARD, '/docs/my%20spec.md?plain=1#limits')).toEqual({ kind: 'file', path: 'docs/my spec.md' });
    expect(resolveProvenanceTarget(CARD, 'spec.md#top')).toEqual({ kind: 'file', path: 'docs/domain/lending/spec.md' });
    expect(resolveProvenanceTarget(CARD, 'bad%E0%A4%A.md')).toEqual({ kind: 'file', path: 'docs/domain/lending/bad%E0%A4%A.md' });
  });

  it('a name that merely starts with two dots stays inside the repository', () => {
    expect(resolveProvenanceTarget('README.md', '..hidden/x.md')).toEqual({ kind: 'file', path: '..hidden/x.md' });
  });

  it('a link that leaves the repository is kept as an external string and never checked on disk', () => {
    expect(resolveProvenanceTarget(CARD, '../../../../outside.md')).toEqual({ kind: 'external', value: '../../../../outside.md' });
    expect(resolveProvenanceTarget(CARD, '/../etc/passwd')).toEqual({ kind: 'external', value: '/../etc/passwd' });
    const fileExists = vi.fn((_: string) => true);
    const result = links('[x](../../../../outside.md) and [y](../../specs/a.md)', { fileExists });
    expect(result.map((l) => l.to)).toEqual([
      { kind: 'external', value: '../../../../outside.md' },
      { kind: 'file', path: 'docs/specs/a.md', exists: true },
    ]);
    expect(fileExists.mock.calls).toEqual([['docs/specs/a.md']]);
  });

  it('URLs, mailto: and protocol-relative links are external, and anchors alone are not provenance', () => {
    expect(resolveProvenanceTarget(CARD, 'https://example.com/a#b')).toEqual({ kind: 'external', value: 'https://example.com/a#b' });
    expect(resolveProvenanceTarget(CARD, 'mailto:team@example.com')).toEqual({ kind: 'external', value: 'mailto:team@example.com' });
    expect(resolveProvenanceTarget(CARD, '//cdn.example.com/x')).toEqual({ kind: 'external', value: '//cdn.example.com/x' });
    expect(resolveProvenanceTarget(CARD, '#loan')).toEqual({ kind: 'anchor' });
    const fileExists = vi.fn((_: string) => true);
    const result = links('[a](https://example.com/a) [m](mailto:team@example.com) [p](//cdn.example.com/x) [h](#loan)', { fileExists });
    expect(result.map((l) => l.to)).toEqual([
      { kind: 'external', value: 'https://example.com/a' },
      { kind: 'external', value: 'mailto:team@example.com' },
      { kind: 'external', value: '//cdn.example.com/x' },
    ]);
    expect(result.every((l) => l.kind === 'decision-provenance' && l.source === 'card-link')).toBe(true);
    expect(fileExists).not.toHaveBeenCalled();
  });
});

describe('decisionLinks', () => {
  it('the spec decision gives two file links and the external #123 in text order', () => {
    const result = links(
      'Loan limit raised from 3 to 5. [spec](../../specs/loan-limit.md), #123, [ADR-007](../../adr/adr-007-loan-limit.md)',
    );
    expect(result).toEqual([
      { kind: 'decision-provenance', from: FROM, to: { kind: 'file', path: 'docs/specs/loan-limit.md', exists: true }, source: 'card-link', at: AT, offset: 38, label: 'spec' },
      { kind: 'decision-provenance', from: FROM, to: { kind: 'external', value: '#123' }, source: 'card-text', at: AT, offset: 66 },
      {
        kind: 'decision-provenance',
        from: FROM,
        to: { kind: 'file', path: 'docs/adr/adr-007-loan-limit.md', exists: true },
        source: 'card-link',
        at: AT,
        offset: 82,
        label: 'ADR-007',
      },
    ]);
  });

  it('bare URLs become external card-text provenance', () => {
    expect(links('see https://example.com/x.').map((l) => [l.to, l.source])).toEqual([
      [{ kind: 'external', value: 'https://example.com/x' }, 'card-text'],
    ]);
  });

  it('a missing file is kept with exists: false', () => {
    const result = links('[gone](../../specs/gone.md)', { fileExists: () => false });
    expect(result.map((l) => l.to)).toEqual([{ kind: 'file', path: 'docs/specs/gone.md', exists: false }]);
  });

  it('decisions link to rule IDs written exactly', () => {
    const result = links('LEND-03, LEND-3, Lend03 and LEND-99', { ruleIds: ['LEND-03'] });
    expect(result).toEqual([{ kind: 'decision-rule', from: FROM, to: 'rule:LEND-03', source: 'card-text', at: AT }]);
    expect(links('XLEND-03 and LEND-03a', { ruleIds: ['LEND-03'] })).toEqual([]);
  });

  it('with LEND as a tracker prefix, LEND-03 still links and LEND-456 becomes external provenance', () => {
    const result = links('Raised for LEND-456 after LEND-03; OPS-1 is not a tracker.', {
      ruleIds: ['LEND-03'],
      trackerPrefixes: ['LEND'],
    });
    expect(result).toEqual([
      { kind: 'decision-provenance', from: FROM, to: { kind: 'external', value: 'LEND-456' }, source: 'card-text', at: AT, offset: 11 },
      { kind: 'decision-rule', from: FROM, to: 'rule:LEND-03', source: 'card-text', at: AT },
    ]);
  });

  it('a repeated reference gives one link', () => {
    const result = links('LEND-03 and LEND-03 again, LEND-7 and LEND-7', { ruleIds: ['LEND-03'], trackerPrefixes: ['LEND'] });
    expect(result.map((l) => l.kind)).toEqual(['decision-rule', 'decision-provenance']);
    // The repeated tracker key keeps its first offset.
    expect(result.flatMap((l) => (l.kind === 'decision-provenance' ? [l.offset] : []))).toEqual([27]);
  });

  it('every provenance link carries its exact offset: a reference inside another, a repeated label, a trimmed label', () => {
    const offsets = (text: string): [string, number][] =>
      links(text).flatMap((l) => (l.kind === 'decision-provenance' ? [[l.to.kind === 'file' ? l.to.path : l.to.value, l.offset] as [string, number]] : []));
    expect(offsets('see #123 and #12')).toEqual([
      ['#123', 4],
      ['#12', 13],
    ]);
    expect(offsets('[doc](../../b.md) then [doc](../../a.md)')).toEqual([
      ['docs/b.md', 6],
      ['docs/a.md', 29],
    ]);
    expect(offsets('[ spec ](../../z.md), #9')).toEqual([
      ['docs/z.md', 9],
      ['#9', 22],
    ]);
  });

  it('decisions are processed in order and each link carries its own decision line', () => {
    const parsed = parseCard(['## Decisions', '- 2026-09-12: LEND-03', '- 2026-09-12: #9'].join('\n')).decisions;
    const nodes: DecisionNode[] = parsed.map((p, i) => ({
      id: decisionNodeId('lending', p.date, i + 1),
      context: 'lending',
      card: CARD,
      date: p.date,
      n: i + 1,
      line: p.line,
      text: p.text,
    }));
    const result = decisionLinks({
      decisions: nodes,
      parsed: new Map(nodes.map((n, i) => [n.id, parsed[i]!])),
      ruleIds: new Set(['LEND-03']),
      trackerPrefixes: new Set(),
      fileExists: () => true,
    });
    expect(result.map((l) => [l.from, 'at' in l ? l.at.line : 0])).toEqual([
      [nodes[0]!.id, 2],
      [nodes[1]!.id, 3],
    ]);
  });

  it('external provenance is never fetched', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('no network')));
    const result = links('[a](https://example.com/a) https://example.com/b #12 LEND-9', { trackerPrefixes: ['LEND'] });
    expect(result).toHaveLength(4);
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a link to the repository root or a directory is not provenance', () => {
    expect(resolveProvenanceTarget(CARD, '../../..')).toEqual({ kind: 'directory' });
    expect(resolveProvenanceTarget(CARD, '/')).toEqual({ kind: 'directory' });
    expect(resolveProvenanceTarget('README.md', './')).toEqual({ kind: 'directory' });
    expect(resolveProvenanceTarget(CARD, '../../specs/')).toEqual({ kind: 'directory' });
    const fileExists = vi.fn((_: string) => true);
    const result = links('[root](../../..) [slash](/) [dir](../../specs/) [folder](../../specs) [file](../../specs/a.md)', {
      fileExists,
      isDirectory: (path) => path === 'docs/specs',
    });
    expect(result.map((l) => l.to)).toEqual([{ kind: 'file', path: 'docs/specs/a.md', exists: true }]);
    expect(fileExists.mock.calls).toEqual([['docs/specs/a.md']]);
  });
});

describe('leaving the repository', () => {
  it.each([
    ['..', true],
    ['../x', true],
    ['/abs', true],
    ['..hidden', false],
    ['..hidden/x.md', false],
    ['docs/../x', false],
  ] as const)('%s: the core check agrees with leavesProject (%s)', (path, leaves) => {
    expect(leavesProject(path)).toBe(leaves);
    expect(leavesRepository(path)).toBe(leaves);
  });

  it.each([
    ['..', { kind: 'external', value: '..' }],
    ['../x', { kind: 'external', value: '../x' }],
    // In a card link a leading slash is the repository root (GitHub's reading), so it stays inside.
    ['/abs', { kind: 'file', path: 'abs' }],
    ['..hidden', { kind: 'file', path: '..hidden' }],
  ] as const)('resolveProvenanceTarget from the root README: %s', (path, expected) => {
    expect(resolveProvenanceTarget('README.md', path)).toEqual(expected);
  });
});
