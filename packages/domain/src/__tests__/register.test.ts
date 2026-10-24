import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { createModuleHost } from '@ctxo/cli/internal';
import { DEFAULT_DOMAIN_CONFIG } from '../core/domain-config.js';
import { register } from '../index.js';
import { DOMAIN_PACKAGE, domainVersion, sameMinor } from '../version.js';

/** A temp project with `.ctxo/` and, unless `registry` is false, the default registry file. */
function project(options: { readonly config?: string; readonly registry?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'ctxo-domain-register-'));
  mkdirSync(join(dir, '.ctxo'));
  if (options.config !== undefined) writeFileSync(join(dir, '.ctxo', 'config.yaml'), options.config);
  if (options.registry !== false) {
    mkdirSync(join(dir, 'docs', 'domain'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'domain', 'contexts.yaml'), 'version: 1\ncontexts: []\n');
  }
  return dir;
}

function majorMinor(version: string): string {
  const [major, minor] = version.split('.');
  return `${major}.${minor}`;
}

describe('register', () => {
  it('register returns the domain registration when the cli minor matches', async () => {
    const dir = project();
    try {
      const host = createModuleHost({ cliVersion: domainVersion(), mode: 'cli', projectRoot: dir });

      const registration = await register(host);

      expect(registration?.id).toBe('domain');
      expect(registration?.indexCapabilities?.facts).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without a registry file the module asks for no facts, so the index JSON stays as without the module (C-M)', async () => {
    for (const dir of [project({ registry: false }), project({ registry: false, config: 'version: "1.0"\ndomain:\n  registry: config/contexts.yaml\n' })]) {
      try {
        // A registry at the default path does not count when the config names another one.
        if (existsSync(join(dir, '.ctxo', 'config.yaml'))) {
          mkdirSync(join(dir, 'docs', 'domain'), { recursive: true });
          writeFileSync(join(dir, 'docs', 'domain', 'contexts.yaml'), 'version: 1\ncontexts: []\n');
        }
        const host = createModuleHost({ cliVersion: domainVersion(), mode: 'cli', projectRoot: dir });
        const registration = await register(host);
        expect(registration?.id).toBe('domain');
        expect(registration?.indexCapabilities).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('a registry at the configured path turns the fact request on', async () => {
    const dir = project({ registry: false, config: 'version: "1.0"\ndomain:\n  registry: config/contexts.yaml\n' });
    try {
      mkdirSync(join(dir, 'config'));
      writeFileSync(join(dir, 'config', 'contexts.yaml'), 'version: 1\ncontexts: []\n');
      const host = createModuleHost({ cliVersion: domainVersion(), mode: 'cli', projectRoot: dir });
      expect((await register(host))?.indexCapabilities?.facts).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the registration requests facts with the configured lists', async () => {
    const dir = project({ config: 'version: "1.0"\ndomain:\n  facts:\n    trivialLiterals: [0, 100]\n' });
    try {
      const host = createModuleHost({ cliVersion: domainVersion(), mode: 'cli', projectRoot: dir });

      const registration = await register(host);

      expect(registration?.indexCapabilities).toEqual({
        facts: true,
        factOptions: { trivialLiterals: [0, 100], normalizationMethods: DEFAULT_DOMAIN_CONFIG.facts.normalizationMethods },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an invalid or unreadable config gives the default fact lists and logs nothing (W7)', async () => {
    const dir = project({ config: 'domain:\n  facts:\n    trivialLiterals: [{}]\n' });
    try {
      const host = createModuleHost({ cliVersion: domainVersion(), mode: 'cli', projectRoot: dir });
      const logged = vi.fn();
      const logger = { debug: logged, info: logged, warn: logged, error: logged };
      const services = {
        ...host.services,
        createLogger: () => logger as unknown as ReturnType<typeof host.services.createLogger>,
      };

      const registration = await register({ ...host, services });
      const throwing = await register({
        ...host,
        services: {
          ...services,
          loadConfig: () => {
            throw new Error('boom');
          },
        },
      });

      const defaults = {
        facts: true,
        factOptions: {
          trivialLiterals: DEFAULT_DOMAIN_CONFIG.facts.trivialLiterals,
          normalizationMethods: DEFAULT_DOMAIN_CONFIG.facts.normalizationMethods,
        },
      };
      expect(registration?.indexCapabilities).toEqual(defaults);
      expect(throwing?.indexCapabilities).toEqual(defaults);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('register does not load the config; the fact request loads it once, on first use', async () => {
    for (const registry of [true, false]) {
      const dir = project({ registry });
      try {
        const host = createModuleHost({ cliVersion: domainVersion(), mode: 'cli', projectRoot: dir });
        const loadConfig = vi.fn(host.services.loadConfig);

        const registration = await register({ ...host, services: { ...host.services, loadConfig } });

        // Commands and the hook route register the module but never read indexCapabilities.
        expect(loadConfig).not.toHaveBeenCalled();
        const first = registration?.indexCapabilities;
        const second = registration?.indexCapabilities;
        expect(loadConfig).toHaveBeenCalledTimes(1);
        expect(second).toBe(first);
        expect(first?.facts).toBe(registry ? true : undefined);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('register warns and resolves undefined when the minors differ', async () => {
    const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: process.cwd() });
    const warn = vi.fn();
    const services = { ...host.services, createLogger: () => ({ ...host.services.createLogger('ctxo:domain'), warn }) };

    const registration = await register({ ...host, services });

    expect(registration).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      `${DOMAIN_PACKAGE} ${domainVersion()} needs @ctxo/cli ${majorMinor(domainVersion())}.x, running 0.0.0; staying inactive`,
    );
  });

  it('the package version equals the cli version', () => {
    const cli = JSON.parse(readFileSync(new URL('../../../cli/package.json', import.meta.url), 'utf8')) as {
      version: string;
    };

    // major.minor only: a cli patch release must not break this (PF19).
    expect(majorMinor(domainVersion())).toBe(majorMinor(cli.version));
  });
});

describe('sameMinor', () => {
  it('compares major and minor only', () => {
    expect(sameMinor('0.13.0', '0.13.9')).toBe(true);
    expect(sameMinor('0.13.0', '0.14.0')).toBe(false);
    expect(sameMinor('x', '0.13.0')).toBe(false);
  });
});
