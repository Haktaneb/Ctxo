import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from '../logger.js';

const log = createLogger('ctxo:roslyn');

export interface RoslynFileResult {
  type: 'file';
  file: string;
  symbols: RoslynSymbol[];
  edges: RoslynEdge[];
  complexity: RoslynComplexity[];
}

export interface RoslynSymbol {
  symbolId: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  startOffset?: number;
  endOffset?: number;
  /** Attribute annotations; absent when the declaration has none. */
  annotations?: RoslynAnnotation[];
}

/** One attribute as the helper reports it (shape of the protocol v2 SymbolAnnotation). */
export interface RoslynAnnotation {
  name: string;
  args?: string[];
  named?: Record<string, string>;
}

export interface RoslynEdge {
  from: string;
  to: string;
  kind: string;
}

export interface RoslynComplexity {
  symbolId: string;
  cyclomatic: number;
  cognitive: number;
}

export interface RoslynProjectGraph {
  type: 'projectGraph';
  projects: Array<{ name: string; path: string }>;
  edges: Array<{ from: string; to: string; kind: string }>;
}

export interface RoslynBatchResult {
  files: RoslynFileResult[];
  projectGraph: RoslynProjectGraph | null;
  totalFiles: number;
  elapsed: string;
  /** False when the helper exited non-zero, was killed (timeout) or could not be spawned. */
  ok: boolean;
  /** Why the run failed (ok false only): the tail of the error output, at most 500 characters. */
  error?: string;
}

/** Longest `RoslynBatchResult.error`. */
const MAX_ERROR_LENGTH = 500;
/** Build error lines kept from stdout; only the tail of the error output is reported. */
const MAX_BUILD_ERROR_LINES = 20;

/**
 * The failure text of a batch run: the build errors `dotnet run` printed on stdout (restore and
 * compile errors go there, starting at the word "error"), then stderr. Only the tail is kept.
 */
function failureText(buildErrors: readonly string[], stderr: string, fallback: string): string {
  const text = [...buildErrors, stderr.trim()].filter(Boolean).join('\n');
  if (!text) return fallback;
  return text.length > MAX_ERROR_LENGTH ? text.slice(-MAX_ERROR_LENGTH) : text;
}

/**
 * Run ctxo-roslyn in one-shot batch mode.
 * Spawns `dotnet run`, reads JSONL from stdout, returns parsed results.
 * Never rejects: a failed run (restore or build error, timeout, missing dotnet) resolves with
 * `ok: false`, no files and the reason in `error`.
 */
