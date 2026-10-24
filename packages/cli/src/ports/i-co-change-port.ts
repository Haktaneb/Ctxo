import type { CoChangeEntry } from '../core/types.js';

/**
 * Read access to the co-change matrix (`co-changes.json`), shaped for lookups: every file maps to the
 * entries it takes part in, so each entry is listed under both of its files.
 *
 * Returns `undefined` when there is no usable matrix (the project was never indexed, or the file is
 * invalid); callers then work from the dependency graph alone. The map is shared between calls, so a
 * caller must treat it, and the lists in it, as read-only.
 */
export interface ICoChangePort {
  readCoChangeMap(): Map<string, CoChangeEntry[]> | undefined;
  /**
   * The validated matrix's `entries` as stored: one per file pair, in file order. Same validation and the
   * same cache as `readCoChangeMap` (one read serves both); `undefined` when there is no usable matrix.
   * Frozen and shared between calls.
   */
  readEntries(): readonly CoChangeEntry[] | undefined;
}
