-- Pixel Office CIC: production RLS hardening overlay.
-- Run this after the bootstrap/feature migrations.
--
-- The app uses a custom admin session and server-side service role for trusted
-- operations. Browser anon access must not receive permissive `using (true)`
-- policies in production.

alter table if exists public.admin_users enable row level security;
alter table if exists public.admin_sessions enable row level security;
alter table if exists public.system_logs enable row level security;
alter table if exists public.team_events enable row level security;
alter table if exists public.room_state enable row level security;
alter table if exists public.player_state enable row level security;
alter table if exists public.chat_threads enable row level security;
alter table if exists public.chat_messages enable row level security;
alter table if exists public.agent_context_items enable row level security;
alter table if exists public.mcp_configs enable row level security;
alter table if exists public.agent_runs enable row level security;
alter table if exists public.agent_run_steps enable row level security;
alter table if exists public.capability_requests enable row level security;
alter table if exists public.validation_results enable row level security;

drop policy if exists "Admin access to admin_users" on public.admin_users;
drop policy if exists "Admin access to admin_sessions" on public.admin_sessions;
drop policy if exists "Admin access to system_logs" on public.system_logs;
drop policy if exists "Admin access to team_events" on public.team_events;
drop policy if exists "Admin access to room_state" on public.room_state;
drop policy if exists "Admin access to player_state" on public.player_state;
drop policy if exists "Admin access on chat_threads" on public.chat_threads;
drop policy if exists "Admin access on chat_messages" on public.chat_messages;
drop policy if exists "Admin access on agent_context_items" on public.agent_context_items;
drop policy if exists "Admin access on mcp_configs" on public.mcp_configs;
drop policy if exists "Service role only agent_runs" on public.agent_runs;
drop policy if exists "Service role only agent_run_steps" on public.agent_run_steps;
drop policy if exists "Service role only capability_requests" on public.capability_requests;
drop policy if exists "Service role only validation_results" on public.validation_results;

create policy "Service role only admin_users"
on public.admin_users for all
using (false)
with check (false);

create policy "Service role only admin_sessions"
on public.admin_sessions for all
using (false)
with check (false);

create policy "Service role only system_logs"
on public.system_logs for all
using (false)
with check (false);

create policy "Service role only team_events"
on public.team_events for all
using (false)
with check (false);

create policy "Service role only room_state"
on public.room_state for all
using (false)
with check (false);

create policy "Service role only player_state"
on public.player_state for all
using (false)
with check (false);

create policy "Service role only chat_threads"
on public.chat_threads for all
using (false)
with check (false);

create policy "Service role only chat_messages"
on public.chat_messages for all
using (false)
with check (false);

create policy "Service role only agent_context_items"
on public.agent_context_items for all
using (false)
with check (false);

create policy "Service role only mcp_configs"
on public.mcp_configs for all
using (false)
with check (false);

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
