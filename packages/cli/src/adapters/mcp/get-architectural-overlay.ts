import { z } from 'zod';
import type { IGitPort } from '../../ports/i-git-port.js';
import type { IStoragePort } from '../../ports/i-storage-port.js';
import type { IMaskingPort } from '../../ports/i-masking-port.js';
import { ArchitecturalOverlay } from '../../core/overlay/architectural-overlay.js';
import { compareCodepoint } from '../../core/compare-codepoint.js';
import { wrapResponse } from '../../core/response-envelope.js';
import { buildSnapshotStaleness } from '../../core/overlay/snapshot-staleness.js';
import type { ClusterLabelMasker } from '../../core/overlay/cluster-label-masker.js';
import type { CommunitySnapshot, GodNode } from '../../core/types.js';
import type { ContextsView } from '../../core/contexts-view/contexts-view-builder.js';
import type { IContextsViewPort } from '../../ports/i-contexts-view-port.js';
import type { StalenessCheck } from './get-logic-slice.js';

export const OVERLAY_MODES = ['regex', 'communities', 'both', 'contexts'] as const;

export const InputSchema = z.object({
  layer: z.string().optional(),
  mode: z.enum(OVERLAY_MODES).optional(),
  candidate: z.number().int().positive().optional(),
});

export interface CommunityOverlayCluster {
  id: number;
  label: string;
  memberCount: number;
  members: string[];
  godNodes: string[];
}

export interface CommunityOverlay {
  clusters: CommunityOverlayCluster[];
  modularity: number;
  edgeQuality: CommunitySnapshot['edgeQuality'];
  crossClusterEdges: number;
  computedAt: string;
  commitSha: string;
}

export function buildCommunityOverlay(
  snapshot: CommunitySnapshot,
  options: { memberPreviewLimit?: number } = {},
): CommunityOverlay {
  const previewLimit = options.memberPreviewLimit ?? 15;
  const byCluster = new Map<number, string[]>();
  for (const entry of snapshot.communities) {
    const list = byCluster.get(entry.communityId) ?? [];
    list.push(entry.symbolId);
    byCluster.set(entry.communityId, list);
  }
  const labelFor = new Map<number, string>();
  for (const entry of snapshot.communities) {
    if (!labelFor.has(entry.communityId)) {
      labelFor.set(entry.communityId, entry.communityLabel);
    }
  }
  const godNodesByCommunity = new Map<number, Set<string>>();
  for (const god of snapshot.godNodes as readonly GodNode[]) {
    for (const communityId of god.bridgedCommunities) {
      const set = godNodesByCommunity.get(communityId) ?? new Set<string>();
      set.add(god.symbolId);
      godNodesByCommunity.set(communityId, set);
    }
  }

  const clusters: CommunityOverlayCluster[] = [];
  for (const [id, members] of byCluster) {
    members.sort();
    clusters.push({
      id,
      label: labelFor.get(id) ?? `community-${id}`,
      memberCount: members.length,
      members: members.slice(0, previewLimit),
      godNodes: [...(godNodesByCommunity.get(id) ?? [])].sort(),
    });
  }
  clusters.sort((a, b) => b.memberCount - a.memberCount || a.id - b.id);

  return {
    clusters,
    modularity: snapshot.modularity,
    edgeQuality: snapshot.edgeQuality,
    crossClusterEdges: snapshot.crossClusterEdges,
    computedAt: snapshot.computedAt,
    commitSha: snapshot.commitSha,
  };
}

/** Hubs and collisions listed in the summary (R24); the totals say how many there are. */
const HUB_COLLISION_LIMIT = 50;
/** Top terms per candidate in the summary. */
const SUMMARY_TERM_LIMIT = 5;
/** Files of the candidate, occurrences per collision and members per occurrence in the detail. */
const DETAIL_LIST_LIMIT = 15;

const NO_VIEW_HINT = 'No contexts view available. Run ctxo index to generate one.';
const SUMMARY_HINT = 'Pass candidate: <id> for one candidate in full; run ctxo contexts --json for the whole view.';

/** Masks candidate labels, after seeding the masker in sorted order so the `[masked-cluster-N]` numbering is stable. */
function labelMaskerFor(view: ContextsView, labelMasker: ClusterLabelMasker | undefined): (label: string) => string {
  const masker = labelMasker?.isEnabled() ? labelMasker : undefined;
  if (!masker) return (label) => label;
  for (const label of [...new Set(view.candidates.map((c) => c.label))].sort(compareCodepoint)) masker.mask(label);
  return (label) => masker.mask(label);
}

/** Every candidate in brief, plus the capped hubs and collisions: small enough to list the whole view. */
function contextsSummary(view: ContextsView, maskLabel: (label: string) => string): Record<string, unknown> {
  return {
    commitSha: view.commitSha,
    coverage: view.coverage,
    candidates: view.candidates.map((candidate) => ({
      id: candidate.id,
      label: maskLabel(candidate.label),
      fingerprint: candidate.fingerprint,
      fileCount: candidate.fileCount,
      cohesion: candidate.cohesion,
      topTerms: candidate.topTerms.slice(0, SUMMARY_TERM_LIMIT),
    })),
    hubs: view.hubs.slice(0, HUB_COLLISION_LIMIT).map((hub) => ({
      file: hub.file,
      reasons: hub.reasons,
      ...(hub.candidate !== undefined ? { candidate: hub.candidate } : {}),
    })),
    hubsTotal: view.hubs.length,
    collisions: view.collisions.slice(0, HUB_COLLISION_LIMIT).map((collision) => ({
      name: collision.name,
      minJaccard: collision.minJaccard,
      candidates: [...new Set(collision.occurrences.map((occurrence) => occurrence.candidate))].sort((a, b) => a - b),
      occurrenceCount: collision.occurrences.length,
    })),
    collisionsTotal: view.collisions.length,
    unclustered: { count: view.unclustered.count },
    hint: SUMMARY_HINT,
  };
}

