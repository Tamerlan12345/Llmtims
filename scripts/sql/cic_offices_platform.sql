-- Digital Pixel Office: offices, skills marketplace, agent runtime state
-- Run this script in Supabase SQL Editor.
create extension if not exists pgcrypto with schema extensions;

alter table public.admin_users
    add column if not exists auth_user_id uuid unique;

create table if not exists public.offices (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references public.admin_users(id) on delete cascade,
    name text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.office_members (
    id uuid primary key default gen_random_uuid(),
    office_id uuid not null references public.offices(id) on delete cascade,
    admin_id uuid not null references public.admin_users(id) on delete cascade,
    role text not null default 'member' check (role in ('owner', 'member', 'observer')),
    telegram_user_id bigint,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (office_id, admin_id)
);

alter table public.agents
    add column if not exists office_id uuid references public.offices(id) on delete cascade;

alter table public.tasks
    add column if not exists office_id uuid references public.offices(id) on delete cascade;

alter table public.token_logs
    add column if not exists office_id uuid references public.offices(id) on delete cascade;

create table if not exists public.skills_catalog (
    id uuid primary key default gen_random_uuid(),
    name text not null unique,
    description text not null default '',
    parameter_schema jsonb not null default '{}'::jsonb,
    runtime text not null default 'http',
    endpoint text,
    source_repo text,
    implementation_ref text,
    is_verified boolean not null default false,
    is_active boolean not null default true,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.agent_skills (
    id uuid primary key default gen_random_uuid(),
    agent_id uuid not null references public.agents(id) on delete cascade,
    skill_id uuid not null references public.skills_catalog(id) on delete cascade,
    office_id uuid references public.offices(id) on delete cascade,
    credentials_secret_ref text,
    config jsonb not null default '{}'::jsonb,
    is_enabled boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (agent_id, skill_id)
);

create table if not exists public.agent_states (
    agent_id uuid primary key references public.agents(id) on delete cascade,
    office_id uuid references public.offices(id) on delete cascade,
    current_action text,
    current_skill text,
    current_target_x integer,
    current_target_y integer,
    status text not null default 'idle' check (status in ('idle', 'working', 'error')),
    metadata jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);

insert into public.offices (owner_id, name)
select
    u.id,
    coalesce(nullif(trim(u.full_name), ''), split_part(u.email, '@', 1), 'Office') || ' Office'
from public.admin_users u
where not exists (
    select 1
    from public.offices o
    where o.owner_id = u.id
)
on conflict do nothing;

insert into public.office_members (office_id, admin_id, role)
select
    o.id,
    o.owner_id,
    'owner'
from public.offices o
where not exists (
    select 1
    from public.office_members m
    where m.office_id = o.id
      and m.admin_id = o.owner_id
)
on conflict do nothing;

with default_office as (
    select id
    from public.offices
    order by created_at asc
    limit 1
)
update public.agents a
set office_id = d.id
from default_office d
where a.office_id is null;

with default_office as (
    select id
    from public.offices
    order by created_at asc
    limit 1
)
update public.tasks t
set office_id = d.id
from default_office d
where t.office_id is null;

with task_offices as (
    select t.id, t.office_id
    from public.tasks t
    where t.office_id is not null
)
update public.token_logs tl
set office_id = to2.office_id
from task_offices to2
where tl.task_id = to2.id
  and tl.office_id is null;

with agent_offices as (
    select a.id, a.office_id
    from public.agents a
    where a.office_id is not null
)
update public.agent_states s
set office_id = ao.office_id
from agent_offices ao
where s.agent_id = ao.id
  and s.office_id is null;

insert into public.skills_catalog (
    name,
    description,
    parameter_schema,
    runtime,
    endpoint,
    source_repo,
    implementation_ref,
    is_verified,
    metadata
)
values
(
    'web-search',
    'Search the web and return summarized findings for the office workflow.',
    '{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}'::jsonb,
    'internal',
    null,
    'https://github.com/openclaw/skills',
    'search/web-search',
    true,
    '{"category":"research"}'::jsonb
),
(
    'document-draft',
    'Generate a structured markdown or HTML document from task context.',
    '{"type":"object","properties":{"title":{"type":"string"},"format":{"type":"string"}},"required":["title"]}'::jsonb,
    'internal',
    null,
    'https://github.com/openclaw/openclaw',
    'generation/document-draft',
    true,
    '{"category":"delivery"}'::jsonb
),
(
    'github-inspector',
    'Inspect repository state, branches, and pull requests for the current office.',
    '{"type":"object","properties":{"repository":{"type":"string"},"query":{"type":"string"}}}'::jsonb,
    'mcp',
    null,
    'https://github.com/openclaw/skills',
    'github/github-inspector',
    false,
    '{"category":"engineering","review_status":"pending"}'::jsonb
)
on conflict (name)
do update set
    description = excluded.description,
    parameter_schema = excluded.parameter_schema,
    runtime = excluded.runtime,
    endpoint = excluded.endpoint,
    source_repo = excluded.source_repo,
    implementation_ref = excluded.implementation_ref,
    is_verified = excluded.is_verified,
    metadata = excluded.metadata,
    updated_at = now();

create or replace function public.current_admin_row_id()
returns uuid
language sql
security definer
set search_path = public
as $$
    select a.id
    from public.admin_users a
    where a.auth_user_id = auth.uid()
    limit 1;
$$;

create or replace function public.has_office_access(p_office_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
    select exists (
        select 1
        from public.offices o
        where o.id = p_office_id
          and (
              o.owner_id = public.current_admin_row_id()
              or exists (
                  select 1
                  from public.office_members m
                  where m.office_id = o.id
                    and m.admin_id = public.current_admin_row_id()
                    and m.is_active = true
              )
          )
    );
$$;

alter table public.offices enable row level security;
alter table public.office_members enable row level security;
alter table public.skills_catalog enable row level security;
alter table public.agent_skills enable row level security;
alter table public.agent_states enable row level security;

drop policy if exists "Office access on offices" on public.offices;
drop policy if exists "Office access on office_members" on public.office_members;
drop policy if exists "Office access on skills_catalog" on public.skills_catalog;
drop policy if exists "Office access on agent_skills" on public.agent_skills;
drop policy if exists "Office access on agent_states" on public.agent_states;

create policy "Office access on offices"
on public.offices for all
using (public.has_office_access(id));

create policy "Office access on office_members"
on public.office_members for all
using (public.has_office_access(office_id));

create policy "Office access on skills_catalog"
on public.skills_catalog for select
using (is_active = true);

create policy "Office access on agent_skills"
on public.agent_skills for all
using (office_id is null or public.has_office_access(office_id));

create policy "Office access on agent_states"
on public.agent_states for all
using (office_id is null or public.has_office_access(office_id));
