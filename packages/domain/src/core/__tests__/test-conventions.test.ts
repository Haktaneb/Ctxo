import { describe, it, expect } from 'vitest';
import { parseAnnotationMatcher } from '../test-conventions.js';

describe('parseAnnotationMatcher', () => {
  it('parseAnnotationMatcher reads the three forms', () => {
    expect(parseAnnotationMatcher('Tag')).toEqual({ name: 'Tag' });
    expect(parseAnnotationMatcher('Tag:characterization')).toEqual({ name: 'Tag', value: 'characterization' });
    expect(parseAnnotationMatcher('Trait:Kind=Characterization')).toEqual({ name: 'Trait', key: 'Kind', value: 'Characterization' });
  });

  it('rejects malformed matchers', () => {
    for (const spec of ['', ':x', 'Trait:', 'Trait:=x', 'Trait:a=b=c']) {
      expect(parseAnnotationMatcher(spec), spec).toBeUndefined();
    }
  });
});
