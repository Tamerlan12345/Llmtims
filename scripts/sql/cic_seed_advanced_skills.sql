-- Advanced skills seed for Digital Pixel Office (v2.2)
-- Adds media/document/web execution skills and a reusable "Digital Production" team template.

alter table public.skills_catalog
    add column if not exists instruction_md text not null default '';

insert into public.skills_catalog (
    name,
    description,
    runtime,
    endpoint,
    parameter_schema,
    instruction_md
)
values
(
    'image_generator',
    'Генерация изображений по текстовому описанию',
    'http',
    '/api/skills/runtime',
    '{
      "type":"object",
      "properties":{
        "prompt":{"type":"string"},
        "aspect_ratio":{"type":"string","enum":["1:1","16:9","9:16"]}
      }
    }'::jsonb,
    '# Skill: Image Generator
**Описание:** Создает высококачественные изображения.
**Правила:**
1. Промпт должен быть подробным, на английском языке, с указанием стиля (например, "cinematic, photorealistic").
2. В ответ ты получишь URL сгенерированной картинки. Обязательно вставь этот URL в свой финальный ответ пользователю в формате Markdown: `![Описание](URL)`.'
),
(
    'video_generator',
    'Создание коротких видеороликов из текста или изображений',
    'http',
    '/api/skills/runtime',
    '{
      "type":"object",
      "properties":{
        "prompt":{"type":"string"},
        "duration_seconds":{"type":"number","enum":[5,10]}
      }
    }'::jsonb,
    '# Skill: Video Generator
**Описание:** Генерирует видео-сцены по сценарию.
**Правила:**
1. Описывай движение камеры и объектов в кадре максимально детально (например, "Pan right, a car driving through neon city").
2. Генерация занимает время. В ответ придет URL на `.mp4` файл.'
),
(
    'pdf_document_generator',
    'Конвертация текста, Markdown или JSON в отформатированный PDF-документ',
    'http',
    '/api/skills/runtime',
    '{
      "type":"object",
      "properties":{
        "title":{"type":"string"},
        "content_markdown":{"type":"string"},
        "template":{"type":"string","enum":["corporate","report","proposal"]}
      }
    }'::jsonb,
    '# Skill: PDF Document Generator
**Описание:** Создает готовые для печати PDF-файлы (коммерческие предложения, отчеты, полисы).
**Правила:**
1. Передавай содержимое в формате Markdown. Используй таблицы, заголовки и списки для структурирования.
2. Если делаешь Коммерческое Предложение (КП), обязательно укажи шаблон `proposal`.
3. В ответ вернется ссылка на готовый PDF. Сохрани её в Артефакты графа.'
),
(
    'excel_report_builder',
    'Создание таблиц Excel (.xlsx) из массивов данных JSON',
    'http',
    '/api/skills/runtime',
    '{
      "type":"object",
      "properties":{
        "filename":{"type":"string"},
        "sheets":{
          "type":"array",
          "items":{
            "type":"object",
            "properties":{
              "sheet_name":{"type":"string"},
              "data_json":{"type":"string"}
            }
          }
        }
      }
    }'::jsonb,
    '# Skill: Excel Report Builder
**Описание:** Превращает сырые данные в красивые Excel-таблицы.
**Правила:**
1. Поле `data_json` должно быть строкой, содержащей валидный JSON-массив объектов. Например: `"[{\"Имя\":\"Иван\", \"Сумма\":100}]"`.
2. Разбивай большие отчеты на несколько листов (`sheets`), давая им понятные названия.'
),
(
    'terminal_bash_executor',
    'Выполнение bash-команд в изолированном контейнере',
    'internal',
    null,
    '{
      "type":"object",
      "properties":{
        "command":{"type":"string"}
      }
    }'::jsonb,
    '# Skill: Terminal Bash Executor
