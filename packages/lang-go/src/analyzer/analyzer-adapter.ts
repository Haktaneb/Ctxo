import { relative } from 'node:path';
import type { SymbolNode, GraphEdge, ComplexityMetrics, SymbolKind, ILanguageAdapter } from '@ctxo/plugin-api';
import { createLogger } from '../logger.js';
import { structTagAnnotations } from '../struct-tags.js';
import { detectGoToolchain } from './toolchain-detect.js';
import { discoverGoModule, findCtxoGoAnalyzerSource } from './module-discovery.js';
import { ensureAnalyzerBinary } from './binary-build.js';
import { sqlEdgesFromCallSites } from '../sql-edges.js';
import { runBatchAnalyze, type AnalyzerFileResult, type AnalyzerBatchResult } from './analyzer-process.js';

const log = createLogger('ctxo:lang-go');
const VALID_SYMBOL_ID = /^.+::.+::.+$/;

/**
 * Full-tier Go adapter. Owns the analyzer binary lifecycle and an
 * in-memory cache of batch results keyed by project-relative file path.
 *
 * Caching strategy: the first extractSymbols/extractEdges call after
 * initialize() triggers a single batch analysis run. Subsequent calls
 * read from cache. This keeps the ILanguageAdapter contract intact
 * (per-file methods) while the binary runs once per index.
 */
export class GoAnalyzerAdapter implements ILanguageAdapter {
  readonly extensions = ['.go'] as const;
  readonly tier = 'full' as const;

  private moduleRoot: string | null = null;
  private binaryPath: string | null = null;
  private modulePathPrefix = '';
  private cache = new Map<string, AnalyzerFileResult>();
  private deadSymbolIds = new Set<string>();
  private hasMain = false;
  private timedOut = false;
  private batchFailed = false;
  private batchPromise: Promise<void> | null = null;
  private initialized = false;
  private readonly sqlCallSites: boolean;
  private sqlStats: { constant: number; nonConstant: number } | undefined;

  constructor(options: { readonly sqlCallSites?: boolean } = {}) {
    this.sqlCallSites = options.sqlCallSites === true;
  }

  /**
   * SQL argument counts reported by the analyzer (`constant` ones gave a call-site record, `nonConstant`
   * ones did not). Undefined until a batch ran with `sqlCallSites`. Cumulative per adapter instance: a full
   * index run creates fresh adapters, and `ctxo watch` never reports these stats.
   */
  getSqlStats(): { constant: number; nonConstant: number } | undefined {
    return this.sqlStats ? { ...this.sqlStats } : undefined;
  }

  isSupported(filePath: string): boolean {
    return filePath.endsWith('.go');
  }

  isReady(): boolean {
    return this.initialized && this.binaryPath !== null && this.moduleRoot !== null;
  }

  async initialize(rootDir: string): Promise<void> {
    const toolchain = detectGoToolchain();
    if (!toolchain.available) {
      log.info(`Go analyzer unavailable: go ${toolchain.version ?? 'not found'} (>= 1.22 required)`);
      return;
    }

    const moduleRoot = discoverGoModule(rootDir);
    if (!moduleRoot) {
      log.info('Go analyzer unavailable: no go.mod or go.work found');
      return;
    }
    this.moduleRoot = moduleRoot;
    const prefix = relative(rootDir, moduleRoot).replace(/\\/g, '/');
    this.modulePathPrefix = prefix && prefix !== '.' ? prefix : '';

    const sourceDir = findCtxoGoAnalyzerSource();
    if (!sourceDir) {
      log.info('Go analyzer unavailable: ctxo-go-analyzer source not located');
      return;
    }

    try {
      this.binaryPath = ensureAnalyzerBinary(sourceDir, toolchain.version!);
    } catch (err) {
      log.warn(`Go analyzer binary build failed: ${(err as Error).message}`);
      return;
    }

    log.info(`Go analyzer ready: go ${toolchain.version}, module ${moduleRoot}`);
    this.initialized = true;
  }

  /**
   * Returns the dead-symbol set emitted by the last batch run. Empty until
   * extractSymbols/Edges has been called at least once. Consumed by cli's
   * find_dead_code MCP tool via the composite delegate.
   */
  getDeadSymbolIds(): Set<string> {
    return this.deadSymbolIds;
  }

  /** True when the analyzer ran in binary mode (precise dead-code). */
  reachabilityHasMain(): boolean {
    return this.hasMain;
  }

  /** True when reach analysis exceeded the deadline (degraded precision). */
  reachabilityTimedOut(): boolean {
    return this.timedOut;
  }

  /** True once a batch run failed or was killed. */
  hasBatchFailed(): boolean {
    return this.batchFailed;
  }

  /**
   * Runs the batch if it has not run yet and tells whether the analyzer result can be used. False when the
   * process failed, crashed or was killed: the composite then indexes with tree-sitter instead of storing
   * an empty full-tier result.
   */
  async isUsable(): Promise<boolean> {
    if (!this.isReady()) return false;
    await this.ensureBatch();
    return !this.batchFailed;
  }

