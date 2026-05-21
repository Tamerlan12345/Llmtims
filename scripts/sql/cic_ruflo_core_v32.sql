-- Migration: Native Ruflo-core memory and lazy tool details
-- Run AFTER cic_approve_mode_v31.sql

create table if not exists public.agent_memory_patterns (
    id uuid primary key default gen_random_uuid(),
    office_id uuid not null references public.offices(id) on delete cascade,
    namespace text not null default 'patterns',
    key text not null,
    value text not null,
    summary text,
    tags text[] not null default '{}'::text[],
    confidence numeric not null default 0.8,
    source_run_id uuid references public.agent_runs(id) on delete set null,
    source_task_id uuid references public.tasks(id) on delete set null,
    metadata jsonb not null default '{}'::jsonb,
    search_text tsvector generated always as (
        to_tsvector(
            'simple',
            coalesce(key, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(value, '')
        )
    ) stored,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint agent_memory_patterns_namespace_key_chk check (
        char_length(trim(namespace)) > 0 and char_length(trim(key)) > 0
    ),
    constraint agent_memory_patterns_confidence_chk check (confidence >= 0 and confidence <= 1)
);

create unique index if not exists uq_agent_memory_patterns_office_namespace_key
    on public.agent_memory_patterns(office_id, namespace, key);

create index if not exists idx_agent_memory_patterns_office_namespace_updated
    on public.agent_memory_patterns(office_id, namespace, updated_at desc);

create index if not exists idx_agent_memory_patterns_source_run
    on public.agent_memory_patterns(source_run_id);

create index if not exists idx_agent_memory_patterns_search
    on public.agent_memory_patterns using gin(search_text);

create table if not exists public.agent_run_tool_details (
    id uuid primary key default gen_random_uuid(),
    office_id uuid not null references public.offices(id) on delete cascade,
    run_id uuid not null references public.agent_runs(id) on delete cascade,
    task_id uuid references public.tasks(id) on delete set null,
    tool_invocation_id uuid references public.tool_invocations(id) on delete set null,
    tool_name text not null,
    tool_call_id text,
    detail_token text not null unique,
    preview text,
    full_detail text not null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    constraint agent_run_tool_details_tool_name_chk check (char_length(trim(tool_name)) > 0),
    constraint agent_run_tool_details_token_chk check (char_length(trim(detail_token)) > 0)
);

create index if not exists idx_agent_run_tool_details_run_created
    on public.agent_run_tool_details(run_id, created_at desc);

create index if not exists idx_agent_run_tool_details_office_run
    on public.agent_run_tool_details(office_id, run_id);

create index if not exists idx_agent_run_tool_details_token
    on public.agent_run_tool_details(detail_token);

alter table public.agent_memory_patterns enable row level security;
alter table public.agent_run_tool_details enable row level security;

drop policy if exists "Service role only agent_memory_patterns" on public.agent_memory_patterns;
drop policy if exists "Service role only agent_run_tool_details" on public.agent_run_tool_details;

create policy "Service role only agent_memory_patterns"
on public.agent_memory_patterns for all
using (false)
with check (false);

create policy "Service role only agent_run_tool_details"
on public.agent_run_tool_details for all
using (false)
with check (false);