**Описание:** Позволяет запускать консольные команды, собирать проекты и тестировать код.
**Правила:**
1. Используй для установки пакетов (`npm install`), запуска линтеров (`npm run lint`) или проверок безопасности.
2. Не пытайся запускать интерактивные команды, требующие ввода от пользователя (например, `nano` или `vim`).'
),
(
    'vercel_project_deployer',
    'Деплой готового веб-приложения на Vercel',
    'http',
    '/api/skills/runtime',
    '{
      "type":"object",
      "properties":{
        "github_repo_url":{"type":"string"},
        "env_vars":{"type":"object"}
      }
    }'::jsonb,
    '# Skill: Vercel Deployer
**Описание:** Публикует репозиторий в интернет и возвращает живую ссылку на проект.
**Правила:**
1. Перед вызовом убедись, что код закомичен в GitHub.
2. Передай все необходимые ключи среды в `env_vars`.'
)
on conflict (name)
do update set
    description = excluded.description,
    runtime = excluded.runtime,
    endpoint = excluded.endpoint,
    parameter_schema = excluded.parameter_schema,
    instruction_md = excluded.instruction_md,
    updated_at = now();

insert into public.team_templates (name, description, roles_json, created_by)
select
    'Digital Production',
    'Команда для генерации кода, медиа-контента и бэк-офисной отчетности.',
    '[
      {
        "roleKey":"senior_web_developer",
        "displayName":"Senior Web Developer",
        "runtimeRole":"Senior Web Developer",
        "roleMarkdown":"Ты сеньор разработчик. Ты пишешь код, проверяешь его в терминале и сразу деплоишь на сервера.",
        "skills":["web_search","github_reader","terminal_bash_executor","vercel_project_deployer"]
      },
      {
        "roleKey":"media_creator",
        "displayName":"Медиа-Креативщик",
        "runtimeRole":"Медиа-Креативщик",
        "roleMarkdown":"Ты арт-директор. Твоя задача брать сухие тексты и превращать их в визуальный контент (видео и графику).",
        "skills":["image_generator","video_generator"]
      },
      {
        "roleKey":"analytics_backoffice",
        "displayName":"Аналитик / Бэк-офис",
        "runtimeRole":"Аналитик / Бэк-офис",
        "roleMarkdown":"Ты работаешь с цифрами и документами. Ты собираешь статистику в Excel и генерируешь PDF-отчеты для руководства.",
        "skills":["sql_executor","excel_report_builder","pdf_document_generator"]
      }
    ]'::jsonb,
    (select id from public.admin_users order by created_at asc limit 1)
where not exists (
    select 1 from public.team_templates where name = 'Digital Production'
);

update public.team_templates
set
    description = 'Команда для генерации кода, медиа-контента и бэк-офисной отчетности.',
    roles_json = '[
      {
        "roleKey":"senior_web_developer",
        "displayName":"Senior Web Developer",
        "runtimeRole":"Senior Web Developer",
        "roleMarkdown":"Ты сеньор разработчик. Ты пишешь код, проверяешь его в терминале и сразу деплоишь на сервера.",
        "skills":["web_search","github_reader","terminal_bash_executor","vercel_project_deployer"]
      },
      {
        "roleKey":"media_creator",
        "displayName":"Медиа-Креативщик",
        "runtimeRole":"Медиа-Креативщик",
        "roleMarkdown":"Ты арт-директор. Твоя задача брать сухие тексты и превращать их в визуальный контент (видео и графику).",
        "skills":["image_generator","video_generator"]
      },
      {
        "roleKey":"analytics_backoffice",
        "displayName":"Аналитик / Бэк-офис",
        "runtimeRole":"Аналитик / Бэк-офис",
        "roleMarkdown":"Ты работаешь с цифрами и документами. Ты собираешь статистику в Excel и генерируешь PDF-отчеты для руководства.",
        "skills":["sql_executor","excel_report_builder","pdf_document_generator"]
      }
    ]'::jsonb,
    updated_at = now()
where name = 'Digital Production';

-- v2.4: strict markdown output format for interactive downloadable artifacts
update public.skills_catalog
set
  instruction_md = $image_generator_v24$
