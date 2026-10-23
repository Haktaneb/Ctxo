import type { SqlTextKind } from '@ctxo/sql-extract';

/**
 * Where a call site's SQL text comes from. `firstArgument`: the constant first argument (or, for a row with
 * an `objectKey`, that property of an object-literal first argument). `taggedTemplate`: the tagged template
 * itself, or a tagged-template first argument, with interpolations replaced by placeholders.
 */
export type SqlTextSource = 'firstArgument' | 'taggedTemplate';

/** One row of the shared known-API table (spec 8A.2), TypeScript side. */
export interface KnownSqlApi {
  /** The npm package the receiver must trace to. */
  readonly module: string;
  /** Members called on the receiver. */
  readonly members: readonly string[];
  /** Text sources, tried in order; the first that gives a text wins. */
  readonly sql: readonly SqlTextSource[];
  /** Config-object property holding the SQL (`{ text }` for pg, `{ sql }` for mysql2). */
  readonly objectKey?: 'text' | 'sql';
  readonly kind: SqlTextKind;
}

/** The TypeScript rows of the shared table. ORM and query-builder calls are deliberately absent. */
export const KNOWN_SQL_APIS: readonly KnownSqlApi[] = [
  { module: 'pg', members: ['query'], sql: ['firstArgument'], objectKey: 'text', kind: 'statement' },
  { module: 'mysql2', members: ['query', 'execute'], sql: ['firstArgument'], objectKey: 'sql', kind: 'statement' },
  { module: 'mssql', members: ['query'], sql: ['firstArgument', 'taggedTemplate'], kind: 'statement' },
  { module: 'mssql', members: ['execute'], sql: ['firstArgument'], kind: 'procedureName' },
  { module: 'knex', members: ['raw'], sql: ['firstArgument'], kind: 'statement' },
  { module: '@prisma/client', members: ['$queryRaw', '$executeRaw'], sql: ['taggedTemplate'], kind: 'statement' },
  { module: '@prisma/client', members: ['$queryRawUnsafe', '$executeRawUnsafe'], sql: ['firstArgument'], kind: 'statement' },
  { module: 'typeorm', members: ['query'], sql: ['firstArgument'], kind: 'statement' },
  { module: 'sequelize', members: ['query'], sql: ['firstArgument'], kind: 'statement' },
  { module: 'better-sqlite3', members: ['prepare', 'exec'], sql: ['firstArgument'], kind: 'statement' },
];

const TABLE_MODULES: ReadonlySet<string> = new Set(KNOWN_SQL_APIS.map((row) => row.module));

/** Every member some row lists: a cheap filter before any provenance walk. */
export const KNOWN_SQL_MEMBERS: ReadonlySet<string> = new Set(KNOWN_SQL_APIS.flatMap((row) => row.members));

/** The package part of a module specifier: `@scope/name/sub` gives `@scope/name`, `mysql2/promise` gives `mysql2`. */
export function packageOfSpecifier(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/** The table module a specifier belongs to, or undefined. */
export function tableModuleOf(specifier: string): string | undefined {
  const pkg = packageOfSpecifier(specifier);
  return TABLE_MODULES.has(pkg) ? pkg : undefined;
}

/** The row for a receiver module and a member, or undefined. */
export function knownSqlApiFor(module: string, member: string): KnownSqlApi | undefined {
  return KNOWN_SQL_APIS.find((row) => row.module === module && row.members.includes(member));
}
