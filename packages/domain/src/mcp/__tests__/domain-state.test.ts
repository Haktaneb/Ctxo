import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModuleHost, type CtxoHost, type FileIndex, type IndexPassContext } from '@ctxo/cli/internal';
import { domainIndexPass } from '../../index-pass/domain-index-pass.js';
import { createDomainState, STALE_CARDS_HINT, type DomainStateResult } from '../domain-state.js';

const REGISTRY = `version: 1
contexts:
  - id: lending
    name: Lending
    card: docs/domain/lending/domain.md
    paths: ["src/Lending/**"]
    rung: bounded
    rulePrefix: LEND
`;

const CARD = [
  '# Lending',
  '',
  '## Rules and invariants',
  '### LEND-03 A member holds at most five loans',
  'Code: `src/Lending/Loan.ts`',
  '',
].join('\n');

const INDEX: FileIndex = {
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
  root = mkdtempSync(join(tmpdir(), 'ctxo-domain-state-'));
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

function setUp(): void {
  write('.ctxo/index/src/Lending/Loan.ts.json', JSON.stringify(INDEX, null, 2));
  write('src/Lending/Loan.ts', 'export class Loan {}\n');
  write('docs/domain/contexts.yaml', REGISTRY);
  write('docs/domain/lending/domain.md', CARD);
}

const newHost = (): CtxoHost => createModuleHost({ cliVersion: '0.0.0', mode: 'mcp', projectRoot: root });

async function runPass(): Promise<void> {
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
}

/** Moves a file's mtime by `seconds`, so the stamp changes even within one clock tick. */
function touch(path: string, seconds = 10): void {
  const stat = statSync(path);
  const next = new Date(stat.mtimeMs + seconds * 1000);
  utimesSync(path, next, next);
}

function failure(result: DomainStateResult): { reason: string; hint: string } {
  if (result.ok) throw new Error('expected a failure');
  return { reason: result.reason, hint: result.hint };
}

describe('createDomainState', () => {
  it('does no I/O until the first load (P19)', () => {
    const host = newHost();
    const loadConfig = vi.fn(host.services.loadConfig);
    const spied: CtxoHost = { ...host, services: { ...host.services, loadConfig } };

    // The project does not exist yet: creating the state must not read or cache anything.
    const state = createDomainState(spied);
    expect(loadConfig).not.toHaveBeenCalled();

    setUp();
    expect(loadConfig).not.toHaveBeenCalled();
    expect(failure(state.load()).reason).toBe('no-graph');
    expect(loadConfig).toHaveBeenCalledTimes(1);
  });

  it('reports no-registry, invalid-registry, no-graph and stale-registry with their hints', async () => {
    const state = createDomainState(newHost());

    expect(failure(state.load())).toEqual({
      reason: 'no-registry',
      hint: 'No domain registry at docs/domain/contexts.yaml. Create one with "ctxo init --domain".',
    });

    write('docs/domain/contexts.yaml', REGISTRY.replace('rung: bounded', 'rung: unknown'));
    expect(failure(state.load())).toEqual({
      reason: 'invalid-registry',
      hint: 'The domain registry at docs/domain/contexts.yaml has problems; run "ctxo verify-domain".',
    });

    setUp();
    touch(join(root, 'docs/domain/contexts.yaml'));
    expect(failure(state.load())).toEqual({ reason: 'no-graph', hint: 'No domain graph yet; run "ctxo index".' });

    await runPass();
    const ok = state.load();
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.snapshot.registryPath).toBe('docs/domain/contexts.yaml');
      expect(ok.snapshot.staleCards).toBe(false);
      expect(ok.snapshot.index.rules.get('LEND-03')?.context).toBe('lending');
      expect(ok.snapshot.ownership.ownerOf('src/Lending/Loan.ts')).toBe('lending');
      expect(ok.snapshot.config.registry).toBe('docs/domain/contexts.yaml');
    }

    write('docs/domain/contexts.yaml', REGISTRY.replace('name: Lending', 'name: Lending desk'));
    touch(join(root, 'docs/domain/contexts.yaml'));
    expect(failure(state.load())).toEqual({
      reason: 'stale-registry',
      hint: 'The domain registry changed since the last "ctxo index"; run it to rebuild the domain graph.',
    });
  });

  it('marks stale cards after a card edit and clears after re-indexing', async () => {
    setUp();
    await runPass();
    const state = createDomainState(newHost());
    const first = state.load();
    expect(first.ok && first.snapshot.staleCards).toBe(false);

    write('docs/domain/lending/domain.md', `${CARD}\nA new paragraph.\n`);
    touch(join(root, 'docs/domain/lending/domain.md'));
    const stale = state.load();
    expect(stale.ok).toBe(true);
    if (stale.ok) {
      expect(stale.snapshot.staleCards).toBe(true);
      // The answers still come from the graph.
      expect(stale.snapshot.index.rules.has('LEND-03')).toBe(true);
    }
    expect(STALE_CARDS_HINT).toBe('Cards or the glossary changed since the last "ctxo index"; run it to refresh rule links.');

    // A glossary that appears is a card change too.
    await runPass();
    const fresh = state.load();
    expect(fresh.ok && fresh.snapshot.staleCards).toBe(false);
    write('docs/domain/glossary.md', '- **Loan**: a book lent\n');
    const glossaryStale = state.load();
    expect(glossaryStale.ok && glossaryStale.snapshot.staleCards).toBe(true);

    await runPass();
    const cleared = state.load();
    expect(cleared.ok && cleared.snapshot.staleCards).toBe(false);
  });

  it('reloads only after a file changes', async () => {
    setUp();
    await runPass();
    const state = createDomainState(newHost());
    const first = state.load();
    const second = state.load();
    if (!first.ok || !second.ok) throw new Error('expected a snapshot');
    expect(second.snapshot).toBe(first.snapshot);
    expect(second.snapshot.generation).toBe(first.snapshot.generation);

    touch(join(ctxoRoot, 'index', 'domain', 'graph.json'));
    const third = state.load();
    if (!third.ok) throw new Error('expected a snapshot');
    expect(third.snapshot.generation).toBeGreaterThan(first.snapshot.generation);
    expect(third.snapshot).not.toBe(first.snapshot);
  });
});
