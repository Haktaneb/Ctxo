import { describe, it, expect } from 'vitest';
import { TsMorphAdapter } from '../ts-morph-adapter.js';

async function symbols(source: string) {
  return new TsMorphAdapter().extractSymbols('src/x.ts', source);
}

describe('decorators as annotations', () => {
  it('class and method decorators become annotations with their string arguments', async () => {
    const out = await symbols(`
@Controller('loans')
export class C {
  @Get(':id') @HttpCode(200)
  find(@Param('id') id: string) {}
}`);
    expect(out.find((s) => s.name === 'C')?.annotations).toEqual([{ name: 'Controller', args: ['loans'] }]);
    expect(out.find((s) => s.name === 'C.find')?.annotations).toEqual([
      { name: 'Get', args: [':id'] },
      { name: 'HttpCode' },
    ]);
  });

  it('property decorators attach to the class with named.member', async () => {
    const out = await symbols(`
@Entity('loans')
export class Loan {
  @Id() id!: number;
  @Column({ name: 'member_id', type: 'int' }) memberId!: number;
  note = '';
}`);
    expect(out.find((s) => s.name === 'Loan')?.annotations).toEqual([
      { name: 'Entity', args: ['loans'] },
      { name: 'Id', named: { member: 'id' } },
      { name: 'Column', named: { member: 'memberId', name: 'member_id' } },
    ]);
    expect(out.map((s) => s.name)).toEqual(['Loan']);
  });

  it('a qualified decorator keeps its rightmost name and a bare one has no args', async () => {
    const out = await symbols(`@nest.Injectable() @Sealed export class S {}`);
    expect(out[0].annotations).toEqual([{ name: 'Injectable' }, { name: 'Sealed' }]);
  });

  it('object keys may be identifiers or strings, the first wins and member is reserved', async () => {
    const out = await symbols(`export class K { @Opt({ a: 'x' }, { a: 'y', 'b-c': 'z', member: 'm' }) p = 1; }`);
    expect(out[0].annotations).toEqual([{ name: 'Opt', named: { member: 'p', a: 'x', 'b-c': 'z' } }]);
  });

  it('caps limit annotations, arguments, named entries and value length', async () => {
    const many = Array.from({ length: 25 }, (_, i) => `@D${i}`).join(' ');
    const a = await symbols(`${many} export class A {}`);
    expect(a[0].annotations).toHaveLength(20);
    expect(a[0].annotations![19].name).toBe('D19');

    const args = Array.from({ length: 12 }, (_, i) => `'a${i}'`).join(', ');
    const b = await symbols(`@F(${args}) export class B {}`);
    expect(b[0].annotations![0].args).toEqual(Array.from({ length: 10 }, (_, i) => `a${i}`));

    const props = Array.from({ length: 12 }, (_, i) => `k${i}: 'v'`).join(', ');
    const c = await symbols(`export class C { @G({ ${props} }) p = 1; }`);
    const named = c[0].annotations![0].named!;
    expect(Object.keys(named)).toHaveLength(11);
    expect(named.member).toBe('p');
    expect(named.k9).toBe('v');
    expect(named.k10).toBeUndefined();

    const d = await symbols(`@L('${'x'.repeat(250)}') export class D {}`);
    expect(d[0].annotations![0].args![0]).toHaveLength(200);
  });

  it('accessor and parameter decorators and non-exported classes produce nothing', async () => {
    const out = await symbols(`
@Hidden() class Hidden {}
export class P {
  constructor(@Inject('x') private x: string) {}
  @Acc() get v() { return 1; }
  @Acc() set v(n: number) {}
  m(@Param('id') id: string) {}
}`);
    expect(out.find((s) => s.name === 'P')).toBeDefined();
    expect(out.every((s) => s.annotations === undefined)).toBe(true);
    expect(out.some((s) => s.name === 'Hidden')).toBe(false);
  });

  it('symbols without decorators carry no annotations key', async () => {
    const out = await symbols(`export class Plain { m() {} }`);
    for (const s of out) expect('annotations' in s).toBe(false);
  });
});
