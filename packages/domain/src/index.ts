import type { CtxoModuleRegister } from '@ctxo/cli/internal';
import { contextsTouchedCommand } from './commands/contexts-touched-command.js';
import { domainGuardHookCommand } from './commands/domain-guard-hook-command.js';
import { domainInit } from './init/domain-init.js';
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
  return {
    id: 'domain',
    indexCapabilities: { facts: true },
    registerCommands(registrar) {
      registrar.registerCommand(contextsTouchedCommand(host));
      registrar.registerCommand(domainGuardHookCommand(host));
    },
    init: domainInit(host),
  };
};
