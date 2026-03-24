import path from "node:path";
import { pathToFileURL } from "node:url";

const EXTENSIONS = [".ts", ".js", "/index.ts", "/index.js"];

export async function resolve(specifier, context, defaultResolve) {
  try {
    return await defaultResolve(specifier, context, defaultResolve);
  } catch (error) {
    if (!shouldRetry(specifier, error)) {
      throw error;
    }

    for (const suffix of EXTENSIONS) {
      try {
        const nextSpecifier = appendSuffix(specifier, suffix, context.parentURL);
        return await defaultResolve(nextSpecifier, context, defaultResolve);
      } catch {
        // Try the next suffix.
      }
    }

    throw error;
  }
}

function shouldRetry(specifier, error) {
  if (!error || error.code !== "ERR_MODULE_NOT_FOUND") {
    return false;
  }
  if (specifier.startsWith("node:")) {
    return false;
  }
  return !path.extname(specifier);
}

function appendSuffix(specifier, suffix, parentURL) {
  if (specifier.startsWith("file://")) {
    return `${specifier}${suffix}`;
  }
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    if (specifier.startsWith("/")) {
      return pathToFileURL(`${specifier}${suffix}`).href;
    }
    if (parentURL?.startsWith("file://")) {
      return new URL(`${specifier}${suffix}`, parentURL).href;
    }
    return `${specifier}${suffix}`;
  }
  return `${specifier}${suffix}`;
}
