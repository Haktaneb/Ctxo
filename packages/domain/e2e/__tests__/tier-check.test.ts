import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireSameTier, TIER_MESSAGE } from './sample-workspace.js';

/** E-M5: two indexes of the same input that ran C# on different tiers are a skip, not a failure (W20). */
describe('requireSameTier', () => {
  const saved = process.env['CTXO_REQUIRE_DOTNET'];
  afterEach(() => {
    if (saved === undefined) delete process.env['CTXO_REQUIRE_DOTNET'];
    else process.env['CTXO_REQUIRE_DOTNET'] = saved;
  });

  it('does nothing when both indexes ran on the same tier', () => {
    delete process.env['CTXO_REQUIRE_DOTNET'];
    const skip = vi.fn();
    requireSameTier({ resolvesEdges: true }, { resolvesEdges: true }, skip);
    requireSameTier({ resolvesEdges: false }, { resolvesEdges: false }, skip);
    expect(skip).not.toHaveBeenCalled();
  });

  it('skips with the tier message when the tiers differ', () => {
    delete process.env['CTXO_REQUIRE_DOTNET'];
    const skip = vi.fn();
    requireSameTier({ resolvesEdges: true }, { resolvesEdges: false }, skip);
    expect(skip).toHaveBeenCalledTimes(1);
    expect(skip.mock.calls[0]![0]).toContain(TIER_MESSAGE);
  });

  it('fails with the tier message under CTXO_REQUIRE_DOTNET=1', () => {
    process.env['CTXO_REQUIRE_DOTNET'] = '1';
    const skip = vi.fn();
    expect(() => requireSameTier({ resolvesEdges: false }, { resolvesEdges: true }, skip)).toThrow(TIER_MESSAGE);
    expect(skip).not.toHaveBeenCalled();
  });
});
