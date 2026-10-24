import { describe, expect, it } from 'vitest';
import type { CodeFact, SymbolNode } from '@ctxo/cli/internal';
import { scanTextFacts } from '../text-facts.js';
import { DEFAULT_DOMAIN_CONFIG } from '../domain-config.js';
import type { FactOptions } from '../facts/fact-types.js';

const OPTIONS: FactOptions = {
  trivialLiterals: DEFAULT_DOMAIN_CONFIG.facts.trivialLiterals,
  normalizationMethods: DEFAULT_DOMAIN_CONFIG.facts.normalizationMethods,
};

/** `kind|text` of every fact the line gives in the file. */
function scan(file: string, text: string, options: FactOptions = OPTIONS): string[] {
  return scanTextFacts(file, text, [], options).map((f) => `${f.kind}|${f.text}`);
}

const PY = 'src/Billing/fees.py';
const LEND = 'src/Loans/policy.lend';

describe('scanTextFacts', () => {
  it('a Python file gives its facts', () => {
    expect(scan(PY, 'TIMEOUT_SECONDS = 30')).toEqual(['retry-timeout|TIMEOUT_SECONDS = 30']);
    expect(scan(PY, 'if days > 14:\n    pass')).toEqual(['literal-comparison|days > 14']);
    expect(scan(PY, "    return 'late' if days > 14 else 'ok'")).toEqual(['literal-comparison|days > 14']);
    expect(scan(PY, 'x = "if a > 5"')).toEqual([]);
    expect(scan(PY, '@app.route("/fees", methods=["POST"])\ndef fees():')).toEqual(['endpoint|POST /fees']);
    const lower = scanTextFacts(PY, 'key = s.lower()', [], { ...OPTIONS, normalizationMethods: ['lower'] });
    expect(lower).toEqual([
      { kind: 'normalization', symbolId: `${PY}::fees::variable`, line: 0, text: 's.lower()', detail: { method: 'lower' } },
    ]);
    const facts = scanTextFacts(PY, 'if days > 14:', [], OPTIONS);
    expect(facts[0]!.detail).toEqual({ operator: '>', literal: '14' });
  });

  it('a C-style file of an unknown language gives its facts', () => {
    expect(scan(LEND, 'if days > 14 then charge 2.5')).toEqual(['literal-comparison|days > 14']);
    expect(scan(LEND, 'retries = 3')).toEqual(['retry-timeout|retries = 3']);
    expect(scan(LEND, '// retries = 3\n/* if days > 14 */')).toEqual([]);
  });

  it('generics are not comparisons', () => {
    expect(scan('src/A.kt', 'List<int> xs = new List<int>();')).toEqual([]);
    expect(scan(LEND, 'Map<String, List<Int>> m = make();')).toEqual([]);
  });

  it('trivial literals in single quotes give nothing', () => {
    expect(scan(PY, "if name == '':")).toEqual([]);
    expect(scan(LEND, "if name == '' then fail")).toEqual([]);
    expect(scan('db/fees.sql', "IF @name == '' BEGIN\nIF @code == 'gold' BEGIN")).toEqual(["literal-comparison|code == 'gold'"]);
    expect(scan(PY, "if name == 'gold':")).toEqual(["literal-comparison|name == 'gold'"]);
    expect(scan(PY, 'if name == """""":')).toEqual([]);
  });

  it('a lone quote does not swallow later lines', () => {
    expect(scan('src/lib.rs', "fn f<'a>(x: &str) {\n    if n > 14 {")).toEqual(['literal-comparison|n > 14']);
  });

  it('count + 1 > limit gives nothing', () => {
    expect(scan(LEND, 'if count + 1 > limit then stop')).toEqual([]);
    expect(scan(LEND, 'if limit < count + 1 then stop')).toEqual([]);
    expect(scan(LEND, 'if a > b then stop')).toEqual([]);
    expect(scan(LEND, 'if 1 > 2 then stop')).toEqual([]);
  });

  it('operands are adjacent runs of words, members, calls and literals, stopping at && and ||', () => {
    expect(scan(LEND, 'if (loan.days() > 14 && user.tier == "gold") {')).toEqual([
      'literal-comparison|loan.days() > 14',
      'literal-comparison|user.tier == "gold"',
    ]);
    expect(scan(LEND, 'while (x>=-5) {')).toEqual(['literal-comparison|x>=-5']);
    expect(scan(LEND, 'ok = days > 14 ? 1 : 2')).toEqual(['literal-comparison|days > 14']);
    expect(scan('src/A.kt', 'if (user?.age >= 18 && flag)')).toEqual(['literal-comparison|user?.age >= 18']);
    expect(scan('src/A.kt', 'ok = user?.age >= 18')).toEqual([]);
    expect(scan(LEND, 'if a.b[2] >= 3.5 {')).toEqual(['literal-comparison|a.b[2] >= 3.5']);
    expect(scan(LEND, 'ok = days > 14')).toEqual([]);
    expect(scan(LEND, 'if (count == 0) {')).toEqual([]);
    expect(scan(PY, 'if not x == None:')).toEqual([]);
    expect(scan(PY, 'if x is None or y == "a":')).toEqual(['literal-comparison|y == "a"']);
  });

  it('a case or when line with one literal gives case evidence', () => {
    expect(scanTextFacts(LEND, '  case 30:\n  when "gold" ->\n  case x:\n  case 0:', [], OPTIONS).map((f) => [f.line, f.text, f.detail])).toEqual([
      [0, 'case 30', { operator: 'case', literal: '30' }],
      [1, 'case "gold"', { operator: 'case', literal: '"gold"' }],
    ]);
  });

  it('bindings need a fragment name and a numeric constant up to the end of the value', () => {
    expect(scan(LEND, 'val retryCount: Int = 3; maxRetries = 5, delayMs := 250)')).toEqual([
      'retry-timeout|delayMs = 250',
      'retry-timeout|maxRetries = 5',
    ]);
    expect(scan(LEND, 'f(timeout=30 * 1000)')).toEqual(['retry-timeout|timeout = 30000']);
    expect(scan(LEND, 'config = { ttl: 60 }')).toEqual(['retry-timeout|ttl = 60']);
    expect(scan(LEND, 'timeout = base * 2')).toEqual([]);
    expect(scan(LEND, 'settlementDays = 3')).toEqual([]);
    expect(scan(LEND, 'if retries == 3 then x')).toEqual(['literal-comparison|retries == 3']);
  });

  it('durations from TimeSpan, Duration, time and setTimeout', () => {
    expect(scan(LEND, 'var t = TimeSpan.FromSeconds(30);')).toEqual(['retry-timeout|t = 30s']);
    expect(scan(LEND, 'return TimeSpan.FromSeconds(30);')).toEqual(['retry-timeout|TimeSpan.FromSeconds = 30s']);
    expect(scan(LEND, 'Timeout = TimeSpan.FromMinutes(2);')).toEqual(['retry-timeout|Timeout = 2min']);
    expect(scan(LEND, 'holdTtl = Duration.ofDays(7)')).toEqual(['retry-timeout|holdTtl = 7d']);
    expect(scan(LEND, 'Duration.ofMillis(1_500)')).toEqual(['retry-timeout|Duration.ofMillis = 1500ms']);
    expect(scan(LEND, 'wait := 5 * time.Second')).toEqual(['retry-timeout|wait = 5s']);
    expect(scan(LEND, 'client.Timeout = time.Minute * 2')).toEqual(['retry-timeout|Timeout = 2min']);
    expect(scan(LEND, 'setTimeout(() => poll(), 5000);')).toEqual(['retry-timeout|setTimeout = 5000ms']);
    expect(scan(LEND, 'TimeSpan.FromSeconds(seconds)')).toEqual([]);
  });

  it('routes from attributes, annotations, decorators and router calls', () => {
    expect(scan(LEND, '[HttpGet("loans/{id}")]')).toEqual(['endpoint|GET /loans/{id}']);
    expect(scan(LEND, '@PostMapping("/loans")')).toEqual(['endpoint|POST /loans']);
    expect(scan(PY, '@router.get("/items")')).toEqual(['endpoint|GET /items']);
    expect(scan(PY, '@app.route("/x")')).toEqual(['endpoint|ANY /x']);
    expect(scan(PY, "@app.route('/x', methods=['GET', 'POST'])")).toEqual(['endpoint|GET /x', 'endpoint|POST /x']);
    expect(scan(LEND, "app.post('/fees', handler)")).toEqual(['endpoint|POST /fees']);
    expect(scan(LEND, "app.all('/any', handler)")).toEqual(['endpoint|ANY /any']);
    expect(scan(LEND, "cache.get('key')")).toEqual([]);
    expect(scan(LEND, 'app.MapDelete("/loans/{id}", Handler);')).toEqual(['endpoint|DELETE /loans/{id}']);
    expect(scan(LEND, 'http.HandleFunc("/health", h)')).toEqual(['endpoint|ANY /health']);
    expect(scan(LEND, 'mux.HandleFunc("GET /loans", h)')).toEqual(['endpoint|GET /loans']);
  });

  it('facts attach to the innermost symbol, others to the module symbol', () => {
    const file = 'src/Loans/policy.lend';
    const cls: SymbolNode = { symbolId: `${file}::Policy::class`, name: 'Policy', kind: 'class', startLine: 1, endLine: 10 };
    const method: SymbolNode = { symbolId: `${file}::Policy.check::method`, name: 'Policy.check', kind: 'method', startLine: 3, endLine: 6 };
    const text = ['retries = 3', 'class Policy {', '  timeout = 30', '  check() {', '    if days > 14 then x', '  }', '}', '', '', '', '', 'delay = 5'].join('\n');
    const facts = scanTextFacts(file, text, [cls, method], OPTIONS);
    expect(facts.map((f: CodeFact) => [f.line, f.symbolId])).toEqual([
      [0, `${file}::policy::variable`],
      [2, cls.symbolId],
      [4, method.symbolId],
      [11, `${file}::policy::variable`],
    ]);
  });

  it('the same text twice gives deep-equal facts', () => {
    const text = 'retries = 3\nif days > 14:\n@app.route("/fees", methods=["POST"])\nTIMEOUT = 30\n';
    expect(scanTextFacts(PY, text, [], OPTIONS)).toEqual(scanTextFacts(PY, text, [], OPTIONS));
    expect(scanTextFacts(PY, text, [], OPTIONS)).toHaveLength(4);
  });

  it('never throws on odd input', () => {
    for (const text of ['', '(((', ')))', 'if', 'if >', 'if > 5', '== 5 ?', 'case', 'timeout =', 'setTimeout(', '@app.route(', '[HttpGet(', '5 * time.']) {
      expect(() => scanTextFacts(LEND, text, [], OPTIONS), text).not.toThrow();
    }
  });
});
