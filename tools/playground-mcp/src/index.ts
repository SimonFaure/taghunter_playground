// Tag Hunter Playground - Claude Desktop extension (stdio MCP server).
//
// Drives the Playground's game-simulator campaigns through the app's local
// control API (tester builds only): src-tauri/src/sim_control_server.rs listens
// on 127.0.0.1 and writes its port + token to
// %APPDATA%\com.taghunter.playground\simulations\control.json.
// This server is a thin pass-through: every tool is one control command.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const APP_ID = 'com.taghunter.playground';

function controlFile(): string {
  if (process.env.PLAYGROUND_CONTROL_FILE) return process.env.PLAYGROUND_CONTROL_FILE;
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return join(appData, APP_ID, 'simulations', 'control.json');
}

class AppUnavailable extends Error {}

async function call(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  let info: { port: number; token: string };
  try {
    info = JSON.parse(await readFile(controlFile(), 'utf8'));
  } catch {
    throw new AppUnavailable(
      'The Playground control API was not found. Open the Tag Hunter Playground TESTER build on this PC and log in, then try again.',
    );
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${info.port}/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
      body: JSON.stringify({ cmd, args }),
      signal: AbortSignal.timeout(100_000),
    });
  } catch {
    throw new AppUnavailable(
      'The Playground is not answering. Is the tester build running on this PC? (It may have been closed since it last started.)',
    );
  }
  if (res.status === 401) {
    throw new AppUnavailable('The Playground refused the token in control.json: restart the tester build so it writes a fresh one.');
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: unknown; error?: string } | null;
  if (!body) throw new Error(`The Playground answered HTTP ${res.status} without a body.`);
  if (!body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.data;
}

/** Tool result: the command's JSON, or the error as text the model can act on. */
async function run(cmd: string, args: Record<string, unknown> = {}) {
  try {
    const data = await call(cmd, args);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
    };
  }
}

const GAME_TYPES = ['mystery', 'tracks', 'tagquest', 'clash'] as const;

const itemSchema = z.object({
  gameType: z.enum(GAME_TYPES),
  combo: z
    .record(z.string())
    .describe('Axis id -> value, from the `axes` listed by `coverage`. Missing axes take their first value.'),
  scenarioUniqid: z.string().optional().describe('Scenario to play this item on (default: first downloaded one that fits).'),
  seed: z.number().int().optional(),
});


const specShape = {
  source: z
    .enum(['gaps', 'all', 'preset', 'custom', 'retry'])
    .describe(
      'gaps = shortest list reaching full pairwise coverage on this app version; all = every valid config without a Pass on this version (can be hundreds); preset = a saved list; custom = `items`; retry = replay recorded Studio runs exactly (same options, scenario, seed, team count) as RETRIES: each verdict is saved as a child of the original run.',
    ),
  retryRunIds: z
    .array(z.number().int().positive())
    .optional()
    .describe('source=retry: the Studio run ids to retry (from retry_candidates). Default: every failed / partial run not resolved (filtered by gameTypes).'),
  gameTypes: z.array(z.enum(GAME_TYPES)).optional().describe('gaps / all: limit to these game types (default: all four).'),
  scenarioUniqid: z.string().optional().describe('Prefer this scenario for every item of its game type.'),
  preset: z.string().optional().describe('source=preset: the preset name.'),
  items: z.array(itemSchema).optional().describe('source=custom: the configurations to play, in order.'),
  includeTested: z.boolean().optional().describe('source=all: also replay configs that already passed.'),
  limit: z.number().int().positive().optional().describe('Keep only the first N runs.'),
  speed: z.number().int().min(1).max(20).optional().describe('Simulation speed, 1-20 (default 20).'),
  teams: z.number().int().min(1).max(50).optional().describe('Mock teams for auto/self-register games (default 6).'),
  clashPurgeAt: z
    .number()
    .int()
    .min(1)
    .max(600)
    .optional()
    .describe(
      'Clash runs with the Purge: minutes after Start at which one player is sure to attempt the Purge (default: random between 25 % and 60 % of the game). Must be before the end of the game.',
    ),
  gameDuration: z
    .number()
    .int()
    .min(1)
    .max(600)
    .optional()
    .describe(
      "The GAME's time limit in minutes for every run, every game type (default: each scenario's own default). The simulated session spans it, so real time is about gameDuration / speed per run.",
    ),
  name: z.string().optional().describe('Campaign name shown in the app.'),
};

