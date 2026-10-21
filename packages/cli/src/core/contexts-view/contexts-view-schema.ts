import { z } from 'zod';

import { EdgeKindSchema } from '../types.js';
import type { ContextsView } from './contexts-view-builder.js';

const count = z.number().int().nonnegative();

const SettingsSchema = z.object({
  weights: z.object({ dependency: z.number(), coChange: z.number() }),
  exclude: z.array(z.string()),
  hubs: z.object({
    auto: z.boolean(),
    topPercent: z.number(),
    minDependents: z.number(),
    paths: z.array(z.string()),
  }),
  resolution: z.number(),
  minCandidateFiles: z.number(),
  technicalTerms: z.array(z.string()),
});

const CandidateSchema = z.object({
  id: z.number().int(),
  label: z.string(),
  fingerprint: z.string(),
  fileCount: count,
  files: z.array(z.string()),
  cohesion: z.number(),
  topTerms: z.array(z.object({ term: z.string(), files: count })),
  crossEdges: z.array(
    z.object({
      candidate: z.number().int(),
      total: count,
      byKind: z.partialRecord(EdgeKindSchema, count),
    }),
  ),
  coChangePairs: z.array(
    z.object({
      file: z.string(),
      otherFile: z.string(),
      otherCandidate: z.number().int(),
      frequency: z.number(),
      sharedCommits: count,
    }),
  ),
});

const HubSchema = z.object({
  file: z.string(),
  reasons: z.array(z.enum(['configured', 'fan-in', 'god-node'])),
  dependents: count,
  damping: z.number(),
  candidate: z.number().int().optional(),
});

const CollisionSchema = z.object({
  name: z.string(),
  minJaccard: z.number(),
  occurrences: z.array(
    z.object({
      candidate: z.number().int(),
      file: z.string(),
      symbolId: z.string(),
      members: z.array(z.string()),
    }),
  ),
});

/** Shape of `.ctxo/index/contexts-view.json`; what the reader accepts. */
export const ContextsViewSchema: z.ZodType<ContextsView> = z.object({
  version: z.literal(1),
  commitSha: z.string(),
  settings: SettingsSchema,
  coverage: z.object({ files: count, covered: count, ratio: z.number() }),
  candidates: z.array(CandidateSchema),
  hubs: z.array(HubSchema),
  unclustered: z.object({ count, files: z.array(z.string()) }),
  collisions: z.array(CollisionSchema),
});
