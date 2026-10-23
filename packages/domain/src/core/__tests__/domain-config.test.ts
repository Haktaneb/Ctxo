import { describe, it, expect } from 'vitest';
import { DEFAULT_DOMAIN_CONFIG, resolveDomainConfig } from '../domain-config.js';

describe('resolveDomainConfig', () => {
  it('defaults when the section is absent', () => {
    const { config, problems } = resolveDomainConfig(undefined);

    expect(problems).toEqual([]);
    expect(config).toEqual(DEFAULT_DOMAIN_CONFIG);
    expect(config.registry).toBe('docs/domain/contexts.yaml');
    expect(config.coverage.unowned).toBe('warn');
    expect(config.boundaries).toEqual({ enforce: 'by-rung', blockingRungs: ['bounded', 'boring'] });
    expect(config.rules.idPattern).toBe('^[A-Z][A-Z0-9]*-\\d+$');
    expect(config.tests.ruleTraitKeys).toEqual(['Rule']);
    expect(config.guard).toEqual({ enabled: true, subagents: false });
  });

  it('keeps valid values', () => {
    const { config, problems } = resolveDomainConfig({
      registry: 'domain/ctx.yaml',
      coverage: { unowned: 'error' },
      boundaries: { enforce: 'report', blockingRungs: ['boring'] },
      rules: { idPattern: '^R-\\d+$', trackerPrefixes: ['JIRA'] },
      tests: { ruleTraitKeys: ['Rule', 'Req'] },
      guard: { enabled: false, base: 'origin/main', subagents: true },
    });

    expect(problems).toEqual([]);
    expect(config).toEqual({
      registry: 'domain/ctx.yaml',
      coverage: { unowned: 'error' },
      boundaries: { enforce: 'report', blockingRungs: ['boring'] },
      rules: { idPattern: '^R-\\d+$', trackerPrefixes: ['JIRA'] },
      tests: { ruleTraitKeys: ['Rule', 'Req'] },
      guard: { enabled: false, base: 'origin/main', subagents: true },
    });
  });

  it('falls back per key and reports each invalid value', () => {
    const { config, problems } = resolveDomainConfig({
      registry: 'domain/ctx.yaml',
      coverage: { unowned: 'eror' },
      boundaries: { enforce: 'strict', blockingRungs: ['gold'] },
      rules: { idPattern: '([', trackerPrefixes: ['JIRA'] },
    });

    expect(problems.map((p) => p.path).sort()).toEqual([
      'domain.boundaries.blockingRungs',
      'domain.boundaries.enforce',
      'domain.coverage.unowned',
      'domain.rules.idPattern',
    ]);
    expect(config.registry).toBe('domain/ctx.yaml');
    expect(config.coverage.unowned).toBe('warn');
    expect(config.boundaries).toEqual(DEFAULT_DOMAIN_CONFIG.boundaries);
    expect(config.rules.idPattern).toBe(DEFAULT_DOMAIN_CONFIG.rules.idPattern);
    expect(config.rules.trackerPrefixes).toEqual(['JIRA']);
  });

  it('rejects bad tracker prefixes, trait keys, guard base and non-boolean flags', () => {
    const { config, problems } = resolveDomainConfig({
      rules: { trackerPrefixes: ['lower'] },
      tests: { ruleTraitKeys: [''] },
      guard: { enabled: 'yes', base: '--upload-pack=x', subagents: 1 },
    });

    expect(problems.map((p) => p.path).sort()).toEqual([
      'domain.guard.base',
      'domain.guard.enabled',
      'domain.guard.subagents',
      'domain.rules.trackerPrefixes',
      'domain.tests.ruleTraitKeys',
    ]);
    expect(config).toEqual(DEFAULT_DOMAIN_CONFIG);
  });
});
