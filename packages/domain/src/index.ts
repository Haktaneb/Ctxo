import type { CtxoModuleRegister } from '@ctxo/cli/internal';
import { contextsTouchedCommand } from './commands/contexts-touched-command.js';
import { domainCommand } from './commands/domain-command.js';
import { domainGuardHookCommand } from './commands/domain-guard-hook-command.js';
import { verifyDomainCommand } from './commands/verify-domain-command.js';
import { domainDoctorChecks } from './doctor/domain-checks.js';
import { domainIndexPass } from './index-pass/domain-index-pass.js';
import { domainInit } from './init/domain-init.js';
import { domainRankedScope } from './mcp/domain-scope.js';
import { createDomainState } from './mcp/domain-state.js';
import { domainTools } from './mcp/domain-tools.js';
import { createEnrichers } from './mcp/enrichers.js';
import { taskContextReservation } from './mcp/graph-enrichers.js';
import { DOMAIN_PACKAGE, domainVersion, sameMinor } from './version.js';

/**
 * The module entry the CLI loads (ADR-018). The module runs only against the CLI minor it was built for;
 * on a mismatch it warns and declines.
 */
export const register: CtxoModuleRegister = async (host) => {
  const version = domainVersion();
  if (!sameMinor(version, host.cliVersion)) {
    const [major, minor] = version.split('.');
    host.services
      .createLogger('ctxo:domain')
      .warn(
        `${DOMAIN_PACKAGE} ${version} needs @ctxo/cli ${major}.${minor}.x, running ${host.cliVersion}; staying inactive`,
      );
    return undefined;
  }
  // One state for the enrichers, the reservation, the tools and the scope; it does no I/O until a first load (P19).
  const state = createDomainState(host);
  return {
    id: 'domain',
    indexCapabilities: { facts: true },
    indexPass: domainIndexPass(host),
    registerCommands(registrar) {
      registrar.registerCommand(contextsTouchedCommand(host));
      registrar.registerCommand(domainGuardHookCommand(host));
      registrar.registerCommand(domainCommand(host));
      registrar.registerCommand(verifyDomainCommand(host));
    },
    registerTools(registrar) {
      for (const tool of domainTools(host, state)) registrar.registerTool(tool);
    },
    enrich: createEnrichers(host, state),
    reserveTaskContextTokens: taskContextReservation(state),
    rankedContextScopes: [domainRankedScope(host, state)],
    init: domainInit(host),
    doctorChecks: domainDoctorChecks(host),
  };
};
