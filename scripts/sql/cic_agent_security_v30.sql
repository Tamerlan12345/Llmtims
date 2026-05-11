-- Run this after cic_agent_runs_v29.sql.

alter table if exists public.agent_runs
    add column if not exists heartbeat_at timestamptz,
    add column if not exists max_tool_calls integer not null default 40,
    add column if not exists max_duration_ms integer not null default 900000,
    add column if not exists failure_category text,
    add column if not exists blocked_reason text;

create index if not exists idx_agent_runs_heartbeat
    on public.agent_runs(status, heartbeat_at, locked_at);

alter table if exists public.mcp_configs
    add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table if exists public.mcp_configs
    drop constraint if exists mcp_configs_name_key;

alter table if exists public.mcp_configs
    drop constraint if exists mcp_configs_office_name_unique;

alter table if exists public.mcp_configs
    add constraint mcp_configs_office_name_unique unique (office_id, name);

create table if not exists public.tool_policies (
    id uuid primary key default gen_random_uuid(),
    office_id uuid references public.offices(id) on delete cascade,
    tool_id text not null,
    risk_level text not null default 'high',
    approval_required boolean not null default true,
    allowed_roles text[] not null default '{}'::text[],
    allowed_offices uuid[] not null default '{}'::uuid[],
    env_allowlist text[] not null default '{}'::text[],
    network_allowlist text[] not null default '{}'::text[],
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint tool_policies_risk_check check (risk_level in ('low', 'medium', 'high', 'critical')),
    constraint tool_policies_tool_nonempty_check check (char_length(trim(tool_id)) > 0)
);

create unique index if not exists uq_tool_policies_office_tool
    on public.tool_policies(office_id, tool_id);

create table if not exists public.approval_requests (
    id uuid primary key default gen_random_uuid(),
    office_id uuid not null references public.offices(id) on delete cascade,
    run_id uuid references public.agent_runs(id) on delete set null,
    task_id uuid references public.tasks(id) on delete set null,
    tool_id text not null,
    risk_level text not null,
    action_summary text not null,
    arguments jsonb not null default '{}'::jsonb,
    resource text,
    status text not null default 'pending',
    decision_by text,
    decision_at timestamptz,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint approval_requests_status_check check (status in ('pending', 'approved', 'rejected', 'edited', 'expired')),
    constraint approval_requests_risk_check check (risk_level in ('low', 'medium', 'high', 'critical')),
    constraint approval_requests_tool_nonempty_check check (char_length(trim(tool_id)) > 0)
);

create index if not exists idx_approval_requests_office_status
    on public.approval_requests(office_id, status, created_at desc);

create index if not exists idx_approval_requests_run
    on public.approval_requests(run_id, created_at desc);

create table if not exists public.tool_invocations (
    id uuid primary key default gen_random_uuid(),
    office_id uuid references public.offices(id) on delete cascade,
    run_id uuid references public.agent_runs(id) on delete set null,
    task_id uuid references public.tasks(id) on delete set null,
    approval_request_id uuid references public.approval_requests(id) on delete set null,
    tool_id text not null,
    action_type text not null,
    risk_level text not null,
    decision text not null,
    status text not null,
    input jsonb not null default '{}'::jsonb,
    output jsonb not null default '{}'::jsonb,
    error text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    constraint tool_invocations_risk_check check (risk_level in ('low', 'medium', 'high', 'critical')),
    constraint tool_invocations_decision_check check (decision in ('allowed', 'denied', 'approval_required')),
    constraint tool_invocations_status_check check (status in ('started', 'completed', 'failed', 'pending'))
);

create index if not exists idx_tool_invocations_run_created
    on public.tool_invocations(run_id, created_at asc);

create index if not exists idx_tool_invocations_office_created
    on public.tool_invocations(office_id, created_at desc);

alter table public.tool_policies enable row level security;
alter table public.approval_requests enable row level security;
alter table public.tool_invocations enable row level security;

drop policy if exists "Service role only tool_policies" on public.tool_policies;
drop policy if exists "Service role only approval_requests" on public.approval_requests;
drop policy if exists "Service role only tool_invocations" on public.tool_invocations;

create policy "Service role only tool_policies"
on public.tool_policies for all
using (false)
with check (false);

create policy "Service role only approval_requests"
on public.approval_requests for all
using (false)
with check (false);

create policy "Service role only tool_invocations"
on public.tool_invocations for all
using (false)
with check (false);
