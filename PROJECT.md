# PROJECT KNOWLEDGE BASE

## Architecture
### Stack
Next.js 14 App Router, TypeScript, Supabase/Postgres/RLS/Realtime, LangGraph, LangChain Google GenAI, Tailwind CSS, Framer Motion.

### Layer Map
API layer: `src/app/api/**` handles admin/worker routes and request auth.
Agent orchestration: `src/lib/agents/**` owns durable runs, LangGraph workflow, nodes, tools, checkpoints, realtime events.
Persistence: Supabase tables `tasks`, `agent_runs`, `agent_run_steps`, `system_logs`, `langgraph_checkpoints`, `workflow_checkpoints`.
Worker runtime: `scripts/agent-worker.mjs` polls `/api/agent-runs/claim` and processes `/api/agent-runs/:id/process`.
UI: `src/app/dashboard/**` and `src/components/dashboard/**` render chat, tasks, trace, approvals.

### Key Decisions
| Decision | Rationale | Date |
|---|---|---|
| Created `PROJECT.md` knowledge base | Required by repository agent workflow before code changes | 2026-05-12 |
| Durable auto runs bypass task pre-approval; `approval_required` remains gated | Prevents auto worker runs from retrying `409 approval_required` until failure | 2026-05-12 |
| LangGraph checkpoint key is `taskId`, not chat `threadId` | Database migration requires `thread_id = task_id`; prevents cross-task state reuse inside one chat thread | 2026-05-12 |
| Worker loads `config.env` directly | `npm run worker` is outside Next.js and otherwise cannot see local runtime env | 2026-05-12 |
| Target autonomy should be task/run-centric | Existing schema already has durable runs, steps, approvals, validations, tools, artifacts, and realtime events; dashboard should organize around this lifecycle instead of chat-only flow | 2026-05-12 |
| Dashboard task status changes go through backend command API | Prevents UI from bypassing auth/lifecycle checks and gives one place to add supervised autopilot invariants | 2026-05-12 |
| Task creation plus run queueing goes through `queueTaskRun` use-case | Keeps chat/API/manual task sources on the same supervised lifecycle boundary | 2026-05-12 |
| Worker health is derived from durable runs before adding a worker registry | `agent_runs` already stores `locked_by`, `heartbeat_at`, retryable and dead-letter state; this gives observability without a migration | 2026-05-12 |
| Dashboard control panels use a compact operations cockpit style | Agent supervision needs dense readable status, not decorative UI; labels should be readable Russian with stable badges and counters | 2026-05-12 |

## Module Registry
| Module | Path | Responsibility | Dependencies |
|---|---|---|---|
| Agent worker | `scripts/agent-worker.mjs` | Poll and process durable agent runs | Next API, `APP_BASE_URL`, `AGENT_WORKER_TOKEN` |
| Agent run service | `src/lib/agents/runService.ts` | Create, claim, process, approve, cancel durable runs | Supabase, workflow runner, realtime |
| Worker health service | `src/lib/agents/workerHealth.ts` | Derive idle/running/stale, heartbeat, current run, retry and dead-letter status from durable runs | Supabase `agent_runs` |
| Task run command | `src/lib/agents/taskRunCommand.ts` | Create/update actionable task, bind thread, queue durable run, patch room state, publish execution event | Supabase, run service, realtime |
| Workflow runner | `src/lib/agents/workflowRunner.ts` | Resolve task/workflow context and invoke LangGraph | Supabase, graph, skill profiles, MCP config |
| Workflow graph | `src/lib/agents/graph.ts` | Build dynamic LangGraph state machine | LangGraph, workflow nodes, checkpointer |
| Workflow nodes | `src/lib/agents/nodes.ts` | Role execution, routing, validation, human waits | LLM tools, Supabase, realtime |
| Checkpoint persistence | `src/lib/agents/persistence.ts` | Persist logs and workflow checkpoints | Supabase |
| Resume route | `src/app/api/agents/resume/route.ts` | Resume paused workflows after human decision | Checkpoints, LangGraph, admin auth |
| Task command route | `src/app/api/tasks/[taskId]/route.ts` | Archive tasks and update task lifecycle status with admin/office checks | Admin session, Supabase, realtime events |
| Task run command route | `src/app/api/task-runs/route.ts` | Public admin API to create/update a task and queue a supervised durable run | Admin office guard, task run command |
| Worker health route | `src/app/api/agent-workers/health/route.ts` | Admin API for dashboard worker health | Admin office guard, worker health service |
| Dashboard page | `src/app/dashboard/page.tsx` | Client-side cockpit for chat, tasks, realtime events, artifacts, agents, and room state | Supabase browser client, dashboard components, agent APIs |
| Task panel | `src/components/dashboard/TaskPanel.tsx` | Lists tasks and simple workflow metadata | Dashboard `TaskItem` model |
| Operator review panel | `src/components/dashboard/OperatorReviewPanel.tsx` | Shows pending approvals and a shallow run trace summary | Approval API, agent run trace API |
| Agent run trace API | `src/app/api/agent-runs/[runId]/trace/route.ts` | Aggregates run steps, approvals, validations, tool invocations, artifacts into a timeline | Supabase admin client |

