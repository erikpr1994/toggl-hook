# toggl-hook

Automatic [Toggl Track](https://toggl.com/track) timers for **Claude Code** and **Gemini CLI** sessions.

Open an AI coding session inside a repo you've mapped to a Toggl project and the timer starts on your first prompt. Go quiet for 15 minutes and it stops itself, retroactively, at your last activity, so idle time is never billed. Close the session and it stops immediately. Single file, zero dependencies, works on macOS (launchd watchdog) and Linux (cron).

```
you: "refactor the auth middleware"          →  ▶ Startup · Claude Code · api   00:00
   ...prompts, tool calls, responses...       →  ▶ still running
   ...you go make coffee, 20 min...           →  ■ stopped at your last activity
```

## Install

Requires Node ≥ 18 (uses the built-in `fetch`).

```bash
git clone https://github.com/erikpr1994/toggl-hook.git ~/.timetrack-src
cd ~/.timetrack-src
node toggl-hook.js setup      # API token → workspace → map Toggl projects to repo folders
node toggl-hook.js install    # writes hooks into ~/.claude/settings.json and ~/.gemini/settings.json
                              # + a launchd job (macOS) that runs the idle check every 5 min
```

`install` copies the script to `~/.timetrack/toggl-hook.js`, so you can delete the clone afterwards.
Your API token is at the bottom of <https://track.toggl.com/profile>. Create your Toggl projects (e.g. "Startup", "Peak Health") **before** running `setup`, it lists them and asks which folders belong to each.

On Linux, `install` prints the cron line to add for the idle watchdog.

## Day to day

| Command | What it does |
| --- | --- |
| `node ~/.timetrack/toggl-hook.js status` | Running and parallel timers, live sessions, mapped folders, last error |
| `node ~/.timetrack/toggl-hook.js map "Startup" ~/code/new-repo` | Map another folder to a Toggl project |
| `node ~/.timetrack/toggl-hook.js stop` | Force-stop every AI timer now |
| `node ~/.timetrack/toggl-hook.js uninstall` | Remove hooks and watchdog (keeps config) |

Tip: `alias tt='node ~/.timetrack/toggl-hook.js'`.

## Behaviour

- **Attribution by folder.** A session's `cwd` is matched against the paths you mapped (subfolders included, longest match wins). Sessions in unmapped folders are ignored; `status` shows the last one so you can map it.
- **Idle gap.** Activity = prompts, tool calls, responses. If nothing happens for `idleMinutes` (default 15), the watchdog stops the entry **at the last activity**, not at the moment it notices. Entries shorter than a minute are deleted.
- **Parallel sessions.** Two sessions (Claude + Gemini, or two terminals) in the same project share one entry.
- **Parallel projects.** Sessions in different projects are tracked at the same time, each with its own entry. Toggl allows only one *running* timer, so the first project holds the live timer and every other active project is tracked locally and written to Toggl as a completed, overlapping entry: created once it passes a minute, extended every `verifyMinutes` while active, and finalised when it goes idle or its sessions end. Toggl marks such entries with an "overlap" label in the web app; that is cosmetic.
- **Your manual timers are sacred.** If a timer without the `ai-session` tag is running (a meeting you started in the Toggl app), it is never stopped or edited. AI sessions are tracked in parallel to it, like a second project.
- **Cheap.** Hooks only call the Toggl API when an entry has to start, stop or be extended; every other activity is a local file write. Claude Code hooks are registered `async` so they never block your session. Failures (offline, Toggl down) are logged to `~/.timetrack/hook.log` and never break the session.

## Config

`~/.timetrack/config.json`:

```json
{
  "apiToken": "…",
  "workspaceId": 1234567,
  "idleMinutes": 15,
  "verifyMinutes": 10,
  "tag": "ai-session",
  "billable": true,
  "projects": {
    "Startup":     { "id": 111, "paths": ["~/code/startup", "~/code/startup-infra"] },
    "Peak Health": { "id": 222, "paths": ["~/code/peakhealth"] }
  }
}
```

`billable` sets the flag on every entry Toggl creates; `tag` is how the script recognises its own entries. `verifyMinutes` is how often the live timer is re-checked against Toggl in case you stopped it by hand, and how often parallel entries are extended in Toggl.

## How it hooks in

Claude Code: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd` → `toggl-hook.js hook claude`
Gemini CLI: `SessionStart`, `BeforeAgent`, `AfterTool`, `AfterAgent`, `SessionEnd` → `toggl-hook.js hook gemini`

Both read the hook JSON from stdin (`session_id`, `cwd`, `hook_event_name`). State lives in `~/.timetrack/state.json`, one entry per active project.

## Test

```bash
node test/run.js   # spins up a fake Toggl API and walks through start / parallel projects / idle / manual-timer / race scenarios
```

## License

MIT
