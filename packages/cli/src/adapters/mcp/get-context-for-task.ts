import { z } from 'zod';
import type { IStoragePort } from '../../ports/i-storage-port.js';
import type { IMaskingPort } from '../../ports/i-masking-port.js';
import type { ICoChangePort } from '../../ports/i-co-change-port.js';
import { ContextAssembler } from '../../core/context-assembly/context-assembler.js';
import { JsonIndexReader } from '../storage/json-index-reader.js';
import { getGraphAndFiles } from './get-logic-slice.js';
import type { StalenessCheck } from './get-logic-slice.js';
import { wrapResponse } from '../../core/response-envelope.js';
import { createLogger } from '../../core/logger.js';
import { describeError } from '../../core/describe-error.js';
import type { ResponseEnricher, TokenReservation } from '../../ports/i-ctxo-module.js';
import { applyEnricher } from './enrich-payload.js';

const log = createLogger('ctxo:modules');

const TaskTypeSchema = z.enum(['fix', 'extend', 'refactor', 'understand']);

export const InputSchema = z.object({
  symbolId: z.string().min(1),
  taskType: TaskTypeSchema,
  tokenBudget: z.number().min(100).optional().default(4000),
});

/** The largest share of `tokenBudget` a module reservation may keep back from the code context. */
export const MAX_RESERVED_SHARE = 0.25;

/**
 * The tokens kept back from `tokenBudget` for module fields: 0 without a reservation, and 0 with a warning
 * when it throws or returns something other than a finite number; otherwise the rounded value, clamped to
 * `[0, floor(tokenBudget * MAX_RESERVED_SHARE)]`.
 */
export function reservedTokens(
  reserve: TokenReservation | undefined,
  args: Readonly<Record<string, unknown>>,
  tokenBudget: number,
): number {
  if (reserve === undefined) return 0;
  let value: unknown;
  try {
    value = reserve(args);
  } catch (err) {
    log.warn(`The get_context_for_task token reservation failed: ${describeError(err)}; nothing is reserved`);
    return 0;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    log.warn('The get_context_for_task token reservation is not a finite number; nothing is reserved');
    return 0;
  }
  return Math.min(Math.max(Math.round(value), 0), Math.floor(tokenBudget * MAX_RESERVED_SHARE));
}

/**
 * @param enrich - the module enricher; it runs on the payload before the envelope and masking
 * @param reserve - the module token reservation; the code context is packed into what it leaves of the budget
 */
export function handleGetContextForTask(
  storage: IStoragePort,
  masking: IMaskingPort,
  staleness?: StalenessCheck,
  ctxoRoot = '.ctxo',
  coChange?: ICoChangePort,
  enrich?: ResponseEnricher,
  reserve?: TokenReservation,
) {
  const assembler = new ContextAssembler();
  const indexReader = new JsonIndexReader(ctxoRoot);

  const getGraph = () => getGraphAndFiles(ctxoRoot, storage);

  return (args: Record<string, unknown>) => {
    try {
      const parsed = InputSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: parsed.error.message }) }],
        };
      }

      const { symbolId, taskType, tokenBudget } = parsed.data;
      const { graph, indexedFiles } = getGraph();
      const indices = indexReader.readAll();

      const reserved = reservedTokens(reserve, parsed.data, tokenBudget);
      const result = assembler.assembleForTask(
        graph,
        symbolId,
        taskType,
        indices,
        tokenBudget - reserved,
        coChange?.readCoChangeMap(),
      );

      if (!result) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ found: false, hint: 'Symbol not found. Run "ctxo index".' }) }],
        };
      }

      // The payload reports the budget the agent asked for, not the part the reservation left.
      const body: Record<string, unknown> = { ...(result as unknown as Record<string, unknown>), tokenBudget };
      const enriched = applyEnricher(enrich, body, parsed.data, 'get_context_for_task');
      const payload = masking.mask(JSON.stringify(wrapResponse(enriched)));

      const content: Array<{ type: 'text'; text: string }> = [];
      if (staleness) {
        const warning = staleness.check(indexedFiles);
        if (warning) content.push({ type: 'text', text: `⚠️ ${warning.message}` });
      }
      content.push({ type: 'text', text: payload });

      return { content };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: (err as Error).message }) }],
      };
    }
  };
}
