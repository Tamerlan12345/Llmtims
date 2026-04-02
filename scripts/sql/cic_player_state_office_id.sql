-- Add office scoping to player_state for multi-office realtime updates.

do $$
begin
    if to_regclass('public.player_state') is null then
        raise notice 'Table public.player_state does not exist, skip migration.';
        return;
    end if;

    if to_regclass('public.offices') is null then
        raise notice 'Table public.offices does not exist, skip migration.';
        return;
    end if;
end
$$;

alter table public.player_state
    add column if not exists office_id uuid references public.offices(id) on delete cascade;

create index if not exists idx_player_state_office_room_updated
    on public.player_state(office_id, room_key, updated_at desc);

update public.player_state ps
set office_id = a.office_id
from public.agents a
where ps.agent_id = a.id
  and ps.office_id is null
  and a.office_id is not null;

do $$
begin
    perform pg_notify('pgrst', 'reload schema');
exception
    when others then
        null;
end
$$;
