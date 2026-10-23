import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModuleHost, type CtxoHost, type FileIndex, type IndexPassContext, type RankedContextScope } from '@ctxo/cli/internal';
import { register } from '../../index.js';
import { domainIndexPass } from '../../index-pass/domain-index-pass.js';
import { domainVersion } from '../../version.js';
import { createDomainState, RACY_WINDOW_MS, STALE_CARDS_HINT } from '../domain-state.js';
import { DOMAIN_SCOPE, domainRankedScope } from '../domain-scope.js';

const REGISTRY = `version: 1
contexts:
  - id: lending
    name: Lending
    card: docs/domain/lending/domain.md
    paths: ["src/Lending/**"]
    rung: bounded
    rulePrefix: LEND
  - id: billing
    name: Billing
    paths: ["src/Billing/**"]
    rung: pinned
`;

const CARD = [
  '# Lending',
  '',
  'Lending lends books to members.',
  '',
  '## Language',
  '- **Loan**: a book lent to a member',
  '',
  '## Rules and invariants',
  '### LEND-03 A member holds at most five loans',
  'Code: `src/Lending/Loan.ts`',
  '',
  'The sixth checkout is refused at the desk.',
  '',
  '## Boundary contracts',
  'Lending asks Billing for open invoices.',
  '',
  '## Decisions',
  '- 2026-09-12: Loan limit raised from 3 to 5. [spec](../../specs/loan-limit.md)',
  '',
].join('\n');

const GLOSSARY = '- **Member**: a registered patron of the library\n';
const SPEC = 'docs/specs/loan-limit.md';
const SPEC_TEXT = '# Loan limit\n\nThe limit rose from three to five loans after the renewal study.\n';

const CODE_INDEX: FileIndex = {
  file: 'src/Lending/Loan.ts',
  lastModified: 1_700_000_000,
  symbols: [{ symbolId: 'src/Lending/Loan.ts::Loan::class', name: 'Loan', kind: 'class', startLine: 0, endLine: 3 }],
  edges: [],
  intent: [],
  antiPatterns: [],
};

let root: string;
let ctxoRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctxo-domain-scope-'));
  ctxoRoot = join(root, '.ctxo');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function write(path: string, text: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, 'utf-8');
}

/** Moves a file's mtime `seconds` into the past, out of the racy window. */
function age(path: string, seconds = 10): void {
  const stat = statSync(join(root, path));
  const next = new Date(stat.mtimeMs - seconds * 1000);
  utimesSync(join(root, path), next, next);
}

const newHost = (): CtxoHost => createModuleHost({ cliVersion: '0.0.0', mode: 'mcp', projectRoot: root });

async function setUp(registry = REGISTRY, cards: Record<string, string> = { 'docs/domain/lending/domain.md': CARD }): Promise<void> {
  write('.ctxo/index/src/Lending/Loan.ts.json', JSON.stringify(CODE_INDEX, null, 2));
  write('src/Lending/Loan.ts', 'export class Loan {}\n');
  write('docs/domain/contexts.yaml', registry);
  write('docs/domain/glossary.md', GLOSSARY);
  write(SPEC, SPEC_TEXT);
  for (const [path, text] of Object.entries(cards)) write(path, text);
  const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: root });
  const { services } = host;
  const indices = services.readIndex(ctxoRoot);
  const config = services.loadConfig(ctxoRoot).config;
  const ctx: IndexPassContext = {
    projectRoot: root,
    ctxoRoot,
    config,
    indices,
    graph: () => services.buildGraph(indices),
    isTestFile: services.createTestFileCheck(config, indices),
  };
  await domainIndexPass(host)(ctx);
  for (const path of ['docs/domain/contexts.yaml', 'docs/domain/glossary.md', SPEC, '.ctxo/index/domain/graph.json', ...Object.keys(cards)]) age(path);
}

function scopeOf(host = newHost()): RankedContextScope {
  return domainRankedScope(host, createDomainState(host));
}

type Obj = Record<string, unknown>;
interface Hit {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly context?: string;
  readonly path: string;
  readonly line?: number;
  readonly excerpt: string;
  readonly relevanceScore: number;
  readonly tokens: number;
}

async function search(scope: RankedContextScope, query: string, tokenBudget = 4000): Promise<Obj> {
  return (await scope.search({ query, tokenBudget })) as Obj;
}

const hits = (payload: Obj): Hit[] => payload['results'] as Hit[];

