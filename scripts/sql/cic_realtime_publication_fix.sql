-- Pixel Office CIC: realtime publication fix
-- Run in Supabase SQL Editor if UI does not receive live updates.
do $$
begin
    if not exists (
        select 1
        from pg_publication
        where pubname = 'supabase_realtime'
    ) then
        create publication supabase_realtime;
    end if;
end $$;

do $$ begin
    alter publication supabase_realtime add table public.agents;
exception when duplicate_object then null; end $$;

do $$ begin
    alter publication supabase_realtime add table public.tasks;
exception when duplicate_object then null; end $$;

do $$ begin
    alter publication supabase_realtime add table public.token_logs;
exception when duplicate_object then null; end $$;

do $$ begin
    alter publication supabase_realtime add table public.room_state;
exception when duplicate_object then null; end $$;

do $$ begin
    alter publication supabase_realtime add table public.player_state;
exception when duplicate_object then null; end $$;

do $$ begin
    alter publication supabase_realtime add table public.team_events;
exception when duplicate_object then null; end $$;

alter table if exists public.agents replica identity full;
alter table if exists public.tasks replica identity full;
alter table if exists public.token_logs replica identity full;
alter table if exists public.room_state replica identity full;
alter table if exists public.player_state replica identity full;
alter table if exists public.team_events replica identity full;
