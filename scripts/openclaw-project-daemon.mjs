#!/usr/bin/env node
import { spawn } from "node:child_process";
import { getOpenClawProjectDaemonStateDir, getOpenClawProjectWorkspaceDir } from "./openclaw-project-paths.mjs";

const workspaceDir = getOpenClawProjectWorkspaceDir();
const daemonStateDir = getOpenClawProjectDaemonStateDir();

const child = spawn(
  process.execPath,
  ["--experimental-strip-types", "--loader", "./scripts/ctx-node-loader.mjs", "scripts/openclaw-platform-daemon.mjs"],
  {
    cwd: workspaceDir,
    stdio: "inherit",
    env: {
      ...process.env,
      CTX_OPENCLAW_DAEMON_STATE_DIR: daemonStateDir,
      CTX_OPENCLAW_WORKSPACE_DIR: workspaceDir,
    },
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
