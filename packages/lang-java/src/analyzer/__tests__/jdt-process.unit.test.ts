import { describe, it, expect, vi, beforeEach } from 'vitest';
import { delimiter } from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { buildAnalyzerArgs, runBatchIndex } from '../jdt-process.js';

const mockedSpawn = vi.mocked(spawn);

/** A batch process that prints `stdout` and exits 0 (the JSONL stream of the analyzer). */
function fakeBatch(stdout: string): void {
  const emitter = new EventEmitter();
  const proc = {
    stdout: Readable.from([stdout]),
    stderr: Readable.from(['']),
    on: (event: string, cb: (...args: unknown[]) => void) => emitter.on(event, cb),
  };
  setTimeout(() => emitter.emit('close', 0), 10);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedSpawn.mockReturnValueOnce(proc as any);
}

describe('buildAnalyzerArgs', () => {
  it('produces basic args ["-jar", jar, root] when no opts', () => {
    const args = buildAnalyzerArgs('/path/to/app.jar', '/project/root');
    expect(args).toEqual(['-jar', '/path/to/app.jar', '/project/root']);
  });

  it('includes --classpath with platform delimiter when classpathOverride provided', () => {
    const args = buildAnalyzerArgs('/app.jar', '/root', { classpathOverride: ['/a', '/b'] });
    const cpIdx = args.indexOf('--classpath');
    expect(cpIdx).toBeGreaterThan(-1);
    expect(args[cpIdx + 1]).toBe(['/a', '/b'].join(delimiter));
  });

  it('uses the correct platform delimiter (os.delimiter)', () => {
    const args = buildAnalyzerArgs('/app.jar', '/root', { classpathOverride: ['/x', '/y', '/z'] });
    const cpIdx = args.indexOf('--classpath');
    const joined = args[cpIdx + 1];
    const parts = joined.split(delimiter);
    expect(parts).toEqual(['/x', '/y', '/z']);
  });

  it('does NOT include --classpath when classpathOverride is empty', () => {
    const args = buildAnalyzerArgs('/app.jar', '/root', { classpathOverride: [] });
    expect(args.includes('--classpath')).toBe(false);
  });

  it('does NOT include --classpath when classpathOverride is absent', () => {
    const args = buildAnalyzerArgs('/app.jar', '/root', {});
    expect(args.includes('--classpath')).toBe(false);
  });

  it('includes --allow-build-tools when allowBuildTools is true', () => {
    const args = buildAnalyzerArgs('/app.jar', '/root', { allowBuildTools: true });
    expect(args.includes('--allow-build-tools')).toBe(true);
  });

  it('does NOT include --allow-build-tools when allowBuildTools is false', () => {
    const args = buildAnalyzerArgs('/app.jar', '/root', { allowBuildTools: false });
    expect(args.includes('--allow-build-tools')).toBe(false);
  });

  it('buildAnalyzerArgs appends --sql-call-sites only when enabled', () => {
    expect(buildAnalyzerArgs('/app.jar', '/root', { sqlCallSites: true })).toEqual([
      '-jar', '/app.jar', '/root', '--sql-call-sites',
    ]);
    expect(buildAnalyzerArgs('/app.jar', '/root', { sqlCallSites: false }).includes('--sql-call-sites')).toBe(false);
    expect(buildAnalyzerArgs('/app.jar', '/root', {}).includes('--sql-call-sites')).toBe(false);
  });
});

describe('runBatchIndex SQL call sites', () => {
  beforeEach(() => {
    mockedSpawn.mockReset();
  });

  it('runBatchIndex reads sqlCallSites records and the sql stats of the done line', async () => {
    const site = {
      symbolId: 'src/A.java::find::method',
      line: 4,
      text: 'SELECT Id FROM dbo.Loans',
      kind: 'statement',
    };
    fakeBatch([
      '{"type":"progress","message":"loading"}',
      JSON.stringify({ type: 'file', file: 'src/A.java', symbols: [], edges: [], complexity: [], sqlCallSites: [site] }),
      JSON.stringify({ type: 'file', file: 'src/B.java', symbols: [], edges: [], complexity: [] }),
      '{"type":"done","totalFiles":2,"elapsed":"1.0s","sql":{"constant":13,"nonConstant":1}}',
      '',
    ].join('\n'));

    const result = await runBatchIndex('java', '/app.jar', '/root', { sqlCallSites: true });

    expect(mockedSpawn.mock.calls[0]![1]).toEqual(['-jar', '/app.jar', '/root', '--sql-call-sites']);
    expect(result.files[0]!.sqlCallSites).toEqual([site]);
    expect(result.files[1]!.sqlCallSites).toBeUndefined();
    expect(result.sql).toEqual({ constant: 13, nonConstant: 1 });
    expect(result.totalFiles).toBe(2);
  });

  it('runBatchIndex has no sql stats when the done line carries none', async () => {
    fakeBatch('{"type":"done","totalFiles":0,"elapsed":"1ms"}\n');
    const result = await runBatchIndex('java', '/app.jar', '/root');
    expect(result.sql).toBeUndefined();
    expect(mockedSpawn.mock.calls[0]![1]).toEqual(['-jar', '/app.jar', '/root']);
  });
});
