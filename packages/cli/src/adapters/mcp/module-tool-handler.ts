import type { z, ZodRawShape } from 'zod';
import type { IMaskingPort } from '../../ports/i-masking-port.js';
import type { CoreToolName, ModuleToolDefinition } from '../../ports/i-ctxo-module.js';
import type { LoadedModule } from '../modules/module-loader.js';
import type { StalenessCheck } from './get-logic-slice.js';
import { wrapResponse } from '../../core/response-envelope.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('ctxo:modules');

/** What an MCP tool handler resolves to: text content only. */
export type McpToolResult = { content: Array<{ type: 'text'; text: string }> };

/** Every core tool name, once; the `satisfies` makes the compiler reject a missing or unknown name. */
const CORE_TOOLS = {
  get_logic_slice: true,
  get_why_context: true,
  get_change_intelligence: true,
  get_blast_radius: true,
  get_architectural_overlay: true,
  find_dead_code: true,
  get_context_for_task: true,
  get_ranked_context: true,
  search_symbols: true,
  get_changed_symbols: true,
  find_importers: true,
  get_class_hierarchy: true,
  get_symbol_importance: true,
  get_pr_impact: true,
} as const satisfies Record<CoreToolName, true>;

/** The 14 tools the MCP server registers itself. A module tool may not take one of these names. */
export const CORE_TOOL_NAMES: ReadonlySet<CoreToolName> = new Set(Object.keys(CORE_TOOLS) as CoreToolName[]);

/**
 * The tools the loaded modules register, in load order. A tool named like a core tool, or like a tool an
 * earlier module registered, is skipped with a warning, and so is a tool without a name or a handler. A
 * module whose `registerTools` throws contributes nothing and the others still count.
 */
export function collectModuleTools(
  modules: readonly LoadedModule[],
  reserved: ReadonlySet<string>,
): ModuleToolDefinition[] {
  const tools = new Map<string, ModuleToolDefinition>();
  for (const module of modules) {
    const register = module.registration.registerTools;
    if (typeof register !== 'function') continue;
    try {
      register.call(module.registration, {
        registerTool: (tool: ModuleToolDefinition) => {
          if (typeof tool?.name !== 'string' || tool.name.length === 0 || typeof tool.handler !== 'function') {
            log.warn(`${module.name} registered a tool without a name or a handler; it was ignored`);
          } else if (reserved.has(tool.name)) {
            log.warn(`${module.name} tool "${tool.name}" has the name of a core tool and was ignored`);
          } else if (tools.has(tool.name)) {
            log.warn(`${module.name} tool "${tool.name}" is already registered and was ignored`);
          } else {
            tools.set(tool.name, tool);
          }
        },
      });
    } catch (err) {
      log.warn(`${module.name} could not register its tools: ${(err as Error).message}`);
    }
  }
  return [...tools.values()];
}

/**
 * The input schema of a module tool, built with the host's zod. Throws when the factory throws or returns
 * anything but an object of zod types, so a bad schema fails its own registration instead of `listTools`.
 */
export function moduleInputShape(tool: ModuleToolDefinition, zod: typeof z): ZodRawShape {
  const shape: unknown = tool.inputSchema(zod);
  const isZodType = (value: unknown) =>
    typeof value === 'object' && value !== null && typeof (value as { safeParse?: unknown }).safeParse === 'function';
  if (shape === null || typeof shape !== 'object' || Array.isArray(shape) || !Object.values(shape).every(isZodType)) {
    throw new Error('its input schema is not an object of zod types');
  }
  return shape as ZodRawShape;
}

/**
 * The MCP handler of a module tool: the module's result goes through the `_meta` envelope and masking like
 * a core tool's payload, after the staleness warning when the index is stale. Never throws: a throwing
 * handler, or one that returns something other than an object, gives `{ error: true, message }`.
 */
export function handleModuleTool(
  tool: ModuleToolDefinition,
  masking: IMaskingPort,
  staleness: StalenessCheck | undefined,
  indexedFiles: () => readonly string[],
): (args: Record<string, unknown>) => Promise<McpToolResult> {
  return async (args: Record<string, unknown>) => {
    try {
      const result: unknown = await tool.handler(args);
      if (result === null || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error(`Module tool ${tool.name} returned no payload object`);
      }
      const payload = masking.mask(JSON.stringify(wrapResponse(result as Record<string, unknown>)));

      const content: McpToolResult['content'] = [];
      if (staleness) {
        const warning = staleness.check(indexedFiles());
        if (warning) content.push({ type: 'text', text: `⚠️ ${warning.message}` });
      }
      content.push({ type: 'text', text: payload });
      return { content };
    } catch (err) {
      // A module's error text is not the core's: it is masked like its payloads.
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: masking.mask(JSON.stringify({ error: true, message })) }] };
    }
  };
}
