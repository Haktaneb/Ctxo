import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InstallCopiesCheck } from '../checks/install-copies-check.js';
import { DoctorCommand } from '../../../cli/doctor-command.js';
import type { CheckContext } from '../../../core/diagnostics/types.js';

describe('InstallCopiesCheck', () => {
  let dir: string;
  let binDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ctxo-install-copies-'));
    binDir = mkdtempSync(join(tmpdir(), 'ctxo-bin-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(binDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const put = (file: string, value: unknown): void => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), JSON.stringify(value), 'utf-8');
  };
  const putBinary = (): void => writeFileSync(join(binDir, process.platform === 'win32' ? 'ctxo.cmd' : 'ctxo'), '', 'utf-8');
  const hooks = (command: string) => ({ hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command }] }] } });
  const run = (pathDirs: readonly string[] = [binDir]) =>
    new InstallCopiesCheck({ pathDirs }).run({ projectRoot: dir, ctxoRoot: join(dir, '.ctxo'), indices: [] } as CheckContext);

  it('warns when MCP uses npx and hooks call ctxo, without naming @ctxo/domain when it is not installed', async () => {
    putBinary();
    put('.mcp.json', { mcpServers: { ctxo: { command: 'npx', args: ['-y', '@ctxo/cli'] } } });
    put('.claude/settings.json', hooks('ctxo gate-hook'));

    const result = await run();

    expect(result.id).toBe('install_copies');
    expect(result.status).toBe('warn');
    expect(result.message).toContain('MCP starts "npx -y @ctxo/cli" while hooks run "ctxo" from PATH');
    expect(JSON.stringify(result)).not.toContain('@ctxo/domain');
  });

  it('reads the servers of every client file and the local settings', async () => {
    putBinary();
    put('.vscode/mcp.json', { servers: { ctxo: { type: 'stdio', command: 'npx', args: ['-y', '@ctxo/cli'] } } });
    put('.claude/settings.local.json', hooks('ctxo gate-hook'));

    expect((await run()).status).toBe('warn');
  });

  it('warns when hooks call ctxo and none is on PATH', async () => {
    put('.mcp.json', { mcpServers: { ctxo: { command: 'ctxo', args: [] } } });
    put('.claude/settings.json', hooks('ctxo gate-hook'));

    const result = await run([]);

    expect(result.status).toBe('warn');
    expect(result.message).toBe('hooks call "ctxo" but no ctxo is on PATH, so they never run');
  });

  it('passes with one copy', async () => {
    putBinary();
    put('.mcp.json', { mcpServers: { ctxo: { command: 'ctxo', args: [] } } });
    put('.claude/settings.json', hooks('ctxo gate-hook'));

    expect(await run()).toMatchObject({ status: 'pass', message: 'one copy: MCP and hooks run ctxo from PATH' });
  });

  it('passes when there is nothing to compare, and ignores hooks that do not start with ctxo', async () => {
    put('.claude/settings.json', hooks('node other.js'));
    put('.mcp.json', 'not an object');

    expect(await run()).toMatchObject({ status: 'pass', message: 'nothing to compare (no ctxo hooks or no MCP entry)' });
  });

  it('survives unreadable and corrupt files', async () => {
    mkdirSync(join(dir, '.mcp.json'));
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), '{ nope', 'utf-8');

    expect((await run()).status).toBe('pass');
  });

  it('doctor registers install_copies', async () => {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stdout.write;
    try {
      await new DoctorCommand(dir).run({ json: true });
    } finally {
      process.stdout.write = orig;
    }
    expect(lines.join('')).toContain('"name": "install_copies"');
  });
});
