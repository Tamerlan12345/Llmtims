/**
 * Sandbox: полный автономный цикл агентов без Supabase и LLM.
 * Симулирует routerNode → createRoleNode → validatorNode → END
 * с реальной логикой маршрутизации из graph.ts.
 *
 * Запуск: node scripts/sandbox-cycle.mjs
 */

import assert from "node:assert/strict";

// ─── Цвета для вывода ────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  white: "\x1b[37m",
};

const log = (color, label, msg) =>
  console.log(`${color}${C.bold}[${label}]${C.reset} ${color}${msg}${C.reset}`);

// ─── Реальная логика маршрутизации (копия из graph.ts) ───────────────────────

const normalizeRoleName = (value) => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const routeWorkflowState = (state) => {
  if (state.workflow_status === "completed" || normalizeRoleName(state.next_agent) === "END") {
    return "end";
  }
  if (state.waiting_for_human && !state.human_decision) {
    return "wait_human";
  }
  const nextAgent =
    normalizeRoleName(state.current_assignee) ?? normalizeRoleName(state.next_agent);
  if (!nextAgent || nextAgent === "WAIT_HUMAN") return "wait_human";
  if (nextAgent === "END") return "end";
  return nextAgent;
};

const routeFromValidatorState = (state, workflowRoles) => {
  if (state.workflow_status === "completed" || normalizeRoleName(state.next_agent) === "END") {
    return "end";
  }
  if (state.waiting_for_human && !state.human_decision) return "wait_human";
  const normalizedTaskStatus = String(state.task_status ?? state.route_status ?? "").trim().toLowerCase();
  if (normalizedTaskStatus === "rejected") {
    const retryRole = normalizeRoleName(state.current_assignee) ?? normalizeRoleName(state.next_agent);
    if (retryRole && workflowRoles.includes(retryRole)) return retryRole;
  }
  const nextRole = normalizeRoleName(state.current_assignee) ?? normalizeRoleName(state.next_agent);
  if (nextRole && workflowRoles.includes(nextRole)) return nextRole;
  return "router";
};

const routeFromRouterState = (state, workflowRoles) => {
  const routeFromState = routeWorkflowState(state);
  if (routeFromState === "end" || routeFromState === "wait_human") return routeFromState;
  if (workflowRoles.includes(routeFromState)) return routeFromState;
  const currentAssignee = normalizeRoleName(state.current_assignee);
  if (currentAssignee && workflowRoles.includes(currentAssignee)) return currentAssignee;
  return "wait_human";
};

// ─── Симуляция нод ────────────────────────────────────────────────────────────

const SCENARIO = {
  taskId: "sandbox-task-001",
  officeId: "mock-office",
  input: "Написать функцию сортировки на TypeScript с тестами",
  roles: ["PM", "Developer", "QA"],
  coordinatorRole: "PM",
};

/** Создаёт начальный AgentState */
const makeInitialState = () => ({
  task_id: SCENARIO.taskId,
  office_id: SCENARIO.officeId,
  messages: [{ type: "human", content: SCENARIO.input }],
  next_agent: null,
  current_assignee: null,
  artifacts: [],
  iterations: 0,
  workflow_mode: "autonomous",
  workflow_roles: SCENARIO.roles,
  coordinator_role: SCENARIO.coordinatorRole,
  completed_roles: [],
  pending_roles: [],
  routing_history: [],
  workflow_status: "running",
  waiting_for_human: false,
  human_decision: null,
  last_actor: null,
  task_status: null,
  route_status: null,
  error_message: null,
  installed_mcps: [],
  run_id: "sandbox-run-001",
});

/** Mock LLM ответы для каждой роли */
const MOCK_LLM_DECISIONS = {
  PM: {
    decision: { status: "completed", next_agent: "Developer", target: "Developer", summary: "Задача декомпозирована. Developer реализует алгоритм." },
    response: "Анализирую задачу. Нужна функция quickSort на TypeScript.\n\n**Plan:**\n1. Developer — реализация\n2. QA — тесты\n\n{\"status\":\"completed\",\"next_agent\":\"Developer\",\"target\":\"Developer\",\"summary\":\"Передаю разработчику\"}",
  },
  Developer: {
    decision: { status: "completed", next_agent: "QA", target: "QA", summary: "TypeScript функция готова, передаю на тестирование." },
    response: `Реализую quickSort:\n\`\`\`typescript\nfunction quickSort<T>(arr: T[]): T[] {\n  if (arr.length <= 1) return arr;\n  const pivot = arr[Math.floor(arr.length / 2)];\n  const left = arr.filter(x => x < pivot);\n  const mid = arr.filter(x => x === pivot);\n  const right = arr.filter(x => x > pivot);\n  return [...quickSort(left), ...mid, ...quickSort(right)];\n}\n\`\`\`\n\n{\"status\":\"completed\",\"next_agent\":\"QA\",\"target\":\"QA\",\"summary\":\"Функция готова, тестирую\"}`,
  },
  QA: {
    decision: { status: "done", next_agent: "END", target: null, summary: "Все тесты пройдены. Задача завершена." },
    response: `Тесты написаны и пройдены:\n\`\`\`typescript\ndescribe('quickSort', () => {\n  it('sorts numbers', () => expect(quickSort([3,1,2])).toEqual([1,2,3]));\n  it('handles empty', () => expect(quickSort([])).toEqual([]));\n  it('handles single', () => expect(quickSort([1])).toEqual([1]));\n});\n\`\`\`\n✅ 3/3 тестов пройдено\n\n{\"status\":\"done\",\"next_agent\":\"END\",\"target\":null,\"summary\":\"Задача завершена\"}`,
  },
};

