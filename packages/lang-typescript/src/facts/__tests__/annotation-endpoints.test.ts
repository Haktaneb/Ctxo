import { describe, expect, it } from 'vitest';
import type { SymbolNode } from '@ctxo/plugin-api';
import { TsMorphAdapter } from '../../ts-morph-adapter.js';
import { annotationRouteEvidence } from '../annotation-endpoints.js';
import { DEFAULT_FACT_OPTIONS } from '../fact-options.js';
import { finishFacts } from '../finish-facts.js';
import { decodeTypescriptStringLiteral } from '../typescript-string-literal.js';

const FILE = 'src/loans.controller.ts';

async function symbolsOf(source: string): Promise<SymbolNode[]> {
  return new TsMorphAdapter().extractSymbols(FILE, source);
}

async function endpoints(source: string): Promise<{ symbolId: string; text: string; line: number }[]> {
  const symbols = await symbolsOf(source);
  return finishFacts(FILE, annotationRouteEvidence(symbols), symbols, DEFAULT_FACT_OPTIONS, decodeTypescriptStringLiteral)
    .map((f) => ({ symbolId: f.symbolId, text: f.text, line: f.line }));
}

describe('annotationRouteEvidence (Nest)', () => {
  it('Nest routes combine the Controller prefix with method decorators', async () => {
    const source = [
      "import { All, Controller, Get, Post } from '@nestjs/common';",
      "@Controller('loans')",
      'export class LoansController {',
      "  @Get(':id')",
      '  find() {}',
      '  @Post()',
      '  borrow() {}',
      "  @All('x')",
      '  any() {}',
      '  helper() {}',
      '}',
    ].join('\n');
    const m = (name: string): string => `${FILE}::LoansController.${name}::method`;
    expect(await endpoints(source)).toEqual([
      { symbolId: m('find'), text: 'GET /loans/:id', line: 3 },
      { symbolId: m('borrow'), text: 'POST /loans', line: 5 },
      { symbolId: m('any'), text: 'ANY /loans/x', line: 7 },
    ]);
  });

  it('every verb decorator maps to its verb, and named.path is the prefix', async () => {
    const source = [
      "@Controller({ path: '/api/' })",
      'export class A {',
      "  @Put('p') put() {}",
      "  @Delete('d') del() {}",
      "  @Patch('/q/') patch() {}",
      '  @Head() head() {}',
      '  @Options() options() {}',
      "  @Get() @Post('both') two() {}",
      '}',
    ].join('\n');
    expect((await endpoints(source)).map((f) => f.text)).toEqual([
      'PUT /api/p',
      'DELETE /api/d',
      'PATCH /api/q',
      'HEAD /api',
      'OPTIONS /api',
      'GET /api',
      'POST /api/both',
    ]);
  });

  it('a Controller without a prefix gives the method path alone', async () => {
    const source = ['@Controller()', 'export class B {', "  @Get('health') health() {}", '}'].join('\n');
    expect((await endpoints(source)).map((f) => f.text)).toEqual(['GET /health']);
  });

  it('method decorators outside a Controller class give nothing', async () => {
    const source = [
      "@Injectable('loans')",
      'export class LoansService {',
      "  @Get(':id')",
      '  find() {}',
      '}',
      'export class Plain {',
      "  @Post('x') make() {}",
      '}',
    ].join('\n');
    expect(annotationRouteEvidence(await symbolsOf(source))).toEqual([]);
  });

  it('a property decorator named Controller does not make a controller', async () => {
    const source = ['export class C {', "  @Controller('x') field = 1;", "  @Get('y') get() {}", '}'].join('\n');
    expect(annotationRouteEvidence(await symbolsOf(source))).toEqual([]);
  });
});
