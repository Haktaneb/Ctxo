import { spawn } from 'node:child_process';
import { createLogger } from '../logger.js';
import type { SqlCallSite } from '../sql-edges.js';

const log = createLogger('ctxo:lang-go');

export interface AnalyzerSymbol {
  symbolId: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  startOffset?: number;
  endOffset?: number;
  /** Raw struct field tags (struct symbols only); parsed by struct-tags.ts. */
  tags?: Array<{ field: string; tag: string }>;
}

export interface AnalyzerEdge {
  from: string;
  to: string;
  kind: string;
  typeArgs?: string[];
}

export interface AnalyzerFileResult {
  type: 'file';
  file: string;
  symbols: AnalyzerSymbol[];
  edges: AnalyzerEdge[];
  complexity: unknown[];
  /** Raw SQL at known database call sites; only with `--sql-call-sites`, omitted when the file has none. */
  sqlCallSites?: SqlCallSite[];
}

export interface AnalyzerBatchResult {
  files: AnalyzerFileResult[];
  dead: string[];
  hasMain: boolean;
  timeout: boolean;
  totalFiles: number;
  elapsed: string;
  /** Constant and non-constant SQL arguments counted by the run; only with `--sql-call-sites`. */
  sql?: { constant: number; nonConstant: number };
  /** True when the process failed to start, exited non-zero or was killed (for example by the timeout). */
  failed?: boolean;
}

export interface GoAnalyzerRunOptions {
  /** Pass `--sql-call-sites`: the analyzer reports raw SQL at known call sites. */
  readonly sqlCallSites?: boolean;
  /** Kill the analyzer after this long (default 120_000). */
  readonly timeoutMs?: number;
}

/** The analyzer's command line for one module; `--sql-call-sites` only when the option asks for it. */
export function buildGoAnalyzerArgs(moduleRoot: string, options: GoAnalyzerRunOptions = {}): string[] {
  return options.sqlCallSites === true ? ['--root', moduleRoot, '--sql-call-sites'] : ['--root', moduleRoot];
}

/**
 * Spawn the analyzer binary in batch mode and parse its JSONL stream.
 * Failures resolve to an empty result with `failed: true` so the adapter can
 * report the analyzer as unavailable and the composite falls back to
 * tree-sitter without throwing.
 */
export async function runBatchAnalyze(
  binaryPath: string,
  moduleRoot: string,
  options: GoAnalyzerRunOptions = {},
): Promise<AnalyzerBatchResult> {
  return new Promise((resolve) => {
    const empty: AnalyzerBatchResult = {
      files: [], dead: [], hasMain: false, timeout: false, totalFiles: 0, elapsed: '', failed: true,
    };
    const proc = spawn(binaryPath, buildGoAnalyzerArgs(moduleRoot, options), {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? 120_000,
    });

    const files: AnalyzerFileResult[] = [];
    let dead: string[] = [];
    let hasMain = false;
    let timeout = false;
    let totalFiles = 0;
    let elapsed = '';
    let sql: AnalyzerBatchResult['sql'];
    let stderr = '';
    let buffer = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          switch (obj.type) {
            case 'file':
              files.push(obj as AnalyzerFileResult);
              break;
            case 'dead':
              dead = Array.isArray(obj.symbolIds) ? obj.symbolIds : [];
              hasMain = Boolean(obj.hasMain);
              timeout = Boolean(obj.timeout);
              break;
            case 'progress':
              log.info(String(obj.message ?? ''));
              break;
            case 'summary':
              totalFiles = Number(obj.totalFiles ?? 0);
              elapsed = String(obj.elapsed ?? '');
              if (obj.sql && typeof obj.sql === 'object') {
                sql = { constant: Number(obj.sql.constant ?? 0), nonConstant: Number(obj.sql.nonConstant ?? 0) };
              }
              break;
          }
        } catch {
          log.error(`Failed to parse JSONL line: ${line.slice(0, 120)}`);
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code, signal) => {
      if (code !== 0) {
        log.error(`ctxo-go-analyzer exited with code ${code}${signal ? ` (signal ${signal})` : ''}: ${stderr.trim().slice(0, 500)}`);
        resolve(empty);
        return;
      }
      resolve({ files, dead, hasMain, timeout, totalFiles, elapsed, ...(sql ? { sql } : {}) });
    });

    proc.on('error', (err) => {
      log.error(`ctxo-go-analyzer spawn error: ${err.message}`);
      resolve(empty);
    });
  });
}
