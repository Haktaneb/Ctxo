import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { getCliPackageRoot, getVersion, locateGitRoot } from '../cli-paths.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('cli-paths', () => {
  it('getCliPackageRoot is the directory of the CLI package.json, and getVersion reads its version', () => {
    const pkg = JSON.parse(readFileSync(join(getCliPackageRoot(), 'package.json'), 'utf-8')) as {
      name: string;
      version: string;
    };

    expect(pkg.name).toBe('@ctxo/cli');
    expect(getVersion()).toBe(pkg.version);
  });

  it('locateGitRoot returns the nearest directory that holds .git', () => {
    const root = mkdtempSync(join(tmpdir(), 'ctxo-cli-paths-'));
    tempDirs.push(root);
    mkdirSync(join(root, '.git'));
    const nested = join(root, 'packages', 'app', 'src');
    mkdirSync(nested, { recursive: true });

    expect(locateGitRoot(nested)).toBe(root);
    expect(locateGitRoot(root)).toBe(root);
  });

  it('locateGitRoot returns null when no directory up to the filesystem root holds .git', () => {
    expect(locateGitRoot(join(parse(tmpdir()).root, 'ctxo-cli-paths-no-such-dir'))).toBeNull();
  });
});
