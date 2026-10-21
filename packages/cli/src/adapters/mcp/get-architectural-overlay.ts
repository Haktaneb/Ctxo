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

const HUB_COLLISION_LIMIT = 50;

/**
 * Builds the `mode: "contexts"` body from the (read-only, shared) view. Every array is copied: the view
 * must never be sorted or spliced in place. Labels are masked after seeding the masker in sorted order,
 * so the `[masked-cluster-N]` numbering is stable across calls.
 */
export function buildContextsOverlay(
  view: ContextsView | undefined,
  options: { memberPreviewLimit?: number; labelMasker?: ClusterLabelMasker } = {},
): Record<string, unknown> {
  if (!view) return { hint: 'No contexts view available. Run ctxo index to generate one.' };
  const previewLimit = options.memberPreviewLimit ?? 15;
  const masker = options.labelMasker?.isEnabled() ? options.labelMasker : undefined;
  if (masker) {
    for (const label of [...new Set(view.candidates.map((c) => c.label))].sort(compareCodepoint)) masker.mask(label);
  }
  const maskLabel = (label: string) => (masker ? masker.mask(label) : label);

  return {
    ...view,
    candidates: view.candidates.map((candidate) => ({
      ...candidate,
      label: maskLabel(candidate.label),
      files: candidate.files.slice(0, previewLimit),
    })),
    unclustered: { ...view.unclustered, files: view.unclustered.files.slice(0, previewLimit) },
    hubs: view.hubs.slice(0, HUB_COLLISION_LIMIT),
    hubsTotal: view.hubs.length,
    collisions: view.collisions.slice(0, HUB_COLLISION_LIMIT),
    collisionsTotal: view.collisions.length,
  };
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
        const body = buildContextsOverlay(contextsView?.readContextsView(), { labelMasker: clusterLabelMasker });
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
