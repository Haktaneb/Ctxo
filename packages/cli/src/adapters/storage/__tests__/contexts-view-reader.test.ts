import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextsViewReader } from '../contexts-view-reader.js';
import { ArchitectureArtifactsWriter } from '../architecture-artifacts-writer.js';
import { resolveContextsViewConfig } from '../../../core/config/load-config.js';
import type { ContextsView } from '../../../core/contexts-view/contexts-view-builder.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

let ctxoRoot: string;
let viewPath: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'ctxo-contexts-view-reader-'));
  roots.push(root);
  ctxoRoot = join(root, '.ctxo');
  mkdirSync(join(ctxoRoot, 'index'), { recursive: true });
  viewPath = join(ctxoRoot, 'index', 'contexts-view.json');
});

function sampleView(): ContextsView {
  return {
    version: 1,
    commitSha: 'abc1234',
    settings: resolveContextsViewConfig({ version: '1.0' }),
    coverage: { files: 4, covered: 3, ratio: 0.75 },
    candidates: [
      {
        id: 1,
        label: 'src/billing',
        fingerprint: '0123456789abcdef',
        fileCount: 3,
        files: ['src/billing/a.ts', 'src/billing/b.ts', 'src/billing/c.ts'],
        cohesion: 1,
        topTerms: [{ term: 'invoice', files: 2 }],
        crossEdges: [{ candidate: 2, total: 2, byKind: { calls: 1, imports: 1 } }],
        coChangePairs: [
          { file: 'src/billing/a.ts', otherFile: 'src/x.ts', otherCandidate: 2, frequency: 0.5, sharedCommits: 2 },
        ],
      },
    ],
    hubs: [{ file: 'src/types.ts', reasons: ['fan-in'], dependents: 12, damping: 0.267, candidate: 1 }],
    unclustered: { count: 1, files: ['src/lonely.ts'] },
    collisions: [
      {
        name: 'Invoice',
        minJaccard: 0.5,
        occurrences: [{ candidate: 1, file: 'src/billing/a.ts', symbolId: 'src/billing/a.ts::Invoice::class', members: ['total'] }],
      },
    ],
  };
}

function setMtime(path: string, seconds: number): void {
  utimesSync(path, seconds, seconds);
}

it('returns the view for a valid file and undefined for a missing one', () => {
  const reader = new ContextsViewReader(ctxoRoot);
  expect(reader.readContextsView()).toBeUndefined();

  const view = sampleView();
  new ArchitectureArtifactsWriter(ctxoRoot).writeContextsView(view);

  expect(reader.readContextsView()).toEqual(view);
});

it('returns undefined and warns once for an invalid or conflict-marked file, then reads the repaired file after it changes', () => {
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
  const reader = new ContextsViewReader(ctxoRoot);
  const view = sampleView();

  writeFileSync(viewPath, `<<<<<<< HEAD\n${JSON.stringify(view, null, 2)}\n=======\n{}\n>>>>>>> branch\n`, 'utf-8');
  setMtime(viewPath, 1_700_000_000);
  expect(reader.readContextsView()).toBeUndefined();
  expect(reader.readContextsView()).toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain('contexts-view.json');

  // Valid JSON of the wrong shape is a different file version: one more warning, not one per call.
  writeFileSync(viewPath, JSON.stringify({ ...view, coverage: { files: 'many' } }), 'utf-8');
  setMtime(viewPath, 1_700_000_100);
  expect(reader.readContextsView()).toBeUndefined();
  expect(reader.readContextsView()).toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(2);

  writeFileSync(viewPath, JSON.stringify(view, null, 2), 'utf-8');
  setMtime(viewPath, 1_700_000_200);
  expect(reader.readContextsView()).toEqual(view);
  expect(warn).toHaveBeenCalledTimes(2);
});

it('picks up a rewritten file by its mtime', () => {
  const reader = new ContextsViewReader(ctxoRoot);
  const view = sampleView();
  writeFileSync(viewPath, JSON.stringify(view, null, 2), 'utf-8');
  setMtime(viewPath, 1_700_000_000);
  expect(reader.readContextsView()?.commitSha).toBe('abc1234');

  writeFileSync(viewPath, JSON.stringify({ ...view, commitSha: 'def5678' }, null, 2), 'utf-8');
  setMtime(viewPath, 1_700_000_300);
  expect(reader.readContextsView()?.commitSha).toBe('def5678');
});
