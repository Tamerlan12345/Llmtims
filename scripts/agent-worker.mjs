const baseUrl = process.env.APP_BASE_URL?.replace(/\/+$/, "");
const token = process.env.AGENT_WORKER_TOKEN?.trim();
const pollMs = Number(process.env.AGENT_WORKER_POLL_MS ?? 3000);
const workerId = process.env.AGENT_WORKER_ID?.trim() || `worker-${process.pid}`;

if (!baseUrl) {
  console.error("APP_BASE_URL is required.");
  process.exit(1);
}

if (!token) {
  console.error("AGENT_WORKER_TOKEN is required.");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const postJson = async (path, body = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
};

console.log(`[agent-worker] started ${workerId}; polling ${baseUrl}`);

while (true) {
  try {
    const claimed = await postJson("/api/agent-runs/claim", { workerId });
    const run = claimed?.run;
    if (!run?.id) {
      await sleep(Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 3000);
      continue;
    }

    console.log(`[agent-worker] processing run ${run.id} task ${run.taskId}`);
    await postJson(`/api/agent-runs/${run.id}/process`, { workerId });
  } catch (error) {
    console.error("[agent-worker]", error instanceof Error ? error.message : error);
    await sleep(Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 3000);
  }
}
