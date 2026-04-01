# Project Architecture: llmtims (Digital Pixel Office)

This document provides a comprehensive technical overview of the llmtims project. It serves as the primary context (System Prompt) for AI agents working on this codebase.

## 1. Tech Stack & Conventions

*   **Framework**: Next.js 14+ (App Router)
*   **Language**: TypeScript (Strict mode)
*   **Database & Auth**: Supabase (Postgres, RLS, Edge Functions, Realtime)
*   **AI Orchestration**: LangGraph (for dynamic workflows and state management)
*   **Styling**: Vanilla CSS + Tailwind CSS (for layout) + Framer Motion (for animations)
*   **Visualization**: Digital Pixel Office (grid-based React components simulating a workspace)
*   **Naming Conventions**: PascalCase for components, camelCase for variables/functions, snake_case for database columns.

---

## 2. Database Schema

The system uses a relational schema in Supabase to manage offices, agents, and their capabilities.

### Core Tables:
*   **`offices`**: Logical containers for a group of agents and tasks. Linked to an owner (admin).
*   **`agents`**: The AI employees. 
    *   `role`: The technical identity (PM, Developer, etc.).
    *   `name`: User-facing name.
    *   `metadata`: Stores coordinates (`x`, `y`), `paletteIndex` (visual style), and current `action`.
*   **`tasks`**: The work units. 
    *   `status`: pending, in_progress, review, done, failed.
    *   `workflow_mode`: `autonomous` (PM-led) or `manual` (step-by-step).
*   **`skills_catalog`**: A library of tools agents can use. Contains `display_name`, `summary` (for LLM), and technical `parameter_schema`.
*   **`agent_skills`**: Junction table linking agents to skills.
*   **`team_templates`**: Reusable configurations of roles and skills for "one-click" office setup.

---

## 3. LangGraph Workflow (AI Engine)

The project uses LangGraph to move away from hardcoded agent chains.

*   **Dynamic Graph**: The workflow is modeled as a state machine where agents (PM, Developer, QA) act as nodes.
*   **AgentState**: A shared state object containing the task history, artifacts, and current focus.
*   **Interrupts**: The graph uses `interrupt` for manual approval stages (e.g., before deployment or final delivery).
*   **Artifacts**: Agents wrap deliverables in `<artifact_content>` tags, which are parsed by the UI.

---

## 4. Tool Calling Logic

Skills are not hardcoded in the AI logic. Instead:
1.  They are loaded from the `skills_catalog` table.
2.  The `usage_notes` and `instruction_md` from the DB are injected into the agent's prompt.
3.  The `tools.ts` module maps these DB entries to executable functions (HTTP calls, database queries, etc.).

---

## 5. UI & Pixel Office

The front-end simulates a living office environment.

*   **`OfficeHub.tsx`**: The main rendering engine for the office map. It translates agent coordinates from the DB into a 2D layout.
*   **Realtime Sync**: Agent movements and status changes are broadcasted via Supabase Realtime, updating the `agent_states` table.
*   **`PixelAgentSprite.tsx`**: Handles character animations (walking, typing, discussing) based on the agent's current activity.

---

## 6. Strict Rules for AI

AI Agents contributing to this project MUST follow these rules:

1.  **No Hardcoded Roles**: NEVER hardcode roles like "PM" or "Developer" in the logic. Always refer to the database `role` or `profession`.
2.  **Artifact Wrapping**: All generated content that is NOT a chat message (code, docs, plans) must be wrapped in `<artifact_content>`.
3.  **Database First**: Always favor database-driven configuration over local constants for agent behaviors and tools.
4.  **Schema Integrity**: When adding columns, ensure they are mirrored in the TypeScript types and follow the snake_case convention.
5.  **RLS Awareness**: Always assume Row Level Security is active. Ensure all queries filter by `office_id` or `admin_id`.
6.  **Aesthetics Matter**: UI components must adhere to the premium "Glassmorphism + Cyberpunk" aesthetic. Use existing color variables and gradients.

---

## 7. Useful Paths

*   `/src/app/api/...`: API Routes (Next.js App Router).
*   `/src/lib/agents/...`: LangGraph logic, prompts, and tool definitions.
*   `/src/components/...`: React UI components.
*   `/scripts/sql/...`: Database migration and seed scripts.