export async function runBatchIndex(
  projectDir: string,
  solutionPath: string,
  timeoutMs = 120_000,
): Promise<RoslynBatchResult> {
  return new Promise((resolve) => {
    const proc = spawn('dotnet', ['run', '--project', projectDir, '--', solutionPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    const files: RoslynFileResult[] = [];
    let projectGraph: RoslynProjectGraph | null = null;
    let totalFiles = 0;
    let elapsed = '';
    let stderr = '';
    const buildErrors: string[] = [];
    let settled = false;

    const fail = (reason: string): void => {
      if (settled) return;
      settled = true;
      const error = failureText(buildErrors, stderr, reason);
      log.error(`ctxo-roslyn failed (${reason}): ${error}`);
      resolve({ files: [], projectGraph: null, totalFiles: 0, elapsed: '', ok: false, error });
    };

    let buffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;

        // dotnet run prints the build output (restore and compile errors) before the helper's JSONL.
        if (!line.startsWith('{')) {
          const errorAt = line.search(/\berror\b/i);
          if (errorAt !== -1) {
            buildErrors.push(line.slice(errorAt));
            if (buildErrors.length > MAX_BUILD_ERROR_LINES) buildErrors.shift();
          }
          log.debug(`ctxo-roslyn build output: ${line.slice(0, 200)}`);
          continue;
        }

        try {
          const obj = JSON.parse(line);
          switch (obj.type) {
            case 'file':
              files.push(obj as RoslynFileResult);
              break;
            case 'projectGraph':
              projectGraph = obj as RoslynProjectGraph;
              break;
            case 'progress':
              log.info(obj.message);
              break;
            case 'done':
              totalFiles = obj.totalFiles ?? 0;
              elapsed = obj.elapsed ?? '';
              break;
          }
        } catch {
          log.error(`Failed to parse JSONL line: ${line.slice(0, 100)}`);
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code, signal) => {
      // A null code means the process was killed, by the timeout or otherwise.
      if (code !== 0) {
        fail(code === null ? `killed by ${signal ?? 'a signal'}` : `exit code ${code}`);
        return;
      }
      if (settled) return;
      settled = true;
      resolve({ files, projectGraph, totalFiles, elapsed, ok: true });
    });

    proc.on('error', (err) => {
      // The spawn error is the reason; the output, if any, comes first.
      stderr += `${stderr ? '\n' : ''}${err.message}`;
      fail(`spawn error: ${err.message}`);
    });
  });
}

/**
 * Keep-alive Roslyn process for watch mode.
 * Stays alive, accepts file paths via stdin, returns results via stdout.
 */
export class RoslynKeepAlive {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private pending: Map<string, (result: RoslynFileResult | null) => void> = new Map();
  private projectDir: string;
  private solutionPath: string;
  private timeoutMs: number;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(projectDir: string, solutionPath: string, timeoutMs = 300_000) {
    this.projectDir = projectDir;
    this.solutionPath = solutionPath;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Resolves true once the helper reports `ready`, and false when it fails to spawn or exits
   * before that (a restore or build failure), so `ctxo watch` never hangs at start.
   */
  async start(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (started: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(started);
      };

      this.proc = spawn('dotnet', ['run', '--project', this.projectDir, '--', this.solutionPath, '--keep-alive'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.proc.stdout!.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString();
        let newlineIdx: number;
        while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, newlineIdx).trim();
          this.buffer = this.buffer.slice(newlineIdx + 1);
          if (!line) continue;

          try {
            const obj = JSON.parse(line);
            if (obj.type === 'ready') {
              log.info(`Roslyn keep-alive ready: ${obj.projectCount} projects, ${obj.fileCount} files`);
              settle(true);
            } else if (obj.type === 'file') {
              const result = obj as RoslynFileResult;
              const callback = this.pending.get(result.file);
              if (callback) {
                this.pending.delete(result.file);
                callback(result);
              }
            } else if (obj.type === 'progress') {
              log.info(obj.message);
            }
          } catch {
            log.error(`Keep-alive parse error: ${line.slice(0, 100)}`);
          }
        }
      });

      this.proc.stderr!.on('data', (chunk: Buffer) => {
        log.error(`Roslyn stderr: ${chunk.toString().trim()}`);
      });

      this.proc.on('close', (code) => {
        log.info(`Roslyn keep-alive exited (code ${code})`);
        this.proc = null;
        if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
        this.inactivityTimer = null;
        // Reject any pending requests
        for (const callback of this.pending.values()) callback(null);
        this.pending.clear();
        // Exited before `ready`: the helper could not restore, build or load the solution.
        settle(false);
      });

      this.proc.on('error', (err) => {
        log.error(`Roslyn keep-alive error: ${err.message}`);
        settle(false);
      });

      this.resetInactivityTimer();
    });
  }

  async analyzeFile(relativePath: string): Promise<RoslynFileResult | null> {
    if (!this.proc || !this.proc.stdin!.writable) {
      return null;
    }

    this.resetInactivityTimer();

    return new Promise((resolve) => {
      this.pending.set(relativePath, resolve);
      this.proc!.stdin!.write(JSON.stringify({ file: relativePath }) + '\n');

      // Per-request timeout
      setTimeout(() => {
        if (this.pending.has(relativePath)) {
          this.pending.delete(relativePath);
          log.error(`Roslyn keep-alive timeout for ${relativePath}`);
          resolve(null);
        }
      }, 30_000);
    });
  }

  isAlive(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  async shutdown(): Promise<void> {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    if (this.proc) {
      this.proc.stdin!.end();
      this.proc.kill();
      this.proc = null;
    }
  }

  private resetInactivityTimer(): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(() => {
      log.info(`Roslyn keep-alive shutting down after ${this.timeoutMs / 1000}s inactivity`);
      this.shutdown();
    }, this.timeoutMs);
  }
}
