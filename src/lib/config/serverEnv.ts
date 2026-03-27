import "server-only";
import fs from "node:fs";
import path from "node:path";

let loaded = false;

export const loadServerEnv = (): void => {
  if (loaded) {
    return;
  }

  loaded = true;
  const configPath = path.join(process.cwd(), "config.env");

  if (!fs.existsSync(configPath)) {
    return;
  }

  const lines = fs.readFileSync(configPath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key || process.env[key]) {
      continue;
    }

    process.env[key] = value;
  }
};
