import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IHealthCheck, CheckResult, CheckContext } from '../../../core/diagnostics/types.js';
import { POST_COMMIT_HOOK_VERSION, readCtxoBlockVersion, resolveHooksDir } from '../../../cli/init-command.js';

export class GitBinaryCheck implements IHealthCheck {
  readonly id = 'git_binary';
  readonly title = 'Git available';

  async run(_ctx: CheckContext): Promise<CheckResult> {
    try {
      const version = execFileSync('git', ['--version'], { encoding: 'utf-8' }).trim();
      return { id: this.id, title: this.title, status: 'pass', message: version, value: version };
    } catch {
      return { id: this.id, title: this.title, status: 'fail', message: 'git not found in PATH', fix: 'Install git and ensure it is in your PATH' };
    }
  }
}

export class GitRepoCheck implements IHealthCheck {
  readonly id = 'git_repo';
  readonly title = 'Git repository';

  async run(ctx: CheckContext): Promise<CheckResult> {
    if (existsSync(join(ctx.projectRoot, '.git'))) {
      return { id: this.id, title: this.title, status: 'pass', message: ctx.projectRoot, value: ctx.projectRoot };
    }
    return { id: this.id, title: this.title, status: 'fail', message: 'Not a git repository', fix: 'Run "git init" or clone a repository' };
  }
}

/**
 * Reports whether the post-commit hook carries the current ctxo block. A missing or older block
 * (the unversioned v1 block re-indexed once per changed file) is a warn; `ctxo doctor --fix` and
 * `ctxo init` upgrade it in place.
 */
export class GitHooksCheck implements IHealthCheck {
  readonly id = 'git_hooks';
  readonly title = 'Git hooks';

  async run(ctx: CheckContext): Promise<CheckResult> {
    // Without a repository there is nothing to install into; git_repo already reports that as a fail.
    if (!existsSync(join(ctx.projectRoot, '.git'))) {
      return { id: this.id, title: this.title, status: 'pass', message: 'Not a git repository (hooks not applicable)' };
    }

    const hookPath = join(resolveHooksDir(ctx.projectRoot), 'post-commit');
    let version: number | undefined;
    try {
      version = readCtxoBlockVersion(readFileSync(hookPath, 'utf-8'));
    } catch {
      version = undefined; // no hook file (or unreadable): same as no ctxo block
    }

    if (version === undefined) {
      return {
        id: this.id,
        title: this.title,
        status: 'warn',
        message: `No ctxo post-commit hook (${hookPath})`,
        fix: 'Run "ctxo init" or "ctxo doctor --fix" to install the post-commit hook',
      };
    }
    if (version < POST_COMMIT_HOOK_VERSION) {
      return {
        id: this.id,
        title: this.title,
        status: 'warn',
        message: `Outdated ctxo post-commit hook (v${version}, current v${POST_COMMIT_HOOK_VERSION})`,
        fix: 'Run "ctxo doctor --fix" or "ctxo init" to upgrade the post-commit hook',
        value: `v${version}`,
      };
    }
    return {
      id: this.id,
      title: this.title,
      status: 'pass',
      message: `ctxo post-commit hook v${version}`,
      value: `v${version}`,
    };
  }
}
