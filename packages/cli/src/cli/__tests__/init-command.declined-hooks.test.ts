import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The interactive flow talks to the terminal through @clack/prompts. Scripted answers: accept the
// default index directory, pick no AI tool, and decline the git hooks.
vi.mock('@clack/prompts', () => ({
  text: vi.fn(async () => '.ctxo/index'),
  multiselect: vi.fn(async () => []),
  confirm: vi.fn(async () => false),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

import { InitCommand } from '../init-command.js';

let dir: string;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ctxo-init-declined-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('InitCommand - declined git hooks advice', () => {
  it('points at ctxo index --commit HEAD and no longer claims ctxo index --check records snapshots', async () => {
    await new InitCommand(dir).run({ noInstall: true });

    const output = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('ctxo watch');
    expect(output).toContain('ctxo index --commit HEAD');
    expect(output).toContain('records no snapshot');
    expect(output).toContain('ctxo init');
    expect(output).not.toMatch(/add `ctxo index --check` to CI/);
    expect(existsSync(join(dir, '.git', 'hooks', 'post-commit'))).toBe(false);
  });
});
