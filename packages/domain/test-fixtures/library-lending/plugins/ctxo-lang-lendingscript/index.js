/**
 * Test fixture: a protocol v1 language plugin for the made-up LendingScript (`.lend`). It turns every
 * `function <name> {` ... `}` block into a `function` symbol and has no `extractFacts`, so the domain layer
 * finds the facts of these files with its text fallback.
 */

const FUNCTION_START = /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*$/;
const BLOCK_END = /^\s*\}\s*$/;

function extractSymbols(filePath, source) {
  const symbols = [];
  const lines = source.split(/\r\n|\r|\n/);
  let open;
  lines.forEach((line, index) => {
    const start = FUNCTION_START.exec(line);
    if (open === undefined && start !== null) {
      open = { name: start[1], startLine: index };
      return;
    }
    if (open !== undefined && BLOCK_END.test(line)) {
      symbols.push({
        symbolId: `${filePath}::${open.name}::function`,
        name: open.name,
        kind: 'function',
        startLine: open.startLine,
        endLine: index,
      });
      open = undefined;
    }
  });
  return symbols;
}

const plugin = {
  apiVersion: '1',
  id: 'lendingscript',
  name: 'LendingScript (test fixture)',
  version: '0.0.0',
  extensions: ['.lend'],
  tier: 'syntax',
  createAdapter() {
    return {
      isSupported: (filePath) => filePath.toLowerCase().endsWith('.lend'),
      extractSymbols: async (filePath, source) => extractSymbols(filePath, source),
      extractEdges: async () => [],
      extractComplexity: async () => [],
    };
  },
};

export default plugin;
