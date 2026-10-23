import { spawn, type ChildProcess } from 'node:child_process';
import { delimiter } from 'node:path';
import { createLogger } from '../logger.js';
import type { SqlCallSite } from '../sql-edges.js';
import { encodeFactOptions } from '../facts/fact-options.js';
import type { FactEvidence, FactOptions } from '../facts/fact-types.js';

const log = createLogger('ctxo:lang-java');

/** A Java annotation as the analyzer reports it; `args` and `named` are absent when empty. */
export interface JdtAnnotation {
  name: string;
  args?: string[];
  named?: Record<string, string>;
}

export interface JdtSymbol {
  symbolId: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  startOffset?: number;
  endOffset?: number;
  /** Source order, capped by the analyzer; absent when the declaration has none. */
  annotations?: JdtAnnotation[];
}

export interface JdtEdge {
  from: string;
  to: string;
  kind: string;
}

export interface JdtFileResult {
  type: 'file';
  file: string;
  symbols: JdtSymbol[];
  edges: JdtEdge[];
  complexity: unknown[];
  /** SQL call sites (only with `--sql-call-sites`; omitted by the analyzer when the file has none). */
  sqlCallSites?: SqlCallSite[];
  /** Fact evidence (only with `--facts=`; omitted by the analyzer when the file has none). */
  factEvidence?: FactEvidence[];
}

/** How many SQL texts the analyzer read as compile-time constants and how many it could not. */
export interface JdtSqlStats {
  constant: number;
  nonConstant: number;
}

export interface JdtBatchResult {
  files: JdtFileResult[];
  totalFiles: number;
  elapsed: string;
  /** From the `done` line; absent without `--sql-call-sites` (the keep-alive prints no `done` line). */
  sql?: JdtSqlStats;
}

export interface RunOpts {
  classpathOverride?: string[];
  allowBuildTools?: boolean;
  timeoutMs?: number;
  /** Pass `--sql-call-sites`: the analyzer reports SQL call-site records and counts. */
  sqlCallSites?: boolean;
  /** Pass `--facts=<encodeFactOptions>`: the analyzer reports fact evidence. */
  facts?: FactOptions;
}

/** The analyzer's `--facts=` argument: standard base64 of `{"normalizationMethods":[...]}`. */
export function factsArgument(facts: FactOptions): string {
  return `--facts=${encodeFactOptions(facts)}`;
}

/** Reads the `sql` member of a `done` line; undefined unless both counts are numbers. */
function parseSqlStats(value: unknown): JdtSqlStats | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { constant, nonConstant } = value as { constant?: unknown; nonConstant?: unknown };
  return typeof constant === 'number' && typeof nonConstant === 'number' ? { constant, nonConstant } : undefined;
}

/**
 * Build the args array for the JDT analyzer process.
 * Extracted as a pure function for unit-testability (no process spawn).
 */
export function buildAnalyzerArgs(jarPath: string, projectRoot: string, opts: RunOpts = {}): string[] {
  const args = ['-jar', jarPath, projectRoot];
  if (opts.classpathOverride?.length) args.push('--classpath', opts.classpathOverride.join(delimiter));
  if (opts.allowBuildTools) args.push('--allow-build-tools');
  if (opts.sqlCallSites) args.push('--sql-call-sites');
  // Last: the analyzer matches it by prefix before its exact-match switch (an older JAR takes it for
  // an extra positional argument and ignores it).
  if (opts.facts) args.push(factsArgument(opts.facts));
  return args;
}

/**
 * Spawn `java -jar <jar> <root> [--classpath ...] [--allow-build-tools]` in batch
 * mode and parse JSONL. Never throws — empty result on any failure.
 */
