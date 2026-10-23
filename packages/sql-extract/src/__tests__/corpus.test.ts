import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSqlAccesses } from '../accesses.js';
import { extractSqlDefinitions } from '../definitions.js';
import type { SqlAccess } from '../types.js';

const corpusDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'corpus');

interface AccessLists { reads: string[]; writes: string[]; executes: string[] }
interface ExpectedDefinition { kind: string; name: string; columns?: string[] }
interface RawCase {
  description: string;
  mode: string;
  sides?: string[];
  definitions?: ExpectedDefinition[];
  accesses: AccessLists;
}
interface CorpusCase extends Omit<RawCase, 'sides'> {
  name: string;
  sides: string[];
  /** True when the expected.json names its sides. */
  sidesGiven: boolean;
}

const DEFAULT_SIDES: Record<string, string[]> = {
  statement: ['sql-extract', 'scriptdom'],
  file: ['sql-extract', 'lang-sql', 'scriptdom'],
};

/** Host-language cases (PR 1C): `<case>.<ext>.fixture`, whose mode follows the extension. */
const HOST_MODES: Record<string, string> = { ts: 'typescript', java: 'java', go: 'go' };
const HOST_SOURCE = /^(.+)\.(ts|java|go)\.fixture$/;
const isSqlMode = (mode: string): boolean => mode === 'statement' || mode === 'file';

/** The sides of a case: as written, else the default of its mode; host-language modes default to none. */
const sidesOf = (raw: Pick<RawCase, 'mode' | 'sides'>): string[] => raw.sides ?? DEFAULT_SIDES[raw.mode] ?? [];

/** Reads every case, whatever its mode. */
function loadAllCases(): CorpusCase[] {
  return readdirSync(corpusDir)
    .filter((f) => f.endsWith('.expected.json'))
    .sort()
    .map((f) => {
      const raw = JSON.parse(readFileSync(join(corpusDir, f), 'utf8')) as RawCase;
      return { ...raw, name: f.slice(0, -'.expected.json'.length), sides: sidesOf(raw), sidesGiven: raw.sides !== undefined };
    });
}

/** The selections of the three SQL-side loops: this file, lang-sql's corpus test and the ScriptDom test. */
const selectedBySqlExtract = (c: CorpusCase): boolean => isSqlMode(c.mode) && c.sides.includes('sql-extract');
const selectedByLangSql = (c: CorpusCase): boolean => c.mode === 'file' && c.sides.includes('lang-sql');
const selectedByScriptDom = (c: CorpusCase): boolean => isSqlMode(c.mode) && c.sides.includes('scriptdom');

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sqlOf = (c: CorpusCase): string => readFileSync(join(corpusDir, `${c.name}.sql`), 'utf8');
const hostSourceOf = (c: CorpusCase): string => {
  const ext = Object.keys(HOST_MODES).find((e) => HOST_MODES[e] === c.mode)!;
  return readFileSync(join(corpusDir, `${c.name}.${ext}.fixture`), 'utf8');
};

function lists(accesses: readonly SqlAccess[]): AccessLists {
  const sets = { reads: new Set<string>(), writes: new Set<string>(), executes: new Set<string>() };
  for (const a of accesses) sets[a.kind].add(a.name);
  return { reads: [...sets.reads].sort(cmp), writes: [...sets.writes].sort(cmp), executes: [...sets.executes].sort(cmp) };
}

/** What sql-extract gives for a case, in the corpus shape. */
function actual(c: CorpusCase, text: string): Pick<CorpusCase, 'definitions' | 'accesses'> {
  if (c.mode === 'statement') return { accesses: lists(extractSqlAccesses(text)) };
  const defs = extractSqlDefinitions(text).definitions;
  return {
    definitions: defs
      .map((d) => (d.kind === 'table' ? { kind: d.kind, name: d.name, columns: [...d.columns] } : { kind: d.kind, name: d.name }))
      .sort((a, b) => cmp(a.name, b.name) || cmp(a.kind, b.kind)),
    accesses: lists(defs.flatMap((d) => d.accesses)),
  };
}

function expected(c: CorpusCase): Pick<CorpusCase, 'definitions' | 'accesses'> {
  return c.mode === 'statement' ? { accesses: c.accesses } : { definitions: c.definitions, accesses: c.accesses };
}

const allCases = loadAllCases();
/** Statement and file cases: SQL text in `<case>.sql`. */
const cases = allCases.filter((c) => isSqlMode(c.mode));
/** Host-language cases: source in `<case>.<ts|java|go>.fixture`, run only by the matching plugin. */
const hostCases = allCases.filter((c) => !isSqlMode(c.mode));
const ours = allCases.filter(selectedBySqlExtract);

