/**
 * Platform configurations and MCP tool usage rule generator.
 *
 * Each platform entry defines where the AI coding assistant reads its
 * project-level instructions; ctxo upserts one marked rules block into that file.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  LEGACY_CURSOR_FRONTMATTER,
  renderRulesBlock,
  textShape,
  upsertRulesBlock,
  type RulesTier,
} from '../core/agent-rules/rules-block.js';

/* ------------------------------------------------------------------ */
/*  Claude Code safe-edit gate hook                                    */
/* ------------------------------------------------------------------ */

const CTXO_HOOK_COMMAND = 'ctxo gate-hook';

export function ensureClaudeHook(projectRoot: string): InstallResult {
  const filePath = join(projectRoot, '.claude', 'settings.json');
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const ctxoEntry = { matcher: 'Edit', hooks: [{ type: 'command', command: CTXO_HOOK_COMMAND }] };

  if (!existsSync(filePath)) {
    writeFileSync(filePath, JSON.stringify({ hooks: { PreToolUse: [ctxoEntry] } }, null, 2) + '\n', 'utf-8');
    return { file: '.claude/settings.json', action: 'created' };
  }

  let existing: Record<string, unknown>;
  try { existing = JSON.parse(readFileSync(filePath, 'utf-8')); }
  catch {
    writeFileSync(filePath, JSON.stringify({ hooks: { PreToolUse: [ctxoEntry] } }, null, 2) + '\n', 'utf-8');
    return { file: '.claude/settings.json', action: 'updated' };
  }

  const hooks = (existing.hooks ?? {}) as Record<string, unknown>;
  const pre = (hooks.PreToolUse ?? []) as Array<{ hooks?: Array<{ command?: string }> }>;
  if (pre.some((e) => e.hooks?.some((h) => h.command === CTXO_HOOK_COMMAND))) {
    return { file: '.claude/settings.json', action: 'skipped' };
  }
  pre.push(ctxoEntry);
  hooks.PreToolUse = pre;
  existing.hooks = hooks;
  writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  return { file: '.claude/settings.json', action: 'updated' };
}

export interface Platform {
  id: string;
  name: string;
  /** The rules file, project-relative with forward slashes; ctxo upserts a marked block into it */
  file: string;
  /** Paths to check for auto-detection (relative to project root) */
  detectPaths: string[];
  /** Show a star next to this platform name */
  starred: boolean;
}

export const PLATFORMS: Platform[] = [
  { id: 'claude-code',    name: 'Claude Code',        file: 'CLAUDE.md',                       detectPaths: ['CLAUDE.md', '.claude'],                    starred: true },
  { id: 'cursor',         name: 'Cursor',             file: '.cursor/rules/ctxo.mdc',          detectPaths: ['.cursor', '.cursorrules'],                  starred: false },
  { id: 'github-copilot', name: 'GitHub Copilot',     file: '.github/copilot-instructions.md', detectPaths: ['.github', '.vscode'],                      starred: false },
  { id: 'windsurf',       name: 'Windsurf',           file: '.windsurfrules',                  detectPaths: ['.windsurfrules', '.windsurf'],              starred: false },
  { id: 'antigravity',    name: 'Google Antigravity', file: 'AGENTS.md',                       detectPaths: ['AGENTS.md', 'GEMINI.md', '.gemini'],       starred: false },
  { id: 'augment',        name: 'Augment Code',       file: 'augment-guidelines.md',           detectPaths: ['augment-guidelines.md', '.augment'],        starred: false },
  { id: 'amazonq',        name: 'Amazon Q',           file: '.amazonq/rules/ctxo.md',          detectPaths: ['.amazonq'],                                starred: false },
  { id: 'gemini-cli',     name: 'Gemini CLI',         file: 'GEMINI.md',                       detectPaths: ['.gemini/settings.json', 'GEMINI.md'],      starred: false },
  { id: 'continue',       name: 'Continue',           file: '.continue/rules/ctxo.md',         detectPaths: ['.continue'],                                starred: false },
];

export function detectPlatforms(projectRoot: string): Set<string> {
  const detected = new Set<string>();
  for (const p of PLATFORMS) {
    if (p.detectPaths.some(d => existsSync(join(projectRoot, d)))) {
      detected.add(p.id);
    }
  }
  return detected;
}

/* ------------------------------------------------------------------ */
/*  Rule content                                                       */
/* ------------------------------------------------------------------ */

/** The frontmatter of a new Cursor rules file; LEGACY_CURSOR_FRONTMATTER is the one it replaces. */
const CURSOR_FRONTMATTER = `---
description: ctxo MCP tool usage rules, always applied
globs:
alwaysApply: true
---

`;

/** The content of a new rules file: the marked block (after the frontmatter for Cursor). */
export function generateRules(platformId: string, tier: RulesTier = 'full'): string {
  const block = renderRulesBlock(tier) + '\n';
  return platformId === 'cursor' ? CURSOR_FRONTMATTER + block : block;
}