const timeline = [];
const recordStep = (phase, role, title, detail = "") => {
  const entry = { time: new Date().toISOString(), phase, role, title, detail };
  timeline.push(entry);
  return entry;
};

// ─── Симуляция узлов ──────────────────────────────────────────────────────────

const simulateRouterNode = (state) => {
  recordStep("routing", "Router", "Workflow routing", `next_agent=${state.next_agent ?? "null"}`);
  log(C.cyan, "ROUTER", `Определяю следующего агента...`);

  let nextAgent = state.next_agent ?? SCENARIO.coordinatorRole;
  if (nextAgent === "WAIT_HUMAN" || !SCENARIO.roles.includes(nextAgent)) {
    nextAgent = SCENARIO.coordinatorRole;
  }

  const nextState = {
    ...state,
    next_agent: nextAgent,
    current_assignee: nextAgent,
    workflow_status: "running",
  };

  const route = routeFromRouterState(nextState, SCENARIO.roles);
  log(C.cyan, "ROUTER", `→ маршрут: ${C.bold}${route}${C.reset}${C.cyan}`);
  return { nextState, route };
};

const simulateRoleNode = (role, state) => {
  recordStep("execution", role, `${role} execution`, `task: ${SCENARIO.input.slice(0, 50)}...`);

  const mock = MOCK_LLM_DECISIONS[role];
  if (!mock) throw new Error(`No mock LLM for role: ${role}`);

  log(C.blue, role, `Вызов LLM (Gemini)... [mock]`);
  log(C.blue, role, `Ответ агента:`);
  console.log(C.dim + mock.response.slice(0, 200) + (mock.response.length > 200 ? "..." : "") + C.reset);

  const decision = mock.decision;
  log(C.blue, role, `Решение: status=${C.bold}${decision.status}${C.reset}${C.blue}, next=${decision.next_agent}`);

  // Simulate delegate_task call
  if (decision.next_agent && decision.next_agent !== "END") {
    log(C.blue, role, `📤 delegate_task → ${decision.next_agent}`);
    recordStep("tool_call", role, "delegate_task", `target=${decision.next_agent}`);
  }

  const artifact = {
    id: `${SCENARIO.taskId}-${role}-${Date.now()}`,
    role,
    skill: "code_generation",
    status: decision.status,
    summary: decision.summary,
    content: mock.response,
    createdAt: new Date().toISOString(),
  };

  const nextState = {
    ...state,
    next_agent: decision.next_agent,
    current_assignee: decision.next_agent === "END" ? null : decision.next_agent,
    completed_roles: [...(state.completed_roles ?? []), role],
    routing_history: [...(state.routing_history ?? []), role],
    artifacts: [...state.artifacts, artifact],
    last_actor: role,
    task_status: decision.status === "done" ? "done" : "in_progress",
    workflow_status: decision.next_agent === "END" ? "completed" : "running",
    messages: [
      ...state.messages,
      { type: "ai", content: mock.response },
    ],
    iterations: state.iterations + 1,
  };

  return nextState;
};

const simulateValidatorNode = (state) => {
  recordStep("validation", "Validator", "Validation", `last_actor=${state.last_actor}`);
  log(C.yellow, "VALIDATOR", `Проверяю результат от ${state.last_actor}...`);

  // Mock validation: pass
  const validationPassed = true;
  log(C.yellow, "VALIDATOR", `✅ Валидация пройдена`);
  recordStep("result", "Validator", "Validation passed", "all checks OK");

  const nextState = {
    ...state,
    workflow_status: state.next_agent === "END" ? "completed" : state.workflow_status,
    task_status: state.next_agent === "END" ? "done" : state.task_status,
  };

  const route = routeFromValidatorState(nextState, SCENARIO.roles);
  log(C.yellow, "VALIDATOR", `→ маршрут: ${C.bold}${route}${C.reset}${C.yellow}`);
  return { nextState, route };
};

// ─── Визуальный вывод состояния офиса ────────────────────────────────────────