# Skill: Image Generator
**Описание:** Создает высококачественные изображения.
**Правила:**
1. Промпт должен быть подробным, на английском языке, с указанием стиля (например, "cinematic, photorealistic").
2. Ты получишь от инструмента URL картинки.
3. В финальном ответе ОБЯЗАТЕЛЬНО выведи URL в двух форматах:
   - Для предпросмотра: `![Сгенерированное изображение](URL)`
   - Для кнопки скачивания: `[📥 Скачать изображение.jpg](URL)`
$image_generator_v24$,
  updated_at = now()
where name = 'image_generator';

update public.skills_catalog
set
  instruction_md = $video_generator_v24$
# Skill: Video Generator
**Описание:** Генерирует видео-сцены по сценарию.
**Правила:**
1. Описывай движение камеры и объектов в кадре максимально детально (например, "Pan right, a car driving through neon city").
2. Когда инструмент вернет ссылку на `.mp4` файл, ты ДОЛЖЕН передать ее пользователю строго в таком виде:
`[📥 Скачать сгенерированное_видео.mp4](URL)`
3. Никаких других тегов или форматов вывода для ссылки не используй.
$video_generator_v24$,
  updated_at = now()
where name = 'video_generator';

update public.skills_catalog
set
  instruction_md = $pdf_generator_v24$
# Skill: PDF Document Generator
**Описание:** Создает готовые для печати PDF-файлы (коммерческие предложения, отчеты, полисы).
**Правила:**
1. Передавай содержимое в формате Markdown. Используй таблицы, заголовки и списки для структурирования.
2. Если делаешь Коммерческое Предложение (КП), обязательно укажи шаблон `proposal`.
3. В ответ вернется ссылка на готовый PDF.
4. Обязательно выведи пользователю ссылку на скачивание, название ссылки должно заканчиваться на расширение файла.
Пример: `[📥 Скачать коммерческое_предложение.pdf](URL)`
$pdf_generator_v24$,
  updated_at = now()
where name = 'pdf_document_generator';

update public.skills_catalog
set
  instruction_md = $excel_builder_v24$
# Skill: Excel Report Builder
**Описание:** Превращает сырые данные в структурированные Excel-таблицы.
**Правила:**
1. Поле `data_json` должно быть строкой, содержащей валидный JSON-массив объектов.
2. Разбивай большие отчеты на несколько листов (`sheets`), давая им понятные названия.
3. Обязательно выведи пользователю ссылку на скачивание, название ссылки должно заканчиваться на расширение файла.
Пример: `[📥 Скачать финансовый_отчет.xlsx](URL)`
$excel_builder_v24$,
  updated_at = now()
where name = 'excel_report_builder';

insert into public.skills_catalog (
    name,
    description,
    runtime,
    endpoint,
    parameter_schema,
    instruction_md
)
values
(
    'plan_gsd_project',
    'PM-планирование проекта по методологии GSD с автоматическим созданием sub_tasks',
    'http',
    '/api/skills/runtime',
    '{
      "type":"object",
      "properties":{
        "project_goal":{"type":"string"},
        "actionable_steps":{
          "type":"array",
          "items":{
            "type":"object",
            "properties":{
              "assignee_role":{"type":"string"},
              "step_description":{"type":"string"}
            },
            "required":["assignee_role","step_description"]
          }
        }
      },
      "required":["project_goal","actionable_steps"]
    }'::jsonb,
    'Ты — PM. Используй этот инструмент для разбивки сложных задач по методологии GSD (Capture -> Clarify -> Organize -> Reflect -> Engage). Инструмент автоматически создаст цепочку sub_tasks для команды.'
),
(
    'instagram_publisher',
    'Публикация поста в Instagram через Graph API',
    'http',
    '/api/skills/runtime',
    '{
      "type":"object",
      "properties":{
        "image_url":{"type":"string"},
        "caption":{"type":"string"}
      },
      "required":["image_url","caption"]
    }'::jsonb,
    'Опубликовать пост в Instagram. Обязательно приложи URL готовой картинки (сгенерированной ранее) и текст.'
)
on conflict (name)
do update set
    description = excluded.description,
    runtime = excluded.runtime,
    endpoint = excluded.endpoint,
    parameter_schema = excluded.parameter_schema,
    instruction_md = excluded.instruction_md,
    updated_at = now();
