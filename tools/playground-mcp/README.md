# Tag Hunter Playground — Claude Desktop extension

Lets a tester type **"Launch the Playground simulations"** in Claude Desktop. Claude then:

1. checks which launch configurations still need a test on this app version;
2. starts a **campaign**: each configuration is launched through the real Launch wizard, played by mock teams on the visible game page, then ended;
3. proposes a Pass / Partial / Fail verdict per run, which the tester confirms before it is saved to Studio.

Only works with the Playground **tester build** (`npm run tauri:build:test`), running on the same PC as Claude Desktop.

## Install (tester PC)

1. Build the extension: `npm install` then `npm run pack`. This writes `taghunter-playground.mcpb`.
2. Double-click `taghunter-playground.mcpb`, or drag it onto Claude Desktop → Settings → Extensions, then Install.
3. Start the Playground tester build and log in. It writes its port and token to
   `%APPDATA%\com.taghunter.playground\simulations\control.json`. The token changes at every start.
4. In Claude Desktop, type: *Launch the Playground simulations*. The prompt is also listed in the "+" menu.

Dev alternative to the `.mcpb`: add this to `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{ "mcpServers": { "taghunter-playground": { "command": "node", "args": ["C:\laragon\www\taghunter_playground\tools\playground-mcp\dist\index.js"] } } }
```

## How it connects

```
Claude Desktop ─stdio─► dist/index.js ─HTTP 127.0.0.1 + token─► src-tauri/src/sim_control_server.rs
                                                    └─ event sim://control ─► src/simulator/controlApi.ts ─► campaign.ts
```

- The listener exists only with the `devtools` cargo feature (tester builds), and binds 127.0.0.1 only.
- The campaign keeps going without Claude. The game page's SIM window offers "Pause after this run", "Skip run" and "Stop".
- The in-app simulator panel (Launched games → Simulate…) has a Campaign tab that starts the same campaigns and records verdicts.
- Campaign state is saved to `simulations/campaign-current.json`. After an app restart the campaign comes back paused; resume it from Claude or from the panel.
- Presets are saved to `simulations/presets.json`.
