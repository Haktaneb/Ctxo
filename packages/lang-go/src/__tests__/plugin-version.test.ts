import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { plugin } from '../index.js';

describe('plugin.version', () => {
  it('matches package.json so ctxo update and doctor report the installed version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version: string };
    expect(plugin.version).toBe(pkg.version);
  });
});
