import { describe, it, expect } from 'vitest';
import { branchExclude, formatGuardReason, guardFingerprint, parseGuardPayload } from '../guard.js';
import type { TouchedContext } from '../touched.js';

const unresolved = (id: string, files: string[], card: string): TouchedContext => ({
  id,
  files,
  card,
  cardChanged: false,
  status: 'unresolved',
});

describe('parseGuardPayload', () => {
  it('parseGuardPayload reads the event, the session and stop_hook_active', () => {
    expect(parseGuardPayload(JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', stop_hook_active: true, cwd: '/repo' }))).toEqual({
      sessionId: 's1',
      event: 'Stop',
      stopHookActive: true,
      cwd: '/repo',
    });
    expect(parseGuardPayload(JSON.stringify({ session_id: 's2', hook_event_name: 'SessionStart', source: 'startup' }))).toEqual({
      sessionId: 's2',
      event: 'SessionStart',
      stopHookActive: false,
    });
    for (const event of ['SubagentStop', 'TaskCompleted'] as const) {
      expect(parseGuardPayload(JSON.stringify({ session_id: 's3', hook_event_name: event }))?.event).toBe(event);
    }
    // Only a literal true counts.
    expect(parseGuardPayload(JSON.stringify({ session_id: 's4', hook_event_name: 'Stop', stop_hook_active: 'true' }))?.stopHookActive).toBe(false);
  });

  it('parseGuardPayload rejects empty input, malformed JSON, a missing session_id and unknown events', () => {
    expect(parseGuardPayload('')).toBeUndefined();
    expect(parseGuardPayload('   ')).toBeUndefined();
    expect(parseGuardPayload('{not json')).toBeUndefined();
    expect(parseGuardPayload('null')).toBeUndefined();
    expect(parseGuardPayload('[1]')).toBeUndefined();
    expect(parseGuardPayload(JSON.stringify({ hook_event_name: 'Stop' }))).toBeUndefined();
    expect(parseGuardPayload(JSON.stringify({ session_id: '', hook_event_name: 'Stop' }))).toBeUndefined();
    expect(parseGuardPayload(JSON.stringify({ session_id: 7, hook_event_name: 'Stop' }))).toBeUndefined();
    expect(parseGuardPayload(JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse' }))).toBeUndefined();
    expect(parseGuardPayload(JSON.stringify({ session_id: 's' }))).toBeUndefined();
  });
});

describe('branchExclude', () => {
  it('branchExclude uses the upstream on the default branch, none without one, and the merge base elsewhere', () => {
    expect(
      branchExclude({ currentBranch: 'main', upstream: 'origin/main', originHead: 'origin/main', branches: ['main', 'origin/main'] }),
    ).toEqual({ kind: 'upstream', ref: 'origin/main' });
    expect(branchExclude({ currentBranch: 'master', branches: ['master'] })).toEqual({ kind: 'none' });
    expect(branchExclude({ currentBranch: 'main', branches: ['feat', 'main'] })).toEqual({ kind: 'none' });
    expect(
      branchExclude({ currentBranch: 'feat', upstream: 'origin/feat', originHead: 'origin/main', branches: ['feat', 'main'] }),
    ).toEqual({ kind: 'merge-base', ref: 'origin/main' });
    expect(branchExclude({ currentBranch: 'feat', branches: ['feat', 'main'] })).toEqual({ kind: 'merge-base', ref: 'main' });
    expect(branchExclude({ currentBranch: 'feat', branches: ['feat', 'master'] })).toEqual({ kind: 'merge-base', ref: 'master' });
    expect(branchExclude({ currentBranch: 'feat', branches: ['feat'] })).toEqual({ kind: 'none' });
  });

  it('the configured base comes first (PF23)', () => {
    expect(branchExclude({ currentBranch: 'feat', originHead: 'origin/main', branches: ['feat', 'main'], configuredBase: 'release' })).toEqual({
      kind: 'merge-base',
      ref: 'release',
    });
  });

  it('a detached HEAD uses the merge base with the default branch', () => {
    expect(branchExclude({ originHead: 'origin/main', branches: ['main'] })).toEqual({ kind: 'merge-base', ref: 'origin/main' });
    expect(branchExclude({ branches: ['main'] })).toEqual({ kind: 'merge-base', ref: 'main' });
  });
});

describe('formatGuardReason', () => {
  it('formatGuardReason matches the spec text for one context', () => {
    const reason = formatGuardReason([
      unresolved(
        'lending',
        ['src/Lending/Fees.cs', 'src/Lending/LoanPolicy.cs', 'src/Lending/Member.cs', 'src/Lending/Renewal.cs'],
        'docs/domain/lending/domain.md',
      ),
    ]);
    expect(reason).toBe(
      [
        'ctxo domain guard: 1 context has committed changes without a card update.',
        '- lending: 4 files (src/Lending/Fees.cs, src/Lending/LoanPolicy.cs, src/Lending/Member.cs, ...)',
        '  card: docs/domain/lending/domain.md (unchanged)',
        'Update the card if behaviour changed (rules, decisions, contracts), then commit it.',
        'If behaviour did not change, add this trailer to a commit:',
        '  Domain-Unchanged: lending (reason)',
      ].join('\n'),
    );
  });

  it('formatGuardReason pluralises for two contexts and lists both in the trailer line', () => {
    const reason = formatGuardReason([
      unresolved('billing', ['src/Billing/Invoice.cs'], 'docs/domain/billing.md'),
      unresolved('lending', ['src/Lending/A.cs', 'src/Lending/B.cs', 'src/Lending/C.cs'], 'docs/domain/lending.md'),
    ]);
    expect(reason).toBe(
      [
        'ctxo domain guard: 2 contexts have committed changes without a card update.',
        '- billing: 1 file (src/Billing/Invoice.cs)',
        '  card: docs/domain/billing.md (unchanged)',
        '- lending: 3 files (src/Lending/A.cs, src/Lending/B.cs, src/Lending/C.cs)',
        '  card: docs/domain/lending.md (unchanged)',
        'Update the card if behaviour changed (rules, decisions, contracts), then commit it.',
        'If behaviour did not change, add this trailer to a commit:',
        '  Domain-Unchanged: billing, lending (reason)',
      ].join('\n'),
    );
  });
});

describe('guardFingerprint', () => {
  it('guardFingerprint sorts the ids', () => {
    expect(guardFingerprint('abc123', ['lending', 'billing', 'Catalog'])).toBe('abc123|Catalog,billing,lending');
    expect(guardFingerprint('abc123', [])).toBe('abc123|');
  });
});
