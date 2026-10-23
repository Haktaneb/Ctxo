import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { mergeDomainDefaults } from '../config-writer.js';
import { DEFAULT_DOMAIN_CONFIG, resolveDomainConfig } from '../../core/domain-config.js';

const BOM = String.fromCharCode(0xfeff);

/** The block an absent `domain:` section gets (D15), with `<mode>` filled in. */
function block(mode: string): string {
  return [
    'domain:',
    '  registry: docs/domain/contexts.yaml',
    '  coverage:',
    '    unowned: warn            # warn | error',
    '  boundaries:',
    `    enforce: ${mode}          # by-rung | report`,
    '    blockingRungs: [bounded, boring]',
    '  rules:',
    '    idPattern: "^[A-Z][A-Z0-9]*-\\\\d+$"',
    '    trackerPrefixes: []',
    '  tests:',
    '    ruleTraitKeys: [Rule]',
    '  guard:',
    '    enabled: true',
    '    subagents: false',
    '',
  ].join('\n');
}

const CONFIG = `# ctxo project configuration
version: "1.0"

gate:
  enabled: true
  sensitivity: balanced   # strict | balanced | lenient
`;

describe('mergeDomainDefaults', () => {
  it('mergeDomainDefaults appends the commented block when the section is absent', () => {
    const merged = mergeDomainDefaults(CONFIG, 'report');

    expect(merged.changed).toBe(true);
    expect(merged.text).toBe(`${CONFIG}\n${block('report')}`);
    // The block parses to the defaults, with the chosen mode.
    const domain = parse(merged.text).domain;
    expect(resolveDomainConfig(domain)).toEqual({
      config: { ...DEFAULT_DOMAIN_CONFIG, boundaries: { ...DEFAULT_DOMAIN_CONFIG.boundaries, enforce: 'report' } },
      problems: [],
    });
    // A text without a trailing newline and an empty text get the block too.
    expect(mergeDomainDefaults('version: "1.0"', 'by-rung').text).toBe(`version: "1.0"\n\n${block('by-rung')}`);
    expect(mergeDomainDefaults('', 'by-rung').text).toBe(block('by-rung'));
  });

  it('adds missing keys and never changes existing values', () => {
    const text = `${CONFIG}domain:
  registry: docs/contexts.yaml
  boundaries:
    enforce: report
  guard:
    subagents: true
`;

    const merged = mergeDomainDefaults(text, 'by-rung');

    expect(merged.changed).toBe(true);
    const domain = parse(merged.text).domain;
    expect(domain.registry).toBe('docs/contexts.yaml');
    expect(domain.boundaries).toEqual({ enforce: 'report', blockingRungs: ['bounded', 'boring'] });
    expect(domain.guard).toEqual({ subagents: true, enabled: true });
    expect(domain.coverage).toEqual({ unowned: 'warn' });
    expect(domain.rules).toEqual({ idPattern: '^[A-Z][A-Z0-9]*-\\d+$', trackerPrefixes: [] });
    expect(domain.tests).toEqual({ ruleTraitKeys: ['Rule'] });

    // A complete section is left exactly as it is.
    expect(mergeDomainDefaults(merged.text, 'by-rung')).toEqual({ text: merged.text, changed: false });
  });

  it('keeps comments', () => {
    const text = `${CONFIG}# Domain layer
domain:
  # where the registry lives
  registry: docs/contexts.yaml # custom
`;

    const merged = mergeDomainDefaults(text, 'report');

    expect(merged.text).toContain('# ctxo project configuration');
    expect(merged.text).toContain('# Domain layer');
    expect(merged.text).toContain('# where the registry lives');
    expect(merged.text).toContain('registry: docs/contexts.yaml # custom');
    expect(merged.text).toContain('sensitivity: balanced');
    expect(parse(merged.text).domain.boundaries.enforce).toBe('report');
  });

  it('keeps CRLF line endings and a BOM', () => {
    const crlf = BOM + CONFIG.replace(/\n/g, '\r\n');
    const appended = mergeDomainDefaults(crlf, 'report');
    expect(appended.text.startsWith(BOM)).toBe(true);
    expect(appended.text.slice(1).replace(/\r\n/g, '')).not.toContain('\n');
    expect(appended.text).toBe(BOM + `${CONFIG}\n${block('report')}`.replace(/\n/g, '\r\n'));

    const partial = BOM + `${CONFIG}domain:\n  registry: x.yaml\n`.replace(/\n/g, '\r\n');
    const merged = mergeDomainDefaults(partial, 'report');
    expect(merged.changed).toBe(true);
    expect(merged.text.startsWith(BOM)).toBe(true);
    expect(merged.text.slice(1).replace(/\r\n/g, '')).not.toContain('\n');
    expect(parse(merged.text.slice(1)).domain.registry).toBe('x.yaml');
  });

  it('fills an empty domain: key and rejects a section that is not a mapping', () => {
    const merged = mergeDomainDefaults('domain:\n', 'report');
    expect(parse(merged.text).domain.boundaries.enforce).toBe('report');
    expect(() => mergeDomainDefaults('domain: 3\n', 'report')).toThrow(/domain must be a mapping/);
    expect(() => mergeDomainDefaults('a: [\n', 'report')).toThrow();
  });
});
