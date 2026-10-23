import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROVENANCE_MAX_BYTES, provenanceStamp, readProvenanceTexts } from '../provenance-texts.js';

let parent: string;
let root: string;

function write(path: string, content: string | Buffer): void {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
}

/** True when the symlink was made (Windows without developer mode cannot). */
function link(target: string, path: string): boolean {
  try {
    symlinkSync(target, join(root, path), 'file');
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'ctxo-domain-provenance-'));
  root = join(parent, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(parent, 'secret.md'), '# Secret\n', 'utf-8');
});

afterEach(() => {
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('readProvenanceTexts', () => {
  it('reads repository files up to 256 KB with their H1 as title', () => {
    expect(PROVENANCE_MAX_BYTES).toBe(262_144);
    write('docs/specs/loan-limit.md', '# Loan limit\n\nThe limit rose from three to five loans after the renewal study.\n');
    write('docs/adr/adr-007.md', 'Intro line\n\n#  Raise the limit  ##\n\nBody.\n');
    write('docs/notes.txt', 'No heading here.\n');
    write('docs/limit.md', `# Limit\n${'x'.repeat(PROVENANCE_MAX_BYTES - 8)}`);
    write('docs/big.md', `# Big\n${'x'.repeat(PROVENANCE_MAX_BYTES)}`);
    write('docs/bom.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Bom\n')]));

    const warnings: string[] = [];
    const texts = readProvenanceTexts(root, [
      'docs/specs/loan-limit.md',
      'docs/notes.txt',
      'docs/adr/adr-007.md',
      'docs/limit.md',
      'docs/big.md',
      'docs/bom.md',
      'docs/specs/loan-limit.md',
    ], { warn: (message) => warnings.push(message) });
    expect(texts.map((t) => [t.path, t.title])).toEqual([
      ['docs/adr/adr-007.md', 'Raise the limit'],
      ['docs/bom.md', 'Bom'],
      ['docs/limit.md', 'Limit'],
      ['docs/notes.txt', 'notes.txt'],
      ['docs/specs/loan-limit.md', 'Loan limit'],
    ]);
    expect(texts[4]!.text).toBe('# Loan limit\n\nThe limit rose from three to five loans after the renewal study.\n');
    expect(texts[1]!.text).toBe('# Bom\n');
    expect(warnings).toEqual(['provenance file docs/big.md is not searched: larger than 262144 bytes']);
  });

  it('skips binary files, directories, missing files and paths outside the repository', () => {
    write('docs/bin.md', Buffer.from([0x23, 0x20, 0x41, 0x00, 0x42]));
    mkdirSync(join(root, 'docs', 'dir'), { recursive: true });
    const linked = link(join(parent, 'secret.md'), 'docs/escape.md');

    const warnings: string[] = [];
    const paths = ['docs/bin.md', 'docs/dir', 'docs/missing.md', '../secret.md', join(parent, 'secret.md'), 'docs/escape.md', ''];
    const texts = readProvenanceTexts(root, paths, { warn: (message) => warnings.push(message) });
    expect(texts).toEqual([]);
    // A missing file is not worth a warning; everything else names its path and reason.
    expect(warnings).toEqual([
      'provenance file  is not searched: not a repo-relative path',
      'provenance file ../secret.md is not searched: outside the repository',
      `provenance file ${join(parent, 'secret.md')} is not searched: not a repo-relative path`,
      'provenance file docs/bin.md is not searched: binary (a NUL byte in the first 8 KiB)',
      'provenance file docs/dir is not searched: not a regular file',
      ...(linked ? ['provenance file docs/escape.md is not searched: outside the repository'] : []),
    ]);
    if (linked) expect(provenanceStamp(root, 'docs/escape.md', () => 'stamp')).toBe('none');
  });

  it('does not read a symlink swapped in after the path check, and says so', () => {
    write('docs/a.md', '# A\n');
    const warnings: string[] = [];
    const checked: string[] = [];
    const real = realpathSync(join(root, 'docs', 'a.md'));
    let swapped = false;
    const texts = readProvenanceTexts(root, ['docs/a.md'], {
      warn: (message) => warnings.push(message),
      afterCheck: (path) => {
        checked.push(path);
        unlinkSync(path);
        swapped = link(join(parent, 'secret.md'), 'docs/a.md');
      },
    });
    // The seam runs between the path check and the open, with the real path the check returned.
    expect(checked).toEqual([real]);
    if (!swapped) return;
    expect(texts).toEqual([]);
    expect(warnings).toEqual(['provenance file docs/a.md is not searched: changed while it was read']);
  });

  it('stamps a file inside the repository with the given stamp, and anything else as none', () => {
    write('docs/a.md', '# A\n');
    const seen: string[] = [];
    const stamp = (absolute: string): string => {
      seen.push(absolute);
      return 'stamp';
    };
    expect(provenanceStamp(root, 'docs/a.md', stamp)).toBe('stamp');
    expect(seen).toHaveLength(1);
    expect(provenanceStamp(root, 'docs/missing.md', stamp)).toBe('none');
    expect(provenanceStamp(root, '../secret.md', stamp)).toBe('none');
    expect(seen).toHaveLength(1);
  });
});
