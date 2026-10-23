import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Its own file: a file-level mock of node:child_process would break the tests of
// jdt-keepalive.unit.test.ts that rely on a real failed spawn.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { JdtKeepAlive } from '../jdt-process.js';

const mockedSpawn = vi.mocked(spawn);

/** A `java -jar ... --keep-alive` process that reports `ready` as soon as it is spawned. */
function readyProcess(): void {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { writable: true, end: vi.fn(), write: vi.fn() },
    killed: false,
    kill: vi.fn(),
  });
  mockedSpawn.mockImplementationOnce(() => {
    queueMicrotask(() => proc.stdout.emit('data', Buffer.from('{"type":"ready"}\n')));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return proc as any;
  });
}

describe('JdtKeepAlive spawn arguments', () => {
  beforeEach(() => {
    mockedSpawn.mockReset();
  });

  it('the keep-alive process gets --sql-call-sites only when enabled', async () => {
    readyProcess();
    const enabled = new JdtKeepAlive('java', '/app.jar', '/root', { sqlCallSites: true });
    expect(await enabled.start()).toBe(true);
    await enabled.shutdown();

    readyProcess();
    const disabled = new JdtKeepAlive('java', '/app.jar', '/root', { sqlCallSites: false });
    expect(await disabled.start()).toBe(true);
    await disabled.shutdown();

    readyProcess();
    const plain = new JdtKeepAlive('java', '/app.jar', '/root');
    expect(await plain.start()).toBe(true);
    await plain.shutdown();

    expect(mockedSpawn.mock.calls.map((call) => call[1])).toEqual([
      ['-jar', '/app.jar', '/root', '--keep-alive', '--sql-call-sites'],
      ['-jar', '/app.jar', '/root', '--keep-alive'],
      ['-jar', '/app.jar', '/root', '--keep-alive'],
    ]);
  });
});
