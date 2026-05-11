const baseUrl = process.env.APP_BASE_URL?.replace(/\/+$/, "");
const token = process.env.AGENT_WORKER_TOKEN?.trim();
const pollMs = Number(process.env.AGENT_WORKER_POLL_MS ?? 3000);
const concurrency = Math.max(1, Math.floor(Number(process.env.AGENT_WORKER_CONCURRENCY ?? 1)));
const workerId = process.env.AGENT_WORKER_ID?.trim() || `worker-${process.pid}`;

let shuttingDown = false;
let activeJobs = 0;

if (!baseUrl) {
  console.error("APP_BASE_URL is required.");
  process.exit(1);
}

if (!token) {
  console.error("AGENT_WORKER_TOKEN is required.");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (ms) => Math.max(250, Math.round(ms * (0.75 + Math.random() * 0.5)));

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

const processOne = async (run) => {
  activeJobs += 1;
  try {
    console.log(JSON.stringify({ event: "agent_worker.processing", workerId, runId: run.id, taskId: run.taskId }));
    await postJson(`/api/agent-runs/${run.id}/process`, { workerId });
  } finally {
    activeJobs -= 1;
  }
};

const handleShutdown = () => {
  shuttingDown = true;
  console.log(JSON.stringify({ event: "agent_worker.shutdown_requested", workerId, activeJobs }));
};

process.on("SIGINT", handleShutdown);
process.on("SIGTERM", handleShutdown);

console.log(JSON.stringify({ event: "agent_worker.started", workerId, baseUrl, concurrency }));

while (!shuttingDown || activeJobs > 0) {
  try {
    if (shuttingDown || activeJobs >= concurrency) {
      await sleep(jitter(Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 3000));
      continue;
    }

    const claimed = await postJson("/api/agent-runs/claim", { workerId });
    const run = claimed?.run;
    if (!run?.id) {
      await sleep(jitter(Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 3000));
      continue;
    }

    void processOne(run).catch((error) => {
      console.error(
        JSON.stringify({
          event: "agent_worker.job_failed",
          workerId,
          runId: run.id,
          message: error instanceof Error ? error.message : String(error),
        })
      );
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "agent_worker.poll_error",
        workerId,
        message: error instanceof Error ? error.message : String(error),
      })
    );
    await sleep(jitter(Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 3000));
  }
}

console.log(JSON.stringify({ event: "agent_worker.stopped", workerId }));
