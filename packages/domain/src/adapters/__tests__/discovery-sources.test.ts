import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createModuleHost, type CtxoHost, type FileIndex, type IGitPort } from '@ctxo/cli/internal';
import { discoverConventions } from '../../core/discovery.js';
import { DEFAULT_DOMAIN_CONFIG } from '../../core/domain-config.js';
import { gatherDiscoveryInput } from '../discovery-sources.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ctxo-domain-sources-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const annotated = (file: string, name: string): FileIndex =>
  ({
    file,
    lastModified: 1,
    symbols: [{ symbolId: `${file}::T::method`, name: 'T', kind: 'method', startLine: 0, endLine: 1, annotations: [{ name }] }],
    edges: [],
    intent: [],
    antiPatterns: [],
  }) as FileIndex;

function hostWith(overrides: Partial<CtxoHost['services']>): CtxoHost {
  const base = createModuleHost({ projectRoot: dir, mode: 'cli' });
  return { ...base, services: { ...base.services, ...overrides } };
}

describe('gatherDiscoveryInput', () => {
  it("forwards the host's test annotation list, and it decides which annotated files count as tests", async () => {
    const indices = [annotated('spec/Loans/A.cs', 'CustomTest')];
    const gather = async (names: readonly string[]) => {
      const host = hostWith({ readIndex: () => indices, testFrameworkAnnotations: names });
      const loaded = host.services.loadConfig(host.ctxoRoot);
      return gatherDiscoveryInput(host, dir, host.ctxoRoot, loaded, DEFAULT_DOMAIN_CONFIG);
    };

    const custom = await gather(['CustomTest']);
    expect(custom.testFrameworkAnnotations).toEqual(['CustomTest']);
    expect(discoverConventions(custom).evidence.uncoveredTestFolders).toEqual([{ folder: 'spec/Loans/**', files: 1 }]);

    const other = await gather(['Fact']);
    expect(discoverConventions(other).evidence.uncoveredTestFolders).toEqual([]);
  });

  it('passes the local and remote-tracking branch lists apart', async () => {
    const git = {
      getRefs: async () => ({ branches: ['OPS-1', 'origin/OPS-1'], localBranches: ['OPS-1'], remoteBranches: ['origin/OPS-1'] }),
    } as unknown as IGitPort;
    const host = hostWith({ createGit: () => git, readIndex: () => [] });
    const loaded = host.services.loadConfig(host.ctxoRoot);

    const input = await gatherDiscoveryInput(host, dir, host.ctxoRoot, loaded, DEFAULT_DOMAIN_CONFIG);

    expect(input.localBranches).toEqual(['OPS-1']);
    expect(input.remoteBranches).toEqual(['origin/OPS-1']);
  });

  it('does not feed discovery a card symlinked outside the repository (I2)', async () => {
    const write = (path: string, text: string): void => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text, 'utf-8');
    };
    write(
      'docs/domain/contexts.yaml',
      'version: 1\ncontexts:\n  - id: lending\n    name: Lending\n    card: docs/domain/lending.md\n    paths: ["src/Lending/**"]\n    rung: named\n',
    );
    const card = '# Lending\n\n## Rules and invariants\n### LEND-03 A member holds at most five loans\n';
    const host = hostWith({ readIndex: () => [] });
    const loaded = host.services.loadConfig(host.ctxoRoot);

    // An in-repo card feeds discovery.
    write('docs/domain/lending.md', card);
    const inside = await gatherDiscoveryInput(host, dir, host.ctxoRoot, loaded, DEFAULT_DOMAIN_CONFIG);
    expect(inside.cards.flatMap((c) => c.rules.map((r) => r.id))).toEqual(['LEND-03']);

    const outside = mkdtempSync(join(tmpdir(), 'ctxo-domain-outside-'));
    try {
      writeFileSync(join(outside, 'secret.md'), card, 'utf-8');
      rmSync(join(dir, 'docs/domain/lending.md'));
      try {
        symlinkSync(join(outside, 'secret.md'), join(dir, 'docs/domain/lending.md'), 'file');
      } catch {
        return; // Windows without developer mode cannot make the symlink.
      }
      const linked = await gatherDiscoveryInput(host, dir, host.ctxoRoot, loaded, DEFAULT_DOMAIN_CONFIG);
      expect(linked.cards).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
