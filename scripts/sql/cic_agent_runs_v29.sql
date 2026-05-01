-- Run this after cic_task_artifacts_status_v28.sql.
create extension if not exists pgcrypto with schema extensions;

alter table if exists public.mcp_configs
    add column if not exists office_id uuid references public.offices(id) on delete cascade;

create index if not exists idx_mcp_configs_office_status
    on public.mcp_configs(office_id, status, updated_at desc);

create table if not exists public.agent_runs (
    id uuid primary key default gen_random_uuid(),
    office_id uuid not null references public.offices(id) on delete cascade,
    task_id uuid not null references public.tasks(id) on delete cascade,
    thread_id text,
    room_key text,
    input text,
    target_role text,
    mode text not null default 'auto',
    status text not null default 'queued',
    attempt_count integer not null default 0,
    max_attempts integer not null default 2,
    locked_by text,
    locked_at timestamptz,
    started_at timestamptz,
    finished_at timestamptz,
    last_error text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint agent_runs_status_check check (
        status in ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')
    ),
    constraint agent_runs_mode_check check (
        mode in ('plan', 'auto', 'manual', 'review', 'autofix', 'approval_required')
    ),
    constraint agent_runs_attempt_count_check check (attempt_count >= 0),
    constraint agent_runs_max_attempts_check check (max_attempts >= 1)
);

create table if not exists public.agent_run_steps (
    id uuid primary key default gen_random_uuid(),
    run_id uuid not null references public.agent_runs(id) on delete cascade,
    office_id uuid not null references public.offices(id) on delete cascade,
    task_id uuid references public.tasks(id) on delete set null,
    step_type text not null,
    role text,
    status text not null default 'pending',
    title text,
    input jsonb not null default '{}'::jsonb,
    output jsonb not null default '{}'::jsonb,
    error text,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint agent_run_steps_status_check check (
        status in ('pending', 'running', 'completed', 'failed', 'skipped')
    )
);

create table if not exists public.capability_requests (
    id uuid primary key default gen_random_uuid(),
    office_id uuid not null references public.offices(id) on delete cascade,
    task_id uuid references public.tasks(id) on delete set null,
    run_id uuid references public.agent_runs(id) on delete set null,
    requested_by_role text,
    target_role text,
    kind text not null,
    query text not null,
    reason text,
    status text not null default 'waiting_approval',
    approval_required boolean not null default true,
    approved_by text,
    approved_at timestamptz,
    rejected_by text,
    rejected_at timestamptz,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint capability_requests_kind_check check (kind in ('mcp', 'api', 'secret', 'tool', 'search')),
    constraint capability_requests_status_check check (
        status in ('proposed', 'waiting_approval', 'approved', 'provisioning', 'active', 'rejected', 'failed')
    ),
    constraint capability_requests_query_nonempty_check check (char_length(trim(query)) > 0)
);

create table if not exists public.validation_results (
    id uuid primary key default gen_random_uuid(),
    office_id uuid not null references public.offices(id) on delete cascade,
    task_id uuid references public.tasks(id) on delete set null,
    run_id uuid references public.agent_runs(id) on delete set null,
    step_id uuid references public.agent_run_steps(id) on delete set null,
    role text,
    command text,
    tool_name text,
    status text not null,
    output text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    constraint validation_results_status_check check (status in ('passed', 'failed', 'skipped'))
);

create index if not exists idx_agent_runs_office_status_updated
    on public.agent_runs(office_id, status, updated_at desc);

create index if not exists idx_agent_runs_task_created
    on public.agent_runs(task_id, created_at desc);

create index if not exists idx_agent_runs_lock
    on public.agent_runs(status, locked_at, created_at asc);

create index if not exists idx_agent_run_steps_run_created
    on public.agent_run_steps(run_id, created_at asc);

create index if not exists idx_capability_requests_office_status
    on public.capability_requests(office_id, status, created_at desc);

create index if not exists idx_validation_results_task_created
    on public.validation_results(task_id, created_at desc);

alter table public.agent_runs enable row level security;
alter table public.agent_run_steps enable row level security;
alter table public.capability_requests enable row level security;
alter table public.validation_results enable row level security;

drop policy if exists "Service role only agent_runs" on public.agent_runs;
drop policy if exists "Service role only agent_run_steps" on public.agent_run_steps;
drop policy if exists "Service role only capability_requests" on public.capability_requests;
drop policy if exists "Service role only validation_results" on public.validation_results;

create policy "Service role only agent_runs"
on public.agent_runs for all
using (false)
with check (false);

create policy "Service role only agent_run_steps"
on public.agent_run_steps for all
using (false)
with check (false);

create policy "Service role only capability_requests"
on public.capability_requests for all
using (false)
with check (false);

create policy "Service role only validation_results"
on public.validation_results for all
using (false)
with check (false);
