import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Project, SyntaxKind } from 'ts-morph';
import type { GraphEdge } from '@ctxo/plugin-api';
import { TsMorphAdapter, type TsMorphAdapterOptions } from '../ts-morph-adapter.js';
import { KNOWN_SQL_APIS, packageOfSpecifier } from '../sql/known-sql-apis.js';
import { ModuleResolver } from '../sql/module-resolver.js';
import { taggedTemplateText } from '../sql/constant-text.js';
import { sqlEdgesFromCallSites } from '../sql/sql-edges.js';

const DATA_KINDS: ReadonlySet<string> = new Set(['reads', 'writes', 'executes']);
const FILE = 'src/run.ts';

/** Preloads `files` (the TypeScript side's `loadProjectSources`) and returns the data edges of `file`. */
async function dataEdges(
  files: Record<string, string>,
  file = FILE,
  options: TsMorphAdapterOptions = { sqlCallSites: true },
): Promise<{ edges: GraphEdge[]; adapter: TsMorphAdapter }> {
  const adapter = new TsMorphAdapter(options);
  const sources = new Map(Object.entries(files));
  adapter.loadProjectSources(sources);
  const edges = await adapter.extractEdges(file, sources.get(file)!);
  return { edges: edges.filter((e) => DATA_KINDS.has(e.kind)), adapter };
}

const reads = (from: string, table: string): GraphEdge => ({ from, to: `${table}::table`, kind: 'reads' });
const writes = (from: string, table: string): GraphEdge => ({ from, to: `${table}::table`, kind: 'writes' });
const executes = (from: string, proc: string): GraphEdge => ({ from, to: `${proc}::procedure`, kind: 'executes' });

/** How each module of the table builds a receiver named `db`. */
const RECEIVERS: Record<string, string> = {
  pg: `import { Pool } from 'pg';\nconst db = new Pool();`,
  mysql2: `import mysql from 'mysql2';\nconst db = mysql.createPool({});`,
  mssql: `import sql from 'mssql';\nconst db = new sql.Request();`,
  knex: `import knex from 'knex';\nconst config = { client: 'mssql' };\nconst db = knex(config);`,
  '@prisma/client': `import { PrismaClient } from '@prisma/client';\nconst db = new PrismaClient();`,
  typeorm: `import { DataSource } from 'typeorm';\nconst options = { type: 'mssql' as const };\nconst db = new DataSource(options);`,
  sequelize: `import { Sequelize } from 'sequelize';\nconst url = 'mssql://localhost/lending';\nconst db = new Sequelize(url);`,
  'better-sqlite3': `import Database from 'better-sqlite3';\nconst file = 'lending.db';\nconst db = new Database(file);`,
};

const ROW_CASES = KNOWN_SQL_APIS.flatMap((row) =>
  row.members.flatMap((member) => row.sql.map((source) => ({ module: row.module, member, source, kind: row.kind }))),
);

