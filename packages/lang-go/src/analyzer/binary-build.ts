import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('ctxo:lang-go');
const BINARY_NAME = platform() === 'win32' ? 'ctxo-go-analyzer.exe' : 'ctxo-go-analyzer';
const BUILD_TIMEOUT_MS = 180_000;

/** Test seams: the cache root (default ~/.cache/ctxo/lang-go-analyzer) and the build step (default go build). */
export interface AnalyzerBuildOptions {
  readonly cacheRoot?: string;
  readonly build?: (outPath: string, sourceDir: string) => void;
}

function goBuild(outPath: string, sourceDir: string): void {
  execFileSync('go', ['build', '-trimpath', '-o', outPath, '.'], {
    cwd: sourceDir,
    timeout: BUILD_TIMEOUT_MS,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

/**
 * Hash the analyzer source tree + go version into a cache key, then build
 * the binary into ~/.cache/ctxo/lang-go-analyzer/<key>/ on first use. ADR-013
 * §4 Q2 - postinstall rejected (breaks sandboxed npm); `go run` rejected
 * (3-5s overhead per invocation).
 *
 * Safe when several processes (vitest workers, parallel CI jobs, two ctxo
 * runs) build the same key at once: each builds into its own temp file next
 * to the cache entry and renames it into place, so no process ever runs or
 * overwrites a half-written binary. A process whose build or rename fails
 * while another one's binary is already in place uses that binary.
 */
export function ensureAnalyzerBinary(sourceDir: string, goVersion: string, options: AnalyzerBuildOptions = {}): string {
  const key = `${hashSourceTree(sourceDir)}-go${goVersion}`;
  const cacheDir = join(options.cacheRoot ?? join(homedir(), '.cache', 'ctxo', 'lang-go-analyzer'), key);
  const binaryPath = join(cacheDir, BINARY_NAME);
  const build = options.build ?? goBuild;

  if (existsSync(binaryPath)) return binaryPath;

  mkdirSync(cacheDir, { recursive: true });
  const ext = platform() === 'win32' ? '.exe' : '';
  const tempPath = join(cacheDir, `.build-${process.pid}-${randomBytes(4).toString('hex')}${ext}`);
  log.info(`Building ctxo-go-analyzer (first run): ${binaryPath}`);
  try {
    build(tempPath, sourceDir);
    if (!existsSync(tempPath)) throw new Error('go build completed but expected binary is missing');
    renameSync(tempPath, binaryPath);
  } catch (err) {
    rmSync(tempPath, { force: true });
    // A concurrent build won (on Windows a rename over a running binary fails): use its binary.
    if (existsSync(binaryPath)) return binaryPath;
    const message = (err as Error).message;
    throw new Error(message.startsWith('go build completed') ? message : `go build failed: ${message}`);
  }
  return binaryPath;
}

function hashSourceTree(dir: string): string {
  const hash = createHash('sha1');
  const files: string[] = [];
  walk(dir, (path) => {
    if (path.endsWith('.go') || path.endsWith('go.mod') || path.endsWith('go.sum')) {
      files.push(path);
    }
  });
  files.sort();
  for (const f of files) {
    hash.update(f);
    hash.update(readFileSync(f));
  }
  return hash.digest('hex').slice(0, 12);
}

function walk(dir: string, cb: (path: string) => void): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as import('node:fs').Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, String(entry.name));
    if (entry.isDirectory()) walk(path, cb);
    else if (entry.isFile()) cb(path);
  }
}
