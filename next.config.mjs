import fs from "node:fs";
import path from "node:path";

const configEnvPath = path.join(process.cwd(), "config.env");

if (fs.existsSync(configEnvPath)) {
  const lines = fs.readFileSync(configEnvPath, "utf8").split(/\r?\n/);

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
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { dev }) => {
    if (dev) {
      // Avoid ENOSPC on constrained disks by keeping webpack cache in memory in dev mode.
      config.cache = { type: "memory" };
    }

    return config;
  },
};

export default nextConfig;
