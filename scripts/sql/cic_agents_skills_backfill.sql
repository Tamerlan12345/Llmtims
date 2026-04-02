-- Backfill agents.skills for legacy rows where skills array is empty.
-- Uses enabled agent_skills links + active skills_catalog names.

do $$
begin
    if to_regclass('public.agents') is null then
        raise notice 'Table public.agents does not exist, skip migration.';
        return;
    end if;

    if to_regclass('public.agent_skills') is null or to_regclass('public.skills_catalog') is null then
        raise notice 'Tables public.agent_skills or public.skills_catalog do not exist, skip migration.';
        return;
    end if;

    if not exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'agents'
          and column_name = 'skills'
    ) then
        raise notice 'Column public.agents.skills does not exist, skip migration.';
        return;
    end if;
end
$$;

with resolved as (
    select
        ask.agent_id,
        array_agg(distinct sc.name order by sc.name)::text[] as skill_names
    from public.agent_skills ask
    join public.skills_catalog sc on sc.id = ask.skill_id
    where coalesce(ask.is_enabled, true) = true
      and coalesce(sc.is_active, true) = true
      and sc.name is not null
      and char_length(trim(sc.name)) > 0
    group by ask.agent_id
)
update public.agents a
set skills = resolved.skill_names
from resolved
where a.id = resolved.agent_id
  and coalesce(array_length(a.skills, 1), 0) = 0;

update public.agents
set skills = '{}'::text[]
where skills is null;