## Task Log
| # | Task | Status | Files touched | Notes |
|---|---|---|---|---|
| 1 | Diagnose why agents do not run autonomously to completion and clean up configuration | done | `PROJECT.md`, `scripts/agent-worker.mjs`, `src/lib/agents/runService.ts`, `src/lib/agents/workflowRunner.ts`, `src/app/api/agents/resume/route.ts`, `.env.example`, `config.env` | Fixed worker env loading, auto approval loop, checkpoint key mismatch; verified tests/typecheck/diagnostic/build |
| 2 | Run sandbox and live autonomy checks | blocked | `PROJECT.md`, generated `.next/required-server-files.json` | Sandbox, diagnostic, unit, typecheck, build passed. Live Next server blocked: `next dev` fails with `spawn EPERM`; `next start` listens on 3217 but returns 404 for `/` and `/api/agent-runs/claim` |
| 3 | Attempt Railway cloud launch | blocked | `PROJECT.md` | Railway CLI works through `npx`, but both configured Railway tokens return `Unauthorized`; cloud deployment cannot proceed without valid Railway authentication |
| 4 | Deep stack review for autonomous agent dashboard architecture | done | `PROJECT.md` | Inspected dashboard data flow, agent run service, LangGraph runner, trace route, and SQL lifecycle migrations; selected Supervised Autopilot as target mode |
| 5 | Add supervised autopilot trace visibility to dashboard | done | `src/app/dashboard/types.ts`, `src/components/dashboard/OperatorReviewPanel.tsx`, `PROJECT.md` | Added shared dashboard trace/run types and changed operator panel to show selected run status, counters, approvals, chronological timeline, and artifacts |
| 6 | Move kanban task status changes behind command API | done | `src/app/api/tasks/[taskId]/route.ts`, `src/app/dashboard/page.tsx`, `PROJECT.md` | Added `PATCH /api/tasks/:taskId` with status whitelist, office access checks, archived guard, realtime event; dashboard kanban now calls API instead of direct Supabase update |
| 7 | Add unified task-run command lifecycle | done | `src/lib/agents/taskRunCommand.ts`, `src/app/api/task-runs/route.ts`, `src/app/api/agents/chat/route.ts`, `PROJECT.md` | Added `queueTaskRun` use-case and `POST /api/task-runs`; chat execution branch now uses the same create/update task + queue durable run lifecycle |
| 8 | Add worker health observability to dashboard | done | `src/lib/agents/workerHealth.ts`, `src/app/api/agent-workers/health/route.ts`, `src/app/dashboard/types.ts`, `src/components/dashboard/OperatorReviewPanel.tsx`, `PROJECT.md` | Added admin health API and dashboard block for worker idle/running/stale state, heartbeat age, current run, queue, retry and dead-letter counts |
| 9 | Polish dashboard operations cockpit UI | done | `src/components/dashboard/TaskPanel.tsx`, `src/components/dashboard/ConsolePanel.tsx`, `src/components/dashboard/OperatorReviewPanel.tsx`, `PROJECT.md` | Replaced mojibake labels, localized key operator text, tightened task/console panels, and made worker/run status badges more readable |

