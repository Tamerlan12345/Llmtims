-- Migration: Per-office token budget caps + soft/hard thresholds.
-- Run AFTER cic_ruflo_core_v32.sql.
-- All columns are nullable / safe defaults — pre-existing offices remain
-- enforcement-off until daily_token_budget or monthly_token_budget is set.

alter table public.offices
    add column if not exists daily_token_budget integer,
    add column if not exists monthly_token_budget integer,
    add column if not exists budget_warn_pct integer not null default 80,
    add column if not exists budget_hard_pct integer not null default 100,
    add column if not exists budget_force_tier text not null default 'fast';

-- Guard against impossible threshold configurations. Hard >= warn ensures the
-- warn band always exists; warn=0 or hard>100 disables sensible enforcement.
alter table public.offices
    drop constraint if exists offices_budget_pct_chk;

alter table public.offices
    add constraint offices_budget_pct_chk check (
        budget_warn_pct between 1 and 100
        and budget_hard_pct between 1 and 100
        and budget_hard_pct >= budget_warn_pct
    );

-- Budget evaluation reads token_logs by office_id within a time window. Add a
-- supporting index so the per-call sum stays cheap on busy offices.
create index if not exists idx_token_logs_office_created
    on public.token_logs(office_id, created_at desc);
