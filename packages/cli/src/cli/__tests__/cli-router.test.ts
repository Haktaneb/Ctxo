import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { CliRouter } from '../cli-router.js';

describe('CliRouter', () => {
  it('outputs help text for --help flag', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const router = new CliRouter(process.cwd());

    await router.route(['--help']);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('ctxo index'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('ctxo sync'));
    spy.mockRestore();
  });

  it('outputs help text for -h flag', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const router = new CliRouter(process.cwd());

    await router.route(['-h']);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('ctxo'));
    spy.mockRestore();
  });

  it('outputs help when no command provided', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const router = new CliRouter(process.cwd());

    await router.route([]);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('ctxo'));
    spy.mockRestore();
  });

  it('exits with error for --max-history without value', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const router = new CliRouter(process.cwd());
    await router.route(['index', '--max-history']);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('--max-history requires a positive integer'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    spy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with error for --max-history with non-numeric value', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const router = new CliRouter(process.cwd());
    await router.route(['index', '--max-history', 'abc']);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('--max-history requires a positive integer'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    spy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with error for --max-history with zero', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const router = new CliRouter(process.cwd());
    await router.route(['index', '--max-history', '0']);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('--max-history requires a positive integer'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    spy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with error for --file without path', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const router = new CliRouter(process.cwd());
    await router.route(['index', '--file']);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('--file requires a path argument'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    spy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with error for --file followed by another flag', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const router = new CliRouter(process.cwd());
    await router.route(['index', '--file', '--check']);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('--file requires a path argument'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    spy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with error for unknown subcommand', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const router = new CliRouter(process.cwd());
    await router.route(['unknown-cmd']);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    spy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe('cli-router update command', () => {
  it('parses update flags and dispatches to UpdateCommand.run', async () => {
    const calls: Array<{ projectRoot: string; options: unknown }> = [];
    const router = new CliRouter(process.cwd());
    const original = await import('../update-command.js');
    // Must be constructible: cli-router calls `new UpdateCommand(...)`. An arrow
    // function has no [[Construct]] slot, so it throws under vitest 5.
    const spy = vi.spyOn(original, 'UpdateCommand' as any).mockImplementation(
      function (this: unknown, projectRoot: string) {
        return {
          run: async (options: unknown) => { calls.push({ projectRoot, options }); },
        };
      } as any,
    );

    await router.route(['update', '--check', '--json', '--pm', 'pnpm', '--print', '--global', '--force']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({
      check: true,
      json: true,
      pm: 'pnpm',
      print: true,
      global: true,
      force: true,
    });
    spy.mockRestore();
  });
});

describe('cli-router index co-change flags', () => {
  let indexRuns: Array<Record<string, unknown>>;
  let indexConstructed: number;
  let errorSpy: MockInstance<typeof console.error>;
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(async () => {
    indexRuns = [];
    indexConstructed = 0;
    // Replace IndexCommand first: if a flag slips through validation, nothing may index the real repo.
    // Must be constructible (see the update test above), hence a function expression.
    const original = await import('../index-command.js');
    vi.spyOn(original, 'IndexCommand' as any).mockImplementation(
      function (this: unknown) {
        indexConstructed += 1;
        return {
          run: async (options: Record<string, unknown>) => { indexRuns.push(options); },
        };
      } as any,
    );
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function route(...args: string[]): Promise<void> {
    await new CliRouter(process.cwd()).route(['index', ...args]);
  }

  it('passes --cochange-commits and --cochange-since to IndexCommand.run', async () => {
    await route('--cochange-commits', '500', '--cochange-since', '12m');

    expect(exitSpy).not.toHaveBeenCalled();
    expect(indexRuns).toHaveLength(1);
    expect(indexRuns[0]).toMatchObject({ cochangeCommits: 500, cochangeSince: '12m' });
  });

  it('accepts all as the value of --cochange-commits', async () => {
    await route('--cochange-commits', 'all');

    expect(exitSpy).not.toHaveBeenCalled();
    expect(indexRuns[0]).toMatchObject({ cochangeCommits: 'all' });
  });

  it.each(['30d', '2w', '12m', '1y', '0d'])('accepts %s as the value of --cochange-since', async (since) => {
    await route('--cochange-since', since);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(indexRuns[0]).toMatchObject({ cochangeSince: since });
  });

  it('leaves both co-change options unset when the flags are absent', async () => {
    await route('--max-history', '5');

    expect(indexRuns).toHaveLength(1);
    expect(indexRuns[0]!['cochangeCommits']).toBeUndefined();
    expect(indexRuns[0]!['cochangeSince']).toBeUndefined();
    expect(indexRuns[0]).toMatchObject({ maxHistory: 5 });
  });

  it('exits with error for --cochange-commits without a value', async () => {
    await route('--cochange-commits');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--cochange-commits requires a positive integer or "all"'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(indexConstructed).toBe(0);
  });

  it.each(['abc', '0', '-5', '1.5', '2e3', '0x10', 'ALL', '', '--skip-history'])(
    'exits with error for --cochange-commits %j',
    async (value) => {
      await route('--cochange-commits', value);

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--cochange-commits requires a positive integer or "all"'));
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(indexConstructed).toBe(0);
    },
  );

  it('exits with error for --cochange-since without a value', async () => {
    await route('--cochange-since');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--cochange-since requires a duration'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(indexConstructed).toBe(0);
  });

  it.each(['abc', '12', '5x', '1.5m', '-3d', '30D', 'm', '', '--skip-history'])(
    'exits with error for --cochange-since %j',
    async (value) => {
      await route('--cochange-since', value);

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--cochange-since requires a duration such as 30d, 2w, 12m or 1y'));
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(indexConstructed).toBe(0);
    },
  );

  it('documents both flags and says --max-history controls intent depth only', async () => {
    await new CliRouter(process.cwd()).route(['--help']);

    const help = errorSpy.mock.calls.map((args) => String(args[0])).join('\n');
    expect(help).toMatch(/--max-history N[^\n]*intent depth only/);
    expect(help).toContain('--cochange-commits <n|all>');
    expect(help).toContain('--cochange-since <duration>');
  });
});

describe('cli-router index --files, --file and --commit', () => {
  let indexRuns: Array<Record<string, unknown>>;
  let indexConstructed: number;
  let errorSpy: MockInstance<typeof console.error>;
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(async () => {
    indexRuns = [];
    indexConstructed = 0;
    // Replace IndexCommand first: if a flag slips through validation, nothing may index the real repo.
    const original = await import('../index-command.js');
    vi.spyOn(original, 'IndexCommand' as any).mockImplementation(
      function (this: unknown) {
        indexConstructed += 1;
        return {
          run: async (options: Record<string, unknown>) => { indexRuns.push(options); },
        };
      } as any,
    );
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function route(...args: string[]): Promise<void> {
    await new CliRouter(process.cwd()).route(['index', ...args]);
  }

  it('passes every value of --files up to the next flag', async () => {
    await route('--files', 'src/a.ts', 'src/b.ts', 'docs/my notes.md', '--max-history', '5');

    expect(exitSpy).not.toHaveBeenCalled();
    expect(indexRuns).toHaveLength(1);
    expect(indexRuns[0]).toMatchObject({ files: ['src/a.ts', 'src/b.ts', 'docs/my notes.md'], maxHistory: 5 });
    expect(indexRuns[0]!['commit']).toBeUndefined();
  });

  it('collects the values of a repeated --files', async () => {
    await route('--files', 'src/a.ts', '--skip-history', '--files', 'src/b.ts');

    expect(indexRuns[0]).toMatchObject({ files: ['src/a.ts', 'src/b.ts'], skipHistory: true });
  });

  it('passes --commit with its one revision', async () => {
    await route('--commit', 'HEAD', '--skip-community');

    expect(exitSpy).not.toHaveBeenCalled();
    expect(indexRuns[0]).toMatchObject({ commit: 'HEAD', skipCommunity: true });
    expect(indexRuns[0]!['files']).toBeUndefined();
  });

  it('keeps --file as an alias of --files with one path', async () => {
    await route('--file', 'src/a.ts');

    expect(exitSpy).not.toHaveBeenCalled();
    expect(indexRuns[0]).toMatchObject({ files: ['src/a.ts'] });
  });

  it('combines --file, --files and --commit', async () => {
    await route('--file', 'src/a.ts', '--files', 'src/b.ts', 'src/c.ts', '--commit', 'abc1234');

    expect(indexRuns[0]).toMatchObject({ files: ['src/a.ts', 'src/b.ts', 'src/c.ts'], commit: 'abc1234' });
  });

  it('leaves files and commit unset when the flags are absent', async () => {
    await route('--max-history', '5');

    expect(indexRuns).toHaveLength(1);
    expect(indexRuns[0]!['files']).toBeUndefined();
    expect(indexRuns[0]!['commit']).toBeUndefined();
  });

  it.each([[['--files']], [['--files', '--check']]])('exits with error for %j without a path', async (args) => {
    await route(...args);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--files requires at least one path'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(indexConstructed).toBe(0);
  });

  it.each([[['--commit']], [['--commit', '--check']]])('exits with error for %j without a revision', async (args) => {
    await route(...args);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--commit requires a revision'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(indexConstructed).toBe(0);
  });

  it('documents --files, --file and --commit in the help', async () => {
    await new CliRouter(process.cwd()).route(['--help']);

    const help = errorSpy.mock.calls.map((args) => String(args[0])).join('\n');
    expect(help).toContain('--files <path...>');
    expect(help).toContain('--file <path>');
    expect(help).toContain('--commit <rev>');
    // --commit is meant for the commit that was just made, which is what the post-commit hook passes.
    expect(help).toMatch(/--commit <rev>[^\n]*commit just made[^\n]*HEAD/);
  });
});
