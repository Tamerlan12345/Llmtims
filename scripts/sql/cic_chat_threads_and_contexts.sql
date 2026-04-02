-- Persistent chat threads + agent context knowledge for Digital Pixel Office.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.chat_threads (
    id uuid primary key default gen_random_uuid(),
    office_id uuid not null references public.offices(id) on delete cascade,
    title text not null,
    created_by uuid references public.admin_users(id) on delete set null,
    is_archived boolean not null default false,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint chat_threads_title_nonempty_chk check (char_length(trim(title)) between 1 and 160)
);

create index if not exists idx_chat_threads_office_updated
    on public.chat_threads(office_id, updated_at desc);

create table if not exists public.chat_messages (
    id uuid primary key default gen_random_uuid(),
    thread_id uuid not null references public.chat_threads(id) on delete cascade,
    office_id uuid not null references public.offices(id) on delete cascade,
    sender text not null check (sender in ('user', 'agent', 'system')),
    role text,
    agent_name text,
    content text not null,
    scope text,
    target_role text,
    client_message_id text,
    task_id uuid references public.tasks(id) on delete set null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    constraint chat_messages_content_nonempty_chk check (char_length(trim(content)) > 0)
);

create index if not exists idx_chat_messages_thread_time
    on public.chat_messages(thread_id, created_at asc);

create index if not exists idx_chat_messages_office_time
    on public.chat_messages(office_id, created_at desc);

create unique index if not exists uq_chat_messages_thread_client_sender
    on public.chat_messages(thread_id, client_message_id, sender)
    where client_message_id is not null;

create table if not exists public.agent_context_items (
    id uuid primary key default gen_random_uuid(),
    office_id uuid not null references public.offices(id) on delete cascade,
    title text not null,
    context_text text not null,
    target_roles text[] not null default '{}',
    target_agent_ids uuid[] not null default '{}',
    is_active boolean not null default true,
    created_by uuid references public.admin_users(id) on delete set null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint agent_context_items_title_nonempty_chk check (char_length(trim(title)) between 1 and 160),
    constraint agent_context_items_text_nonempty_chk check (char_length(trim(context_text)) between 1 and 12000)
);

create index if not exists idx_agent_context_items_office_updated
    on public.agent_context_items(office_id, updated_at desc);

create index if not exists idx_agent_context_items_active
    on public.agent_context_items(office_id, is_active, updated_at desc);

alter table public.chat_threads enable row level security;
alter table public.chat_messages enable row level security;
alter table public.agent_context_items enable row level security;

drop policy if exists "Admin access on chat_threads" on public.chat_threads;
drop policy if exists "Admin access on chat_messages" on public.chat_messages;
drop policy if exists "Admin access on agent_context_items" on public.agent_context_items;

create policy "Admin access on chat_threads"
on public.chat_threads for all
using (true);

create policy "Admin access on chat_messages"
on public.chat_messages for all
using (true);

create policy "Admin access on agent_context_items"
on public.agent_context_items for all
using (true);
