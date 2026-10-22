import type { IHealthCheck, CheckContext, CheckResult } from '../../../core/diagnostics/types.js';
import { RULES_TEMPLATE_VERSION, classifyRulesBlock, type BlockStatus } from '../../../core/agent-rules/rules-block.js';
import {
  PLATFORMS,
  SKILL_PLATFORMS,
  gateEnabled,
  guardExpected,
  readClaudeGuardState,
  readRulesStates,
  resolveRulesTier,
  skillStates,
  skillsExpected,
  type PlatformRulesState,
} from '../../../cli/ai-rules.js';

/*
 * Agent-setup checks: the ctxo rules blocks, the bundled skills and the Claude Code safe-edit guard.
 * Each reports drift as a warn and never fails or throws: an internal error (such as the bundled
 * skills not being found) becomes a warn that carries its message.
 */

const RULES_FIX = 'Run "ctxo doctor --fix" or "ctxo init" to re-render the ctxo rules blocks';
const SKILLS_FIX = 'Run "ctxo doctor --fix" or "ctxo init --only skills"';
const GUARD_FIX = 'Run "ctxo doctor --fix" or "ctxo init --only guard"';
const UNREADABLE_SETTINGS_FIX = 'Repair .claude/settings.json by hand; ctxo never overwrites it';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function platformName(platformId: string): string {
  return PLATFORMS.find((p) => p.id === platformId)?.name ?? platformId;
}

/**
 * Reports, per rules file, a block whose template is outdated (D2: a newer one is fine), a Claude
 * Code block that expects the guard while it is missing, a current block in the wrong tier, several
 * blocks in one file, and a start marker without an end marker.
 */
export class AiRulesCheck implements IHealthCheck {
  readonly id = 'ai_rules';
  readonly title = 'AI rules';

  async run(ctx: CheckContext): Promise<CheckResult> {
    try {
      return this.check(ctx.projectRoot);
    } catch (err) {
      return { id: this.id, title: this.title, status: 'warn', message: `ctxo rules blocks could not be checked: ${errorMessage(err)}` };
    }
  }

  private check(projectRoot: string): CheckResult {
    const problems: string[] = [];
    const summary: string[] = [];
    for (const state of readRulesStates(projectRoot)) {
      const first = state.scan.blocks[0];
      const status = first ? classifyRulesBlock(first) : undefined;
      problems.push(...fileProblems(projectRoot, state, status).map((phrase) => `${state.file}: ${phrase}`));
      if (status?.state === 'current') summary.push(`${state.file} v${RULES_TEMPLATE_VERSION} ${status.tier}`);
      if (status?.state === 'newer') summary.push(`${state.file} v${status.version} from a newer ctxo`);
    }

    if (problems.length > 0) {
      return { id: this.id, title: this.title, status: 'warn', message: problems.join('; '), fix: RULES_FIX };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      message: summary.length > 0 ? summary.join('; ') : 'no ctxo rules blocks',
    };
  }
}

/** The problems in one rules file; `status` classifies its first block. */
function fileProblems(projectRoot: string, state: PlatformRulesState, status: BlockStatus | undefined): string[] {
  const problems: string[] = [];

  if (status?.state === 'outdated') {
    const found = status.reason === 'older' ? `v${state.scan.blocks[0]?.version ?? ''}` : status.reason;
    problems.push(`rules template outdated (${found} block, template v${RULES_TEMPLATE_VERSION})`);
  }

  const guardMissing =
    state.platformId === 'claude-code' &&
    readClaudeGuardState(projectRoot) === 'absent' &&
    guardExpected(projectRoot);
  if (guardMissing) problems.push('rules present, guard missing');

  if (status?.state === 'current' && !guardMissing) {
    const expected = resolveRulesTier(projectRoot, state.platformId);
    if (status.tier !== expected) problems.push(`rules tier does not match the guard and skills (expected ${expected})`);
  }

  if (state.scan.blocks.length > 1) problems.push(`${state.scan.blocks.length} ctxo rules blocks`);
  if (state.scan.unterminated) problems.push('start marker without end marker');
  return problems;
}

/**
 * Reports missing and outdated skills for each skill platform that expects them: one ctxo skill is
 * installed, or its rules block is pre-tier or compact. A deliberate opt-out (a versioned full block
 * and no skills) passes.
 */
export class SkillsCheck implements IHealthCheck {
  readonly id = 'skills';
  readonly title = 'Agent skills';

  async run(ctx: CheckContext): Promise<CheckResult> {
    try {
      return this.check(ctx.projectRoot);
    } catch (err) {
      return { id: this.id, title: this.title, status: 'warn', message: `ctxo skills could not be checked: ${errorMessage(err)}` };
    }
  }

  private check(projectRoot: string): CheckResult {
    const problems: string[] = [];
    const summary: string[] = [];
    for (const platformId of SKILL_PLATFORMS) {
      const name = platformName(platformId);
      if (!skillsExpected(projectRoot, platformId)) {
        summary.push(`${name}: not installed`);
        continue;
      }
      const states = skillStates(projectRoot, platformId);
      const missing = states.filter((s) => s.state === 'missing').map((s) => s.skill);
      const outdated = states.filter((s) => s.state === 'outdated').map((s) => s.skill);
      if (missing.length > 0) problems.push(`${name}: missing ${missing.join(', ')}`);
      if (outdated.length > 0) problems.push(`${name}: outdated ${outdated.join(', ')}`);
      if (missing.length === 0 && outdated.length === 0) summary.push(`${name}: current`);
    }

    if (problems.length > 0) {
      return { id: this.id, title: this.title, status: 'warn', message: problems.join('; '), fix: SKILLS_FIX };
    }
    return { id: this.id, title: this.title, status: 'pass', message: summary.join('; ') };
  }
}

/**
 * Reports an unreadable `.claude/settings.json`, and a missing guard when CLAUDE.md's block expects it
 * (pre-tier or compact) and the gate is enabled. A versioned full block or `gate.enabled: false`
 * records an opt-out and passes.
 */
export class ClaudeGuardHookCheck implements IHealthCheck {
  readonly id = 'claude_guard_hook';
  readonly title = 'Claude guard hook';

  async run(ctx: CheckContext): Promise<CheckResult> {
    try {
      return this.check(ctx.projectRoot);
    } catch (err) {
      return { id: this.id, title: this.title, status: 'warn', message: `safe-edit guard could not be checked: ${errorMessage(err)}` };
    }
  }

  private check(projectRoot: string): CheckResult {
    const state = readClaudeGuardState(projectRoot);
    if (state === 'unreadable') {
      return {
        id: this.id,
        title: this.title,
        status: 'warn',
        message: '.claude/settings.json is not valid JSON or not a settings object; the guard cannot be verified',
        fix: UNREADABLE_SETTINGS_FIX,
      };
    }
    if (state === 'absent' && guardExpected(projectRoot)) {
      return {
        id: this.id,
        title: this.title,
        status: 'warn',
        message: 'safe-edit guard hook missing from .claude/settings.json',
        fix: GUARD_FIX,
      };
    }
    const message =
      state === 'absent'
        ? 'not installed'
        : gateEnabled(projectRoot)
          ? 'installed'
          : 'installed, disabled by gate.enabled: false';
    return { id: this.id, title: this.title, status: 'pass', message };
  }
}
