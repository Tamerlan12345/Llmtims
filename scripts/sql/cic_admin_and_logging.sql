-- Pixel Office CIC: admin auth + system logging bootstrap
-- Run this script in your PostgreSQL/Supabase SQL editor.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.admin_users (
    id uuid primary key default gen_random_uuid(),
    email text unique not null,
    full_name text not null default 'CIC Administrator',
    password_hash text not null,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.admin_sessions (
    id uuid primary key default gen_random_uuid(),
    admin_id uuid not null references public.admin_users(id) on delete cascade,
    token_hash text not null unique,
    expires_at timestamptz not null,
    last_seen_at timestamptz,
    created_at timestamptz not null default now()
);

create table if not exists public.system_logs (
    id bigserial primary key,
    level text not null check (level in ('debug', 'info', 'warn', 'error')),
    scope text not null,
    event text not null,
    actor_email text,
    task_id uuid references public.tasks(id) on delete set null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists idx_admin_sessions_admin on public.admin_sessions(admin_id);
create index if not exists idx_admin_sessions_expiry on public.admin_sessions(expires_at);
create index if not exists idx_system_logs_scope_time on public.system_logs(scope, created_at);
create index if not exists idx_system_logs_level_time on public.system_logs(level, created_at);

alter table public.admin_users enable row level security;
alter table public.admin_sessions enable row level security;
alter table public.system_logs enable row level security;

drop policy if exists "Admin access to admin_users" on public.admin_users;
drop policy if exists "Admin access to admin_sessions" on public.admin_sessions;
drop policy if exists "Admin access to system_logs" on public.system_logs;

create policy "Admin access to admin_users" on public.admin_users for all using (true);
create policy "Admin access to admin_sessions" on public.admin_sessions for all using (true);
create policy "Admin access to system_logs" on public.system_logs for all using (true);

create or replace function public.verify_admin_credentials(
    p_email text,
    p_password text
)
returns table (
    id uuid,
    email text,
    full_name text
)
language sql
security definer
set search_path = public
as $$
    select u.id, u.email, u.full_name
    from public.admin_users u
    where lower(u.email) = lower(p_email)
      and u.is_active = true
      and u.password_hash = extensions.crypt(p_password::text, u.password_hash::text)
    limit 1;
$$;

revoke all on function public.verify_admin_credentials(text, text) from public;
grant execute on function public.verify_admin_credentials(text, text) to anon, authenticated, service_role;

insert into public.admin_users (email, full_name, password_hash, is_active)
values (
    'admin@cic.kz',
    'CIC Administrator',
    extensions.crypt('Tamer25'::text, extensions.gen_salt('bf'::text)),
    true
)
on conflict (email)
do update set
    full_name = excluded.full_name,
    password_hash = excluded.password_hash,
    is_active = true,
    updated_at = now();