  async extractSymbols(filePath: string, _source: string): Promise<SymbolNode[]> {
    if (!this.isReady()) return [];
    await this.ensureBatch();
    const file = this.cache.get(this.normalizePath(filePath));
    if (!file) return [];
    return file.symbols
      .filter((s) => VALID_SYMBOL_ID.test(s.symbolId))
      .map((s) => {
        const annotations = s.tags ? structTagAnnotations(s.tags) : undefined;
        return {
          symbolId: s.symbolId,
          name: s.name,
          kind: s.kind as SymbolKind,
          startLine: s.startLine,
          endLine: s.endLine,
          ...(s.startOffset != null ? { startOffset: s.startOffset } : {}),
          ...(s.endOffset != null ? { endOffset: s.endOffset } : {}),
          ...(annotations ? { annotations } : {}),
        };
      });
  }

  async extractEdges(filePath: string, _source: string): Promise<GraphEdge[]> {
    if (!this.isReady()) return [];
    await this.ensureBatch();
    const file = this.cache.get(this.normalizePath(filePath));
    if (!file) return [];
    const edges: GraphEdge[] = file.edges
      .filter((e) => VALID_SYMBOL_ID.test(e.from) && VALID_SYMBOL_ID.test(e.to))
      .map((e) => ({
        from: e.from,
        to: e.to,
        kind: e.kind as GraphEdge['kind'],
      }));
    // Data edges are built from the already rewritten call-site ids and skip the 3-part `to` filter above:
    // their targets are canonical names such as `dbo.loans::table`.
    if (file.sqlCallSites?.length) edges.push(...sqlEdgesFromCallSites(file.sqlCallSites));
    return edges;
  }

  async extractComplexity(_filePath: string, _source: string): Promise<ComplexityMetrics[]> {
    // Tree-sitter layer fills complexity — the binary intentionally emits []
    // so the composite adapter merges the two sources without contention.
    return [];
  }

  async dispose(): Promise<void> {
    this.cache.clear();
    this.deadSymbolIds.clear();
    this.batchPromise = null;
    this.initialized = false;
  }

  private async ensureBatch(): Promise<void> {
    if (this.batchPromise) return this.batchPromise;
    this.batchPromise = this.runBatch();
    return this.batchPromise;
  }

  private async runBatch(): Promise<void> {
    if (!this.binaryPath || !this.moduleRoot) return;
    const result = await runBatchAnalyze(this.binaryPath, this.moduleRoot, { sqlCallSites: this.sqlCallSites });
    if (result.failed) {
      this.batchFailed = true;
      log.warn('Go analyzer run failed or timed out; these files fall back to the tree-sitter syntax tier');
      return;
    }
    this.absorbBatch(result);
    if (this.sqlCallSites) {
      if (result.sql) {
        log.debug(`Go analyzer SQL arguments: ${result.sql.constant} constant, ${result.sql.nonConstant} non-constant`);
      } else {
        log.warn('Go analyzer reported no SQL statistics although --sql-call-sites was requested (analyzer too old?)');
      }
    }
    log.info(`Go analyzer batch: ${result.totalFiles} files in ${result.elapsed}, ${result.dead.length} dead`);
  }

  private absorbBatch(result: AnalyzerBatchResult): void {
    this.cache.clear();
    this.deadSymbolIds.clear();
    this.hasMain = result.hasMain;
    this.timedOut = result.timeout;

    const rewrite = this.buildPathRewriter();
    for (const file of result.files) {
      const projectRel = rewrite(file.file);
      this.cache.set(projectRel, {
        ...file,
        file: projectRel,
        symbols: file.symbols.map((s) => ({ ...s, symbolId: rewriteId(s.symbolId, file.file, projectRel) })),
        edges: file.edges.map((e) => ({
          ...e,
          from: rewriteId(e.from, file.file, projectRel),
          to: rewriteIdAcrossModule(e.to, this.modulePathPrefix),
        })),
        // Only the enclosing symbol gets the module prefix; the table targets are built later from the text.
        ...(file.sqlCallSites
          ? { sqlCallSites: file.sqlCallSites.map((s) => ({ ...s, symbolId: rewriteIdAcrossModule(s.symbolId, this.modulePathPrefix) })) }
          : {}),
      });
    }
    if (result.sql) {
      this.sqlStats = {
        constant: (this.sqlStats?.constant ?? 0) + result.sql.constant,
        nonConstant: (this.sqlStats?.nonConstant ?? 0) + result.sql.nonConstant,
      };
    }
    for (const id of result.dead) {
      this.deadSymbolIds.add(rewriteIdAcrossModule(id, this.modulePathPrefix));
    }
  }

  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
  }

  private buildPathRewriter(): (analyzerRel: string) => string {
    if (!this.modulePathPrefix) return (p) => p;
    const prefix = this.modulePathPrefix;
    return (p) => `${prefix}/${p}`;
  }
}

/** Replace the analyzer's module-relative file prefix in a symbol id with the project-relative one. */
function rewriteId(id: string, analyzerFile: string, projectFile: string): string {
  if (analyzerFile === projectFile) return id;
  return id.startsWith(`${analyzerFile}::`) ? `${projectFile}${id.slice(analyzerFile.length)}` : id;
}

/** Edge targets may live in any other file of the module — apply the global prefix shift. */
function rewriteIdAcrossModule(id: string, prefix: string): string {
  if (!prefix) return id;
  const sepIdx = id.indexOf('::');
  if (sepIdx <= 0) return id;
  return `${prefix}/${id}`;
}
