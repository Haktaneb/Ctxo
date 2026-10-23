import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuardSessionStore } from '../guard-session-store.js';

const dirs: string[] = [];

function cacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ctxo-domain-guard-store-'));
  dirs.push(dir);
  return join(dir, '.ctxo', '.cache');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('GuardSessionStore', () => {
  it('round-trips a record', () => {
    const store = new GuardSessionStore(cacheDir());
    expect(store.read('s1')).toBeUndefined();
    store.write('s1', { version: 1, startHead: 'abc', blocked: [] });
    expect(store.read('s1')).toEqual({ version: 1, startHead: 'abc', blocked: [] });
    store.write('s1', { version: 1, startHead: null, blocked: ['abc|lending'] });
    expect(store.read('s1')).toEqual({ version: 1, startHead: null, blocked: ['abc|lending'] });
  });

  it('create keeps an existing record (a resumed session)', () => {
    const store = new GuardSessionStore(cacheDir());
    expect(store.create('s1', { version: 1, startHead: 'first', blocked: [] })).toBe(true);
    expect(store.create('s1', { version: 1, startHead: 'second', blocked: [] })).toBe(false);
    expect(store.read('s1')?.startHead).toBe('first');
  });

  it('a corrupt record reads as missing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dir = cacheDir();
    const store = new GuardSessionStore(dir);
    mkdirSync(join(dir, 'domain-guard'), { recursive: true });
    const cases = ['{not json', 'null', '[]', '{"version":2,"startHead":null,"blocked":[]}', '{"version":1,"startHead":5,"blocked":[]}', '{"version":1,"startHead":null,"blocked":[1]}'];
    for (const [i, text] of cases.entries()) {
      writeFileSync(join(dir, 'domain-guard', `c${i}.json`), text, 'utf-8');
      expect(store.read(`c${i}`)).toBeUndefined();
    }
  });

  it('sanitises session ids into file names', () => {
    const dir = cacheDir();
    const store = new GuardSessionStore(dir);
    store.write('a/b\\c', { version: 1, startHead: null, blocked: [] });
    store.write('../up', { version: 1, startHead: null, blocked: [] });
    expect(readdirSync(join(dir, 'domain-guard')).sort()).toEqual(['___up.json', 'a_b_c.json']);
    expect(store.read('a/b\\c')).toEqual({ version: 1, startHead: null, blocked: [] });
  });

  it('write never throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dir = cacheDir();
    mkdirSync(join(dir), { recursive: true });
    // A file where the directory should be makes every write fail.
    writeFileSync(join(dir, 'domain-guard'), 'x', 'utf-8');
    const store = new GuardSessionStore(dir);
    expect(() => store.write('s', { version: 1, startHead: null, blocked: [] })).not.toThrow();
    expect(store.create('s', { version: 1, startHead: null, blocked: [] })).toBe(false);
  });
});