const INSTRUCTIONS = `Tag Hunter Playground game simulator (tester builds only). The Playground app runs on this PC; a tester watches its screens while simulated teams play real games.

When the user says "Launch the Playground simulations" (or similar), follow the launch_playground_simulations prompt:
1. playground_info, then coverage. Summarise briefly: per game type, untested pairwise gaps, configs never passed, failed configs; devices online (combos with devices=several need 2 devices that can play; with one PC they are skipped). A device can play when it is online, not operator-only and not inGame (still in an active game: end that game in the Playground first). A reader is NEVER needed: simulated reads don't go through one, so the reader flag is only informative.
2. Unless the user already said which series, ask: coverage gaps (recommended), a saved preset, specific configs, or every config. If the tester gives a game duration ("10-minute games"), pass it as gameDuration - it is the game's time limit, not the simulation's length (that one is set by speed). For Clash, one player always attempts the Purge: if the tester wants it at a given moment ("purge at minute 4"), pass clashPurgeAt.
   Runs meant for several devices need the other devices to be tester builds with the Playground open: if a run reports that devices never started their share, say so plainly. For "every config", call estimate_campaign first and state the run count and rough duration; suggest speed 20 and say the campaign can be paused and resumed (it survives an app restart).
3. start_campaign, tell the tester what is about to play on screen, then loop on wait_next_result (pass back the returned seq as \`since\`).
4. Each time a run ends (it appears in awaitingVerdict), call run_result and PROPOSE a verdict with a one-line reason:
   - pass: all planned reads played, no anomalies;
   - partial: it played to the end but something looks off (some anomalies, refused reads, teams that never started, everyone at 0);
   - fail: simulator error, stalled run, the game could not be launched, mock teams missing from the game, or a bip the game never applied (a lost start or finish, a name on the wrong team).
   When something needs explaining (a team at 0, a lopsided score, a team not finished), call run_result with full=true and read the whole journal and the score timeline before proposing a cause; never guess from the 30 last lines.
   Ask the tester to confirm or correct it, and whether they saw anything wrong ON SCREEN (the anomalies are only what the code can detect). Only call record_verdict after they confirm; put what they saw in the note and start the note with "Proposed by Claude, confirmed by <tester>". Several runs may be confirmed in one answer. Never record a verdict nobody confirmed.
5. When the campaign ends: recap pass/partial/fail/skipped counts with skip reasons, configs still not covered, runs still waiting for a verdict.

RETRIES. When the tester asks to retry runs (or to check a fix): call retry_candidates, show the list briefly (id, game type, verdict, what went wrong, existing retries), confirm which ones, then start_campaign with source=retry and retryRunIds. Each retry replays the original run exactly (same options, scenario, seed, mock teams) and the verdict you record for it is saved in Studio as a RETRY (child) of the original run - no linking needed. Judge a retry like any run; in the note say what changed compared with the original run (e.g. "the start bip is now applied"). If a retry passes, tell the tester the original run can be marked Resolved in Studio (Dev → Simulation runs); you can't change triage yourself.

Write to the tester in their language (French if they write French). Keep messages short: they are watching the game screens. Skipped runs are not failures. The app never needs to be clicked while a campaign runs, but they can use Pause after this run / Skip run / Stop on the game page's SIM window.`;

const server = new McpServer({ name: 'taghunter-playground', version: '1.4.1' }, { instructions: INSTRUCTIONS });

server.registerTool(
  'playground_info',
  {
    title: 'Playground status',
    description: 'App version, devices of the Playground network (online, operator-only, inGame = already in an active game, reader = informative only, never required), tester name and the current campaign.',
    annotations: { readOnlyHint: true },
  },
  () => run('info'),
);

server.registerTool(
  'list_scenarios',
  {
    title: 'Downloaded scenarios',
    description: 'Downloaded scenarios the simulator can play, with game type, number of Tracks routes and whether a Clash Purge image exists.',
    annotations: { readOnlyHint: true },
  },
  () => run('list_scenarios'),
);

server.registerTool(
  'coverage',
  {
    title: 'Simulation coverage',
    description:
      'Per game type: the axes (launch options) and their values, how many configs exist and passed on this app version, pairwise coverage, the gap list (shortest set of configs to reach full pairwise coverage) and failed configs.',
    inputSchema: { gameTypes: z.array(z.enum(GAME_TYPES)).optional() },
    annotations: { readOnlyHint: true },
  },
  (args) => run('coverage', args),
);

server.registerTool(
  'estimate_campaign',
  {
    title: 'Estimate a campaign',
    description: 'How many runs a campaign would play, per game type, and a rough real-time duration. Starts nothing.',
    inputSchema: specShape,
    annotations: { readOnlyHint: true },
  },
  (args) => run('estimate', args),
);

