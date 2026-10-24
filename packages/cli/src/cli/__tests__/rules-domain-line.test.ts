import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMPACT_DOMAIN_LINE,
  FULL_DOMAIN_LINE,
  RULES_TEMPLATE_VERSION,
  classifyRulesBlock,
  renderRulesBlock,
  ruleBody,
  scanRulesBlocks,
  type RulesTier,
} from '../../core/agent-rules/rules-block.js';
import { AiRulesCheck } from '../../adapters/diagnostics/checks/agent-setup-check.js';
import type { CheckContext, DoctorReport } from '../../core/diagnostics/types.js';
import { installRules } from '../ai-rules.js';
import { applyFixes } from '../doctor-fix.js';
import { InitCommand } from '../init-command.js';
import { isolateGitEnv, type IsolatedGitEnv } from './git-test-env.js';

/**
 * #191: the rules block names `ctxo domain discover` only when `@ctxo/domain` is installed. The module loader
 * is stubbed so `ctxo init` sees the module (or not) without a real package.
 */
const domain = vi.hoisted(() => ({ installed: false }));

vi.mock('../../adapters/modules/module-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../adapters/modules/module-loader.js')>();
  return {
    ...actual,
    loadCtxoModules: async () =>
      domain.installed
        ? { modules: [{ name: '@ctxo/domain', version: '0.0.0', registration: { id: 'domain' } }], reports: [] }
        : { modules: [], reports: [] },
  };
});

vi.mock('../../adapters/language/plugin-discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../adapters/language/plugin-discovery.js')>();
  return {
    ...actual,
    resolvePackageCandidates: (name: string, ...rest: unknown[]) =>
      name === '@ctxo/domain'
        ? domain.installed
          ? ['/stub/@ctxo/domain']
          : []
        : (actual.resolvePackageCandidates as (...a: unknown[]) => string[])(name, ...rest),
  };
});

const TIERS: readonly RulesTier[] = ['compact', 'full'];

function nonBlankLines(text: string): number {
  return text.split('\n').filter((line) => line.trim() !== '').length;
}

describe('the domain line in the rules block (#191)', () => {
  it('is in both tiers with the domain module and in neither without it; the template version is unchanged', () => {
    expect(RULES_TEMPLATE_VERSION).toBe('0.13');
    expect(renderRulesBlock('compact', { domain: true })).toContain(COMPACT_DOMAIN_LINE);
    expect(renderRulesBlock('full', { domain: true })).toContain(FULL_DOMAIN_LINE);
    for (const tier of TIERS) {
      const plain = renderRulesBlock(tier);
      expect(plain).not.toContain('ctxo domain discover');
      // Without the module the block is byte-identical to the one before #191.
      expect(renderRulesBlock(tier, { domain: false })).toBe(plain);
      expect(ruleBody({ tier, domain: false })).toBe(ruleBody({ tier }));
    }
  });

  it('keeps the compact tier within its cap of 8 non-blank lines', () => {
    expect(nonBlankLines(renderRulesBlock('compact', { domain: true }))).toBe(7);
  });

  it('puts the full-tier line under "Orientation in Unfamiliar Areas"', () => {
    const body = ruleBody({ tier: 'full', domain: true });
    const orientation = body.indexOf('### Orientation in Unfamiliar Areas');
    const never = body.indexOf('### NEVER Do These');
    const at = body.indexOf(FULL_DOMAIN_LINE);
    expect(orientation).toBeLessThan(at);
    expect(at).toBeLessThan(never);
  });

  it('classifies a block against the variant: current, or outdated with the domain-line reason', () => {
    for (const tier of TIERS) {
      const plain = scanRulesBlocks(renderRulesBlock(tier)).blocks[0]!;
      const withLine = scanRulesBlocks(renderRulesBlock(tier, { domain: true })).blocks[0]!;
      expect(classifyRulesBlock(plain)).toEqual({ state: 'current', tier });
      expect(classifyRulesBlock(withLine, { domain: true })).toEqual({ state: 'current', tier });
      expect(classifyRulesBlock(plain, { domain: true })).toEqual({ state: 'outdated', reason: 'domain-line', tier });
      expect(classifyRulesBlock(withLine)).toEqual({ state: 'outdated', reason: 'domain-line', tier });
    }
  });
});

