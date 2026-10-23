// Loaded with `node --import`: registers a resolve hook that logs every module URL the process resolves
// to the file named by CTXO_IMPORT_LOG (the guard hook route e2e test reads it).
import { register } from 'node:module';

register('./import-recorder-hooks.mjs', import.meta.url);
