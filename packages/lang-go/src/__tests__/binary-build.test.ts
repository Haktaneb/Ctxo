import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const BINARY_BUILD = pathToFileURL(join(import.meta.dirname, '..', 'analyzer', 'binary-build.ts')).href;

/**
 * One builder process: waits for the shared start time, then calls ensureAnalyzerBinary with a fake build that
 * writes the output in two parts with a pause between them (as a real linker writes a large file), and checks the
 * binary it was handed is complete.
 */
const CHILD = `
import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';
const { ensureAnalyzerBinary } = await import(process.argv[2]);
const [, , , sourceDir, cacheRoot, startAt] = process.argv;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
while (Date.now() < Number(startAt)) pause(1);
const build = (outPath) => {
  const fd = openSync(outPath, 'w');
  writeSync(fd, 'BEGIN ' + process.pid + '\\n');
  pause(300);
  writeSync(fd, 'END ' + process.pid + '\\n');
  closeSync(fd);
};
const binary = ensureAnalyzerBinary(sourceDir, '1.24.0', { cacheRoot, build });
const body = readFileSync(binary, 'utf8');
if (!/^BEGIN (\\d+)\\nEND \\1\\n$/.test(body)) {
  process.stderr.write('incomplete binary: ' + JSON.stringify(body) + '\\n');
  process.exit(3);
}
process.stdout.write(binary);
`;

function runChild(script: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, BINARY_BUILD, ...args], { cwd: REPO_ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('ensureAnalyzerBinary concurrent builds', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('several processes building a fresh cache key at once all succeed and leave one complete binary', async () => {
    const work = mkdtempSync(join(tmpdir(), 'ctxo-go-build-'));
    dirs.push(work);
    const sourceDir = join(work, 'src');
    const cacheRoot = join(work, 'cache');
    const script = join(work, 'child.mjs');
    writeFileSync(script, CHILD);
    mkdirSync(sourceDir);
    writeFileSync(join(sourceDir, 'main.go'), 'package main\n\nfunc main() {}\n');

    const startAt = String(Date.now() + 1_500);
    const results = await Promise.all(Array.from({ length: 6 }, () => runChild(script, [sourceDir, cacheRoot, startAt])));

    for (const r of results) expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: '' });
    const paths = new Set(results.map((r) => r.stdout));
    expect(paths.size).toBe(1);

    const [key] = readdirSync(cacheRoot);
    const entries = readdirSync(join(cacheRoot, key!));
    expect(entries).toHaveLength(1);
    expect(readFileSync(join(cacheRoot, key!, entries[0]!), 'utf8')).toMatch(/^BEGIN (\d+)\nEND \1\n$/);
  }, 30_000);
});