/**
 * One candidate in full (files capped), the hubs assigned to it and the collisions it takes part in. A
 * collision lists at most `DETAIL_LIST_LIMIT` occurrences: all of this candidate's that fit, then the first
 * of the others, kept in view order.
 */
function contextsDetail(
  view: ContextsView,
  id: number,
  maskLabel: (label: string) => string,
): Record<string, unknown> {
  const candidate = view.candidates.find((c) => c.id === id);
  if (!candidate) {
    return { found: false, hint: `No candidate ${id} in the contexts view. Call without candidate for the list.` };
  }
  return {
    commitSha: view.commitSha,
    candidate: {
      ...candidate,
      label: maskLabel(candidate.label),
      files: candidate.files.slice(0, DETAIL_LIST_LIMIT),
    },
    hubs: view.hubs
      .filter((hub) => hub.candidate === id)
      .map((hub) => ({ file: hub.file, reasons: hub.reasons, dependents: hub.dependents, damping: hub.damping })),
    collisions: view.collisions
      .filter((collision) => collision.occurrences.some((occurrence) => occurrence.candidate === id))
      .map((collision) => {
        const own = collision.occurrences.filter((occurrence) => occurrence.candidate === id);
        const others = collision.occurrences.filter((occurrence) => occurrence.candidate !== id);
        const kept = new Set([...own, ...others].slice(0, DETAIL_LIST_LIMIT));
        return {
          name: collision.name,
          minJaccard: collision.minJaccard,
          occurrences: collision.occurrences
            .filter((occurrence) => kept.has(occurrence))
            .map((occurrence) => ({
              ...occurrence,
              members: occurrence.members.slice(0, DETAIL_LIST_LIMIT),
              memberCount: occurrence.members.length,
            })),
          occurrenceCount: collision.occurrences.length,
        };
      }),
  };
}

/**
 * Builds the `mode: "contexts"` body from the (read-only, shared, deep-frozen) view: the summary of every
 * candidate, or with `candidate` that one candidate in full. Only copies are built (`map`, `slice`, spread):
 * the view must never be sorted or spliced in place. The full view stays in the artifact and in
 * `ctxo contexts --json`; `settings` is left out here.
 */
export function buildContextsOverlay(
  view: ContextsView | undefined,
  options: { candidate?: number; labelMasker?: ClusterLabelMasker } = {},
): Record<string, unknown> {
  if (!view) return { found: false, hint: NO_VIEW_HINT };
  const maskLabel = labelMaskerFor(view, options.labelMasker);
  return options.candidate === undefined
    ? contextsSummary(view, maskLabel)
    : contextsDetail(view, options.candidate, maskLabel);
}

export function handleGetArchitecturalOverlay(
  storage: IStoragePort,
  masking: IMaskingPort,
  staleness?: StalenessCheck,
  git?: IGitPort,
  clusterLabelMasker?: ClusterLabelMasker,
  contextsView?: IContextsViewPort,
) {
  const overlay = new ArchitecturalOverlay();

  return async (args: Record<string, unknown>) => {
    try {
      const parsed = InputSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: parsed.error.message }) }],
        };
      }

      const files = storage.listIndexedFiles();
      const result = overlay.classify(files);
      const mode = parsed.data.mode ?? 'both';

      const buildContent = (payloadStr: string) => {
        const content: Array<{ type: 'text'; text: string }> = [];
        if (staleness) {
          const warning = staleness.check(files);
          if (warning) content.push({ type: 'text', text: `⚠️ ${warning.message}` });
        }
        content.push({ type: 'text', text: payloadStr });
        return content;
      };

      const stalenessMeta = git ? await buildSnapshotStaleness(storage, git) : undefined;
      const extras = stalenessMeta ? { snapshotStaleness: stalenessMeta } : undefined;

      // Filter by layer if specified (regex-mode semantics always apply here)
      if (parsed.data.layer) {
        const filtered = result.layers[parsed.data.layer];
        const payload = masking.mask(
          JSON.stringify(wrapResponse({ layer: parsed.data.layer, files: filtered ?? [] }, extras)),
        );
        return { content: buildContent(payload) };
      }

      if (mode === 'contexts') {
        const body = buildContextsOverlay(contextsView?.readContextsView(), {
          candidate: parsed.data.candidate,
          labelMasker: clusterLabelMasker,
        });
        const payload = masking.mask(JSON.stringify(wrapResponse(body, extras)));
        return { content: buildContent(payload) };
      }

      const rawSnapshot = mode === 'regex' ? undefined : storage.readCommunities();
      const snapshot =
        rawSnapshot && clusterLabelMasker?.isEnabled()
          ? clusterLabelMasker.maskSnapshot(rawSnapshot)
          : rawSnapshot;
      const community = snapshot ? buildCommunityOverlay(snapshot) : undefined;

      const body: Record<string, unknown> = {};
      if (mode !== 'communities') body.layers = result.layers;
      if (community) body.communities = community;
      if (mode === 'communities' && !community) {
        body.hint = 'No community snapshot available. Run `ctxo index` to generate one.';
      }

      const payload = masking.mask(JSON.stringify(wrapResponse(body, extras)));
      return { content: buildContent(payload) };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: (err as Error).message }) }],
      };
    }
  };
}
