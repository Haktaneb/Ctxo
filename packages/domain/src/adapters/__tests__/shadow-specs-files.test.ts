import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fingerprint } from '../../core/fingerprint.js';
import { findOrphanShadowSpecs, readShadowSpecs, SHADOW_SPECS_MAX_BYTES } from '../shadow-specs-files.js';

const REGISTRY = 'docs/domain/contexts.yaml';
const ENTRY = '- fingerprint: "retry-timeout | SmtpSender.Send | Timeout = 30s"\n  resolution: { notARule: transport }\n';

let parent: string;
let root: string;

function write(path: string, content: string | Buffer): void {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
}

/** True when the symlink was made (Windows without developer mode cannot). */
function link(target: string, path: string, type: 'file' | 'dir' = 'file'): boolean {
  try {
    mkdirSync(join(root, path, '..'), { recursive: true });
    symlinkSync(target, join(root, path), type === 'dir' ? 'junction' : 'file');
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'ctxo-domain-shadow-specs-'));
  root = join(parent, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(parent, 'secret.yaml'), ENTRY, 'utf-8');
});

afterEach(() => {
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('readShadowSpecs', () => {
  it('readShadowSpecs reads <registry folder>/<context>/shadow-specs.yaml and reports missing files as absent', () => {
    write('docs/domain/lending/shadow-specs.yaml', ENTRY);
    const loaded = readShadowSpecs(root, REGISTRY, ['lending', 'billing']);
    expect(loaded).toEqual([
      {
        context: 'lending',
        path: 'docs/domain/lending/shadow-specs.yaml',
        parsed: {
          entries: [{ fingerprint: fingerprint('retry-timeout', 'SmtpSender.Send', 'Timeout = 30s'), resolution: { notARule: 'transport' }, line: 1 }],
          problems: [],
        },
      },
      { context: 'billing', path: 'docs/domain/billing/shadow-specs.yaml' },
    ]);
  });

  it('keeps registry order and follows another registry folder', () => {
    write('config/domain/zeta/shadow-specs.yaml', '[]\n');
    write('config/domain/alpha/shadow-specs.yaml', ENTRY);
    const loaded = readShadowSpecs(root, 'config/domain/contexts.yaml', ['zeta', 'alpha']);
    expect(loaded.map((l) => [l.context, l.path, l.parsed?.entries.length])).toEqual([
      ['zeta', 'config/domain/zeta/shadow-specs.yaml', 0],
      ['alpha', 'config/domain/alpha/shadow-specs.yaml', 1],
    ]);
  });

  it('a malformed file gives problems, not a throw', () => {
    write('docs/domain/lending/shadow-specs.yaml', '- fingerprint: [\n');
    const [lending] = readShadowSpecs(root, REGISTRY, ['lending']);
    expect(lending!.parsed!.entries).toEqual([]);
    expect(lending!.parsed!.problems).toHaveLength(1);
    expect(lending!.parsed!.problems[0]!.severity).toBe('error');
    expect(lending!.parsed!.problems[0]!.line).toBeGreaterThanOrEqual(1);
  });

  it('an oversized file is skipped with an error at line 1', () => {
    expect(SHADOW_SPECS_MAX_BYTES).toBe(1_048_576);
    write('docs/domain/lending/shadow-specs.yaml', `# ${'x'.repeat(SHADOW_SPECS_MAX_BYTES)}\n`);
    const [lending] = readShadowSpecs(root, REGISTRY, ['lending']);
    expect(lending!.parsed).toEqual({
      entries: [],
      problems: [{ line: 1, severity: 'error', message: 'shadow-specs.yaml is not read: larger than 1048576 bytes' }],
    });
  });

  it('a binary file is skipped with an error at line 1', () => {
    write('docs/domain/lending/shadow-specs.yaml', Buffer.from([0x2d, 0x20, 0x00, 0x01]));
    const [lending] = readShadowSpecs(root, REGISTRY, ['lending']);
    expect(lending!.parsed!.entries).toEqual([]);
    expect(lending!.parsed!.problems).toEqual([
      { line: 1, severity: 'error', message: 'shadow-specs.yaml is not read: binary (a NUL byte in the first 8 KiB)' },
    ]);
  });

  it('a file with bytes that are not UTF-8 is not parsed: one error at the line of the first bad byte (I1)', () => {
    const bytes = Buffer.concat([Buffer.from(ENTRY, 'utf-8'), Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from('\n# more\n'), Buffer.from([0xff])]);
    write('docs/domain/lending/shadow-specs.yaml', bytes);
    const [lending] = readShadowSpecs(root, REGISTRY, ['lending']);
    expect(lending!.parsed).toEqual({
      entries: [],
      problems: [{ line: 3, severity: 'error', message: 'shadow-specs.yaml is not read: not valid UTF-8' }],
    });
  });

  it('a valid UTF-8 file holding a literal U+FFFD parses normally (I1)', () => {
    write('docs/domain/lending/shadow-specs.yaml', `${ENTRY}# copied from a fingerprint: caf\uFFFD\n`);
    const [lending] = readShadowSpecs(root, REGISTRY, ['lending']);
    expect(lending!.parsed!.problems).toEqual([]);
    expect(lending!.parsed!.entries).toHaveLength(1);
  });

  it('a directory where the file should be is an error at line 1', () => {
    mkdirSync(join(root, 'docs/domain/lending/shadow-specs.yaml'), { recursive: true });
    const [lending] = readShadowSpecs(root, REGISTRY, ['lending']);
    expect(lending!.parsed!.problems).toEqual([{ line: 1, severity: 'error', message: 'shadow-specs.yaml is not read: not a regular file' }]);
  });

  it('a file symlinked outside the repository is not read (W18)', (ctx) => {
    if (!link(join(parent, 'secret.yaml'), 'docs/domain/lending/shadow-specs.yaml')) ctx.skip();
    const [lending] = readShadowSpecs(root, REGISTRY, ['lending']);
    expect(lending!.parsed).toEqual({
      entries: [],
      problems: [{ line: 1, severity: 'error', message: 'shadow-specs.yaml is not read: outside the repository' }],
    });
  });

  it('a context folder symlinked outside the repository is not read (W18)', (ctx) => {
    mkdirSync(join(parent, 'elsewhere'), { recursive: true });
    writeFileSync(join(parent, 'elsewhere', 'shadow-specs.yaml'), ENTRY, 'utf-8');
    if (!link(join(parent, 'elsewhere'), 'docs/domain/lending', 'dir')) ctx.skip();
    const [lending] = readShadowSpecs(root, REGISTRY, ['lending']);
    expect(lending!.parsed).toEqual({
      entries: [],
      problems: [{ line: 1, severity: 'error', message: 'shadow-specs.yaml is not read: outside the repository' }],
    });
  });

  it('a context folder symlinked inside the repository is read, as cards are', (ctx) => {
    write('docs/shared/lending/shadow-specs.yaml', ENTRY);
    if (!link(join(root, 'docs/shared/lending'), 'docs/domain/lending', 'dir')) ctx.skip();
    const [lending] = readShadowSpecs(root, REGISTRY, ['lending']);
    expect(lending!.parsed!.problems).toEqual([]);
    expect(lending!.parsed!.entries).toHaveLength(1);
  });

  it('a registry path outside the project reads nothing: the path check refuses it', () => {
    // The file the path names exists, outside the project: without the check its entry would be read.
    mkdirSync(join(parent, 'lending'), { recursive: true });
    writeFileSync(join(parent, 'lending', 'shadow-specs.yaml'), ENTRY, 'utf-8');
    const loaded = readShadowSpecs(root, '../contexts.yaml', ['lending']);
    expect(loaded).toEqual([
      {
        context: 'lending',
        path: '../lending/shadow-specs.yaml',
        parsed: { entries: [], problems: [{ line: 1, severity: 'error', message: 'shadow-specs.yaml is not read: outside the repository' }] },
      },
    ]);
  });
});

describe('findOrphanShadowSpecs', () => {
  it('findOrphanShadowSpecs lists files for unknown contexts', () => {
    write('docs/domain/lending/shadow-specs.yaml', ENTRY);
    write('docs/domain/payments/shadow-specs.yaml', ENTRY);
    write('docs/domain/archive/shadow-specs.yaml', '[]\n');
    write('docs/domain/notes/readme.md', '# notes\n');
    write('docs/domain/shadow-specs.yaml', ENTRY);
    expect(findOrphanShadowSpecs(root, REGISTRY, ['lending', 'billing'])).toEqual([
      'docs/domain/archive/shadow-specs.yaml',
      'docs/domain/payments/shadow-specs.yaml',
    ]);
  });

  it('lists a linked folder that stays inside the repository and skips one that leads outside (M3)', (ctx) => {
    write('docs/domain/lending/shadow-specs.yaml', ENTRY);
    write('docs/old/loans/shadow-specs.yaml', ENTRY);
    mkdirSync(join(parent, 'elsewhere'), { recursive: true });
    writeFileSync(join(parent, 'elsewhere', 'shadow-specs.yaml'), ENTRY, 'utf-8');
    const inside = link(join(root, 'docs/old/loans'), 'docs/domain/loans', 'dir');
    const outside = link(join(parent, 'elsewhere'), 'docs/domain/external', 'dir');
    if (!inside || !outside) ctx.skip();
    expect(findOrphanShadowSpecs(root, REGISTRY, ['lending'])).toEqual(['docs/domain/loans/shadow-specs.yaml']);
    // A linked folder that is a context id is not an orphan.
    expect(findOrphanShadowSpecs(root, REGISTRY, ['lending', 'loans'])).toEqual([]);
  });

  it('gives an empty list when the registry folder is missing', () => {
    expect(findOrphanShadowSpecs(root, REGISTRY, ['lending'])).toEqual([]);
  });

  it('gives an empty list when the registry folder is outside the project: the path check refuses it', () => {
    // The folder exists outside the project and holds an orphan: without the check it would be listed.
    mkdirSync(join(parent, 'x', 'payments'), { recursive: true });
    writeFileSync(join(parent, 'x', 'payments', 'shadow-specs.yaml'), ENTRY, 'utf-8');
    expect(findOrphanShadowSpecs(root, '../x/contexts.yaml', ['lending'])).toEqual([]);
  });
});
