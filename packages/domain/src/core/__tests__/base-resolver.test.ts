import { describe, it, expect } from 'vitest';
import { resolveBaseRef } from '../base-resolver.js';
import { DEFAULT_DOMAIN_CONFIG, type DomainConfig } from '../domain-config.js';

const withBase = (base: string): DomainConfig => ({ ...DEFAULT_DOMAIN_CONFIG, guard: { ...DEFAULT_DOMAIN_CONFIG.guard, base } });

describe('resolveBaseRef', () => {
  it('prefers the configured base', () => {
    expect(resolveBaseRef(withBase('release'), { branches: ['main'], originHead: 'origin/main' })).toBe('release');
  });

  it('uses origin/HEAD, then main, then master', () => {
    expect(resolveBaseRef(DEFAULT_DOMAIN_CONFIG, { branches: ['feat', 'main'], currentBranch: 'feat', originHead: 'origin/trunk' })).toBe('origin/trunk');
    expect(resolveBaseRef(DEFAULT_DOMAIN_CONFIG, { branches: ['feat', 'main', 'master'], currentBranch: 'feat' })).toBe('main');
    expect(resolveBaseRef(DEFAULT_DOMAIN_CONFIG, { branches: ['feat', 'master'], currentBranch: 'feat' })).toBe('master');
    expect(resolveBaseRef(DEFAULT_DOMAIN_CONFIG, { branches: ['feat'], currentBranch: 'feat' })).toBeUndefined();
    expect(resolveBaseRef(DEFAULT_DOMAIN_CONFIG, undefined)).toBeUndefined();
  });

  it('on the default branch the upstream is the base (@{u}..HEAD)', () => {
    expect(
      resolveBaseRef(DEFAULT_DOMAIN_CONFIG, { branches: ['main'], currentBranch: 'main', upstream: 'origin/main', originHead: 'origin/main' }),
    ).toBe('origin/main');
    expect(resolveBaseRef(DEFAULT_DOMAIN_CONFIG, { branches: ['master'], currentBranch: 'master', upstream: 'origin/master' })).toBe('origin/master');
  });

  it('a feature branch with an upstream still uses the default branch', () => {
    expect(
      resolveBaseRef(DEFAULT_DOMAIN_CONFIG, { branches: ['feat', 'main'], currentBranch: 'feat', upstream: 'origin/feat', originHead: 'origin/main' }),
    ).toBe('origin/main');
  });
});
