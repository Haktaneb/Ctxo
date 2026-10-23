import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectJavaRuntime, type JavaToolchainInfo } from '../../analyzer/toolchain-detect.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ANALYZER_PACKAGE = resolve(HERE, '../../../../lang-java-analyzer');
const RESOURCES = resolve(ANALYZER_PACKAGE, 'java/src/test/resources');

/** Absolute path of the synthetic lending sample shared by JUnit and the lang-java tests. */
export const LENDING_FIXTURE: string = resolve(RESOURCES, 'lending');

/** Absolute path of the original JDT fixture (`Foo`, `Bar`, `Shapes`, `Uses`, `StaticImp`). */
export const JDT_FIXTURE: string = resolve(RESOURCES, 'fixture');

let runtime: JavaToolchainInfo | undefined;
function javaRuntime(): JavaToolchainInfo {
  runtime ??= detectJavaRuntime();
  return runtime;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The analyzer JAR for tests: `CTXO_JDT_ANALYZER_JAR` when that file exists, else the JAR that
 * `pnpm --filter @ctxo/lang-java-analyzer build` writes (`-17` on JRE 17 or later, which can
 * also run `-11`; `-11` otherwise). Each candidate is checked on its own; nothing is read.
 */
export function testAnalyzerJar(): string | undefined {
  const override = process.env.CTXO_JDT_ANALYZER_JAR;
  if (override && isFile(override)) return override;
  const major = javaRuntime().major ?? 0;
  const variants = major >= 17 ? ['17', '11'] : ['11'];
  for (const variant of variants) {
    const jar = resolve(ANALYZER_PACKAGE, 'jar', `ctxo-jdt-analyzer-${variant}.jar`);
    if (isFile(jar)) return jar;
  }
  return undefined;
}

/** True when the Java full tier can run here: a JRE 11 or later and a built analyzer JAR. */
export const CAN_RUN_JDT: boolean = javaRuntime().available && testAnalyzerJar() !== undefined;