describe('domain scope of get_ranked_context', () => {
  it('names the scope with its description and register contributes it', async () => {
    const scope = scopeOf();
    expect(DOMAIN_SCOPE).toBe('domain');
    expect(scope.scope).toBe('domain');
    expect(scope.description).toBe('"domain": card sections, glossary entries and in-repo provenance files from @ctxo/domain.');

    const registration = await register(createModuleHost({ cliVersion: domainVersion(), mode: 'mcp', projectRoot: root }));
    expect(registration!.rankedContextScopes!.map((s) => s.scope)).toEqual(['domain']);
  });

  it('finds a rule by words in its body', async () => {
    await setUp();
    const payload = await search(scopeOf(), 'checkout refused');
    expect(payload).toMatchObject({ query: 'checkout refused', scope: 'domain', tokenBudget: 4000 });
    expect(payload['searchMetrics']).toBeDefined();
    expect(hits(payload)[0]).toMatchObject({
      id: 'rule:LEND-03',
      kind: 'rule',
      title: 'LEND-03 A member holds at most five loans',
      context: 'lending',
      path: 'docs/domain/lending/domain.md',
      line: 9,
    });
    expect(hits(payload)[0]!.excerpt).toContain('The sixth checkout is refused at the desk.');
  });

  it('finds a rule by the words of its title, with punctuation in the query', async () => {
    await setUp();
    const scope = scopeOf();
    const asked = await search(scope, 'five loans?');
    expect(hits(asked).map((h) => h.id)).toContain('rule:LEND-03');
    // The punctuation never reaches the engine: the same hits, scores included, as the plain words.
    expect(asked['results']).toEqual((await search(scope, 'five loans'))['results']);
    expect(hits(await search(scope, 'at most five loans?!'))[0]!.id).toBe('rule:LEND-03');
  });

  it('punctuation on body-only words still gives exact hits, not a fallback', async () => {
    await setUp();
    const scope = scopeOf();
    for (const [query, first] of [
      ['refused?', 'rule:LEND-03'],
      ['renewal study.', `file:${SPEC}`],
    ] as const) {
      const payload = await search(scope, query);
      expect((payload['searchMetrics'] as Obj)['porterHits'], query).toBeGreaterThan(0);
      expect(payload['fuzzyCorrection'], query).toBeUndefined();
      expect(hits(payload)[0]!.id, query).toBe(first);
    }
  });

  it('finds a glossary entry by its definition', async () => {
    await setUp();
    expect(hits(await search(scopeOf(), 'registered patron'))[0]).toMatchObject({
      id: 'term:*/member',
      kind: 'term',
      title: 'Member',
      path: 'docs/domain/glossary.md',
      line: 1,
    });
  });

  it('finds a provenance file by its text', async () => {
    await setUp();
    const first = hits(await search(scopeOf(), 'renewal study'))[0]!;
    expect(first).toMatchObject({ id: `file:${SPEC}`, kind: 'provenance', title: 'Loan limit', path: SPEC });
    expect(first).not.toHaveProperty('context');
  });

  it('finds a section and a decision', async () => {
    await setUp();
    expect(hits(await search(scopeOf(), 'open invoices'))[0]).toMatchObject({ kind: 'section', title: 'Boundary contracts', context: 'lending' });
    expect(hits(await search(scopeOf(), 'raised'))[0]).toMatchObject({ id: 'decision:lending/2026-09-12-1', kind: 'decision', title: '2026-09-12 decision' });
  });

  it('results stay within the token budget', async () => {
    await setUp();
    const scope = scopeOf();
    const all = await search(scope, 'loan limit lending member');
    const small = await search(scope, 'loan limit lending member', 100);
    expect(hits(all).length).toBeGreaterThan(hits(small).length);
    expect(small['tokenBudget']).toBe(100);
    expect(small['totalTokens']).toBeLessThanOrEqual(100);
    expect(small['totalTokens']).toBe(hits(small).reduce((sum, h) => sum + h.tokens, 0));
  });

  it('corrects a typo', async () => {
    await setUp();
    const payload = await search(scopeOf(), 'chekout');
    expect(payload['fuzzyCorrection']).toBeDefined();
    expect(hits(payload)[0]!.id).toBe('rule:LEND-03');
  });

  it('no registry gives the graceful hint', async () => {
    expect(await search(scopeOf(), 'loan')).toEqual({
      found: false,
      hint: 'No domain registry at docs/domain/contexts.yaml. Create one with "ctxo init --domain".',
    });
  });

  it('the same query twice gives identical results', async () => {
    await setUp();
    const scope = scopeOf();
    const a = await search(scope, 'loan limit');
    const b = await search(scope, 'loan limit');
    const c = await search(scopeOf(), 'loan limit');
    expect(hits(a).length).toBeGreaterThan(1);
    expect(b['results']).toEqual(a['results']);
    expect(c['results']).toEqual(a['results']);
    expect(JSON.stringify({ ...b, searchMetrics: undefined })).toBe(JSON.stringify({ ...a, searchMetrics: undefined }));
  });

  it('stale cards add stale and the hint', async () => {
    await setUp();
    const scope = scopeOf();
    expect((await search(scope, 'checkout'))['stale']).toBeUndefined();

    write('docs/domain/lending/domain.md', `${CARD}\nAn edit after indexing.\n`);
    age('docs/domain/lending/domain.md', 5);
    const stale = await search(scope, 'checkout');
    expect(stale['stale']).toBe(true);
    expect(stale['hint']).toBe(STALE_CARDS_HINT);
    expect(hits(stale)[0]!.id).toBe('rule:LEND-03');
  });

  it('a punctuation-only query gives no results', async () => {
    await setUp();
    const payload = await search(scopeOf(), '?!');
    expect(payload).toMatchObject({ scope: 'domain', results: [], totalTokens: 0 });
  });

  it('rebuilds the index only when the snapshot or a provenance file changes', async () => {
    await setUp();
    const base = newHost();
    const build = vi.fn(base.services.createDocumentSearch);
    const host: CtxoHost = { ...base, services: { ...base.services, createDocumentSearch: build } };
    const scope = domainRankedScope(host, createDomainState(host));

    await search(scope, 'renewal study');
    await search(scope, 'loan');
    expect(build).toHaveBeenCalledTimes(1);
    const docs = build.mock.calls[0]![0];
    const ids = docs.map((d) => d.id);
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

    write(SPEC, '# Loan limit\n\nThe limit rose after the overdue survey.\n');
    age(SPEC, 5);
    const after = hits(await search(scope, 'overdue survey'));
    expect(build).toHaveBeenCalledTimes(2);
    expect(after[0]!.id).toBe(`file:${SPEC}`);
  });

  it('a provenance file modified within the racy window is re-read on every search', async () => {
    await setUp();
    const base = newHost();
    const build = vi.fn(base.services.createDocumentSearch);
    const host: CtxoHost = { ...base, services: { ...base.services, createDocumentSearch: build } };
    const fixed = new Date(Math.floor(Date.now() / 1000) * 1000);
    let clock = fixed.getTime() + 500;
    const scope = domainRankedScope(host, createDomainState(host), { now: () => clock });

    // Same size, same mtime: only the racy rule can tell the second text from the first.
    write(SPEC, '# Loan limit\n\nThe limit rose after the overdue survey.\n');
    utimesSync(join(root, SPEC), fixed, fixed);
    await search(scope, 'overdue');
    write(SPEC, '# Loan limit\n\nThe limit rose after the backlog survey.\n');
    utimesSync(join(root, SPEC), fixed, fixed);
    expect(hits(await search(scope, 'backlog'))[0]!.id).toBe(`file:${SPEC}`);
    expect(build).toHaveBeenCalledTimes(2);

    // Past the window the stamp is trusted again.
    clock += RACY_WINDOW_MS + 60_000;
    await search(scope, 'backlog');
    await search(scope, 'backlog');
    expect(build).toHaveBeenCalledTimes(3);
  });

  it('a provenance file it cannot search is logged once with its path and reason', async () => {
    await setUp();
    const base = newHost();
    const warn = vi.fn();
    const host: CtxoHost = {
      ...base,
      services: {
        ...base.services,
        createLogger: (namespace: string) => {
          const logger = base.services.createLogger(namespace);
          return namespace === 'ctxo:domain' ? { ...logger, warn } : logger;
        },
      },
    };
    // Over 256 KB and written just now: racy, so every search rebuilds and meets it again.
    write(SPEC, `# Loan limit\n${'x'.repeat(262_144)}`);
    const scope = domainRankedScope(host, createDomainState(host));
    await search(scope, 'renewal');
    await search(scope, 'renewal');
    expect(warn.mock.calls).toEqual([[`provenance file ${SPEC} is not searched: larger than 262144 bytes`]]);
  });

  it('a card two contexts share gives one hit per context for the same section', async () => {
    const shared = `version: 1
contexts:
  - id: lending
    name: Lending
    card: docs/domain/shared.md
    paths: ["src/Lending/**"]
    rung: named
  - id: billing
    name: Billing
    card: docs/domain/shared.md
    paths: ["src/Billing/**"]
    rung: named
`;
    await setUp(shared, { 'docs/domain/shared.md': '# Shared\n\nOne card for the circulation desk.\n' });
    const found = hits(await search(scopeOf(), 'circulation desk')).filter((h) => h.kind === 'section');
    expect(found.map((h) => [h.id, h.context])).toEqual([
      ['section:docs/domain/shared.md:1', 'billing'],
      ['section:docs/domain/shared.md:1', 'lending'],
    ]);
  });
});
