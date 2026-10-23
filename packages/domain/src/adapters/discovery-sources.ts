import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CtxoHost, FileIndex, IGitPort, LoadedConfig } from '@ctxo/cli/internal';
import { parseCard, type ParsedCard } from '../core/card-parser.js';
import type { DiscoveryInput } from '../core/discovery.js';
import type { DomainConfig } from '../core/domain-config.js';
import { readRegistry } from './registry-reader.js';
import { readCardText } from './repo-files.js';

/**
 * Gathers what `discoverConventions` reads: the cards, the co-change window's commit subjects, the branch
 * names, the index and the tracked files. Every git source is optional; without git history the evidence
 * from commits and branches is simply empty (warn-and-continue).
 */
export async function gatherDiscoveryInput(
  host: CtxoHost,
  projectRoot: string,
  ctxoRoot: string,
  loaded: LoadedConfig,
  config: DomainConfig,
): Promise<DiscoveryInput> {
  const services = host.services;
  const registryFile = readRegistry(projectRoot, config.registry);
  const registry = registryFile?.registry !== undefined && registryFile.problems.length === 0 ? registryFile.registry : undefined;

  const cards: ParsedCard[] = [];
  const seen = new Set<string>();
  for (const context of registry?.contexts ?? []) {
    if (context.card === undefined || seen.has(context.card)) continue;
    seen.add(context.card);
    // Read like every other card read (I2): real path inside the repo, no-follow open, 1 MiB cap.
    const text = readCardText(projectRoot, context.card, (message) => services.createLogger('ctxo:domain').warn(message));
    if (text !== undefined) cards.push(parseCard(text));
  }

  let indices: FileIndex[] = [];
  try {
    indices = services.readIndex(ctxoRoot);
  } catch {
    indices = [];
  }

  let git: IGitPort | undefined;
  try {
    git = services.createGit(projectRoot);
  } catch {
    git = undefined;
  }

  let commitSubjects: string[] = [];
  try {
    const window = await services.readCoChangeWindow(projectRoot, loaded.config);
    commitSubjects = (window?.commits ?? []).map((commit) => commit.message);
  } catch {
    commitSubjects = [];
  }

  let localBranches: readonly string[] = [];
  let remoteBranches: readonly string[] = [];
  try {
    const refs = await git?.getRefs?.();
    localBranches = refs?.localBranches ?? refs?.branches ?? [];
    remoteBranches = refs?.remoteBranches ?? [];
  } catch {
    localBranches = [];
    remoteBranches = [];
  }

  let trackedFiles: readonly string[] | undefined;
  try {
    trackedFiles = await git?.listTrackedFiles?.();
  } catch {
    trackedFiles = undefined;
  }

  return {
    cards,
    ...(registry !== undefined ? { registry } : {}),
    commitSubjects,
    localBranches,
    remoteBranches,
    indices,
    trackedFiles: trackedFiles ?? indices.map((index) => index.file),
    // Deliberately path globs only (default globs plus index.tests): annotated files outside them are what discovery reports.
    isPathTestFile: services.createTestFileCheck(loaded.config, []),
    testFrameworkAnnotations: services.testFrameworkAnnotations,
    config,
    indexTests: loaded.config.index?.tests ?? [],
  };
}

/** The text of the config file, read once; undefined when it does not exist. */
export function readConfigText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Writes the config through a `wx` temp file renamed over the target (PF27). */
export function writeConfigText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, text, { encoding: 'utf-8', flag: 'wx' });
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}
