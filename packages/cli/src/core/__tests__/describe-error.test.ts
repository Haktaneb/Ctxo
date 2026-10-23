import { describe, it, expect } from 'vitest';
import { describeError } from '../describe-error.js';

describe('describeError', () => {
  it('describeError gives an Error its message and a string itself', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('plain text')).toBe('plain text');
  });

  it('describeError never throws on a null-prototype object', () => {
    expect(() => describeError(Object.create(null))).not.toThrow();
    expect(describeError(Object.create(null))).not.toBe('');
  });

  it('describeError never throws on hostile values', () => {
    const hostileError = new Error('x');
    Object.defineProperty(hostileError, 'message', {
      get() {
        throw new Error('getter');
      },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const hostileToString = {
      toString() {
        throw new Error('toString');
      },
    };
    for (const value of [hostileError, cyclic, hostileToString, undefined, null, 1n, Symbol('s'), 42]) {
      expect(() => describeError(value)).not.toThrow();
      expect(typeof describeError(value)).toBe('string');
    }
  });

  it('describeError names undefined and null instead of returning undefined', () => {
    expect(describeError(undefined)).toContain('undefined');
    expect(describeError(null)).toContain('null');
  });
});
