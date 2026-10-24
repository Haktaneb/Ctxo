import type { CodeFact, SymbolNode, GraphEdge, ComplexityMetrics, SymbolKind, ILanguageAdapter } from '@ctxo/plugin-api';
import type { FactOptions } from './facts/fact-types.js';
import { GoAnalyzerAdapter } from './analyzer/analyzer-adapter.js';
import { GoAdapter } from './go-adapter.js';
import { createLogger } from './logger.js';

const log = createLogger('ctxo:lang-go');

/**
 * Picks between the full-tier ctxo-go-analyzer and the syntax-tier
 * tree-sitter adapter at initialize() time. Symbols and edges come from
 * whichever delegate is active; complexity is ALWAYS sourced from
 * tree-sitter because the binary intentionally emits empty complexity.
 */
export class GoCompositeAdapter implements ILanguageAdapter {
  private analyzer: GoAnalyzerAdapter | null = null;
  private treeSitter: GoAdapter;
  private fellBack = false;

  /** True when the analyzer is asked for SQL call sites (`capabilities.sqlCallSites`); full tier only. */
  readonly sqlCallSites: boolean;

  /** Fact detector options, set when the host requests facts (`capabilities.facts`). */
  readonly facts: FactOptions | undefined;

  constructor(options: { readonly sqlCallSites?: boolean; readonly facts?: FactOptions } = {}) {
    this.sqlCallSites = options.sqlCallSites === true;
    this.facts = options.facts;
    // The one syntax-tier construction: it serves facts when there is no analyzer and after a failed batch (Q8).
    this.treeSitter = new GoAdapter(this.facts ? { facts: this.facts } : {});
  }

  async initialize(rootDir: string): Promise<void> {
    try {
      // Stale files (a `ctxo watch` save) get their facts from the same tree-sitter adapter (B-I1).
      const analyzer = new GoAnalyzerAdapter({
        sqlCallSites: this.sqlCallSites,
        ...(this.facts ? { facts: this.facts, syntaxFacts: this.treeSitter } : {}),
      });
      await analyzer.initialize(rootDir);
      if (analyzer.isReady()) {
        this.analyzer = analyzer;
        log.info('Go plugin: ctxo-go-analyzer full-tier active');
        return;
      }
      await analyzer.dispose();
    } catch (err) {
      log.warn(`Go analyzer unavailable: ${(err as Error).message}`);
    }
    log.info('Go plugin: tree-sitter syntax-tier active (install Go 1.22+ for full tier)');
  }

  async dispose(): Promise<void> {
    if (this.analyzer) await this.analyzer.dispose();
  }

  /** The analyzer while its batch run is usable; tree-sitter when there is no analyzer or its run failed. */
  private async delegate(): Promise<ILanguageAdapter> {
    if (!this.analyzer) return this.treeSitter;
    if (await this.analyzer.isUsable()) return this.analyzer;
    if (!this.fellBack) {
      this.fellBack = true;
      log.warn('Go plugin: ctxo-go-analyzer run failed, using the tree-sitter syntax tier for this run');
    }
    return this.treeSitter;
  }

  async extractSymbols(filePath: string, source: string): Promise<SymbolNode[]> {
    return (await this.delegate()).extractSymbols(filePath, source);
  }

  async extractEdges(filePath: string, source: string): Promise<GraphEdge[]> {
    return (await this.delegate()).extractEdges(filePath, source);
  }

  /**
   * Code facts (protocol v2): from the analyzer's evidence in the full tier, from the tree-sitter collector in the
   * syntax tier (no analyzer, or its batch failed); without the `facts` option this is always `[]`. The plugin's
   * adapter boundary: an internal failure (for example a stack overflow on a very deep expression) is
   * warn-and-continue, logged and `[]` (B-M1, the same as the Java plugin).
   */
  async extractFacts(filePath: string, source: string): Promise<CodeFact[]> {
    if (!this.facts) return [];
    try {
      const delegate = await this.delegate();
      return delegate.extractFacts ? await delegate.extractFacts(filePath, source) : [];
    } catch (err) {
      log.warn(`Fact extraction failed for ${filePath}: ${(err as Error).message}`);
      return [];
    }
  }

  extractComplexity(filePath: string, source: string): Promise<ComplexityMetrics[]> {
    // Always tree-sitter — analyzer emits empty complexity by design.
    return this.treeSitter.extractComplexity(filePath, source);
  }

  isSupported(filePath: string): boolean {
    return filePath.toLowerCase().endsWith('.go');
  }

  setSymbolRegistry(registry: Map<string, SymbolKind>): void {
    this.treeSitter.setSymbolRegistry?.(registry);
  }

  /** Exposed for cli optimizations. Null when running in syntax tier. */
  getAnalyzerDelegate(): GoAnalyzerAdapter | null {
    return this.analyzer && !this.analyzer.hasBatchFailed() ? this.analyzer : null;
  }

  getTier(): 'full' | 'syntax' | 'unavailable' {
    if (this.analyzer && !this.analyzer.hasBatchFailed()) return 'full';
    if (this.treeSitter) return 'syntax';
    return 'unavailable';
  }
}
