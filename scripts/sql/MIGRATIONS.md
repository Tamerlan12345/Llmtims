# SQL Migration Order

Run existing bootstrap and feature scripts in their current deployment order,
then apply the production hardening overlay last:

```text
cic_admin_and_logging.sql
cic_offices_platform.sql
cic_seed_roles_skills.sql
cic_seed_advanced_skills.sql
cic_dynamic_workflows_v3.sql
cic_dynamic_workflows_seed.sql
cic_agent_skills_profiles.sql
cic_agent_skills_markdown_seed.sql
cic_agents_skills_backfill.sql
cic_agents_role_text_compat.sql
cic_agents_role_constraint_relax.sql
cic_chat_threads_and_contexts.sql
cic_mcp_configs.sql
cic_player_state_office_id.sql
cic_realtime_publication_fix.sql
cic_workflow_sync_v25.sql
cic_sub_tasks_v26.sql
cic_task_artifacts_status_v28.sql
cic_agent_runs_v29.sql
cic_production_rls_hardening.sql
```

`cic_production_rls_hardening.sql` intentionally removes permissive
`using (true)` admin policies. Production access should go through protected
Next.js API routes using `SUPABASE_SERVICE_ROLE_KEY`.
