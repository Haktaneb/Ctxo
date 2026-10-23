import { describe, expect, it } from 'vitest';
import type { SymbolNode } from '@ctxo/plugin-api';
import { annotationRouteEvidence } from '../annotation-endpoints.js';
import { DEFAULT_FACT_OPTIONS } from '../fact-options.js';
import { finishFacts } from '../finish-facts.js';
import { decodeJavaStringLiteral } from '../java-string-literal.js';

const FILE = 'src/main/java/lending/facts/LoanController.java';

function cls(name: string, startLine: number, endLine: number, annotations?: SymbolNode['annotations'], kind: 'class' | 'interface' = 'class'): SymbolNode {
  return { symbolId: `${FILE}::${name}::${kind}`, name, kind, startLine, endLine, ...(annotations ? { annotations } : {}) };
}

function method(name: string, line: number, annotations?: SymbolNode['annotations']): SymbolNode {
  return { symbolId: `${FILE}::${name}::method`, name, kind: 'method', startLine: line, endLine: line + 3, ...(annotations ? { annotations } : {}) };
}

function endpoints(symbols: readonly SymbolNode[], requestMethods?: ReadonlyMap<string, readonly string[]>): string[] {
  return finishFacts(FILE, annotationRouteEvidence(symbols, requestMethods), symbols, DEFAULT_FACT_OPTIONS, decodeJavaStringLiteral)
    .map((f) => `${f.line} ${f.symbolId.slice(FILE.length + 2)} ${f.text}`);
}

describe('annotationRouteEvidence (Spring, JAX-RS)', () => {
  it('Spring mappings combine the class RequestMapping with method mappings', () => {
    const symbols = [
      cls('LoanController', 8, 40, [{ name: 'RestController' }, { name: 'RequestMapping', args: ['/api/loans'] }]),
      method('get', 11, [{ name: 'GetMapping', args: ['/{id}'] }]),
      method('borrow', 16, [{ name: 'PostMapping' }]),
      method('put', 20, [{ name: 'PutMapping', named: { path: 'p' } }]),
      method('del', 24, [{ name: 'DeleteMapping', named: { value: '/d/' } }]),
      method('patch', 28, [{ name: 'PatchMapping', args: ['a', 'b'] }]),
      method('helper', 32, [{ name: 'Transactional' }]),
      method('plain', 36),
    ];
    expect(annotationRouteEvidence(symbols)[0]).toEqual({
      kind: 'route', symbolId: `${FILE}::get::method`, line: 11, verb: 'GET', route: '/api/loans/{id}',
    });
    expect(endpoints(symbols)).toEqual([
      '11 get::method GET /api/loans/{id}',
      '16 borrow::method POST /api/loans',
      '20 put::method PUT /api/loans/p',
      '24 del::method DELETE /api/loans/d',
      '28 patch::method PATCH /api/loans/a',
      '28 patch::method PATCH /api/loans/b',
    ]);
  });

  it('RequestMapping verbs come from named.method and default to ANY', () => {
    const symbols = [
      cls('HoldController', 0, 40, [{ name: 'RequestMapping', named: { path: 'holds' } }]),
      method('renew', 3, [{ name: 'RequestMapping', args: ['/renew'], named: { method: 'RequestMethod.POST' } }]),
      method('both', 8, [{ name: 'RequestMapping', named: { value: 'x', method: 'RequestMethod.GET,RequestMethod.HEAD' } }]),
      method('any', 12, [{ name: 'RequestMapping', args: ['any'] }]),
      method('bare', 16, [{ name: 'RequestMapping', named: { method: 'PUT' } }]),
    ];
    expect(endpoints(symbols)).toEqual([
      '3 renew::method POST /holds/renew',
      '8 both::method GET /holds/x',
      '8 both::method HEAD /holds/x',
      '12 any::method ANY /holds/any',
      '16 bare::method PUT /holds',
    ]);
  });

  it('RequestMapping verbs the annotations do not carry come from requestMethods (the syntax tier drops enum values)', () => {
    const symbols = [
      cls('HoldController', 0, 40, [{ name: 'RequestMapping', args: ['/holds'] }]),
      method('renew', 3, [{ name: 'RequestMapping', named: { value: '/renew' } }]),
      method('both', 8, [{ name: 'RequestMapping', args: ['x'], named: { method: 'RequestMethod.DELETE' } }]),
    ];
    const verbs = new Map([[`${FILE}::renew::method`, ['POST']], [`${FILE}::both::method`, ['GET']]]);
    expect(endpoints(symbols, verbs)).toEqual(['3 renew::method POST /holds/renew', '8 both::method DELETE /holds/x']);
  });

  it('JAX-RS verbs pair with Path on the class and the method', () => {
    const symbols = [
      cls('HoldResource', 5, 40, [{ name: 'Path', args: ['/holds'] }]),
      method('get', 7, [{ name: 'GET' }, { name: 'Path', args: ['{id}'] }]),
      method('list', 12, [{ name: 'GET' }]),
      method('create', 16, [{ name: 'POST' }, { name: 'Consumes', args: ['application/json'] }]),
      method('all', 20, [{ name: 'PUT' }, { name: 'DELETE' }, { name: 'PATCH' }, { name: 'HEAD' }, { name: 'OPTIONS' }]),
      method('locator', 24, [{ name: 'Path', args: ['sub'] }]),
    ];
    expect(endpoints(symbols)).toEqual([
      '7 get::method GET /holds/{id}',
      '12 list::method GET /holds',
      '16 create::method POST /holds',
      '20 all::method DELETE /holds',
      '20 all::method HEAD /holds',
      '20 all::method OPTIONS /holds',
      '20 all::method PATCH /holds',
      '20 all::method PUT /holds',
    ]);
  });

  it('a JAX-RS Path reads named.value when args is empty', () => {
    const symbols = [
      cls('HoldResource', 0, 30, [{ name: 'Path', named: { value: '/holds' } }]),
      method('get', 3, [{ name: 'GET' }, { name: 'Path', named: { value: '{id}' } }]),
      method('put', 8, [{ name: 'PUT' }, { name: 'Path', args: ['x'], named: { value: 'ignored' } }]),
    ];
    expect(endpoints(symbols)).toEqual(['3 get::method GET /holds/{id}', '8 put::method PUT /holds/x']);
  });

  it('the innermost enclosing class gives the prefix; a method outside a class or a class without a prefix gives the method path', () => {
    const symbols = [
      cls('Outer', 0, 50, [{ name: 'RequestMapping', args: ['outer'] }]),
      cls('Inner', 2, 20, [{ name: 'Path', args: ['inner'] }]),
      method('ping', 4, [{ name: 'GET' }, { name: 'Path', args: ['ping'] }]),
      method('root', 30, [{ name: 'GetMapping', args: ['r'] }]),
      cls('Api', 60, 70, [], 'interface'),
      method('find', 62, [{ name: 'GetMapping', args: ['find'] }]),
      method('loose', 80, [{ name: 'PostMapping', args: ['/loose/'] }]),
    ];
    expect(endpoints(symbols)).toEqual([
      '4 ping::method GET /inner/ping',
      '30 root::method GET /outer/r',
      '62 find::method GET /find',
      '80 loose::method POST /loose',
    ]);
  });

  it('a class RequestMapping with several paths gives one route per prefix', () => {
    const symbols = [
      cls('C', 0, 20, [{ name: 'RequestMapping', args: ['/a', '/b'] }]),
      method('m', 3, [{ name: 'GetMapping', args: ['x'] }]),
    ];
    expect(endpoints(symbols)).toEqual(['3 m::method GET /a/x', '3 m::method GET /b/x']);
  });
});
