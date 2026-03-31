-- Digital Pixel Office v2.0
-- Popular roles, reusable team templates, and workflow-ready task schema.
-- Sources:
--   https://github.com/openclaw/skills
--   https://github.com/VoltAgent/awesome-openclaw-skills

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.roles_catalog (
    id uuid primary key default gen_random_uuid(),
    role_key text not null unique,
    display_name text not null,
    runtime_role text not null,
    description text not null default '',
    default_skills jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now()
);

create table if not exists public.team_templates (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    description text,
    roles_json jsonb not null default '[]'::jsonb,
    created_by uuid references public.admin_users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.tasks
    add column if not exists parent_task_id uuid references public.tasks(id) on delete set null;

alter table public.tasks
    add column if not exists dependencies jsonb not null default '[]'::jsonb;

alter table public.tasks
    add column if not exists assigned_agent_id uuid references public.agents(id) on delete set null;

alter table public.tasks
    add column if not exists workflow_mode text not null default 'autonomous'
        check (workflow_mode in ('autonomous', 'manual'));

alter table public.tasks
    add column if not exists manual_workflow_roles jsonb not null default '[]'::jsonb;

alter table public.tasks
    add column if not exists artifacts jsonb not null default '[]'::jsonb;

insert into public.skills_catalog (
    name,
    description,
    runtime,
    parameter_schema,
    source_repo,
    implementation_ref,
    is_verified,
    metadata
)
values
(
    'web_search',
    'Поиск актуальной информации и выдача краткой выжимки по источникам.',
    'http',
    '{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}'::jsonb,
    'https://github.com/openclaw/skills',
    'research/web-search',
    true,
    '{"category":"research","popularity":"high"}'::jsonb
),
(
    'competitive_research',
    'Сбор конкурентной аналитики, основных игроков и позиционирования.',
    'http',
    '{"type":"object","properties":{"query":{"type":"string"},"market":{"type":"string"}},"required":["query"]}'::jsonb,
    'https://github.com/VoltAgent/awesome-openclaw-skills',
    'competitor-analyzer',
    true,
    '{"category":"research","popularity":"high"}'::jsonb
),
(
    'github_reader',
    'Чтение файлов, pull request и структуры репозитория.',
    'mcp',
    '{"type":"object","properties":{"repo":{"type":"string"},"path":{"type":"string"}},"required":["repo"]}'::jsonb,
    'https://github.com/openclaw/skills',
    'git-github/github-reader',
    true,
    '{"category":"engineering","popularity":"high"}'::jsonb
),
(
    'jira_manager',
    'Создание, обновление и перемещение карточек в Jira/Trello-подобных системах.',
    'http',
    '{"type":"object","properties":{"title":{"type":"string"},"status":{"type":"string"},"description":{"type":"string"}},"required":["title"]}'::jsonb,
    'https://github.com/openclaw/skills',
    'productivity/jira-manager',
    true,
    '{"category":"tasks","popularity":"high"}'::jsonb
),
(
    'trello_manager',
    'Управление карточками, колонками и связями канбан-доски.',
    'http',
    '{"type":"object","properties":{"title":{"type":"string"},"column":{"type":"string"},"dependsOn":{"type":"array","items":{"type":"string"}}},"required":["title"]}'::jsonb,
    'https://github.com/VoltAgent/awesome-openclaw-skills',
    'productivity-tasks/trello',
    true,
    '{"category":"tasks","popularity":"high"}'::jsonb
),
(
    'document_drafter',
    'Создание структурированных markdown/html документов и черновиков.',
    'internal',
    '{"type":"object","properties":{"title":{"type":"string"},"brief":{"type":"string"}},"required":["title"]}'::jsonb,
    'https://github.com/openclaw/openclaw',
    'documents/document-draft',
    true,
    '{"category":"documents","popularity":"high"}'::jsonb
),
(
    'sql_executor',
    'Безопасное выполнение read-only SQL для анализа данных и проверки состояния.',
    'internal',
    '{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}'::jsonb,
    'https://github.com/openclaw/skills',
    'data/sql-executor',
    false,
    '{"category":"data","mode":"read-mostly","popularity":"high"}'::jsonb
),
(
    'http_fetcher',
    'Универсальный REST/HTTP вызов внешнего API с JSON payload.',
    'http',
    '{"type":"object","properties":{"url":{"type":"string"},"method":{"type":"string"},"body":{"type":"object"}},"required":["url"]}'::jsonb,
    'https://github.com/VoltAgent/awesome-openclaw-skills',
    'self-hosted/http',
    true,
    '{"category":"integration","popularity":"high"}'::jsonb
),
(
    'cloud_monitor',
    'Проверка состояния деплоя, логов и health-check инфраструктуры.',
    'http',
    '{"type":"object","properties":{"service":{"type":"string"},"environment":{"type":"string"}},"required":["service"]}'::jsonb,
    'https://github.com/VoltAgent/awesome-openclaw-skills',
    'devops-cloud/cloud-monitor',
    true,
    '{"category":"devops","popularity":"high"}'::jsonb
),
(
    'content_writer',
    'Подготовка постов, лендинговых текстов и маркетинговых черновиков.',
    'internal',
    '{"type":"object","properties":{"title":{"type":"string"},"brief":{"type":"string"},"tone":{"type":"string"}},"required":["title"]}'::jsonb,
    'https://github.com/VoltAgent/awesome-openclaw-skills',
    'blog-writer',
    true,
    '{"category":"marketing","popularity":"high"}'::jsonb
)
on conflict (name)
do update set
    description = excluded.description,
    runtime = excluded.runtime,
    parameter_schema = excluded.parameter_schema,
    source_repo = excluded.source_repo,
    implementation_ref = excluded.implementation_ref,
    is_verified = excluded.is_verified,
    metadata = excluded.metadata,
    updated_at = now();

insert into public.roles_catalog (role_key, display_name, runtime_role, description, default_skills)
values
(
    'ceo_expert',
    'CEO / Главный Эксперт',
    'PM',
    'Принимает задачу от человека, декомпозирует, назначает связи и контролирует автономный цикл.',
    '["jira_manager","trello_manager"]'::jsonb
),
(
    'developer',
    'Разработчик',
    'Developer',
    'Пишет код, проектирует архитектуру и реализует изменения.',
    '["github_reader","sql_executor"]'::jsonb
),
(
    'qa',
    'QA / Тестировщик',
    'QA',
    'Проверяет сценарии, формирует regressions и может вернуть задачу назад.',
    '["web_search","github_reader"]'::jsonb
),
(
    'devops',
    'DevOps / SRE',
    'DevOps',
    'Готовит инфраструктуру, следит за логами и релизным контуром.',
    '["cloud_monitor","http_fetcher"]'::jsonb
),
(
    'marketing_copywriter',
    'Маркетолог-Копирайтер',
    'PM',
    'Исследует конкурентов, пишет посты и формирует маркетинговые материалы.',
    '["web_search","competitive_research","content_writer"]'::jsonb
)
on conflict (role_key)
do update set
    display_name = excluded.display_name,
    runtime_role = excluded.runtime_role,
    description = excluded.description,
    default_skills = excluded.default_skills;

insert into public.team_templates (name, description, roles_json, created_by)
select
    'Команда Web-разработки',
    'CEO + разработка + QA + DevOps для продуктовых задач.',
    '[
        {"roleKey":"ceo_expert","displayName":"CEO / Главный Эксперт","runtimeRole":"PM","skills":["jira_manager","trello_manager"]},
        {"roleKey":"developer","displayName":"Разработчик","runtimeRole":"Developer","skills":["github_reader","sql_executor"]},
        {"roleKey":"qa","displayName":"QA / Тестировщик","runtimeRole":"QA","skills":["web_search","github_reader"]},
        {"roleKey":"devops","displayName":"DevOps / SRE","runtimeRole":"DevOps","skills":["cloud_monitor","http_fetcher"]}
    ]'::jsonb,
    (select id from public.admin_users order by created_at asc limit 1)
where not exists (
    select 1 from public.team_templates where name = 'Команда Web-разработки'
);

insert into public.team_templates (name, description, roles_json, created_by)
select
    'Маркетинг и контент',
    'CEO + маркетолог для исследований, постов и контентных задач.',
    '[
        {"roleKey":"ceo_expert","displayName":"CEO / Главный Эксперт","runtimeRole":"PM","skills":["jira_manager","trello_manager"]},
        {"roleKey":"marketing_copywriter","displayName":"Маркетолог-Копирайтер","runtimeRole":"PM","skills":["web_search","competitive_research","content_writer","document_drafter"]}
    ]'::jsonb,
    (select id from public.admin_users order by created_at asc limit 1)
where not exists (
    select 1 from public.team_templates where name = 'Маркетинг и контент'
);
