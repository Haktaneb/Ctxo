// A module customization `resolve` hook: appends each resolved URL, one per line, to CTXO_IMPORT_LOG.
import { appendFileSync } from 'node:fs';

const logFile = process.env.CTXO_IMPORT_LOG;

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (logFile) appendFileSync(logFile, `${result.url}\n`, 'utf-8');
  return result;
}
