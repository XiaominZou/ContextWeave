#!/usr/bin/env node
import { spawn } from "node:child_process";
import { getOpenClawProjectStateDir, getOpenClawProjectWorkspaceDir } from "./openclaw-project-paths.mjs";

const stateDir = getOpenClawProjectStateDir();
const workspaceDir = getOpenClawProjectWorkspaceDir();
const args = process.argv.slice(2);
const env = {
  ...process.env,
  OPENCLAW_STATE_DIR: stateDir,
  CTX_OPENCLAW_WORKSPACE_DIR: workspaceDir,
};
const child = process.platform === "win32"
  ? spawn(
    process.env.ComSpec || "cmd.exe",
    ["/d", "/s", "/c", buildWindowsCommand(["openclaw.cmd", "agent", ...args])],
    {
      cwd: workspaceDir,
      stdio: "inherit",
      env,
    },
  )
  : spawn("openclaw", ["agent", ...args], {
    cwd: workspaceDir,
    stdio: "inherit",
    env,
  });

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

function buildWindowsCommand(parts) {
  return parts.map((part) => quoteWindowsArg(part)).join(" ");
}

function quoteWindowsArg(value) {
  if (!value) {
    return "\"\"";
  }
  if (!/[\s"]/u.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, "\\\"")}"`;
}
