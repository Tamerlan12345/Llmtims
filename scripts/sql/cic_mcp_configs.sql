-- Digital Pixel Office: MCP connection registry
-- Run this script in Supabase SQL Editor.
create extension if not exists pgcrypto with schema extensions;

do $$
begin
    if not exists (
        select 1
        from pg_type
        where typname = 'mcp_transport_type'
          and typnamespace = 'public'::regnamespace
    ) then
        create type public.mcp_transport_type as enum ('stdio', 'sse');
    end if;
end
$$;

do $$
begin
    if not exists (
        select 1
        from pg_type
        where typname = 'mcp_config_status'
          and typnamespace = 'public'::regnamespace
    ) then
        create type public.mcp_config_status as enum ('active', 'testing', 'error');
    end if;
end
$$;

create table if not exists public.mcp_configs (
    id uuid primary key default gen_random_uuid(),
    name text not null unique,
    type public.mcp_transport_type not null,
    command text,
    url text,
    env_vars jsonb not null default '{}'::jsonb,
    status public.mcp_config_status not null default 'testing',
    last_error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint mcp_configs_transport_payload_chk check (
        (type = 'stdio' and command is not null and url is null)
        or
        (type = 'sse' and url is not null and command is null)
    )
);

create index if not exists idx_mcp_configs_status on public.mcp_configs(status, updated_at desc);
create index if not exists idx_mcp_configs_type on public.mcp_configs(type);

alter table public.mcp_configs enable row level security;

drop policy if exists "Admin access on mcp_configs" on public.mcp_configs;

create policy "Admin access on mcp_configs"
on public.mcp_configs for all
using (true);
