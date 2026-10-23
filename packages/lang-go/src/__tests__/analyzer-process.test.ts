import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { buildGoAnalyzerArgs, runBatchAnalyze } from '../analyzer/analyzer-process.js';

const mockedSpawn = vi.mocked(spawn);

interface FakeProc {
  stdout: Readable;
  stderr: Readable;
  emitter: EventEmitter;
}

function fakeProcess(opts: { stdout?: string; stderr?: string; exitCode?: number | null; signal?: string; spawnError?: Error } = {}): FakeProc {
  const stdout = Readable.from([opts.stdout ?? '']);
  const stderr = Readable.from([opts.stderr ?? '']);
  const emitter = new EventEmitter();
  // Mirror ChildProcess shape — `on` proxies to our emitter.
  const proc = {
    stdout,
    stderr,
    on: (event: string, cb: (...args: unknown[]) => void) => emitter.on(event, cb),
  };
  setTimeout(() => {
    if (opts.spawnError) {
      emitter.emit('error', opts.spawnError);
    } else {
      emitter.emit('close', opts.exitCode === undefined ? 0 : opts.exitCode, opts.signal ?? null);
    }
  }, 5);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedSpawn.mockReturnValueOnce(proc as any);
  return { stdout, stderr, emitter };
}

describe('runBatchAnalyze — JSONL parsing', () => {
  beforeEach(() => {
    mockedSpawn.mockReset();
  });

  it('parses a successful run with file + dead + summary records', async () => {
    fakeProcess({
      stdout: [
        '{"type":"progress","message":"loading"}',
        '{"type":"file","file":"a.go","symbols":[{"symbolId":"a.go::Foo::function","name":"Foo","kind":"function","startLine":1,"endLine":3}],"edges":[],"complexity":[]}',
        '{"type":"dead","symbolIds":["a.go::Foo::function"],"hasMain":true}',
        '{"type":"summary","totalFiles":1,"elapsed":"42ms"}',
        '',
      ].join('\n'),
    });

    const result = await runBatchAnalyze('/fake/binary', '/some/module');
    expect(result.totalFiles).toBe(1);
    expect(result.elapsed).toBe('42ms');
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.file).toBe('a.go');
    expect(result.files[0]!.symbols[0]!.name).toBe('Foo');
    expect(result.dead).toEqual(['a.go::Foo::function']);
    expect(result.hasMain).toBe(true);
    expect(result.timeout).toBe(false);
  });

  it('returns empty result on non-zero exit', async () => {
    fakeProcess({ exitCode: 1, stderr: 'analyzer crashed: bad input' });
    const result = await runBatchAnalyze('/fake/binary', '/some/module');
    expect(result.files).toHaveLength(0);
    expect(result.dead).toHaveLength(0);
    expect(result.totalFiles).toBe(0);
    expect(result.failed).toBe(true);
  });

  it('marks a run killed by a signal (the spawn timeout) as failed', async () => {
    fakeProcess({ exitCode: null, signal: 'SIGTERM', stdout: '{"type":"file","file":"a.go","symbols":[],"edges":[],"complexity":[]}\n' });
    const result = await runBatchAnalyze('/fake/binary', '/some/module');
    expect(result.failed).toBe(true);
    expect(result.files).toHaveLength(0);
  });

  it('does not mark a successful run as failed', async () => {
    fakeProcess({ stdout: '{"type":"summary","totalFiles":0,"elapsed":"1ms"}\n' });
    const result = await runBatchAnalyze('/fake/binary', '/some/module');
    expect(result.failed).toBeUndefined();
  });

  it('skips malformed lines without throwing', async () => {
    fakeProcess({
      stdout: [
        'not json at all',
        '{"type":"file","file":"a.go","symbols":[],"edges":[],"complexity":[]}',
        '{"type":"summary","totalFiles":1,"elapsed":"1ms"}',
        '',
      ].join('\n'),
    });
    const result = await runBatchAnalyze('/fake/binary', '/some/module');
    expect(result.files).toHaveLength(1);
    expect(result.totalFiles).toBe(1);
  });

  it('returns empty when spawn raises an error', async () => {
    fakeProcess({ spawnError: new Error('ENOENT') });
    const result = await runBatchAnalyze('/nonexistent', '/some/module');
    expect(result.failed).toBe(true);
    expect(result.files).toHaveLength(0);
    expect(result.totalFiles).toBe(0);
  });

  it('flags timeout from dead record', async () => {
    fakeProcess({
      stdout: [
        '{"type":"file","file":"a.go","symbols":[],"edges":[],"complexity":[]}',
        '{"type":"dead","symbolIds":[],"hasMain":false,"timeout":true}',
        '{"type":"summary","totalFiles":1,"elapsed":"60s"}',
        '',
      ].join('\n'),
    });
    const result = await runBatchAnalyze('/fake/binary', '/some/module');
    expect(result.timeout).toBe(true);
    expect(result.hasMain).toBe(false);
  });
});

describe('SQL call sites', () => {
  beforeEach(() => {
    mockedSpawn.mockReset();
  });

  it('buildGoAnalyzerArgs adds --sql-call-sites only when enabled', () => {
    expect(buildGoAnalyzerArgs('/m')).toEqual(['--root', '/m']);
    expect(buildGoAnalyzerArgs('/m', {})).toEqual(['--root', '/m']);
    expect(buildGoAnalyzerArgs('/m', { sqlCallSites: false })).toEqual(['--root', '/m']);
    expect(buildGoAnalyzerArgs('/m', { sqlCallSites: true })).toEqual(['--root', '/m', '--sql-call-sites']);
  });

  it('runBatchAnalyze spawns with those args and reads sqlCallSites and the summary sql stats', async () => {
    fakeProcess({
      stdout: [
        '{"type":"file","file":"a.go","symbols":[],"edges":[],"complexity":[],"sqlCallSites":[{"symbolId":"a.go::Foo::function","line":4,"text":"SELECT Id FROM dbo.Loans","kind":"statement"}]}',
        '{"type":"file","file":"b.go","symbols":[],"edges":[],"complexity":[]}',
        '{"type":"summary","totalFiles":2,"elapsed":"1ms","sql":{"constant":1,"nonConstant":2}}',
        '',
      ].join('\n'),
    });
    const result = await runBatchAnalyze('/fake/binary', '/some/module', { sqlCallSites: true, timeoutMs: 5_000 });

    expect(mockedSpawn).toHaveBeenCalledWith(
      '/fake/binary',
      ['--root', '/some/module', '--sql-call-sites'],
      expect.objectContaining({ timeout: 5_000 }),
    );
    expect(result.files[0]!.sqlCallSites).toEqual([
      { symbolId: 'a.go::Foo::function', line: 4, text: 'SELECT Id FROM dbo.Loans', kind: 'statement' },
    ]);
    expect(result.files[1]!.sqlCallSites).toBeUndefined();
    expect(result.sql).toEqual({ constant: 1, nonConstant: 2 });
  });

  it('runBatchAnalyze without the option spawns without the flag and reports no stats', async () => {
    fakeProcess({ stdout: '{"type":"summary","totalFiles":0,"elapsed":"1ms"}\n' });
    const result = await runBatchAnalyze('/fake/binary', '/some/module');
    expect(mockedSpawn).toHaveBeenCalledWith('/fake/binary', ['--root', '/some/module'], expect.anything());
    expect(result.sql).toBeUndefined();
  });
});