server.registerTool(
  'start_campaign',
  {
    title: 'Start a simulation campaign',
    description:
      'Start a series of simulated sessions on this PC. Each run is launched through the real Launch wizard, played by mock teams on the visible game page, then ended. Fails if a campaign is already running.',
    inputSchema: specShape,
  },
  (args) => run('start_campaign', args),
);

server.registerTool(
  'retry_candidates',
  {
    title: 'Runs to retry',
    description:
      'Recorded Studio runs worth retrying: verdict fail or partial and not marked resolved, newest first. Each has its id, game type, verdict, triage status, version, scenario, config, seed, the tester note, whether it can be retried (scenario known) and its existing retries (ids + latest verdict). Retry them with start_campaign source=retry + retryRunIds.',
    inputSchema: {
      gameTypes: z.array(z.enum(GAME_TYPES)).optional(),
      limit: z.number().int().min(1).max(200).optional().describe('Default 30.'),
    },
    annotations: { readOnlyHint: true },
  },
  (args) => run('retry_candidates', args),
);

server.registerTool(
  'campaign_status',
  {
    title: 'Campaign status',
    description: 'The current campaign: state, counts, the run playing now (with live reads), every run, and the runs waiting for a verdict.',
    annotations: { readOnlyHint: true },
  },
  () => run('campaign_status'),
);

server.registerTool(
  'wait_next_result',
  {
    title: 'Wait for the next run to end',
    description:
      'Blocks until a run ends or the campaign does (or timeoutSec passes), then returns the campaign status. Pass the `seq` from the previous answer as `since`.',
    inputSchema: {
      since: z.number().int().optional(),
      timeoutSec: z.number().int().min(1).max(60).optional().describe('Default 55.'),
    },
    annotations: { readOnlyHint: true },
  },
  (args) => run('wait_next_result', args),
);

server.registerTool(
  'run_result',
  {
    title: 'One run in detail',
    description:
      'A run of the current campaign: its config, scenario, reads played/planned, refused reads, anomalies the code detected (including bips the game never applied: lost starts/finishes, a name on the wrong team), warnings, final standings and the last 30 journal lines. With full=true: the whole journal of every device and the score timeline (standings each time they changed, at least once per simulated minute; Clash adds territory owners, clan sizes/weights and the Purge state).',
    inputSchema: {
      index: z.number().int().min(0).describe('The run index (0-based, as listed in the campaign).'),
      full: z.boolean().optional().describe('Include the whole journal and the score timeline (large).'),
    },
    annotations: { readOnlyHint: true },
  },
  (args) => run('run_result', args),
);

server.registerTool(
  'record_verdict',
  {
    title: 'Record a verdict',
    description:
      'Save the verdict of a finished run to Studio (simulation coverage). Only after the tester confirmed it. The tester name is remembered for later runs.',
    inputSchema: {
      index: z.number().int().min(0),
      verdict: z.enum(['pass', 'partial', 'fail']),
      note: z.string().optional().describe('Start with "Proposed by Claude, confirmed by <tester>", then what was seen.'),
      tester: z.string().optional().describe('Tester name (defaults to the one remembered by the app).'),
    },
  },
  (args) => run('record_verdict', args),
);

server.registerTool(
  'control_campaign',
  {
    title: 'Pause, resume, skip or stop',
    description:
      'pause = finish the current run, then wait; resume = go on (also continues a campaign reloaded after an app restart); skip = end the current run now and go to the next; stop = end the current run and the campaign.',
    inputSchema: { action: z.enum(['pause', 'resume', 'skip', 'stop']) },
  },
  ({ action }) => run(action),
);

server.registerTool(
  'list_presets',
  {
    title: 'Saved presets',
    description: 'Named lists of configurations saved on this PC (source=preset).',
    annotations: { readOnlyHint: true },
  },
  () => run('list_presets'),
);

server.registerTool(
  'save_preset',
  {
    title: 'Save a preset',
    description: 'Save a named list of configurations to replay later with source=preset (replaces a preset of the same name).',
    inputSchema: { name: z.string().min(1), items: z.array(itemSchema).min(1) },
  },
  (args) => run('save_preset', args),
);

server.registerPrompt(
  'launch_playground_simulations',
  {
    title: 'Launch the Playground simulations',
    description: 'Check what is untested, run a simulation campaign on this PC and judge each run with the tester.',
  },
  () => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: 'Launch the Playground simulations. Start with playground_info and coverage, summarise what is untested, ask me which series to run unless it is obvious, then run it and propose a verdict for each finished run for me to confirm.',
        },
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