describe('conformance corpus', () => {
  it('every corpus source (.sql or .<ts|java|go>.fixture) has an expected.json and the reverse', () => {
    const files = readdirSync(corpusDir);
    const sources = new Map<string, string[]>();
    for (const f of files) {
      const name = f.endsWith('.sql') ? f.slice(0, -'.sql'.length) : HOST_SOURCE.exec(f)?.[1];
      if (name !== undefined) sources.set(name, [...(sources.get(name) ?? []), f]);
    }
    const expectedCases = new Set(files.filter((f) => f.endsWith('.expected.json')).map((f) => f.slice(0, -'.expected.json'.length)));
    for (const name of sources.keys()) expect(expectedCases.has(name), `${name}.expected.json`).toBe(true);
    for (const name of expectedCases) expect(sources.get(name), `the source of ${name}`).toHaveLength(1);
    expect(cases.length).toBeGreaterThan(0);
    expect(hostCases.length).toBeGreaterThan(0);
  });

  it('host-language cases use the mode of their extension', () => {
    const byName = new Map(allCases.map((c) => [c.name, c]));
    for (const f of readdirSync(corpusDir)) {
      const host = HOST_SOURCE.exec(f);
      if (host) expect(byName.get(host[1]!)?.mode, f).toBe(HOST_MODES[host[2]!]);
      if (f.endsWith('.sql')) expect(['statement', 'file'], f).toContain(byName.get(f.slice(0, -'.sql'.length))?.mode);
    }
    for (const c of hostCases) expect(Object.values(HOST_MODES), c.name).toContain(c.mode);
  });

  it('host-language cases default to sides []', () => {
    for (const mode of Object.values(HOST_MODES)) expect(sidesOf({ mode }), mode).toEqual([]);
    for (const c of hostCases) {
      expect(c.sidesGiven, `${c.name} leaves sides out`).toBe(false);
      expect(c.sides, c.name).toEqual([]);
      expect(selectedBySqlExtract(c) || selectedByLangSql(c) || selectedByScriptDom(c), c.name).toBe(false);
    }
    expect(ours.every((c) => isSqlMode(c.mode))).toBe(true);
  });

  it('every host-language case has a description, sorted lists and LF text', () => {
    for (const c of hostCases) {
      expect(typeof c.description, c.name).toBe('string');
      expect(c.definitions, c.name).toBeUndefined();
      expect(Object.keys(c.accesses).sort(), c.name).toEqual(['executes', 'reads', 'writes']);
      for (const list of [c.accesses.reads, c.accesses.writes, c.accesses.executes]) {
        expect(list, c.name).toEqual([...new Set(list)].sort(cmp));
      }
      const text = hostSourceOf(c);
      expect(text.includes('\r'), `${c.name} fixture has CR`).toBe(false);
      expect(text.charCodeAt(0), `${c.name} fixture has a BOM`).not.toBe(0xfeff);
    }
  });

  it('every case has a description, known sides, sorted lists and LF text', () => {
    for (const c of cases) {
      expect(typeof c.description, c.name).toBe('string');
      for (const side of c.sides) expect(['sql-extract', 'lang-sql', 'scriptdom'], c.name).toContain(side);
      expect(Object.keys(c.accesses).sort(), c.name).toEqual(['executes', 'reads', 'writes']);
      for (const list of [c.accesses.reads, c.accesses.writes, c.accesses.executes]) {
        expect(list, c.name).toEqual([...new Set(list)].sort(cmp));
      }
      if (c.mode === 'file') {
        const defs = c.definitions ?? [];
        expect(defs.length, c.name).toBeGreaterThan(0);
        expect(defs, c.name).toEqual([...defs].sort((a, b) => cmp(a.name, b.name) || cmp(a.kind, b.kind)));
        for (const d of defs) expect(d.columns !== undefined, `${c.name} ${d.name}`).toBe(d.kind === 'table');
      } else {
        expect(c.definitions, c.name).toBeUndefined();
      }
      const text = sqlOf(c);
      expect(text.includes('\r'), `${c.name}.sql has CR`).toBe(false);
      expect(text.charCodeAt(0), `${c.name}.sql has a BOM`).not.toBe(0xfeff);
    }
  });

  it.each(ours.filter((c) => c.mode === 'statement'))('$name: statement accesses match', (c) => {
    expect(actual(c, sqlOf(c))).toEqual(expected(c));
  });

  it.each(ours.filter((c) => c.mode === 'file'))('$name: definitions and body accesses match', (c) => {
    expect(actual(c, sqlOf(c))).toEqual(expected(c));
  });

  it.each(ours)('$name: CRLF line endings give the same result', (c) => {
    expect(actual(c, sqlOf(c).replace(/\n/g, '\r\n'))).toEqual(expected(c));
  });
});
