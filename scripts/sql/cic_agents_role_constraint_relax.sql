-- Relax strict role constraint on public.agents.
-- Goal:
-- 1) Drop legacy role whitelist check (PM/Developer/QA/DevOps only)
-- 2) Keep a lightweight guard: role must be non-empty text

do $$
declare
    rec record;
begin
    if to_regclass('public.agents') is null then
        raise notice 'Table public.agents does not exist, skip migration.';
        return;
    end if;

    -- Explicit legacy name.
    execute 'alter table public.agents drop constraint if exists agents_role_check';

    -- Defensive cleanup: drop any legacy whitelist check constraints on role.
    for rec in
        select c.conname
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public'
          and t.relname = 'agents'
          and c.contype = 'c'
          and pg_get_constraintdef(c.oid) ilike '%role%'
          and pg_get_constraintdef(c.oid) ilike '% in (%'
          and (
              pg_get_constraintdef(c.oid) ilike '%PM%'
              or pg_get_constraintdef(c.oid) ilike '%Developer%'
              or pg_get_constraintdef(c.oid) ilike '%QA%'
              or pg_get_constraintdef(c.oid) ilike '%DevOps%'
          )
    loop
        execute format('alter table public.agents drop constraint %I', rec.conname);
    end loop;
end
$$;

alter table public.agents
    alter column role type text using trim(role::text);

-- Normalize legacy/invalid blanks before adding stricter non-empty check.
update public.agents
set role = 'Generalist'
where role is null or trim(role) = '';

alter table public.agents
    drop constraint if exists agents_role_nonempty_check;

alter table public.agents
    add constraint agents_role_nonempty_check
    check (char_length(trim(role)) between 1 and 120);

