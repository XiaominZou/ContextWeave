#!/usr/bin/env node
import path from "node:path";

export function getOpenClawProjectStateDir() {
  return path.resolve(process.env.OPENCLAW_STATE_DIR || process.env.CTX_OPENCLAW_PROJECT_STATE_DIR || ".openclaw-project");
}

export function getOpenClawProjectDaemonStateDir() {
  return path.resolve(
    process.env.CTX_OPENCLAW_DAEMON_STATE_DIR || path.join(getOpenClawProjectStateDir(), "daemon-state"),
  );
}

export function getOpenClawProjectWorkspaceDir() {
  return path.resolve(process.env.CTX_OPENCLAW_WORKSPACE_DIR || process.cwd());
}