/**
 * Swaps a leading LEGACY_CURSOR_FRONTMATTER for CURSOR_FRONTMATTER. The swapped lines keep their
 * BOM and line endings; anything else is returned as it is.
 */
function replaceLegacyCursorFrontmatter(content: string): string {
  const lineBreaks = LEGACY_CURSOR_FRONTMATTER.split('\n').length - 1;
  let end = 0;
  for (let i = 0; i < lineBreaks; i++) {
    const next = content.indexOf('\n', end);
    if (next < 0) return content;
    end = next + 1;
  }
  const head = textShape(content.slice(0, end));
  if (head.text !== LEGACY_CURSOR_FRONTMATTER) return content;
  return head.restore(CURSOR_FRONTMATTER) + content.slice(end);
}

/* ------------------------------------------------------------------ */
/*  File operations                                                    */
/* ------------------------------------------------------------------ */

export interface InstallResult {
  /** Project-relative, forward slashes */
  file: string;
  action: 'created' | 'updated' | 'skipped';
  /** Why a file was left unchanged although it needs attention */
  warning?: string;
}

/**
 * Upserts the ctxo rules block into a platform's rules file. A missing file gets
 * `generateRules`; an existing one keeps every byte outside the ctxo block. The action compares
 * the final content with the original: equal is `skipped`. `dryRun` computes the same action and
 * writes nothing, not even a directory.
 */
export function installRules(
  projectRoot: string,
  platformId: string,
  options: { readonly tier?: RulesTier; readonly dryRun?: boolean } = {},
): InstallResult {
  const platform = PLATFORMS.find(p => p.id === platformId);
  if (!platform) throw new Error(`Unknown platform: ${platformId}`);

  const tier = options.tier ?? 'full';
  const filePath = join(projectRoot, platform.file);

  if (!existsSync(filePath)) {
    if (!options.dryRun) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, generateRules(platformId, tier), 'utf-8');
    }
    return { file: platform.file, action: 'created' };
  }

  const existing = readFileSync(filePath, 'utf-8');
  const upsert = upsertRulesBlock(existing, renderRulesBlock(tier));
  if (upsert.kind === 'unterminated') {
    return {
      file: platform.file,
      action: 'skipped',
      warning: `${platform.file}: ctxo rules start marker has no end marker; left unchanged`,
    };
  }
  if (upsert.kind === 'newer') {
    return {
      file: platform.file,
      action: 'skipped',
      warning: `${platform.file}: rules block v${upsert.version} comes from a newer ctxo; left unchanged`,
    };
  }

  const content = platformId === 'cursor' ? replaceLegacyCursorFrontmatter(upsert.content) : upsert.content;
  if (content === existing) return { file: platform.file, action: 'skipped' };
  if (!options.dryRun) writeFileSync(filePath, content, 'utf-8');
  return { file: platform.file, action: 'updated' };
}

/* ------------------------------------------------------------------ */
/*  Skills                                                             */
/* ------------------------------------------------------------------ */

export const SKILLS = ['ctxo-understand', 'ctxo-safe-edit', 'ctxo-review-pr'] as const;

/** Platforms with a markdown skill/rule directory we can drop skills into. */
const SKILL_TARGET_DIR: Partial<Record<string, (root: string, skill: string) => string>> = {
  'claude-code': (root, skill) => join(root, '.claude', 'skills', skill, 'SKILL.md'),
  cursor: (root, skill) => join(root, '.cursor', 'rules', `${skill}.mdc`),
};

function skillsSourceDir(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'skills');
    if (existsSync(join(candidate, 'ctxo-safe-edit', 'SKILL.md'))) return candidate;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate ctxo skills/ directory.');
}