## Known Issues
| Issue | Severity | Location | Notes |
|---|---|---|---|
| Real secrets are present in `config.env` | high | `config.env` | File is gitignored, but tokens should be rotated if ever shared |
| No durable run history currently exists in Supabase | medium | `agent_runs`, `agent_run_steps` | Latest live logs show only `agents.chat` events with `approved=false` and `executedTools=[]`; worker-flow had not been used |
| Existing uncommitted change outside this task | low | `src/app/api/agents/chat/route.ts` | File was already modified; not touched during this task |
| Live local Next runtime does not serve app routes | high | `next dev`, `next start -p 3217` | `next dev` fails with `spawn EPERM`; `next start` starts but returns 404 for routes present in `.next/server/app`; live worker-flow cannot be tested until runtime path/Windows spawn issue is fixed |
| Railway credentials are not accepted | high | `config.env` Railway token/API key | `npx @railway/cli whoami` and `railway link --project ...` both return `Unauthorized`; need `railway login` or a fresh project/account token |
| Dashboard task model is inconsistent with usage | low | `src/app/dashboard/types.ts`, `src/app/dashboard/page.tsx` | `TaskItem` now includes assignee/signal/attachment fields; remaining risk is loose casts in page/kanban call sites |
| Task lifecycle still has a low-level run API | low | `src/app/api/agent-runs/route.ts` | Preferred path for new work is `POST /api/task-runs`; direct `agent-runs` API remains for existing task/manual low-level operations |
| Run trace depends on worker step history | low | `src/app/api/agent-runs/[runId]/trace/route.ts`, `src/components/dashboard/OperatorReviewPanel.tsx` | Operator panel renders the timeline, tools, approvals and artifacts; it will still be sparse if the worker has not recorded `agent_run_steps` |
| Idle worker process presence is inferred, not directly registered | medium | `src/lib/agents/workerHealth.ts`, `scripts/agent-worker.mjs` | Health can detect running/stale runs and retry/dead-letter state; a fully idle worker with no claimed run is not visible until a worker registry/heartbeat table is added |

## Build & Test Commands
```bash
# Build:   npm run build
# Test:    npm test
# E2E:     npm run test:e2e:diagnostic
# Type:    npm run typecheck
# Lint:    npm run lint
# Worker:  npm run worker
```

## Context Anchors
- 2026-05-12: `PROJECT.md` was missing and has been created.
- 2026-05-12: `.codex/skills/*` referenced by AGENTS.md was not present in this repository; used available architecture guidance and code inspection.
- 2026-05-12: Root causes found: worker did not load `config.env`, auto runs were sent through pre-approval, and LangGraph used chat thread id as checkpoint key.
- 2026-05-12: Sandbox autonomy check completed successfully; live server check is blocked by local Next runtime serving 404 despite built app routes.
- 2026-05-12: Railway cloud launch attempted; blocked by invalid/expired Railway authentication in `config.env`.
- 2026-05-12: Deep stack review found that durable autonomy primitives exist, but dashboard and command flow are not yet organized around a single task/run lifecycle.
- 2026-05-12: Supervised Autopilot selected as target mode; dashboard operator panel now renders durable run status and unified trace timeline from the existing trace API.
- 2026-05-12: Kanban task status changes now use a backend task command route instead of direct browser Supabase updates.
- 2026-05-12: `queueTaskRun` is now the unified command for task creation/update plus durable run queueing; chat execution uses it.
- 2026-05-12: Dashboard operator panel now includes worker health derived from `agent_runs`: status, heartbeat, current run, retry queue and dead-letter.
- 2026-05-12: Dashboard task, console and operator panels were polished into a compact operations cockpit with readable Russian labels.