describe('SQL call sites: the known-API table', () => {
  it('lists the TypeScript rows of the shared table', () => {
    expect(
      KNOWN_SQL_APIS.map((r) => ({ module: r.module, members: r.members, sql: r.sql, objectKey: r.objectKey, kind: r.kind })),
    ).toEqual([
      { module: 'pg', members: ['query'], sql: ['firstArgument'], objectKey: 'text', kind: 'statement' },
      { module: 'mysql2', members: ['query', 'execute'], sql: ['firstArgument'], objectKey: 'sql', kind: 'statement' },
      { module: 'mssql', members: ['query'], sql: ['firstArgument', 'taggedTemplate'], objectKey: undefined, kind: 'statement' },
      { module: 'mssql', members: ['execute'], sql: ['firstArgument'], objectKey: undefined, kind: 'procedureName' },
      { module: 'knex', members: ['raw'], sql: ['firstArgument'], objectKey: undefined, kind: 'statement' },
      { module: '@prisma/client', members: ['$queryRaw', '$executeRaw'], sql: ['taggedTemplate'], objectKey: undefined, kind: 'statement' },
      { module: '@prisma/client', members: ['$queryRawUnsafe', '$executeRawUnsafe'], sql: ['firstArgument'], objectKey: undefined, kind: 'statement' },
      { module: 'typeorm', members: ['query'], sql: ['firstArgument'], objectKey: undefined, kind: 'statement' },
      { module: 'sequelize', members: ['query'], sql: ['firstArgument'], objectKey: undefined, kind: 'statement' },
      { module: 'better-sqlite3', members: ['prepare', 'exec'], sql: ['firstArgument'], objectKey: undefined, kind: 'statement' },
    ]);
  });

  it('packageOfSpecifier keeps the package part of a specifier', () => {
    expect(packageOfSpecifier('@scope/name/sub')).toBe('@scope/name');
    expect(packageOfSpecifier('@prisma/client')).toBe('@prisma/client');
    expect(packageOfSpecifier('mysql2/promise')).toBe('mysql2');
    expect(packageOfSpecifier('pg')).toBe('pg');
  });

  it.each(ROW_CASES)(
    'every row of the API table yields an edge at a matching call site: $module $member ($source)',
    async ({ module, member, source, kind }) => {
      const text = kind === 'procedureName' ? 'usp_CloseLoan' : 'SELECT * FROM dbo.Loans';
      const call = source === 'taggedTemplate' ? `db.${member}\`${text}\`` : `db.${member}('${text}')`;
      const { edges } = await dataEdges({
        [FILE]: `${RECEIVERS[module]}\n\nexport async function run() {\n  return ${call};\n}\n`,
      });
      expect(edges).toEqual([
        kind === 'procedureName'
          ? executes('src/run.ts::run::function', 'dbo.usp_closeloan')
          : reads('src/run.ts::run::function', 'dbo.loans'),
      ]);
    },
  );

  it('config objects carry the SQL in text for pg and in sql for mysql2', async () => {
    const { edges } = await dataEdges({
      [FILE]: [
        `import { Pool } from 'pg';`,
        `import mysql from 'mysql2/promise';`,
        `const pool = new Pool();`,
        `export async function viaPg() { await pool.query({ text: 'SELECT * FROM dbo.Loans', values: [1] }); }`,
        `export async function viaShorthand() { const text = 'SELECT * FROM dbo.LoanArchive'; await pool.query({ text }); }`,
        `export async function viaMysql() {`,
        `  const conn = await mysql.createConnection({});`,
        `  await conn.query({ sql: 'SELECT * FROM dbo.Members' });`,
        `}`,
        `export async function swappedKeys() {`,
        `  await pool.query({ sql: 'SELECT * FROM dbo.Holds' });`,
        `  const conn = await mysql.createConnection({});`,
        `  await conn.execute({ text: 'SELECT * FROM dbo.Holds' });`,
        `}`,
      ].join('\n'),
    });
    expect(edges).toEqual([
      reads('src/run.ts::viaMysql::function', 'dbo.members'),
      reads('src/run.ts::viaPg::function', 'dbo.loans'),
      reads('src/run.ts::viaShorthand::function', 'dbo.loanarchive'),
    ]);
  });

  it('tagged templates replace interpolations with placeholders', async () => {
    const { edges } = await dataEdges({
      [FILE]: [
        `import { PrismaClient } from '@prisma/client';`,
        `import sql from 'mssql';`,
        `const prisma = new PrismaClient();`,
        `export async function holds(id: number) { return prisma.$queryRaw\`SELECT * FROM dbo.Holds WHERE MemberId = \${id}\`; }`,
        `export async function dynamic(table: string) {`,
        `  const request = new sql.Request();`,
        `  return request.query\`SELECT * FROM \${table}\`;`,
        `}`,
      ].join('\n'),
    });
    expect(edges).toEqual([reads('src/run.ts::holds::function', 'dbo.holds')]);

    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile('t.ts', 'tag`SELECT ${a} FROM dbo.Loans WHERE Id = ${b} AND Note = \'x\'`;');
    const tagged = sf.getFirstDescendantByKindOrThrow(SyntaxKind.TaggedTemplateExpression);
    expect(taggedTemplateText(tagged)).toBe("SELECT @p0 FROM dbo.Loans WHERE Id = @p1 AND Note = 'x'");
  });

  it('constants cover literals, templates, concatenation, const bindings and constant substitutions', async () => {
    const { edges, adapter } = await dataEdges({
      [FILE]: [
        `import { Pool } from 'pg';`,
        `const pool = new Pool();`,
        `const LOANS = 'dbo.Loans';`,
        `const BY_ID = 'SELECT * FROM dbo.Loans WHERE Id = $1';`,
        `export async function constant() {`,
        `  await pool.query('SELECT * FROM dbo.Loans');`,
        `  await pool.query(\`SELECT * FROM dbo.Loans WHERE Id = 1\`);`,
        `  await pool.query('SELECT * FROM ' + LOANS);`,
        `  await pool.query(BY_ID);`,
        `  await pool.query(\`SELECT * FROM \${LOANS} WHERE ClosedAt IS NULL\`);`,
        `}`,
        `function tableName(): string { return 'dbo.Members'; }`,
        `export async function nonConstant(table: string) {`,
        `  let text = 'SELECT * FROM dbo.Members';`,
        `  await pool.query(text);`,
        `  await pool.query(table);`,
        `  await pool.query(tableName());`,
        `  await pool.query(\`SELECT * FROM dbo.Members WHERE Note = '\${table}'\`);`,
        `}`,
      ].join('\n'),
    });
    expect(edges).toEqual([reads('src/run.ts::constant::function', 'dbo.loans')]);
    expect(adapter.getSqlStats()).toEqual({ constant: 5, nonConstant: 4 });
  });

  it('a constant used twice in one expression stays constant', async () => {
    const { edges, adapter } = await dataEdges({
      'src/sql/parts.ts': `export const LOANS = 'dbo.Loans';\nexport const MEMBERS = 'dbo.Members';\n`,
      'src/sql/index.ts': `export * from './parts';\n`,
      [FILE]: [
        `import { Pool } from 'pg';`,
        `import { LOANS, MEMBERS } from './sql';`,
        `const pool = new Pool();`,
        `const S = 'dbo';`,
        `const A = B + 'x';`,
        `const B = A + 'y';`,
        `export async function inTemplate() {`,
        `  await pool.query(\`SELECT * FROM \${S}.Loans l JOIN \${S}.Members m ON m.Id = l.MemberId\`);`,
        `}`,
        `export async function inConcatenation() {`,
        `  await pool.query('SELECT * FROM ' + S + '.Holds h JOIN ' + S + '.Members m ON m.Id = h.MemberId');`,
        `}`,
        `export async function throughOneBarrel() {`,
        `  await pool.query('SELECT * FROM ' + LOANS + ' l JOIN ' + MEMBERS + ' m ON m.Id = l.MemberId');`,
        `}`,
        `export async function cycle() {`,
        `  await pool.query(A);`,
        `}`,
      ].join('\n'),
    });
    expect(edges).toEqual([
      reads('src/run.ts::inConcatenation::function', 'dbo.holds'),
      reads('src/run.ts::inConcatenation::function', 'dbo.members'),
      reads('src/run.ts::inTemplate::function', 'dbo.loans'),
      reads('src/run.ts::inTemplate::function', 'dbo.members'),
      reads('src/run.ts::throughOneBarrel::function', 'dbo.loans'),
      reads('src/run.ts::throughOneBarrel::function', 'dbo.members'),
    ]);
    // The cycle A -> B -> A ends without a text instead of looping.
    expect(adapter.getSqlStats()).toEqual({ constant: 3, nonConstant: 1 });
  });

  it('the receiver must trace to the listed library', async () => {
    const { edges, adapter } = await dataEdges({
      'src/bus.ts': `export const bus = { execute(name: string) { return name; } };\n`,
      [FILE]: [
        `import { bus } from './bus';`,
        `import { Client } from '@elastic/elasticsearch';`,
        `import mysql from 'mysql2/promise';`,
        `import sql from 'mssql';`,
        `const client = new Client({ node: 'http://localhost:9200' });`,
        `export async function notDatabases() {`,
        `  bus.execute('CloseLoan');`,
        `  /x/.exec('SELECT 1 FROM dbo.Loans');`,
        `  await client.query('SELECT * FROM dbo.Loans');`,
        `}`,
        `export async function databases() {`,
        `  const conn = await mysql.createConnection({});`,
        `  await conn.execute('UPDATE dbo.Loans SET Flag = 1');`,
        `  const request = new sql.Request();`,
        `  await request.execute('usp_CloseLoan');`,
        `}`,
      ].join('\n'),
    });
    expect(edges).toEqual([
      executes('src/run.ts::databases::function', 'dbo.usp_closeloan'),
      writes('src/run.ts::databases::function', 'dbo.loans'),
    ]);
    expect(adapter.getSqlStats()).toEqual({ constant: 2, nonConstant: 0 });
  });

  it.each([
    {
      name: 'a constructor parameter property through this',
      from: 'src/run.ts::LoanStore.run::method',
      source: [
        `import { Pool } from 'pg';`,
        `export class LoanStore {`,
        `  constructor(private readonly pool: Pool) {}`,
        `  async run() { return this.pool.query('SELECT * FROM dbo.Loans'); }`,
        `}`,
      ],
    },
    {
      name: 'require with destructuring',
      from: 'src/run.ts::run::function',
      source: [
        `const { Pool } = require('pg');`,
        `const pool = new Pool();`,
        `export async function run() { return pool.query('SELECT * FROM dbo.Loans'); }`,
      ],
    },
    {
      name: 'an awaited factory and a call chain',
      from: 'src/run.ts::run::function',
      source: [
        `import sql from 'mssql';`,
        `const config = { server: 'localhost' };`,
        `export async function run() {`,
        `  const pool = await sql.connect(config);`,
        `  return pool.request().input('id', 1).query('SELECT * FROM dbo.Loans WHERE Id = @id');`,
        `}`,
      ],
    },
    {
      name: 'a subclass',
      from: 'src/run.ts::run::function',
      source: [
        `import { PrismaClient } from '@prisma/client';`,
        `class PrismaService extends PrismaClient {}`,
        `export async function run() { return new PrismaService().$queryRawUnsafe('SELECT * FROM dbo.Loans'); }`,
      ],
    },
    {
      name: 'a parameter typed import("pg").PoolClient',
      from: 'src/run.ts::run::function',
      source: [`export async function run(client: import('pg').PoolClient) { return client.query('SELECT * FROM dbo.Loans'); }`],
    },
    {
      name: 'a typed property and a namespace import',
      from: 'src/run.ts::LoanStore.run::method',
      source: [
        `import * as pg from 'pg';`,
        `export class LoanStore {`,
        `  private readonly pool: pg.Pool = createPool();`,
        `  async run() { return this.pool.query('SELECT * FROM dbo.Loans'); }`,
        `}`,
        `declare function createPool(): unknown;`,
      ],
    },
    {
      name: 'import = require and a function return type',
      from: 'src/run.ts::run::function',
      source: [
        `import sql = require('mssql');`,
        `function request(): sql.Request { return new sql.Request(); }`,
        `export async function run() { return request().query('SELECT * FROM dbo.Loans'); }`,
      ],
    },
    {
      name: 'this inside a subclass of the client',
      from: 'src/run.ts::LoanClient.run::method',
      source: [
        `import { PrismaClient } from '@prisma/client';`,
        `export class LoanClient extends PrismaClient {`,
        `  async run() { return this.$queryRawUnsafe('SELECT * FROM dbo.Loans'); }`,
        `}`,
      ],
    },
  ])('provenance follows annotations, parameter properties, this members, require, destructuring, awaited factories and subclasses: $name', async ({ from, source }) => {
    const { edges } = await dataEdges({ [FILE]: source.join('\n') });
    expect(edges).toEqual([reads(from, 'dbo.loans')]);
  });

  it('provenance follows relative imports, export { x } from re-exports and export * barrels', async () => {
    const { edges } = await dataEdges({
      'src/db/client.ts': `import { Pool } from 'pg';\nexport const pool = new Pool();\nexport const READ_LOANS = 'SELECT * FROM dbo.Loans';\n`,
      'src/db/reexport.ts': `export { pool as loanPool, READ_LOANS as LOANS_SQL } from './client';\n`,
      'src/db/index.ts': `export * from './reexport';\n`,
      [FILE]: [
        `import { loanPool, LOANS_SQL } from './db';`,
        `export async function run() { return loanPool.query(LOANS_SQL); }`,
      ].join('\n'),
    });
    expect(edges).toEqual([reads('src/run.ts::run::function', 'dbo.loans')]);
  });

  it('provenance stops after 8 steps and at a declaration seen before', async () => {
    const chain = [`import { Pool } from 'pg';`, `const a0 = new Pool();`];
    for (let i = 1; i <= 7; i++) chain.push(`const a${i} = a${i - 1};`);
    const { edges } = await dataEdges({
      [FILE]: [
        ...chain,
        `let loop1 = loop2;`,
        `let loop2 = loop1;`,
        `export async function sixHops() { return a6.query('SELECT * FROM dbo.Loans'); }`,
        `export async function sevenHops() { return a7.query('SELECT * FROM dbo.Members'); }`,
        `export async function cycle() { return loop1.query('SELECT * FROM dbo.Holds'); }`,
      ].join('\n'),
    });
    // a6 -> a5 -> ... -> a0 is 7 declaration steps and Pool's import binding the 8th; a7 needs a 9th.
    expect(edges).toEqual([reads('src/run.ts::sixHops::function', 'dbo.loans')]);
  });

  it('ORM and query-builder calls produce nothing', async () => {
    const { edges, adapter } = await dataEdges({
      [FILE]: [
        `import knexFactory from 'knex';`,
        `import { PrismaClient } from '@prisma/client';`,
        `import { DataSource } from 'typeorm';`,
        `import { Model } from 'sequelize';`,
        `const knex = knexFactory({ client: 'mssql' });`,
        `const prisma = new PrismaClient();`,
        `const dataSource = new DataSource({ type: 'mssql' });`,
        `class Loan extends Model {}`,
        `export async function orm() {`,
        `  await knex('Loans').where({ Id: 1 }).select('Id');`,
        `  await prisma.loan.findMany();`,
        `  await dataSource.getRepository('Loan').find();`,
        `  await Loan.findAll();`,
        `}`,
      ].join('\n'),
    });
    expect(edges).toEqual([]);
    expect(adapter.getSqlStats()).toEqual({ constant: 0, nonConstant: 0 });
  });

  it('edges come from the innermost scope', async () => {
    const file = 'src/__tests__/loans.test.ts';
    const { edges } = await dataEdges(
      {
        [file]: [
          `import { Pool } from 'pg';`,
          `const pool = new Pool();`,
          `export async function exportedFn() { await pool.query('SELECT * FROM dbo.Loans'); }`,
          `export class LoanQueries {`,
          `  async byId() { await pool.query('SELECT * FROM dbo.Members'); }`,
          `}`,
          `export const arrow = async () => { await pool.query('SELECT * FROM dbo.Holds'); };`,
          `async function hidden() { await pool.query('SELECT * FROM dbo.LoanArchive'); }`,
          `describe('loans', () => {`,
          `  beforeEach(async () => { await pool.query('DELETE FROM dbo.LoanStaging'); });`,
          `  describe('nested', () => {`,
          `    it('reads', async () => { await pool.query('SELECT * FROM dbo.Reservations'); });`,
          `  });`,
          `});`,
        ].join('\n'),
      },
      file,
    );
    expect(edges).toEqual([
      reads(`${file}::LoanQueries.byId::method`, 'dbo.members'),
      reads(`${file}::arrow::variable`, 'dbo.holds'),
      reads(`${file}::exportedFn::function`, 'dbo.loans'),
      reads(`${file}::loans > nested > reads::function`, 'dbo.reservations'),
      writes(`${file}::loans::function`, 'dbo.loanstaging'),
    ]);
  });

  const MIXED = [
    `import { Pool } from 'pg';`,
    `const pool = new Pool();`,
    `export async function zeta() {`,
    `  await pool.query('SELECT * FROM dbo.Members');`,
    `  await pool.query('SELECT * FROM dbo.Loans');`,
    `  await pool.query('SELECT * FROM dbo.Loans');`,
    `  await pool.query('UPDATE dbo.Loans SET Flag = 1');`,
    `}`,
    `export async function alpha() {`,
    `  await pool.query('EXEC dbo.usp_CloseLoan');`,
    `  await pool.query('SELECT * FROM dbo.Holds');`,
    `}`,
  ].join('\n');

  it('without the capability there are no data edges', async () => {
    const plain = await dataEdges({ [FILE]: MIXED }, FILE, {});
    expect(plain.adapter.sqlCallSites).toBe(false);
    expect(plain.edges).toEqual([]);
    expect(plain.adapter.getSqlStats()).toEqual({ constant: 0, nonConstant: 0 });
    const off = await dataEdges({ [FILE]: MIXED }, FILE, { sqlCallSites: false });
    expect(off.edges).toEqual([]);
  });

  it('edges are unique and sorted by source, kind and target', async () => {
    const { edges } = await dataEdges({ [FILE]: MIXED });
    expect(edges).toEqual([
      executes('src/run.ts::alpha::function', 'dbo.usp_closeloan'),
      reads('src/run.ts::alpha::function', 'dbo.holds'),
      reads('src/run.ts::zeta::function', 'dbo.loans'),
      reads('src/run.ts::zeta::function', 'dbo.members'),
      writes('src/run.ts::zeta::function', 'dbo.loans'),
    ]);
  });

  it('sqlEdgesFromCallSites skips a call-site text longer than 1 MiB', () => {
    const text = (n: number): string => 'SELECT * FROM dbo.Loans'.padEnd(n, ' ');
    expect(
      sqlEdgesFromCallSites([
        { symbolId: 'src/a.ts::a::function', line: 0, text: text(1_048_576), kind: 'statement' },
        { symbolId: 'src/b.ts::b::function', line: 0, text: text(1_048_577), kind: 'statement' },
      ]),
    ).toEqual([reads('src/a.ts::a::function', 'dbo.loans')]);
  });
});

