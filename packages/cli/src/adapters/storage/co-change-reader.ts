import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadCoChangeMap } from '../../core/co-change/co-change-analyzer.js';
import { createLogger } from '../../core/logger.js';
import { CoChangeMatrixSchema, type CoChangeEntry } from '../../core/types.js';
import type { ICoChangePort } from '../../ports/i-co-change-port.js';

const log = createLogger('ctxo:co-change');

/** What one version of the file, told apart by mtime and size, was read as. `map` is undefined when it was unusable. */
interface CachedRead {
  readonly mtimeMs: number;
  readonly size: number;
  readonly map: Map<string, CoChangeEntry[]> | undefined;
}

/**
 * Reads `<ctxoRoot>/index/co-changes.json` for every caller that tiers a blast radius: the MCP handlers,
 * `ctxo blast-radius`, the safe-edit gate and `ctxo gate --preview`.
 *
 * The file is validated with `CoChangeMatrixSchema` and turned into a lookup by file. The result is cached
 * until the file's mtime or size changes, so a long-running MCP server picks up a matrix that `ctxo index`
 * or the post-commit hook rewrites, without parsing it again on every call. Size joins the mtime in the
 * key because a coarse file system clock can give two different writes the same mtime.
 *
 * It never throws. A missing file is the normal state of a project without history and returns `undefined`
 * silently. An unreadable or invalid file returns `undefined` and warns once per version of the file.
 * Every caller then works from the dependency graph alone.
 *
 * The returned map is shared between calls: treat it, and the lists in it, as read-only.
 */
export class CoChangeReader implements ICoChangePort {
  private readonly filePath: string;
  private cached: CachedRead | undefined;

  constructor(ctxoRoot: string) {
    this.filePath = join(ctxoRoot, 'index', 'co-changes.json');
  }

  readCoChangeMap(): Map<string, CoChangeEntry[]> | undefined {
    let stats;
    try {
      stats = statSync(this.filePath);
    } catch {
      this.cached = undefined;
      return undefined;
    }

    // The stat is taken before the read: a file replaced in between is cached under the older key, so the
    // next call sees a different stat and reads again. The other order could keep stale content under a new key.
    if (this.cached && this.cached.mtimeMs === stats.mtimeMs && this.cached.size === stats.size) {
      return this.cached.map;
    }

    const map = this.load();
    this.cached = { mtimeMs: stats.mtimeMs, size: stats.size, map };
    return map;
  }

  private load(): Map<string, CoChangeEntry[]> | undefined {
    const unusable = (problem: string): undefined => {
      log.warn(`${this.filePath} ${problem}; co-change is ignored until ctxo index rewrites it`);
      return undefined;
    };

    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      return unusable(`cannot be read (${(err as Error).message})`);
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return unusable(`is not valid JSON (${(err as Error).message})`);
    }

    const parsed = CoChangeMatrixSchema.safeParse(data);
    if (parsed.success) return loadCoChangeMap(parsed.data);

    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : '';
    return unusable(`is not a valid co-change matrix (${where}${issue?.message ?? 'unknown problem'})`);
  }
}
