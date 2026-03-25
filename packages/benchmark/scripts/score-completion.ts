import { scoreCompletionForFixture } from "../src/index.ts";

const entryArg = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
if (import.meta.url.endsWith(entryArg)) {
  const result = await scoreCompletionForFixture();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
