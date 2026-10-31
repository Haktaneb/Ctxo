import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { domainLayerCommitted, installRules } from '../ai-rules.js';
import { applyFixes } from '../doctor-fix.js';
import { InitCommand } from '../init-command.js';
import { isolateGitEnv, type IsolatedGitEnv } from './git-test-env.js';

/**
 * #191: the rules block names `ctxo domain discover` only when `@ctxo/domain` is installed. The module loader
 * is stubbed so `ctxo init` sees the module (or not) without a real package.
 */
const domain = vi.hoisted(() => ({
  installed: false,
  /** Loads that still report no module, as before an install later in the run. */
  loadsBeforeInstalled: 0,
  /** Calls of the stub module's init `apply`. */
  applied: 0,
}));

vi.mock('../../adapters/modules/module-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../adapters/modules/module-loader.js')>();
  return {
    ...actual,
    loadCtxoModules: async () => {
      if (domain.loadsBeforeInstalled > 0) {
        domain.loadsBeforeInstalled -= 1;
        return { modules: [], reports: [] };
      }
      if (!domain.installed) return { modules: [], reports: [] };
      const init = {
        part: 'domain',
        apply: async () => {
          domain.applied += 1;
          return [];
        },
      };
      return { modules: [{ name: '@ctxo/domain', version: '0.0.0', registration: { id: 'domain', init } }], reports: [] };
    },
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
    domain.loadsBeforeInstalled = 0;
    gitEnv.restore();
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('ai_rules reports the missing or stray line, and doctor --fix adds or removes it', async () => {
    const original = `${renderRulesBlock('full')}\n`;
    writeFileSync(join(tmp, 'CLAUDE.md'), original, 'utf-8');

    expect((await new AiRulesCheck().run(ctx())).status).toBe('pass');
    const missing = await new AiRulesCheck({ domain: true }).run(ctx());
    expect(missing.status).toBe('warn');
    expect(missing.message).toBe('CLAUDE.md: rules block lacks the "ctxo domain discover" line (the domain layer is set up)');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await applyFixes(report(), { projectRoot: tmp, ctxoRoot: join(tmp, '.ctxo'), yes: true, domain: true });
      expect(claudeMd()).toContain(FULL_DOMAIN_LINE);
      expect((await new AiRulesCheck({ domain: true }).run(ctx())).status).toBe('pass');

      const stray = await new AiRulesCheck().run(ctx());
      expect(stray.status).toBe('warn');
      expect(stray.message).toBe(
        'CLAUDE.md: rules block has the "ctxo domain discover" line, but the domain layer is not set up (no domain config, no registry, @ctxo/domain not loaded)',
      );
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

  describe('committed state decides, the module only adds (I-R1)', () => {
    const writeRepo = (path: string, text: string): void => {
      mkdirSync(dirname(join(tmp, path)), { recursive: true });
      writeFileSync(join(tmp, path), text, 'utf-8');
    };

    it('two machines with the same committed domain config render the same block, module or not', async () => {
      writeRepo('.ctxo/config.yaml', 'version: "1.0"\ndomain:\n  registry: docs/domain/contexts.yaml\n');
      expect(domainLayerCommitted(tmp)).toBe(true);

      domain.installed = false;
      await init();
      const withoutModule = claudeMd();
      expect(withoutModule).toContain(FULL_DOMAIN_LINE);

      domain.installed = true;
      await init();
      expect(claudeMd()).toBe(withoutModule);

      // Neither machine reports drift.
      expect((await new AiRulesCheck().run(ctx())).status).toBe('pass');
      expect((await new AiRulesCheck({ domain: true }).run(ctx())).status).toBe('pass');
    });

    it('the default registry file alone counts as committed domain state', () => {
      expect(domainLayerCommitted(tmp)).toBe(false);
      writeRepo('docs/domain/contexts.yaml', 'version: 1\ncontexts: []\n');
      expect(domainLayerCommitted(tmp)).toBe(true);
    });

    it('module absent and no domain state give exactly the block without the line', async () => {
      domain.installed = false;
      await init();
      expect(claudeMd()).toBe(`${renderRulesBlock('full')}\n`);
    });

    it('a module that fails to load keeps the line while the committed state says domain', async () => {
      writeRepo('docs/domain/contexts.yaml', 'version: 1\ncontexts: []\n');
      const withLine = `${renderRulesBlock('full', { domain: true })}\n`;
      writeRepo('CLAUDE.md', withLine);
      // The loader reports no module (as on a load failure or a version mismatch).
      domain.installed = false;
      expect((await new AiRulesCheck({ domain: false }).run(ctx())).status).toBe('pass');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await applyFixes(report(), { projectRoot: tmp, ctxoRoot: join(tmp, '.ctxo'), yes: true });
      } finally {
        errorSpy.mockRestore();
      }
      expect(claudeMd()).toBe(withLine);
      await init();
      expect(claudeMd()).toBe(withLine);
    });
  });

  it('init renders the rules again when the domain step makes the package available, with one created row (m5)', async () => {
    domain.installed = true;
    // The rules step's load sees no module; the domain step's load finds it.
    domain.loadsBeforeInstalled = 1;
    domain.applied = 0;
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    const lines: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      await new InitCommand(tmp).run({ tools: ['claude-code'], yes: true, noInstall: true, only: ['rules', 'domain'] });
    } finally {
      errorSpy.mockRestore();
    }
    expect(domain.applied).toBe(1);
    expect(claudeMd()).toContain(FULL_DOMAIN_LINE);
    const rows = lines.filter((line) => line.includes('CLAUDE.md'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/created/i);
  });
});
