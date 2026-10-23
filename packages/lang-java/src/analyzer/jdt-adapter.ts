import type { ComplexityMetrics, GraphEdge, ILanguageAdapter, SymbolNode } from '@ctxo/plugin-api';
import { createLogger } from '../logger.js';
import { resolveAnalyzerJar, analyzerPackageVersion, baseVersionMismatch, PLUGIN_VERSION } from './jar-resolve.js';
import { toGraphEdges, toSymbolNode } from './jdt-mapping.js';
import { runBatchIndex, JdtKeepAlive, type JdtFileResult, type JdtSqlStats } from './jdt-process.js';
import { detectJavaRuntime } from './toolchain-detect.js';

const log = createLogger('ctxo:lang-java');
const FULL_SYMBOL_ID = /^.+::.+::.+$/;

export class JdtAnalyzerAdapter implements ILanguageAdapter {
  readonly extensions = ['.java'] as const;
  readonly tier = 'full' as const;

  private root: string | null = null;
  private javaBin = 'java';
  private jarPath: string | null = null;
  private cache = new Map<string, JdtFileResult>();
  private batchPromise: Promise<void> | null = null;
  private initialized = false;
  private keepAlive: JdtKeepAlive | null = null;
  private readonly sqlCallSites: boolean;
  private sqlStats: JdtSqlStats | undefined;

  /** `sqlCallSites`: ask the analyzer for SQL call sites and turn them into data edges (the host's `capabilities.sqlCallSites`). */
  constructor(options: { readonly sqlCallSites?: boolean } = {}) {
    this.sqlCallSites = options.sqlCallSites === true;
  }

  /**
   * How many SQL texts the analyzer read as constants and how many it could not, summed over the batch
   * runs of this adapter instance (cumulative: a full index run creates fresh adapters, and `ctxo watch`
   * never reports it). Undefined without `sqlCallSites` or before any batch has reported.
   */
  getSqlStats(): JdtSqlStats | undefined {
    return this.sqlStats ? { ...this.sqlStats } : undefined;
  }

  isSupported(filePath: string): boolean {
    return filePath.toLowerCase().endsWith('.java');
  }

  isReady(): boolean {
    return this.initialized && this.jarPath !== null && this.root !== null;
  }

  async initialize(rootDir: string): Promise<void> {
    const java = detectJavaRuntime();
    if (!java.available) {
      log.info(`Java full tier unavailable: JRE ${java.version ?? 'not found'} (>= 11 required)`);
      return;
    }
    const jar = resolveAnalyzerJar(java.jarVariant);
    if (!jar) {
      log.info('Java full tier unavailable: @ctxo/lang-java-analyzer not installed (run: ctxo install java --full-tier)');
      return;
    }
    const analyzerVer = analyzerPackageVersion();
    if (analyzerVer && baseVersionMismatch(analyzerVer, PLUGIN_VERSION)) {
      log.warn(`Analyzer package version ${analyzerVer} != plugin ${PLUGIN_VERSION}; using it anyway. Re-run "ctxo install java --full-tier" to align.`);
    }
    this.root = rootDir;
    this.javaBin = java.javaBin;
    this.jarPath = jar;
    this.initialized = true;
    log.info(`Java analyzer ready: JRE ${java.version}, jar ${jar}`);
  }

  async extractSymbols(filePath: string, _source: string): Promise<SymbolNode[]> {
    if (!this.isReady()) return [];
    await this.ensureBatch();
    const file = this.cache.get(this.norm(filePath));
    if (!file) return [];
    return file.symbols.filter((s) => FULL_SYMBOL_ID.test(s.symbolId)).map(toSymbolNode);
  }

  async extractEdges(filePath: string, _source: string): Promise<GraphEdge[]> {
    if (!this.isReady()) return [];
    await this.ensureBatch();
    const file = this.cache.get(this.norm(filePath));
    if (!file) return [];
    return toGraphEdges(file, { sqlCallSites: this.sqlCallSites });
  }

  async extractComplexity(_filePath: string, _source: string): Promise<ComplexityMetrics[]> {
    return [];
  }

  async startKeepAlive(): Promise<boolean> {
    if (!this.isReady() || !this.jarPath || !this.root) return false;
    this.keepAlive = new JdtKeepAlive(this.javaBin, this.jarPath, this.root, { sqlCallSites: this.sqlCallSites });
    const ok = await this.keepAlive.start();
    if (!ok) this.keepAlive = null;
    return ok;
  }

  async reindexFileRaw(relativePath: string): Promise<JdtFileResult | null> {
    if (!this.keepAlive?.isAlive()) return null;
    return this.keepAlive.analyzeFile(relativePath);
  }

  async dispose(): Promise<void> {
    if (this.keepAlive) { await this.keepAlive.shutdown(); this.keepAlive = null; }
    this.cache.clear();
    this.batchPromise = null;
    this.initialized = false;
  }

  private norm(filePath: string): string {
    return filePath.replace(/\\/g, '/');
  }

  private ensureBatch(): Promise<void> {
    if (this.batchPromise) return this.batchPromise;
    this.batchPromise = this.runBatch();
    return this.batchPromise;
  }

  private async runBatch(): Promise<void> {
    if (!this.jarPath || !this.root) return;
    const result = await runBatchIndex(this.javaBin, this.jarPath, this.root, { sqlCallSites: this.sqlCallSites });
    if (result.sql) {
      this.sqlStats = {
        constant: (this.sqlStats?.constant ?? 0) + result.sql.constant,
        nonConstant: (this.sqlStats?.nonConstant ?? 0) + result.sql.nonConstant,
      };
      log.debug(`Java analyzer SQL arguments: ${result.sql.constant} constant, ${result.sql.nonConstant} non-constant`);
    } else if (this.sqlCallSites) {
      log.warn('Java analyzer reported no SQL statistics although --sql-call-sites was requested (analyzer too old?)');
    }
    this.cache.clear();
    for (const file of result.files) this.cache.set(this.norm(file.file), file);
    log.info(`Java analyzer batch: ${result.files.length} files in ${result.elapsed}`);
  }
}
