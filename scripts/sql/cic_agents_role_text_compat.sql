-- v2.5: ensure custom role naming is not constrained by enum-like columns
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'agents'
      and column_name = 'role_name'
  ) then
    execute 'alter table public.agents alter column role_name type text using role_name::text';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'agents'
      and column_name = 'display_name'
  ) then
    execute 'alter table public.agents alter column display_name type text using display_name::text';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'agents'
      and column_name = 'role'
  ) then
    execute 'alter table public.agents alter column role type text using role::text';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'agents'
      and column_name = 'name'
  ) then
    execute 'alter table public.agents alter column name type text using name::text';
  end if;
end $$;

