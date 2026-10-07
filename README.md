# Codex OBS overlay

A standalone Bun service that displays local Codex desktop activity in a read-only OBS browser source.
The panel follows the most recently active session in the project selected by its URL,
with a full transcript of the app-visible content available in the saved session.

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
connect to a model, resume sessions, or modify Codex files. It serves display entries and recorded
image/audio attachments; there are no mutation or arbitrary-file endpoints.

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
- **Action**: commands and scripts, stdout/stderr, exit codes, timing,
  file diffs, searches, MCP arguments/results, and completion/failure.
- **Plan / Activity**: saved plans, requests for input, errors, and other recorded UI events.

The small header identifies the selected session. The footer shows its last recorded working,
idle, interrupted, or waiting-for-input state, activity age, and model/reasoning-effort/token metadata
when recorded. This is persisted session state, not proof that an agent process is still running.

The entire available display history is restored on load, with no entry-count, text-length, or
four-line cap. Tool details are expanded. Messages use common Markdown formatting; commands and
outputs preserve whitespace, and diffs highlight additions and deletions. Text uses regular weight
throughout, working-directory rows are hidden, and action headers combine the action name, shell,
completion state, exit code, duration, and timestamp when available. Speaker labels sit beside the
first line of prose; code and list openings keep their label above the content. Compact spacing
keeps more of the transcript visible without shrinking message or code fonts.
Recorded local or inline
PNG/JPEG/GIF/WebP images and MP3/WAV/OGG/M4A audio can be displayed. Remote media and other files
appear as references. HTML and hyperlinks stay inert.

The view **follows the newest activity immediately**, including the end of long outputs. To read
earlier entries, open the browser source's **Interact** window in OBS and scroll up. Auto-follow
pauses while you read; scroll to the bottom or click **Follow live** to resume. These controls only
change the view; they cannot send prompts, approve requests, or operate Codex. Audio does not autoplay.

A newly active session replaces the panel's history and resumes following. Metadata updates and
renames alone do not cause switches. Idle history stays visible, and messages do not fade. After
updating the service, refresh the OBS browser source to load the latest renderer.

Only non-archived, top-level interactive local sessions are eligible. Internal review and subagent
sessions are excluded. An unknown project waits for activity without falling back to other projects.
The root session's recorded collaboration events are visible, but separate subagent transcripts
are not merged in. Injected system/developer context, raw reasoning, and encrypted content remain
excluded. Saved reasoning summaries are shown as recorded; missing summaries are not generated.
The overlay cannot recover content already truncated or omitted from Codex's saved logs, or reproduce
interactive app features such as editors and approval dialogs.

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
| `/api/activity?project=…` | Current full display snapshot |
| `/api/activity/stream?project=…` | Full initial SSE snapshot, followed by incremental updates |
| `/api/media?project=…&session=…&asset=…` | A registered image/audio attachment of the selected session |
| `/healthz` | `200` when the Codex catalog is readable; `503` when unavailable or unsupported |

Snapshots have `session` (`{id,title}` or `null`), `epoch` (reader generation), `status`,
`lastActivity` (ISO timestamp or `null`), `info` (optional model/effort/token metadata), and `entries`.
Each entry contains `id`, `kind`, `text`, `timestamp`, and optional `phase`, `outcome`, `sections`
(`{label,text,format}`), and `attachments` (`{id,kind,label}`). Status is `waiting`, `working`, `idle`,
`interrupted`, `needs-input`, or `unavailable`.

SSE events named `snapshot` carry `reset: true` and the entire history: **replace existing entries**.
Events named `update` carry `reset: false` and only new/changed entries: **upsert by entry ID** while
preserving order. All events include the latest session/status/metadata. Session switches and log
replacement send a reset. Reconnects always receive fresh full history without a cursor.

Large events are delivered in chunks with backpressure. Slow viewers receive the latest pending
state without accumulating an unbounded queue of updates. Heartbeat comments are sent every 15 seconds,
and Bun's request timeout is disabled for the stream. The browser reconnects with exponential backoff,
up to 30 seconds, retaining the last visible activity during outages. Attachments are fetched through
the scoped media endpoint rather than included as binary data in SSE; paths cannot be requested
directly, supported formats are checked, and each media response is limited to 64 MiB.

Missing, relative, or invalid project parameters return `400`; unknown routes return `404`; non-GET
methods return `405`. The service permits up to 16 recently used projects and 32 streams. Excess viewers
or projects return `503`. Unused project readers are released after approximately 30–40 seconds.

## Session compatibility

Discovery reads the highest-version `state_*.sqlite` catalog with SQLite's read-only flag, plus the
optional session-name index. It rescans every two seconds. Each subscribed project's rollout files
are read incrementally every 500 ms, shared by all viewers of that project. Initial recovery streams
the files once and retains the full projected history in memory while the project is in use.
Memory and initial-load time therefore grow with the recorded transcript.

The adapter supports the observed `history_mode=paginated` / `item_completed` records, and legacy
`event_msg` messages with `response_item` tool calls and saved reasoning summaries. In paginated
sessions, raw response-item duplicates are ignored; recorded `item_started` and `item_updated` events
update the same entry. Unknown raw event types are skipped, while other structured UI items can be
shown as activity details. Unterminated lines wait for completion; malformed lines are skipped.
Records over 64 MiB produce a visible omission notice so one giant record cannot block the feed. File replacement
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

Tests cover both formats, filtering, deduplication, full history and long messages, UTF-8 partial writes, file
replacement, outages, project isolation, automatic switching, SSE reconnects and idle connections,
large SSE payloads, multiple viewers, reader cleanup, scoped attachments, and inert Markdown rendering.
They use disposable fixtures and loopback HTTP servers.

## License and styling attribution

GPL-2.0-or-later; see `LICENSE`. Panel colors, border, background, typography, and alignment are adapted
from `mod-chat-widget/receiver/src/web/widget.css` in the user's AzerothCore modules. The original file
is also licensed GPL-2.0-or-later. The Codex reader, projection, transport, and service are standalone.