describe('drift and repair of the domain line (#191)', () => {
  let tmp: string;
  let gitEnv: IsolatedGitEnv;
  const ctx = (): CheckContext => ({ projectRoot: tmp, ctxoRoot: join(tmp, '.ctxo'), indices: [] }) as CheckContext;
  const claudeMd = (): string => readFileSync(join(tmp, 'CLAUDE.md'), 'utf-8');
  const report = (): DoctorReport => ({
    checks: [{ id: 'ai_rules', title: 'AI rules', status: 'warn', message: '' }],
    summary: { pass: 0, warn: 1, fail: 0 },
    exitCode: 1,
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ctxo-domain-line-'));
    gitEnv = isolateGitEnv();
    domain.installed = false;
  });

  afterEach(() => {
    domain.installed = false;
    gitEnv.restore();
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('ai_rules reports the missing or stray line, and doctor --fix adds or removes it', async () => {
    const original = `${renderRulesBlock('full')}\n`;
    writeFileSync(join(tmp, 'CLAUDE.md'), original, 'utf-8');

    expect((await new AiRulesCheck().run(ctx())).status).toBe('pass');
    const missing = await new AiRulesCheck({ domain: true }).run(ctx());
    expect(missing.status).toBe('warn');
    expect(missing.message).toBe('CLAUDE.md: rules block lacks the "ctxo domain discover" line (@ctxo/domain is installed)');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await applyFixes(report(), { projectRoot: tmp, ctxoRoot: join(tmp, '.ctxo'), yes: true, domain: true });
      expect(claudeMd()).toContain(FULL_DOMAIN_LINE);
      expect((await new AiRulesCheck({ domain: true }).run(ctx())).status).toBe('pass');

      const stray = await new AiRulesCheck().run(ctx());
      expect(stray.status).toBe('warn');
      expect(stray.message).toBe('CLAUDE.md: rules block has the "ctxo domain discover" line (@ctxo/domain is not installed)');
      await applyFixes(report(), { projectRoot: tmp, ctxoRoot: join(tmp, '.ctxo'), yes: true });
    } finally {
      errorSpy.mockRestore();
    }
    expect(claudeMd()).toBe(original);
  });

  it('installRules writes the line only when asked, and a second write is a no-op', () => {
    expect(installRules(tmp, 'claude-code', { tier: 'full' }).action).toBe('created');
    expect(claudeMd()).not.toContain('ctxo domain discover');
    expect(installRules(tmp, 'claude-code', { tier: 'full', domain: true }).action).toBe('updated');
    expect(claudeMd()).toContain(FULL_DOMAIN_LINE);
    expect(installRules(tmp, 'claude-code', { tier: 'full', domain: true }).action).toBe('skipped');
  });

  async function init(): Promise<void> {
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await new InitCommand(tmp).run({ tools: ['claude-code'], yes: true, noInstall: true, only: ['rules'] });
    } finally {
      errorSpy.mockRestore();
    }
  }

  it('ctxo init writes the line with @ctxo/domain installed and not without it', async () => {
    await init();
    expect(claudeMd()).not.toContain('ctxo domain discover');
    const without = claudeMd();

    domain.installed = true;
    await init();
    expect(claudeMd()).toContain(FULL_DOMAIN_LINE);
    expect(claudeMd().replace(`\n${FULL_DOMAIN_LINE}`, '')).toBe(without);
  });

  it('the compact tier gets the line too', () => {
    // The compact tier needs the guard, the skills and an enabled gate on disk; render it directly.
    const block = renderRulesBlock('compact', { domain: true });
    expect(block.split('\n').at(-3)).toBe(COMPACT_DOMAIN_LINE);
  });
});