export function installSkills(projectRoot: string, platformId: string): InstallResult[] {
  const target = SKILL_TARGET_DIR[platformId];
  if (!target) return [];
  const src = skillsSourceDir();
  const out: InstallResult[] = [];
  for (const skill of SKILLS) {
    const from = join(src, skill, 'SKILL.md');
    const to = target(projectRoot, skill);
    mkdirSync(dirname(to), { recursive: true });
    const existed = existsSync(to);
    writeFileSync(to, readFileSync(from, 'utf-8'), 'utf-8');
    out.push({ file: to, action: existed ? 'updated' : 'created' });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Project scaffolding (automatic, not prompted)                      */
/* ------------------------------------------------------------------ */

const GITIGNORE_ENTRY = '.ctxo/.cache/';

export function ensureGitignore(projectRoot: string): InstallResult {
  const filePath = join(projectRoot, '.gitignore');

  if (!existsSync(filePath)) {
    writeFileSync(filePath, `# Ctxo local cache (auto-rebuilt, never committed)\n${GITIGNORE_ENTRY}\n`, 'utf-8');
    return { file: '.gitignore', action: 'created' };
  }

  const existing = readFileSync(filePath, 'utf-8');
  if (existing.includes(GITIGNORE_ENTRY)) {
    return { file: '.gitignore', action: 'skipped' };
  }

  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  const updated = existing + `${separator}# Ctxo local cache (auto-rebuilt, never committed)\n${GITIGNORE_ENTRY}\n`;
  writeFileSync(filePath, updated, 'utf-8');
  return { file: '.gitignore', action: 'updated' };
}

const DEFAULT_CONFIG = `# ctxo project configuration
# Docs: https://github.com/alperhankendi/Ctxo
version: "1.0"

# Exclude files and workspaces from indexing.
# Uncomment and edit to activate — both fields accept picomatch globs
# (forward-slash paths relative to repo root).
index:
  # Per-file filter applied after \`git ls-files\`.
  ignore: []
  # - "packages/**/fixtures/**"
  # - "tools/legacy-*/**"

  # Workspace filter — matching workspaces are skipped entirely
  # (no plugin load, no file enumeration).
  ignoreProjects: []
  # - "packages/experimental-*"
  # - "examples/*"

gate:
  enabled: true
  sensitivity: balanced   # strict | balanced | lenient

# Co-change analysis: which files change together (.ctxo/index/co-changes.json).
# Every field is optional. Uncomment the block to edit it; the values shown are the defaults.
# cochange:
#   maxCommits: 2000        # number or "all"
#   # since: 12m            # optional age limit; d, w, m, y
#   maxFilesPerCommit: 30
#   minShared: 2
#   include: []             # extra tracked files no plugin indexes (picomatch globs)
#   exclude: []             # indexed files to leave out (picomatch globs)
`;

export function ensureConfig(projectRoot: string): InstallResult {
  const filePath = join(projectRoot, '.ctxo', 'config.yaml');
  const dir = dirname(filePath);

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (existsSync(filePath)) {
    return { file: '.ctxo/config.yaml', action: 'skipped' };
  }

  writeFileSync(filePath, DEFAULT_CONFIG, 'utf-8');
  return { file: '.ctxo/config.yaml', action: 'created' };
}

/* ------------------------------------------------------------------ */
/*  MCP server registration                                            */
/* ------------------------------------------------------------------ */

const CTXO_MCP_ENTRY = { command: 'npx', args: ['-y', '@ctxo/cli'] };

interface McpConfigTarget {
  file: string;
  /** JSON key that holds server map */
  serverKey: 'mcpServers' | 'servers';
  /** Extra fields per server entry */
  extraFields?: Record<string, string>;
}

/**
 * Returns which MCP config files to create/update based on selected platforms.
 * Multiple platforms may map to the same config file (deduplicated).
 */
export function getMcpConfigTargets(selectedPlatformIds: string[]): McpConfigTarget[] {
  const targets = new Map<string, McpConfigTarget>();

  for (const id of selectedPlatformIds) {
    switch (id) {
      case 'claude-code':
      case 'cursor':
      case 'windsurf':
      case 'augment':
      case 'antigravity':
        // .mcp.json is the universal project-level MCP config
        targets.set('.mcp.json', { file: '.mcp.json', serverKey: 'mcpServers' });
        break;
      case 'github-copilot':
        targets.set('.vscode/mcp.json', { file: '.vscode/mcp.json', serverKey: 'servers', extraFields: { type: 'stdio' } });
        break;
      case 'amazonq':
        targets.set('.amazonq/mcp.json', { file: '.amazonq/mcp.json', serverKey: 'mcpServers' });
        break;
      case 'gemini-cli':
        // Gemini CLI reads MCP servers from .gemini/settings.json (project) or ~/.gemini/settings.json (user).
        targets.set('.gemini/settings.json', { file: '.gemini/settings.json', serverKey: 'mcpServers' });
        break;
      case 'continue':
        // Continue reads each MCP server from a standalone file under .continue/mcpServers/.
        targets.set('.continue/mcpServers/ctxo.json', { file: '.continue/mcpServers/ctxo.json', serverKey: 'mcpServers' });
        break;
    }
  }

  return [...targets.values()];
}

export function ensureMcpConfig(projectRoot: string, target: McpConfigTarget): InstallResult {
  const filePath = join(projectRoot, target.file);
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const entry = target.extraFields
    ? { ...target.extraFields, ...CTXO_MCP_ENTRY }
    : { ...CTXO_MCP_ENTRY };

  if (!existsSync(filePath)) {
    const config = { [target.serverKey]: { ctxo: entry } };
    writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return { file: target.file, action: 'created' };
  }

  // Merge into existing config
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    // Corrupt JSON — overwrite
    const config = { [target.serverKey]: { ctxo: entry } };
    writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return { file: target.file, action: 'updated' };
  }

  const servers = (existing[target.serverKey] ?? {}) as Record<string, unknown>;
  if (servers['ctxo']) {
    return { file: target.file, action: 'skipped' };
  }

  servers['ctxo'] = entry;
  existing[target.serverKey] = servers;
  writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  return { file: target.file, action: 'updated' };
}