export async function runBatchIndex(
  javaBin: string,
  jarPath: string,
  projectRoot: string,
  opts: RunOpts = {},
): Promise<JdtBatchResult> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  return new Promise((resolve) => {
    const empty: JdtBatchResult = { files: [], totalFiles: 0, elapsed: '' };
    const args = buildAnalyzerArgs(jarPath, projectRoot, opts);
    const proc = spawn(javaBin, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    const files: JdtFileResult[] = [];
    let sql: JdtSqlStats | undefined;
    let totalFiles = 0,
      elapsed = '',
      stderr = '',
      buffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as {
            type: string;
            message?: unknown;
            totalFiles?: unknown;
            elapsed?: unknown;
            sql?: unknown;
          };
          switch (obj.type) {
            case 'file':
              files.push(obj as unknown as JdtFileResult);
              break;
            case 'progress':
              log.info(String(obj.message ?? ''));
              break;
            case 'done':
              totalFiles = Number(obj.totalFiles ?? 0);
              elapsed = String(obj.elapsed ?? '');
              sql = parseSqlStats(obj.sql);
              break;
          }
        } catch {
          log.error(`Failed to parse JSONL line: ${line.slice(0, 120)}`);
        }
      }
    });
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        log.error(`ctxo-jdt-analyzer exited ${code}: ${stderr.trim().slice(0, 500)}`);
        resolve(empty);
        return;
      }
      resolve({ files, totalFiles, elapsed, ...(sql ? { sql } : {}) });
    });
    proc.on('error', (err) => {
      log.error(`ctxo-jdt-analyzer spawn error: ${(err as Error).message}`);
      resolve(empty);
    });
  });
}

/** Options of the keep-alive process. */
export interface JdtKeepAliveOptions {
  /** Pass `--sql-call-sites` (after `--keep-alive`), so each file result carries its call-site records. */
  readonly sqlCallSites?: boolean;
  /** Pass `--facts=` (after the other flags), so each file result carries its fact evidence. */
  readonly facts?: FactOptions;
  /** Inactivity timeout in milliseconds (default 300000). */
  readonly idleMs?: number;
}

/** Keep-alive JDT analyzer for watch mode: stays alive, re-analyzes one file per request. */
export class JdtKeepAlive {
  private readonly sqlCallSites: boolean;
  private readonly facts: FactOptions | undefined;
  private readonly idleMs: number;
  private proc: ChildProcess | null = null;
  private buffer = '';
  private pending = new Map<string, (r: JdtFileResult | null) => void>();
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly javaBin: string,
    private readonly jarPath: string,
    private readonly projectRoot: string,
    options: JdtKeepAliveOptions = {},
  ) {
    this.sqlCallSites = options.sqlCallSites === true;
    this.facts = options.facts;
    this.idleMs = options.idleMs ?? 300_000;
  }

  async start(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
      const args = ['-jar', this.jarPath, this.projectRoot, '--keep-alive'];
      if (this.sqlCallSites) args.push('--sql-call-sites');
      if (this.facts) args.push(factsArgument(this.facts));
      this.proc = spawn(this.javaBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc.stdout!.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString();
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'ready') { settle(true); }
            else if (obj.type === 'file') {
              const norm = String(obj.file).replace(/\\/g, '/');
              const cb = this.pending.get(norm);
              if (cb) { this.pending.delete(norm); cb(obj as JdtFileResult); }
            }
          } catch {
            log.error(`JdtKeepAlive parse error: ${line.slice(0, 120)}`);
          }
        }
      });
      this.proc.stderr!.on('data', (c: Buffer) => log.error(`jdt keep-alive: ${c.toString().trim()}`));
      this.proc.on('close', () => { this.proc = null; for (const cb of this.pending.values()) cb(null); this.pending.clear(); settle(false); });
      this.proc.on('error', (err) => { log.error(`JdtKeepAlive spawn error: ${err.message}`); settle(false); });
      this.resetIdle();
    });
  }

  isAlive(): boolean { return this.proc !== null && !this.proc.killed; }

  async analyzeFile(relativePath: string): Promise<JdtFileResult | null> {
    if (!this.proc || !this.proc.stdin!.writable) return null;
    const norm = relativePath.replace(/\\/g, '/');
    this.resetIdle();
    return new Promise((resolve) => {
      const prior = this.pending.get(norm);
      if (prior) { this.pending.delete(norm); prior(null); }
      this.pending.set(norm, resolve);
      this.proc!.stdin!.write(JSON.stringify({ file: norm }) + '\n');
      setTimeout(() => {
        if (this.pending.has(norm)) { this.pending.delete(norm); log.error(`JdtKeepAlive timeout for ${norm}`); resolve(null); }
      }, 30_000);
    });
  }

  async shutdown(): Promise<void> {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    if (this.proc) { this.proc.stdin!.end(); this.proc.kill(); this.proc = null; }
  }

  private resetIdle(): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(() => { log.info('JdtKeepAlive idle shutdown'); void this.shutdown(); }, this.idleMs);
  }
}
