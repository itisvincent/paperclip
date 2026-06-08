# reclaude-paperclip-adapter

An **external** Paperclip agent adapter that runs the [`reclaude`](#) CLI — a drop-in
replacement for Claude Code's `claude` — in headless
`--print --output-format stream-json` mode. Installable from the Paperclip board via
**Settings → Adapters → Install External Adapter** (local path or npm), no fork edits
required.

- Adapter type: `reclaude_local`
- Label in the adapter dropdown: derived from the package (shown as `reclaude_local`)
- Self-contained: depends only on Node built-ins (no `@paperclipai/*` packages)

## What it does

Mirrors the built-in `claude_local` adapter, but spawns `reclaude` instead of `claude`:

```
reclaude --print - --output-format stream-json --verbose \
  [--resume <sessionId>] [--dangerously-skip-permissions] [--chrome] \
  [--model <id>] [--effort <low|medium|high>] [--max-turns <n>] \
  [--append-system-prompt-file <path>] [<extraArgs...>]
```

The prompt is piped to **stdin** (the bare `-`); the NDJSON event stream on stdout is
parsed for session id, assistant text, token usage, cost, and errors. Session resume is
cwd-aware, and a "session not found" failure transparently retries with a fresh session.

`reclaude` must be a true drop-in: it must accept these flags and emit the same
`stream-json` event shapes (`system/init`, `assistant`, `user`, terminal `result`) that
Claude Code produces. Auth honors `ANTHROPIC_API_KEY` and `CLAUDE_CONFIG_DIR`.

## Install

### Option A — Local path

The path must be reachable **by the Paperclip server process**. If you run Paperclip in
Docker, the adapter must be inside the container (mounted or copied), and you enter the
**container** path.

`docker/docker-compose.yml` already mounts it into the `server` service (host paths
are relative to the compose file's directory):

```yaml
services:
  server:
    volumes:
      - paperclip-data:/paperclip
      - ../external-adapters/reclaude-adapter:/opt/reclaude-adapter:ro
```

Rebuild/restart the stack, then in the Install dialog choose **Local path** and enter
the **container** path:

```
/opt/reclaude-adapter
```

The install record persists in the `paperclip-data` volume, so it survives restarts as
long as the bind mount stays in place.

### Option B — npm

Publish the package, then choose **npm package** in the dialog and enter the package
name. The server runs `npm install --no-save <name>` into its plugin store. (Keep the
package self-contained — private workspace deps will not resolve.)

## Configure an agent

After install, `reclaude_local` appears in the **Adapter type** dropdown. The config form
is rendered from this adapter's declarative schema:

| Field | adapterConfig key | Notes |
|-------|-------------------|-------|
| CLI binary | `command` | default `reclaude`; must be on PATH |
| Working directory | `cwd` | absolute; created if missing |
| Model | `model` | `--model` |
| Reasoning effort | `effort` | `--effort` |
| Agent instructions file | `instructionsFilePath` | `--append-system-prompt-file` (fresh sessions) |
| Skip permissions | `dangerouslySkipPermissions` | default `true` (required for `--print`) |
| Enable Chrome | `chrome` | `--chrome` |
| Max turns per run | `maxTurnsPerRun` | `--max-turns`; 0 = unlimited |
| Extra args | `extraArgs` | space/comma separated |
| Prompt template | `promptTemplate` | `{{var}}` placeholders |

## Files

- `index.js` — server module (ESM). Exports `createServerAdapter()`.
- `ui-parser.js` — UI transcript parser (CommonJS, sandboxed in a Web Worker).
- `package.json` — declares `exports["."]`, `exports["./ui-parser"]`, and
  `paperclip.adapterUiParser: "1"`.

## Reload during development

After editing, use **Settings → Adapters → Reload** (or `POST /api/adapters/reclaude_local/reload`)
to hot-reload without restarting the server.
