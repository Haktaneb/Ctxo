import { describe, it, expect } from 'vitest';
import { createModuleHost } from '@ctxo/cli/internal';
import { createOwnership } from '../ownership.js';
import { parseRegistry } from '../registry.js';

const REGISTRY = `version: 1
contexts:
  - id: lending
    name: Lending
    paths: ["src/Lending/**", "src/Shared/**"]
    rung: pinned
    contracts:
      billing: ["src/Billing/Api/**"]
  - id: billing
    name: Billing
    paths: ["src/Billing/**", "src/Shared/**"]
    rung: named
  - id: reporting
    name: Reporting
    paths: ["src/Reporting/**"]
    rung: fear
unowned:
  allow: ["src/Host/**"]
`;

function ownership() {
  const { registry, problems } = parseRegistry(REGISTRY);
  expect(problems).toEqual([]);
  const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: process.cwd() });
  return createOwnership(registry!, host.services.makeGlobMatcher);
}

describe('createOwnership', () => {
  it('a file matching one context is owned by it', () => {
    const o = ownership();

    expect(o.owners('src/Lending/Loan.cs')).toEqual(['lending']);
    expect(o.ownerOf('src/Lending/Loan.cs')).toBe('lending');
    expect(o.ownerOf('src/Elsewhere/X.cs')).toBeUndefined();
  });

  it('a file matching two contexts has two owners and no single owner', () => {
    const o = ownership();

    expect(o.owners('src/Shared/Util.cs')).toEqual(['lending', 'billing']);
    expect(o.ownerOf('src/Shared/Util.cs')).toBeUndefined();
  });

  it('allows unowned files that match unowned.allow', () => {
    const o = ownership();

    expect(o.isAllowedUnowned('src/Host/Program.cs')).toBe(true);
    expect(o.isAllowedUnowned('src/Other/Program.cs')).toBe(false);
  });

  it('contracts allow edges into listed target files only', () => {
    const o = ownership();

    expect(o.isContract('lending', 'src/Billing/Api/IChargeService.cs')).toBe(true);
    expect(o.isContract('lending', 'src/Billing/Internal/Ledger.cs')).toBe(false);
    expect(o.isContract('billing', 'src/Lending/Loan.cs')).toBe(false);
    expect(o.isContract('lending', 'src/Unowned/X.cs')).toBe(false);
    expect(o.isContract('nope', 'src/Billing/Api/IChargeService.cs')).toBe(false);
  });

  it('matches backslash paths, spaces and non-ASCII characters', () => {
    const o = ownership();

    expect(o.ownerOf('src\\Lending\\Şube Kaydı.cs')).toBe('lending');
    expect(o.ownerOf('src/Lending/Şube Kaydı.cs')).toBe('lending');
  });
});
