import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { readRegistry } from '../registry-reader.js';

const VALID = 'version: 1\ncontexts:\n  - id: billing\n    name: Billing\n    paths: ["src/Billing/**"]\n    rung: fear\n';

describe('readRegistry', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ctxo-domain-reg-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns undefined for a missing file and reads the configured path', () => {
    expect(readRegistry(root, 'docs/domain/contexts.yaml')).toBeUndefined();

    mkdirSync(join(root, 'custom'), { recursive: true });
    writeFileSync(join(root, 'custom', 'ctx.yaml'), VALID);
    const loaded = readRegistry(root, 'custom/ctx.yaml');

    expect(loaded?.path).toBe('custom/ctx.yaml');
    expect(loaded?.text).toBe(VALID);
    expect(loaded?.problems).toEqual([]);
    expect(loaded?.registry?.contexts.map((c) => c.id)).toEqual(['billing']);
  });

  it('returns the problems of an invalid registry without a registry', () => {
    writeFileSync(join(root, 'ctx.yaml'), 'version: 2\ncontexts: []\n');
    const loaded = readRegistry(root, 'ctx.yaml');

    expect(loaded?.registry).toBeUndefined();
    expect(loaded?.problems.map((p) => p.path)).toEqual(['version']);
  });

  it('refuses a registry path outside the project', () => {
    const loaded = readRegistry(root, '../outside.yaml');

    expect(loaded?.registry).toBeUndefined();
    expect(loaded?.problems).toHaveLength(1);
  });

  it('reads a registry in a folder whose name merely starts with two dots (M2)', () => {
    mkdirSync(join(root, '..docs'), { recursive: true });
    writeFileSync(join(root, '..docs', 'contexts.yaml'), VALID);

    const loaded = readRegistry(root, '..docs/contexts.yaml');

    expect(loaded?.problems).toEqual([]);
    expect(loaded?.registry?.contexts.map((c) => c.id)).toEqual(['billing']);
  });
});