describe('SQL call sites: the module resolver', () => {
  function writeTree(root: string, files: Record<string, string>): void {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text, 'utf-8');
    }
  }

  it('serves project files first, reads candidates from disk under projectRoot and releases only what it read', () => {
    const root = mkdtempSync(join(tmpdir(), 'ctxo-ts-resolver-'));
    try {
      writeTree(root, {
        'src/db/index.ts': 'export const fromDisk = 1;\n',
        'src/queries.ts': 'export const fromDisk = 2;\n',
        'src/legacy.js': 'export const fromDisk = 3;\n',
        'src/view.tsx': 'export const fromDisk = 4;\n',
        'src/preloaded.ts': 'export const fromDisk = 5;\n',
        'src/config.json': '{ "fromDisk": 7 }\n',
        'outside.ts': 'export const fromDisk = 6;\n',
      });
      const project = new Project({ useInMemoryFileSystem: true });
      const from = project.createSourceFile('src/run.ts', '');
      project.createSourceFile('src/preloaded.ts', 'export const inMemory = true;\n');
      const resolver = new ModuleResolver(project, root);

      expect(resolver.sourceFileFor(from, './db')?.getFilePath()).toBe('/src/db/index.ts');
      expect(resolver.sourceFileFor(from, './queries.js')?.getFilePath()).toBe('/src/queries.ts');
      expect(resolver.sourceFileFor(from, './legacy')?.getFilePath()).toBe('/src/legacy.js');
      expect(resolver.sourceFileFor(from, './view')?.getFilePath()).toBe('/src/view.tsx');
      expect(resolver.sourceFileFor(from, './preloaded')?.getText()).toContain('inMemory');
      expect(resolver.sourceFileFor(from, './missing')).toBeUndefined();
      expect(resolver.sourceFileFor(from, './config.json')).toBeUndefined();
      expect(resolver.sourceFileFor(from, '../../outside')).toBeUndefined();
      expect(resolver.sourceFileFor(from, 'pg')).toBeUndefined();

      resolver.release();
      expect(project.getSourceFiles().map((f) => f.getFilePath()).sort()).toEqual(['/src/preloaded.ts', '/src/run.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never reads a file outside projectRoot, with forward or back slashes', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ctxo-ts-resolver-escape-'));
    try {
      const root = join(tmp, 'project');
      writeTree(tmp, {
        'outside.ts': 'export const decoy = true;\n',
        'project/src/inside.ts': 'export const inside = true;\n',
      });
      const project = new Project({ useInMemoryFileSystem: true });
      const nested = project.createSourceFile('src/run.ts', '');
      const top = project.createSourceFile('run.ts', '');
      const resolver = new ModuleResolver(project, root);

      expect(resolver.sourceFileFor(nested, './inside')?.getFilePath()).toBe('/src/inside.ts');
      for (const [from, specifier] of [
        [top, '../outside'],
        [nested, '../../outside'],
        [nested, './..\\..\\outside'],
        [nested, '../..\\outside'],
        [top, './..\\outside'],
      ] as const) {
        expect(resolver.sourceFileFor(from, specifier), `${from.getFilePath()} ${specifier}`).toBeUndefined();
      }
      expect(project.getSourceFiles().some((f) => f.getText().includes('decoy'))).toBe(false);
      resolver.release();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('without projectRoot only project files resolve', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const from = project.createSourceFile('src/run.ts', '');
    project.createSourceFile('src/db.ts', 'export const x = 1;\n');
    const resolver = new ModuleResolver(project);
    expect(resolver.sourceFileFor(from, './db')?.getFilePath()).toBe('/src/db.ts');
    expect(resolver.sourceFileFor(from, './queries')).toBeUndefined();
  });
});
