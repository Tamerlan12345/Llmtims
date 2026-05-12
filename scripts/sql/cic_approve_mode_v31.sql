-- Migration: Approve Mode, auto_approved_mcps, agent_run_steps phase tagging
-- Run AFTER all prior migrations (see MIGRATIONS.md)

-- 1. Extend offices table for per-office approve mode settings
ALTER TABLE public.offices
  ADD COLUMN IF NOT EXISTS approve_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approve_mode_min_risk text NOT NULL DEFAULT 'high'
    CHECK (approve_mode_min_risk IN ('low', 'medium', 'high', 'critical')),
  ADD COLUMN IF NOT EXISTS auto_approved_mcps text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN public.offices.approve_mode IS
  'When true, all tool invocations at or above approve_mode_min_risk require human approval.';
COMMENT ON COLUMN public.offices.approve_mode_min_risk IS
  'Minimum risk level that triggers approve mode gate: low | medium | high | critical.';
COMMENT ON COLUMN public.offices.auto_approved_mcps IS
  'List of MCP template names that are pre-approved for self-provisioning without explicit admin approval.';

-- 2. Add phase column to agent_run_steps for E2E trace visibility
ALTER TABLE public.agent_run_steps
  ADD COLUMN IF NOT EXISTS phase text DEFAULT 'execution'
    CHECK (phase IN ('routing', 'execution', 'tool_call', 'approval', 'validation', 'result'));

COMMENT ON COLUMN public.agent_run_steps.phase IS
  'Workflow phase: routing | execution | tool_call | approval | validation | result.';

-- Index for trace timeline queries
CREATE INDEX IF NOT EXISTS idx_agent_run_steps_run_phase
  ON public.agent_run_steps (run_id, phase, created_at DESC);
