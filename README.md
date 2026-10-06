# Codex OBS overlay

A standalone Bun service that displays local Codex desktop activity in a read-only OBS browser source.
The panel follows the most recently active session in the project selected by its URL.

## Run

Requires **Bun 1.4.2 or newer**. No package installation or build is needed to run the service:

```sh
bun run --silent start
```

If Bun is not on your PATH, use `~/.bun/bin/bun run --silent start`.
The listener is `http://127.0.0.1:3004`. Startup and error diagnostics go to stderr.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Local Codex data directory, read only |
| `CODEX_OBS_PORT` | `3004` | Port, an integer from 1 to 65535 |

The service always binds to IPv4 loopback. It does not require an API key, start an agent,
connect to a model, resume sessions, or modify Codex files. It serves only projected display entries;
there are no mutation or raw-file endpoints.

## OBS setup

Add a **Browser** source named **Agent**, using a URL pointing to your gameplay project:

```text
http://127.0.0.1:3004/widget?project=%2Fpath%2Fto%2Fagent-wow-project
```

Set **Width 800**, **Height 300**. On the existing 1920×1080 scene, place it at **X 1120, Y 780**.
Use scale 1:1, no crop, and no custom CSS. The page itself is transparent outside the panel.
You can enable “Shutdown source when not visible”; reopening restores the latest history.

Change `project` in the URL to the URL-encoded absolute directory of another Codex project.
Directory matching is exact after normalizing `.`/`..` and trailing slashes; it does not follow
subdirectories or resolve symlink aliases. Use the working directory recorded by Codex.
Separate browser sources may follow different projects simultaneously.

The panel shows:

- **You**: user prompts.
- **Agent**: commentary and final messages.
- **Thinking**: saved reasoning summaries, when present.
- **Action**: concise command, file-change, web, and MCP activity, including completion/failure.

The small header identifies the selected session. The footer shows its last recorded working,
idle, or interrupted state and the age of the last activity. This is persisted session state,
not proof that an agent process is still running.

The latest 100 display entries are restored on load. A newly active session replaces the panel's
history; metadata updates and renames alone do not cause switches. Idle history stays visible.
Entries are bounded to 640 characters (220 for actions), and the panel displays at most four lines
per entry so long replies cannot overwhelm it. Messages do not fade.

Only non-archived, top-level interactive local sessions are eligible. Internal review and subagent
sessions are excluded. An unknown project waits for activity without falling back to other projects.
Prompts and messages are rendered as literal text; HTML and links are inert. Images, injected
system/developer context, full scripts, tool arguments/output, raw reasoning, and encrypted content
are not sent to the browser. Saved summaries are shown as recorded; missing summaries are not generated.

## Automatic startup

From this directory:

```sh
bash install-service.sh --dry-run
bash install-service.sh
```

The installer verifies, installs, enables, and starts a **user** systemd service. It records the
absolute project directory and Bun executable; it does not depend on the login shell's PATH.
It refuses to replace unrelated units. Run it again after moving the project or Bun executable.
The service starts when you log in and restarts after failures.

Optional settings go in `~/.config/codex-obs-overlay.env`, for example:

```ini
CODEX_OBS_PORT=3004
CODEX_HOME=/path/to/codex-home
```

```sh
bash restart-service.sh
systemctl --user status codex-obs-overlay
journalctl --user -u codex-obs-overlay -e
```

The restart script restarts the installed user service and prints its status.

To remove the managed service while preserving the project and configuration:

```sh
bash uninstall-service.sh
```

The uninstall script uses the installer's existing removal logic and ownership checks.
`bash install-service.sh --uninstall` remains available as an equivalent command.

`systemd/codex-obs-overlay.service` also provides a reference unit for the default installation paths.

## HTTP API

All routes use `GET`, are read-only, and return `Cache-Control: no-store`.

| Route | Result |
| --- | --- |
| `/widget?project=…` | OBS HTML panel |
| `/api/activity?project=…` | Current display snapshot |
| `/api/activity/stream?project=…` | SSE snapshot initially and whenever display data changes |
| `/healthz` | `200` when the Codex catalog is readable; `503` when unavailable or unsupported |

Snapshots have `session` (`{id,title}` or `null`), `status`, `lastActivity` (ISO timestamp or `null`),
and `entries`. Each entry contains `id`, `kind`, `text`, `timestamp`, and optional action `outcome`.
Status is `waiting`, `working`, `idle`, `interrupted`, or `unavailable`.

SSE events are named `snapshot`. **Replace the displayed snapshot on every event**; do not append it.
Reconnects receive fresh bounded history without a cursor. Heartbeat comments are sent every 15 seconds,
and Bun's request timeout is disabled for the stream. The browser reconnects with exponential backoff,
up to 30 seconds, retaining the last visible activity during outages.

Missing, relative, or invalid project parameters return `400`; unknown routes return `404`; non-GET
methods return `405`. The service permits up to 16 recently used projects and 32 streams. Excess viewers
or projects return `503`. Unused project readers are released after approximately 30–40 seconds.

## Session compatibility

Discovery reads the highest-version `state_*.sqlite` catalog with SQLite's read-only flag, plus the
optional session-name index. It rescans every two seconds. Each subscribed project's rollout files
are read incrementally every 500 ms, shared by all viewers of that project. Initial recovery streams
the files once and retains only bounded display history.

The adapter supports the observed `history_mode=paginated` / `item_completed` records, and legacy
`event_msg` messages with `response_item` tool calls and saved reasoning summaries. In paginated
sessions, raw response-item duplicates are ignored. Unknown event types are skipped. Unterminated
lines wait for completion; malformed or oversized lines (over 8 MiB) are skipped. File replacement
and truncation reset the affected reader. Temporary catalog/file failures preserve visible history
and mark it unavailable.

This is a passive adapter to Codex's local storage, which is not a versioned public integration
contract. A future storage change may require updating the adapter. Updates appear after Codex
persists events; this is not token-by-token streaming, and many actions appear on completion.

## Development and synthetic preview

```sh
bun install --frozen-lockfile
bun run check
bun test --timeout 15000
bun run demo
```

The demo serves `http://127.0.0.1:3005/widget?project=%2Fdemo%2Fagent-wow` using
`examples/session.jsonl`. It creates a separate temporary catalog, cycles through synthetic gameplay
activity, and removes its data on normal shutdown. It never reads or changes actual Codex sessions.

Tests cover both formats, filtering, deduplication, bounded history, UTF-8 partial writes, file
replacement, outages, project isolation, automatic switching, SSE reconnects and idle connections,
multiple viewers, and reader cleanup. They use disposable fixtures and loopback HTTP servers.

## License and styling attribution

GPL-2.0-or-later; see `LICENSE`. Panel colors, border, background, typography, and alignment are adapted
from `mod-chat-widget/receiver/src/web/widget.css` in the user's AzerothCore modules. The original file
is also licensed GPL-2.0-or-later. The Codex reader, projection, transport, and service are standalone.
