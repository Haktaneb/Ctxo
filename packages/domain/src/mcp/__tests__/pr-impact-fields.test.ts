import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createModuleHost, type CtxoHost } from '@ctxo/cli/internal';
import { DomainArtifactStore } from '../../adapters/artifact-store.js';
import {
  buildFixtureGraph,
  GLOSSARY_PATH,
  LENDING_CARD,
  LENDING_FIXTURE,
  manyContextsFixture,
  POLICY_FILE,
  REGISTRY_PATH,
  type FixtureInput,
} from '../../core/__tests__/lending-graph.fixture.js';
import { createDomainState } from '../domain-state.js';
import { createEnrichers } from '../enrichers.js';
import { prImpactDomainFields, TOUCHED_FILES_CAP } from '../pr-impact-fields.js';

type Payload = Record<string, unknown>;

let root: string;
let errors: MockInstance;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctxo-domain-pr-impact-'));
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8' });
}

function commit(message: string): void {
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@test.com', 'commit', '-q', '-m', message);
}

/** The domain warnings logged so far (the host logger writes `[ctxo:domain] WARN ...` to stderr). */
function domainWarnings(): string[] {
  return errors.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[ctxo:domain] WARN'));
}

interface Repo {
  readonly host: CtxoHost;
  readonly fields: (payload: Payload, args?: Payload) => Promise<Payload>;
}

/**
 * A temp repo: `main` holds the registry, the cards, the glossary and `code` files; the domain graph is written
 * under the ignored `.ctxo/`; HEAD is then a new `feat` branch.
 */
function repo(options: { fixture?: FixtureInput; registry?: boolean; code?: Record<string, string> } = {}): Repo {
  const fixture = options.fixture ?? LENDING_FIXTURE;
  git('init', '-q', '-b', 'main');
  write('.gitignore', '.ctxo/\n');
  if (options.registry !== false) write(REGISTRY_PATH, fixture.registryText);
  for (const [path, text] of Object.entries(fixture.cards)) write(path, text);
  if (fixture.glossaryText !== undefined) write(GLOSSARY_PATH, fixture.glossaryText);
  for (const [path, text] of Object.entries(options.code ?? { [POLICY_FILE]: 'class LoanPolicy {}\n' })) write(path, text);
  commit('main');
  git('checkout', '-q', '-b', 'feat');
  const host = createModuleHost({ cliVersion: '0.0.0', mode: 'mcp', projectRoot: root });
  new DomainArtifactStore(host.ctxoRoot).writeIfChanged('graph.json', buildFixtureGraph(fixture));
  const enricher = prImpactDomainFields(host, createDomainState(host));
  return { host, fields: async (payload, args = {}) => await enricher(structuredClone(payload), args) };
}

const CORE: Payload = { since: 'main', changedFiles: 1, files: [{ file: POLICY_FILE, symbols: [] }] };

