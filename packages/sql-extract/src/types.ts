export type SqlTokenKind = 'word' | 'quoted' | 'string' | 'number' | 'variable' | 'punct' | 'batch';

export interface SqlToken {
  readonly kind: SqlTokenKind;
  /** Raw source slice. */
  readonly text: string;
  /** Word as written (temp names keep '#'); quoted: delimiters removed, doubled closers collapsed; string: content. */
  readonly value: string;
  /** UTF-16 offsets into the source. */
  readonly start: number;
  readonly end: number;
  /** 0-based line of the token start. */
  readonly line: number;
}
