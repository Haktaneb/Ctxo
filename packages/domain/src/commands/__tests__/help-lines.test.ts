import { describe, expect, it } from 'vitest';
import type { CtxoHost } from '@ctxo/cli/internal';
import { contextsTouchedCommand } from '../contexts-touched-command.js';
import { domainCommand } from '../domain-command.js';
import { verifyDomainCommand } from '../verify-domain-command.js';

describe('module command help lines (M3)', () => {
  it('carry no leading whitespace: the CLI indents them once under its heading', () => {
    const host = {} as CtxoHost;
    for (const command of [verifyDomainCommand(host), contextsTouchedCommand(host), domainCommand(host)]) {
      expect(command.help.length, command.name).toBeGreaterThan(0);
      for (const line of command.help) expect(line, command.name).toMatch(/^ctxo /);
    }
  });
});
