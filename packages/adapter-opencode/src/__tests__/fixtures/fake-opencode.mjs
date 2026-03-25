import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const scenario = process.env.OPENCODE_FAKE_SCENARIO ?? "success";
const prompt = process.argv.at(-1) ?? "";

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function loadSystemText() {
  const configHome = process.env.XDG_CONFIG_HOME;
  if (!configHome) {
    return "";
  }

  const configPath = path.join(configHome, "opencode", "opencode.json");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return "";
  }

  const pluginPaths = Array.isArray(config.plugin) ? config.plugin.filter((value) => typeof value === "string") : [];
  const system = [];

  for (const pluginPath of pluginPaths) {
    try {
      const mod = await import(pathToFileURL(pluginPath).href);
      const createHooks = mod.default;
      if (typeof createHooks !== "function") {
        continue;
      }
      const hooks = await createHooks({});
      const transform = hooks?.["experimental.chat.system.transform"];
      if (typeof transform === "function") {
        await transform({}, { system });
      }
    } catch {
      // ignore plugin load failures in fake mode
    }
  }

  return system.join("\n");
}

if (scenario === "success") {
  const systemText = await loadSystemText();
  emit({ type: "run_started", sessionId: "oc_session_test", model: "gpt-test" });
  emit({ type: "text", text: `echo:${systemText ? `${systemText}\n` : ""}${prompt}` });
  emit({
    type: "step_finish",
    part: {
      reason: "end_turn",
      tokens: {
        input: 321,
        output: 45,
        total: 366,
        cache: {
          read: 17,
          write: 0,
        },
      },
    },
  });
  emit({ type: "run_completed", reason: "end_turn" });
  process.exit(0);
}

if (scenario === "invalid-json") {
  process.stdout.write("{not-json}\n");
  emit({ type: "message_stop", stop_reason: "invalid_json_followed_by_stop" });
  process.exit(0);
}

if (scenario === "non-zero") {
  process.stderr.write("boom from fake opencode");
  process.exit(2);
}

if (scenario === "stderr-zero") {
  process.stderr.write("error: Unable to connect. Is the computer able to access the url?\n  path: \"http://127.0.0.1:4317/v1/chat/message\",\n errno: 0,\n  code: \"ConnectionRefused\"\n");
  process.exit(0);
}

process.stderr.write(`unknown scenario: ${scenario}`);
process.exit(9);
