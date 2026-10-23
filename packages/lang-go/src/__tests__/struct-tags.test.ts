import { describe, it, expect } from 'vitest';
import { parseStructTag, structTagAnnotations } from '../struct-tags.js';

describe('parseStructTag', () => {
  it('follows reflect.StructTag conventions', () => {
    expect(parseStructTag('json:"loan_id,omitempty" gorm:"column:loan_id"')).toEqual([
      ['json', 'loan_id,omitempty'],
      ['gorm', 'column:loan_id'],
    ]);
    expect(parseStructTag('  json:"a"   db:"b"  ')).toEqual([['json', 'a'], ['db', 'b']]);
    expect(parseStructTag('x:"a\\"b"')).toEqual([['x', 'a"b']]);
    expect(parseStructTag('json:loan_id')).toEqual([]);
    expect(parseStructTag('a:"1" bad b:"2"')).toEqual([['a', '1']]);
    expect(parseStructTag('a:"1" a:"2"')).toEqual([['a', '1']]);
    expect(parseStructTag('a:"unterminated')).toEqual([]);
  });
});

describe('structTagAnnotations', () => {
  it('records each tagged field with named.member and skips untagged ones', () => {
    expect(structTagAnnotations([
      { field: 'LoanID', tag: 'json:"loan_id" gorm:"column:loan_id;primaryKey"' },
      { field: 'Note', tag: '' },
      { field: 'Junk', tag: 'nothing' },
      { field: 'Due', tag: 'json:"due_at"' },
    ])).toEqual([
      { name: 'tag', named: { member: 'LoanID', json: 'loan_id', gorm: 'column:loan_id;primaryKey' } },
      { name: 'tag', named: { member: 'Due', json: 'due_at' } },
    ]);
  });

  it('returns undefined when nothing is tagged', () => {
    expect(structTagAnnotations([{ field: 'A', tag: '' }])).toBeUndefined();
    expect(structTagAnnotations([])).toBeUndefined();
  });

  it('a tag key named member does not replace the field name, and type is dropped', () => {
    expect(structTagAnnotations([{ field: 'Loan', tag: 'member:"x" type:"y" json:"j"' }])).toEqual([
      { name: 'tag', named: { member: 'Loan', json: 'j' } },
    ]);
  });

  it('caps apply', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ field: `F${i}`, tag: 'json:"x"' }));
    expect(structTagAnnotations(many)).toHaveLength(20);

    const keys = Array.from({ length: 12 }, (_, i) => `k${i}:"v"`).join(' ');
    const named = structTagAnnotations([{ field: 'A', tag: keys }])![0]!.named!;
    expect(Object.keys(named)).toHaveLength(11);
    expect(named['member']).toBe('A');
    expect(named['k9']).toBe('v');
    expect(named['k10']).toBeUndefined();

    const long = structTagAnnotations([{ field: 'A', tag: `json:"${'x'.repeat(250)}"` }])![0]!.named!;
    expect(long['json']).toHaveLength(200);
  });
});
