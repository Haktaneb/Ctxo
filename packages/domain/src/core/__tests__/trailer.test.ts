import { describe, it, expect } from 'vitest';
import { DOMAIN_UNCHANGED_TRAILER, parseDomainUnchanged } from '../trailer.js';

describe('parseDomainUnchanged', () => {
  it('parses ids and a reason', () => {
    expect(parseDomainUnchanged('lending, billing (refactor only)')).toEqual({
      ids: ['lending', 'billing'],
      reason: 'refactor only',
    });
  });

  it('parses ids without a reason', () => {
    expect(parseDomainUnchanged('lending')).toEqual({ ids: ['lending'] });
  });

  it('keeps nested parentheses in the reason', () => {
    expect(parseDomainUnchanged('lending (refactor (no behaviour change))')).toEqual({
      ids: ['lending'],
      reason: 'refactor (no behaviour change)',
    });
  });

  it('trims ids and drops empty ones', () => {
    expect(parseDomainUnchanged('  lending ,, billing ,  ')).toEqual({ ids: ['lending', 'billing'] });
  });

  it('names the trailer key', () => {
    expect(DOMAIN_UNCHANGED_TRAILER).toBe('Domain-Unchanged');
  });
});