const printOfficeState = (state, activeRole) => {
  const roles = SCENARIO.roles;
  const completedSet = new Set(state.completed_roles ?? []);

  console.log(`\n${C.bold}╔══════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}║  🏢 Digital Pixel Office — Task State               ║${C.reset}`);
  console.log(`${C.bold}╠══════════════════════════════════════════════════════╣${C.reset}`);
  for (const role of roles) {
    const isActive = role === activeRole;
    const isDone = completedSet.has(role);
    const icon = isActive ? "▶" : isDone ? "✅" : "○";
    const color = isActive ? C.green + C.bold : isDone ? C.dim : C.white;
    const status = isActive ? " ← ACTIVE" : isDone ? " done" : "";
    console.log(`${C.bold}║${C.reset}  ${color}${icon} ${role.padEnd(12)}${status}${C.reset}`);
  }
  console.log(`${C.bold}╠══════════════════════════════════════════════════════╣${C.reset}`);
  console.log(`${C.bold}║${C.reset}  Статус: ${C.green}${state.workflow_status}${C.reset}`);
  console.log(`${C.bold}║${C.reset}  Итерации: ${state.iterations}`);
  console.log(`${C.bold}║${C.reset}  Артефактов: ${state.artifacts.length}`);
  console.log(`${C.bold}╚══════════════════════════════════════════════════════╝${C.reset}\n`);
};

// ─── Главный цикл ─────────────────────────────────────────────────────────────

console.log(`\n${C.magenta}${C.bold}═══ SANDBOX: Автономный цикл агентов Pixel Office ═══${C.reset}`);
console.log(`${C.dim}Задача: ${SCENARIO.input}${C.reset}`);
console.log(`${C.dim}Роли: ${SCENARIO.roles.join(" → ")}${C.reset}\n`);

let state = makeInitialState();
let currentNode = "router";
let stepCount = 0;
const MAX_STEPS = 20;

while (currentNode !== "end" && stepCount < MAX_STEPS) {
  stepCount++;
  console.log(`\n${C.white}${C.dim}─── Шаг ${stepCount}: NODE=${currentNode} ─────────────────────${C.reset}`);

  if (currentNode === "router") {
    const { nextState, route } = simulateRouterNode(state);
    state = nextState;
    currentNode = route === "end" ? "end" : route === "wait_human" ? "wait_human" : route;
    printOfficeState(state, currentNode);

  } else if (currentNode === "wait_human") {
    log(C.red, "WAIT_HUMAN", "⏸ Ожидание решения пользователя (в симуляции — пропускаем)");
    break;

  } else if (SCENARIO.roles.includes(currentNode)) {
    const role = currentNode;
    printOfficeState(state, role);
    state = simulateRoleNode(role, state);
    currentNode = "workflow_validator";

  } else if (currentNode === "workflow_validator") {
    const { nextState, route } = simulateValidatorNode(state);
    state = nextState;
    currentNode = route === "end" ? "end" : route;

  } else {
    log(C.red, "ERROR", `Неизвестный узел: ${currentNode}`);
    break;
  }
}

// ─── Финальный результат ──────────────────────────────────────────────────────

console.log(`\n${C.green}${C.bold}═══ РЕЗУЛЬТАТ ЦИКЛА ═══${C.reset}\n`);
printOfficeState(state, null);

console.log(`${C.bold}Артефакты:${C.reset}`);
for (const artifact of state.artifacts) {
  console.log(`  ${C.green}✓${C.reset} [${artifact.role}] ${artifact.summary}`);
}

console.log(`\n${C.bold}Routing History:${C.reset} ${state.routing_history.join(" → ")} → END`);
console.log(`${C.bold}Workflow Status:${C.reset} ${C.green}${state.workflow_status}${C.reset}`);
console.log(`${C.bold}Итераций:${C.reset} ${state.iterations}`);

console.log(`\n${C.bold}E2E Timeline (${timeline.length} шагов):${C.reset}`);
for (const entry of timeline) {
  const phaseColor = {
    routing: C.cyan, execution: C.blue, tool_call: C.magenta,
    validation: C.yellow, result: C.green, approval: C.red,
  }[entry.phase] ?? C.white;
  console.log(`  ${phaseColor}[${entry.phase.toUpperCase().padEnd(10)}]${C.reset} ${entry.role.padEnd(12)} ${entry.title}`);
}

// ─── Assertions ───────────────────────────────────────────────────────────────

assert.equal(state.workflow_status, "completed", "workflow_status должен быть completed");
assert.deepEqual(state.routing_history, ["PM", "Developer", "QA"], "routing_history должен содержать всех агентов");
assert.equal(state.artifacts.length, 3, "должно быть 3 артефакта");
assert.equal(currentNode, "end", "цикл должен завершиться на END");
assert.equal(state.next_agent, "END", "next_agent должен быть END");

console.log(`\n${C.green}${C.bold}✅ Все assertions прошли — цикл автономен и замкнут.${C.reset}\n`);
