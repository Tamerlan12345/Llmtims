-- Pixel Office CIC: skills catalog + role -> skills profile mapping
-- Run this script in PostgreSQL/Supabase SQL editor.
-- Purpose:
-- 1) Keep clean canonical skills catalog with descriptions in DB
-- 2) Keep canonical role skill profiles in DB
-- 3) Sync profiles into public.agents.skills, used by runtime prompts
-- Note:
-- Full SKILL.md bodies are loaded by:
--   scripts/sql/cic_agent_skills_markdown_seed.sql

create table if not exists public.agent_skill_catalog (
    skill_name text primary key,
    display_name text not null,
    summary text not null,
    usage_notes text not null,
    source_path text not null,
    skill_markdown text not null default '',
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);

alter table public.agent_skill_catalog add column if not exists skill_markdown text not null default '';

alter table public.agent_skill_catalog enable row level security;

drop policy if exists "Admin access to agent_skill_catalog" on public.agent_skill_catalog;
create policy "Admin access to agent_skill_catalog"
on public.agent_skill_catalog for all using (true);

insert into public.agent_skill_catalog (
    skill_name,
    display_name,
    summary,
    usage_notes,
    source_path
)
values
(
    'agile-product-owner',
    'Agile Product Owner',
    'INVEST stories, acceptance criteria, sprint planning, backlog prioritization, and stakeholder communication.',
    'Use for discovery, decomposition, priorities, and sprint-ready scope.',
    '.agents/skills/agile-product-owner/SKILL.md'
),
(
    'architecture-patterns',
    'Architecture Patterns',
    'Clean/Hexagonal/DDD architecture patterns for maintainable and testable systems.',
    'Use for module boundaries, dependency flow, and long-term maintainability decisions.',
    '.agents/skills/architecture-patterns/SKILL.md'
),
(
    'audit-website',
    'Website Audit',
    'SEO, performance, security, and technical audits with actionable reports.',
    'Use for QA diagnostics, release readiness checks, and production health baselines.',
    '.agents/skills/audit-website/SKILL.md'
),
(
    'brainstorming',
    'Brainstorming',
    'Structured requirement discovery and option analysis before implementation.',
    'Use before creative or ambiguous tasks to clarify goals, constraints, and success criteria.',
    '.agents/skills/brainstorming/SKILL.md'
),
(
    'canvas-design',
    'Canvas Design',
    'Visual philosophy and static visual artifact generation in PNG/PDF.',
    'Use for posters, visual concepts, and static design deliverables.',
    '.agents/skills/canvas-design/SKILL.md'
),
(
    'frontend-design',
    'Frontend Design',
    'Distinctive production-grade UI implementation with strong visual direction.',
    'Use for pages/components UI work while preserving responsiveness and accessibility.',
    '.agents/skills/frontend-design/SKILL.md'
),
(
    'gemini',
    'Gemini CLI',
    'Large-context analysis and comprehensive code/plan review workflows.',
    'Use when scope is very large or requires deep multi-file reasoning.',
    '.agents/skills/gemini/SKILL.md'
),
(
    'pptx',
    'PPTX',
    'Read, edit, and generate .pptx presentations with structured tooling.',
    'Use for any deck workflow: extract, modify, create, merge, or update slides.',
    '.agents/skills/pptx/SKILL.md'
),
(
    'supabase-postgres-best-practices',
    'Supabase Postgres Best Practices',
    'Postgres performance and schema/query optimization guidance.',
    'Use for SQL tuning, indexing, RLS, query plans, and DB reliability.',
    '.agents/skills/supabase-postgres-best-practices/SKILL.md'
),
(
    'ui-ux-pro-max',
    'UI/UX Pro Max',
    'UI/UX design intelligence for accessibility, typography, color, and interaction quality.',
    'Use for UX review, visual hierarchy, and component usability improvements.',
    '.agents/skills/ui-ux-pro-max/SKILL.md'
)
on conflict (skill_name)
do update set
    display_name = excluded.display_name,
    summary = excluded.summary,
    usage_notes = excluded.usage_notes,
    source_path = excluded.source_path,
    updated_at = now();

create table if not exists public.agent_role_skill_profiles (
    role text primary key check (role in ('PM', 'Developer', 'QA', 'DevOps')),
    skill_names text[] not null default '{}',
    notes text,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);

alter table public.agent_role_skill_profiles enable row level security;

drop policy if exists "Admin access to agent_role_skill_profiles" on public.agent_role_skill_profiles;
create policy "Admin access to agent_role_skill_profiles"
on public.agent_role_skill_profiles for all using (true);

insert into public.agent_role_skill_profiles (role, skill_names, notes)
values
(
    'PM',
    array[
        'agile-product-owner',
        'brainstorming',
        'ui-ux-pro-max',
        'gemini',
        'pptx'
    ],
    'PM profile: discovery, planning, prioritization, UX alignment, facilitation'
),
(
    'Developer',
    array[
        'architecture-patterns',
        'frontend-design',
        'ui-ux-pro-max',
        'supabase-postgres-best-practices',
        'brainstorming',
        'gemini'
    ],
    'Developer profile: implementation, architecture, UI delivery, DB best practices'
),
(
    'QA',
    array[
        'audit-website',
        'supabase-postgres-best-practices',
        'brainstorming',
        'gemini'
    ],
    'QA profile: audit/validation, edge cases, quality gates'
),
(
    'DevOps',
    array[
        'architecture-patterns',
        'supabase-postgres-best-practices',
        'audit-website',
        'gemini'
    ],
    'DevOps profile: infrastructure safety, rollout checks, observability mindset'
)
on conflict (role)
do update set
    skill_names = excluded.skill_names,
    notes = excluded.notes,
    updated_at = now();

alter table public.agents add column if not exists skills text[] not null default '{}';

update public.agents as a
set skills = coalesce((
        select array_agg(s.skill_name order by s.ord)
        from unnest(p.skill_names) with ordinality as s(skill_name, ord)
        join public.agent_skill_catalog c on c.skill_name = s.skill_name
    ), '{}'::text[]),
    updated_at = now()
from public.agent_role_skill_profiles as p
where a.role = p.role;

-- Verify catalog, mapping, and sync
select
    c.skill_name,
    c.display_name,
    c.summary,
    c.source_path
from public.agent_skill_catalog c
order by c.skill_name;

select
    p.role,
    p.skill_names as profile_skills,
    a.name as agent_name,
    a.skills as agent_skills
from public.agent_role_skill_profiles p
left join public.agents a on a.role = p.role
order by p.role;
