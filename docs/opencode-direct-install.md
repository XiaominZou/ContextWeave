# OpenCode Direct Install

This is the shortest path to use the platform from a normal OpenCode session in VSCode.

## What Gets Installed

- a local OpenCode plugin: [ctx-platform-plugin.mjs](/e:/vibecoding/sdk/V1/plugins/opencode/ctx-platform-plugin.mjs)
- a local platform daemon: [opencode-platform-daemon.mjs](/e:/vibecoding/sdk/V1/scripts/opencode-platform-daemon.mjs)
- a config installer: [install-opencode-plugin.mjs](/e:/vibecoding/sdk/V1/scripts/install-opencode-plugin.mjs)

The plugin uses OpenCode's chat hooks to call the local daemon before each model call. The daemon owns canonical platform `session/task/memory/context` state for the attached OpenCode workspace.

## Install

From the repo root run:

```powershell
npm run opencode:install-plugin
```

That adds the plugin path to your OpenCode config file.

## Start The Platform Daemon

In a separate terminal run:

```powershell
npm run opencode:daemon
```

The daemon listens on `http://127.0.0.1:4317` by default.

Optional env vars:

- `CTX_OPENCODE_DAEMON_HOST`
- `CTX_OPENCODE_DAEMON_PORT`
- `CTX_OPENCODE_USER_ID`
- `CTX_OPENCODE_PLATFORM_DAEMON_URL`
- `CTX_OPENCODE_PLATFORM_CONTEXT_MODE`

## Use In OpenCode

1. Restart OpenCode after plugin installation.
2. Open a workspace in VSCode.
3. Start chatting normally in OpenCode.
4. The plugin will:
   - send each user message to the local daemon
   - ask the daemon for platform-owned system context before each model call
   - inject that context into OpenCode's system prompt hooks

## Remember Something Explicitly

You can write a confirmed long-term memory into the daemon with:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4317/v1/memory/remember -ContentType 'application/json' -Body '{"directory":"E:\\vibecoding\\sdk\\V1","title":"Preference","content":"User prefers concise architectural summaries."}'
```

Then ask OpenCode about that preference in the same workspace.

## Inspect Current Platform State

```powershell
Invoke-RestMethod http://127.0.0.1:4317/v1/state
```

## Current Limits

- the daemon is in-memory for now, so restarting it loses state
- the plugin currently focuses on transparent system-context injection plus basic message-to-task syncing
- native OpenCode runtime instability on this machine can still block full real-session validation