describe('get_pr_impact domain fields', () => {
  it('reports a touched context, its unchanged card and its rules without tests', async () => {
    const { fields } = repo();
    write(POLICY_FILE, 'class LoanPolicy { int limit = 5; }\n');
    commit('raise the limit');

    const result = await fields(CORE, { since: 'main' });

    expect(result['contextsTouched']).toEqual([
      { id: 'lending', status: 'unresolved', card: LENDING_CARD, cardChanged: false, fileCount: 1, files: [POLICY_FILE] },
    ]);
    expect(result['cardsChanged']).toEqual([]);
    expect(result['rulesWithoutTests']).toEqual([
      {
        ruleId: 'LEND-04',
        title: 'A member with an unpaid fine cannot borrow',
        context: 'lending',
        card: LENDING_CARD,
        untested: 'covered by manual QA',
      },
      { ruleId: 'LEND-05', title: 'A loan can be renewed twice', context: 'lending', card: LENDING_CARD },
    ]);
    // A small change: no totals.
    expect(result).not.toHaveProperty('contextsTouchedTotal');
    expect(result).not.toHaveProperty('cardsChangedTotal');
    expect(result).not.toHaveProperty('rulesWithoutTestsTotal');
    // The core fields stay as they were.
    expect(result['files']).toEqual(CORE['files']);
    expect(domainWarnings()).toEqual([]);
  });

  it('an acknowledged context shows the trailer reason', async () => {
    const { fields } = repo();
    write(POLICY_FILE, 'class LoanPolicy { }\n');
    commit('tidy\n\nDomain-Unchanged: lending (refactor only)');
    const sha7 = git('rev-parse', '--short=7', 'HEAD').trim();

    const result = await fields(CORE, { since: 'main' });

    expect(result['contextsTouched']).toEqual([
      {
        id: 'lending',
        status: 'acknowledged',
        card: LENDING_CARD,
        cardChanged: false,
        acknowledged: { commit: sha7, reason: 'refactor only' },
        fileCount: 1,
        files: [POLICY_FILE],
      },
    ]);
  });

  it('a card-only change lists the card in cardsChanged and touches no context', async () => {
    const { fields } = repo();
    write(LENDING_CARD, `${LENDING_FIXTURE.cards[LENDING_CARD]}\nOne more line.\n`);
    commit('card');

    const result = await fields({ files: [] }, { since: 'main' });

    expect(result['contextsTouched']).toEqual([]);
    expect(result['cardsChanged']).toEqual([LENDING_CARD]);
    expect(result['rulesWithoutTests']).toEqual([]);
  });

  it('working-tree changes count', async () => {
    const { fields } = repo();
    write(POLICY_FILE, 'class LoanPolicy { int uncommitted; }\n');
    write('src/Lending/NewRule.cs', 'class NewRule {}\n');
    write(LENDING_CARD, `${LENDING_FIXTURE.cards[LENDING_CARD]}\nDraft.\n`);

    const result = await fields(CORE, { since: 'main' });

    expect(result['contextsTouched']).toEqual([
      {
        id: 'lending',
        status: 'card-changed',
        card: LENDING_CARD,
        cardChanged: true,
        fileCount: 2,
        files: [POLICY_FILE, 'src/Lending/NewRule.cs'],
      },
    ]);
    expect(result['cardsChanged']).toEqual([LENDING_CARD]);
  });

  it('uses the merge base of since and HEAD, and HEAD~1 when since is not given', async () => {
    const { fields } = repo();
    write(POLICY_FILE, 'class LoanPolicy { int a; }\n');
    commit('one');
    write(LENDING_CARD, `${LENDING_FIXTURE.cards[LENDING_CARD]}\nEdit.\n`);
    commit('two');

    // HEAD~1 sees only the card commit.
    const latest = await fields({ files: [] }, {});
    expect(latest['contextsTouched']).toEqual([]);
    expect(latest['cardsChanged']).toEqual([LENDING_CARD]);
    const empty = await fields({ files: [] }, { since: '' });
    expect(empty['contextsTouched']).toEqual([]);

    // main sees both commits.
    const all = await fields({ files: [] }, { since: 'main' });
    expect((all['contextsTouched'] as { id: string; status: string }[]).map((c) => [c.id, c.status])).toEqual([['lending', 'card-changed']]);
  });

  it(`contextsTouched keeps the first ${TOUCHED_FILES_CAP} files of a context with fileCount`, async () => {
    const { fields } = repo();
    const names = Array.from({ length: 12 }, (_, i) => `src/Lending/F${String(i).padStart(2, '0')}.cs`);
    for (const name of names) write(name, 'class F {}\n');
    commit('many files');

    const result = await fields({ files: [] }, { since: 'main' });

    const [lending] = result['contextsTouched'] as { files: string[]; fileCount: number }[];
    expect(lending!.fileCount).toBe(12);
    expect(lending!.files).toEqual(names.slice(0, TOUCHED_FILES_CAP));
  });

  it('the three lists are capped at 50 with their totals', async () => {
    // 60 one-rule contexts, each with an untested rule: touching all 60 gives 60 contexts and 60 rules.
    const fixture = manyContextsFixture(60, 'src/c1/a.cs::A::class', []);
    const code: Record<string, string> = {};
    for (let i = 1; i <= 60; i++) code[`src/c${i}/a.cs`] = 'class A {}\n';
    const { fields } = repo({ fixture, code });
    for (let i = 1; i <= 60; i++) write(`src/c${i}/a.cs`, 'class A { int x; }\n');
    for (const [path, text] of Object.entries(fixture.cards)) write(path, `${text}\nEdited.\n`);
    commit('everything');

    const result = await fields({ files: [] }, { since: 'main' });

    const touched = result['contextsTouched'] as { id: string }[];
    expect(touched).toHaveLength(50);
    expect(result['contextsTouchedTotal']).toBe(60);
    // Codepoint order: c1, c10, c11, ...
    expect(touched.slice(0, 3).map((c) => c.id)).toEqual(['c1', 'c10', 'c11']);
    const cards = result['cardsChanged'] as string[];
    expect(cards).toHaveLength(50);
    expect(result['cardsChangedTotal']).toBe(60);
    expect(cards.slice(0, 2)).toEqual(['docs/domain/c1/domain.md', 'docs/domain/c10/domain.md']);
    const rules = result['rulesWithoutTests'] as { ruleId: string }[];
    expect(rules).toHaveLength(50);
    expect(result['rulesWithoutTestsTotal']).toBe(60);
  });

  it('an unknown since ref adds nothing and warns once', async () => {
    const { fields } = repo();
    write(POLICY_FILE, 'class LoanPolicy { int b; }\n');
    commit('change');

    const result = await fields(CORE, { since: 'no-such-ref' });

    expect(result).toEqual(CORE);
    expect(domainWarnings()).toEqual([
      '[ctxo:domain] WARN The get_pr_impact domain fields are left out: git cannot resolve "no-such-ref" against HEAD',
    ]);
  });

  it('no registry adds nothing', async () => {
    const { fields } = repo({ registry: false });
    write(POLICY_FILE, 'class LoanPolicy { int c; }\n');
    commit('change');

    expect(await fields(CORE, { since: 'main' })).toEqual(CORE);
    expect(domainWarnings()).toEqual([]);
  });

  it('createEnrichers composes the fields into the bounded get_pr_impact enricher', async () => {
    const { host } = repo();
    write(POLICY_FILE, 'class LoanPolicy { int d; }\n');
    commit('change');
    const enrichers = createEnrichers(host, createDomainState(host));

    const result = await enrichers.get_pr_impact!(structuredClone(CORE), { since: 'main' });

    expect((result['contextsTouched'] as { id: string }[]).map((c) => c.id)).toEqual(['lending']);
    expect(result['cardsChanged']).toEqual([]);
    expect((result['rulesWithoutTests'] as { ruleId: string }[]).map((r) => r.ruleId)).toEqual(['LEND-04', 'LEND-05']);
  });
});
