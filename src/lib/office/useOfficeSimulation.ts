"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AgentMode, TaskStatus, resolveAgentMode } from "./engine";
import {
  PixelDirection,
  PixelOfficeSeat,
  TILE_SIZE,
  TilePoint,
  buildAgentSeatAssignments,
  directionBetween,
  findPath,
  pixelOfficeBlockedTiles,
  pixelOfficeSeatMap,
  pixelOfficeWalkableTiles,
  toWorldCenter,
} from "./pixelOfficeLayout";

type BehaviorKind = "work" | "roam" | "meeting";
type SimState = "type" | "idle" | "walk";

interface OfficeAgentInput {
  id: string;
  role: string;
  is_active: boolean;
}

interface OfficeAgentRuntimeInput {
  status?: string | null;
  current_action?: string | null;
  current_skill?: string | null;
}

interface OfficeAgentTaskInput {
  taskId: string;
  title: string;
  status: TaskStatus;
  workflowSignal?: string | null;
}

interface SimAgentState {
  id: string;
  role: string;
  tileCol: number;
  tileRow: number;
  x: number;
  y: number;
  direction: PixelDirection;
  path: TilePoint[];
  moveProgress: number;
  state: SimState;
  seatId: string | null;
  wanderTimer: number;
  wanderCount: number;
  wanderLimit: number;
  seatTimer: number;
  goalKey: string | null;
  behavior: BehaviorKind;
}

export interface SimAgentSnapshot {
  id: string;
  x: number;
  y: number;
  direction: PixelDirection;
  isMoving: boolean;
  isSeated: boolean;
  seatId: string | null;
  zY: number;
}

const WALK_SPEED_PX_PER_SEC = 48;
const MAX_DELTA_TIME_SEC = 0.1;
const WANDER_PAUSE_MIN_SEC = 2.0;
const WANDER_PAUSE_MAX_SEC = 20.0;
const WANDER_MOVES_BEFORE_REST_MIN = 3;
const WANDER_MOVES_BEFORE_REST_MAX = 6;
const SEAT_REST_MIN_SEC = 120.0;
const SEAT_REST_MAX_SEC = 240.0;

const MEETING_POINTS: Record<"PM" | "Peer", TilePoint> = {
  PM: { col: 12, row: 17 },
  Peer: { col: 16, row: 17 },
};

const randomRange = (min: number, max: number) => min + Math.random() * (max - min);
const randomInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const toKey = ({ col, row }: TilePoint) => `${col},${row}`;

const isFocusedMode = (mode: AgentMode) =>
  mode === "typing" || mode === "testing" || mode === "monitoring" || mode === "debugging";

const resolveBehavior = (mode: AgentMode): BehaviorKind => {
  if (mode === "discussing") return "meeting";
  if (isFocusedMode(mode)) return "work";
  return "roam";
};

const resolveAssignedTaskMode = (role: string): AgentMode => {
  const roleKind = resolveRoleKind(role);
  if (roleKind === "qa") return "testing";
  if (roleKind === "ops") return "monitoring";
  return "typing";
};

const resolveRoleKind = (role: string): "coordinator" | "builder" | "qa" | "ops" => {
  const normalized = role.trim().toLowerCase();
  if (
    normalized.includes("pm") ||
    normalized.includes("ceo") ||
    normalized.includes("manager") ||
    normalized.includes("lead") ||
    normalized.includes("owner") ||
    normalized.includes("expert")
  ) {
    return "coordinator";
  }
  if (normalized.includes("qa") || normalized.includes("test")) {
    return "qa";
  }
  if (
    normalized.includes("devops") ||
    normalized.includes("ops") ||
    normalized.includes("sre") ||
    normalized.includes("infra") ||
    normalized.includes("platform")
  ) {
    return "ops";
  }
  return "builder";
};

const resolveRuntimeMode = (
  role: string,
  runtimeStatus: string | null | undefined,
  runtimeSkill: string | null | undefined,
  runtimeAction: string | null | undefined,
  fallbackMode: AgentMode
): AgentMode => {
  const haystack = `${runtimeSkill ?? ""} ${runtimeAction ?? ""}`.toLowerCase();
  const isMcpOperation =
    haystack.includes("mcp") ||
    haystack.includes("sandbox") ||
    haystack.includes("railway") ||
    haystack.includes("github") ||
    haystack.includes("google") ||
    haystack.includes("filesystem");
  if (isMcpOperation) return "monitoring";

  const roleKind = resolveRoleKind(role);
  if (runtimeStatus === "error") return "debugging";
  if (runtimeStatus === "typing") return "typing";
  if (runtimeStatus === "working") {
    if (roleKind === "qa") return "testing";
    if (roleKind === "ops") return "monitoring";
    return "typing";
  }
  if (runtimeStatus === "waiting") {
    return roleKind === "coordinator" ? "typing" : fallbackMode;
  }
  if (runtimeStatus === "offline") return "watching_tv";
  return fallbackMode;
};

const resolveMeetingDirection = (role: string, interactionTargetRole?: string | null): PixelDirection => {
  if (role === "PM") return "right";
  if (role === interactionTargetRole) return "left";
  return "down";
};

const resolveIdleDirection = (seat: PixelOfficeSeat | null): PixelDirection => seat?.facingDir ?? "down";

const createAgentState = (agent: OfficeAgentInput, seatId: string | null): SimAgentState => {
  const seat = seatId ? pixelOfficeSeatMap.get(seatId) ?? null : null;
  const spawnPoint = seat ? { col: seat.seatCol, row: seat.seatRow } : pixelOfficeWalkableTiles[0] ?? { col: 1, row: 1 };
  const world = toWorldCenter(spawnPoint);

  return {
    id: agent.id,
    role: agent.role,
    tileCol: spawnPoint.col,
    tileRow: spawnPoint.row,
    x: world.x,
    y: world.y,
    direction: resolveIdleDirection(seat),
    path: [],
    moveProgress: 0,
    state: "idle",
    seatId,
    wanderTimer: randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC),
    wanderCount: 0,
    wanderLimit: randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX),
    seatTimer: 0,
    goalKey: null,
    behavior: "roam",
  };
};

const syncActors = (
  current: Record<string, SimAgentState>,
  agents: OfficeAgentInput[],
  seatAssignments: Record<string, string | null>
) => {
  const next: Record<string, SimAgentState> = {};

  for (const agent of agents) {
    const existing = current[agent.id] ?? createAgentState(agent, seatAssignments[agent.id] ?? null);
    existing.role = agent.role;
    existing.seatId = seatAssignments[agent.id] ?? null;
    next[agent.id] = existing;
  }

  return next;
};

const advanceWalk = (actor: SimAgentState, dt: number) => {
  const nextTile = actor.path[0];
  if (!nextTile) {
    const center = toWorldCenter({ col: actor.tileCol, row: actor.tileRow });
    actor.x = center.x;
    actor.y = center.y;
    actor.moveProgress = 0;
    return true;
  }

  actor.direction = directionBetween({ col: actor.tileCol, row: actor.tileRow }, nextTile);
  actor.moveProgress += (WALK_SPEED_PX_PER_SEC / TILE_SIZE) * dt;

  const from = toWorldCenter({ col: actor.tileCol, row: actor.tileRow });
  const to = toWorldCenter(nextTile);
  const progress = Math.min(actor.moveProgress, 1);
  actor.x = from.x + (to.x - from.x) * progress;
  actor.y = from.y + (to.y - from.y) * progress;

  if (actor.moveProgress >= 1) {
    actor.tileCol = nextTile.col;
    actor.tileRow = nextTile.row;
    actor.x = to.x;
    actor.y = to.y;
    actor.path.shift();
    actor.moveProgress = 0;
  }

  return actor.path.length === 0 && actor.moveProgress === 0;
};

const ensurePath = (
  actor: SimAgentState,
  target: TilePoint,
  allowBlockedTarget = false
) => {
  const targetKey = toKey(target);
  if (actor.tileCol === target.col && actor.tileRow === target.row) {
    actor.goalKey = targetKey;
    actor.path = [];
    actor.moveProgress = 0;
    return false;
  }

  const lastStep = actor.path[actor.path.length - 1];
  if (actor.goalKey === targetKey && lastStep && lastStep.col === target.col && lastStep.row === target.row) {
    return actor.path.length > 0;
  }

  actor.goalKey = targetKey;
  actor.path = findPath(
    { col: actor.tileCol, row: actor.tileRow },
    target,
    pixelOfficeBlockedTiles,
    allowBlockedTarget ? targetKey : null
  );
  actor.moveProgress = 0;
  return actor.path.length > 0;
};

const setTypeState = (actor: SimAgentState, seat: PixelOfficeSeat | null, seatTimer = 0) => {
  actor.state = "type";
  actor.direction = resolveIdleDirection(seat);
  actor.path = [];
  actor.moveProgress = 0;
  actor.goalKey = seat ? toKey({ col: seat.seatCol, row: seat.seatRow }) : null;
  actor.seatTimer = seatTimer;
};

const setIdleState = (actor: SimAgentState, direction?: PixelDirection) => {
  actor.state = "idle";
  actor.path = [];
  actor.moveProgress = 0;
  actor.goalKey = null;
  if (direction) {
    actor.direction = direction;
  }
};

const updateWorkBehavior = (actor: SimAgentState, seat: PixelOfficeSeat | null, dt: number) => {
  if (!seat) {
    setIdleState(actor);
    return;
  }

  if (actor.tileCol === seat.seatCol && actor.tileRow === seat.seatRow && actor.state !== "walk") {
    setTypeState(actor, seat);
    return;
  }

  if (actor.state !== "walk") {
    const hasPath = ensurePath(actor, { col: seat.seatCol, row: seat.seatRow }, true);
    if (hasPath) {
      actor.state = "walk";
    } else {
      setTypeState(actor, seat);
    }
    return;
  }

  const arrived = advanceWalk(actor, dt);
  if (arrived) {
    if (actor.tileCol === seat.seatCol && actor.tileRow === seat.seatRow) {
      setTypeState(actor, seat);
    } else {
      setIdleState(actor);
    }
  }
};

const updateMeetingBehavior = (
  actor: SimAgentState,
  role: string,
  interactionTargetRole: string | null | undefined,
  dt: number
) => {
  const target = role === "PM" ? MEETING_POINTS.PM : MEETING_POINTS.Peer;
  const facing = resolveMeetingDirection(role, interactionTargetRole);

  if (actor.tileCol === target.col && actor.tileRow === target.row && actor.state !== "walk") {
    setIdleState(actor, facing);
    return;
  }

  if (actor.state !== "walk") {
    const hasPath = ensurePath(actor, target, false);
    if (hasPath) {
      actor.state = "walk";
    } else {
      setIdleState(actor, facing);
    }
    return;
  }

  const arrived = advanceWalk(actor, dt);
  if (arrived) {
    setIdleState(actor, facing);
  }
};

const updateRoamBehavior = (actor: SimAgentState, seat: PixelOfficeSeat | null, dt: number) => {
  if (actor.state === "type") {
    actor.seatTimer -= dt;
    if (actor.seatTimer <= 0) {
      actor.seatTimer = 0;
      setIdleState(actor, resolveIdleDirection(seat));
      actor.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
    }
    return;
  }

  if (actor.state === "walk") {
    const arrived = advanceWalk(actor, dt);
    if (!arrived) return;

    if (seat && actor.tileCol === seat.seatCol && actor.tileRow === seat.seatRow) {
      setTypeState(actor, seat, randomRange(SEAT_REST_MIN_SEC, SEAT_REST_MAX_SEC));
      actor.wanderCount = 0;
      actor.wanderLimit = randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX);
    } else {
      setIdleState(actor);
      actor.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
    }
    return;
  }

  actor.wanderTimer -= dt;
  if (actor.wanderTimer > 0) {
    return;
  }

  if (seat && actor.wanderCount >= actor.wanderLimit) {
    const hasPath = ensurePath(actor, { col: seat.seatCol, row: seat.seatRow }, true);
    if (hasPath) {
      actor.state = "walk";
    } else {
      setTypeState(actor, seat, randomRange(SEAT_REST_MIN_SEC, SEAT_REST_MAX_SEC));
      actor.wanderCount = 0;
    }
    actor.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
    return;
  }

  const target = pixelOfficeWalkableTiles[Math.floor(Math.random() * pixelOfficeWalkableTiles.length)];
  if (target) {
    const hasPath = ensurePath(actor, target, false);
    if (hasPath) {
      actor.state = "walk";
      actor.wanderCount += 1;
    }
  }

  actor.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
};

export const useOfficeSimulation = (
  agents: OfficeAgentInput[],
  taskStatus: TaskStatus,
  activeTaskByRole: Record<string, OfficeAgentTaskInput> = {},
  interactionTargetRole?: string | null,
  runtimeStateByAgentId: Record<string, OfficeAgentRuntimeInput> = {}
) => {
  const [snapshot, setSnapshot] = useState<Record<string, SimAgentSnapshot>>({});
  const actorsRef = useRef<Record<string, SimAgentState>>({});
  const seatAssignments = useMemo(
    () => buildAgentSeatAssignments((agents || []).map((agent) => ({ id: agent.id, role: agent.role }))),
    [agents]
  );

  useEffect(() => {
    actorsRef.current = syncActors(actorsRef.current, agents || [], seatAssignments);
  }, [agents, seatAssignments]);

  useEffect(() => {
    let frame = 0;
    let previous = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - previous) / 1000, MAX_DELTA_TIME_SEC);
      previous = now;
      const nextActors = { ...actorsRef.current };

      for (const agent of (agents || [])) {
        const actor = nextActors[agent.id] ?? createAgentState(agent, seatAssignments[agent.id] ?? null);
        const discussing = Boolean(
          interactionTargetRole && (agent.role === "PM" || agent.role === interactionTargetRole)
        );
        const assignedTask = activeTaskByRole[agent.role];
        const fallbackMode = discussing
          ? "discussing"
          : assignedTask
            ? resolveAssignedTaskMode(agent.role)
            : resolveAgentMode(agent.role, agent.is_active, taskStatus, false);
        const runtime = runtimeStateByAgentId[agent.id];
        const effectiveMode = resolveRuntimeMode(
          agent.role,
          runtime?.status,
          runtime?.current_skill,
          runtime?.current_action,
          fallbackMode
        );
        const behavior = resolveBehavior(effectiveMode);
        const seat = actor.seatId ? pixelOfficeSeatMap.get(actor.seatId) ?? null : null;

        if (behavior !== actor.behavior) {
          actor.goalKey = null;
          actor.path = [];
          actor.moveProgress = 0;
          if (behavior === "roam" && actor.state === "type") {
            actor.state = "idle";
            actor.seatTimer = 0;
            actor.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
          }
        }

        actor.behavior = behavior;

        if (behavior === "work") {
          updateWorkBehavior(actor, seat, dt);
        } else if (behavior === "meeting") {
          updateMeetingBehavior(actor, agent.role, interactionTargetRole, dt);
        } else {
          updateRoamBehavior(actor, seat, dt);
        }

        nextActors[agent.id] = actor;
      }

      actorsRef.current = nextActors;
      setSnapshot(
        Object.fromEntries(
          Object.values(nextActors).map((actor) => [
            actor.id,
            {
              id: actor.id,
              x: actor.x,
              y: actor.y,
              direction: actor.direction,
              isMoving: actor.state === "walk",
              isSeated:
                actor.state === "type" &&
                Boolean(
                  actor.seatId &&
                    (() => {
                      const seat = pixelOfficeSeatMap.get(actor.seatId);
                      return seat && seat.seatCol === actor.tileCol && seat.seatRow === actor.tileRow;
                    })()
                ),
              seatId: actor.seatId,
              zY: actor.y + TILE_SIZE / 2 + 0.5,
            } satisfies SimAgentSnapshot,
          ])
        )
      );

      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [activeTaskByRole, agents, interactionTargetRole, runtimeStateByAgentId, seatAssignments, taskStatus]);

  return {
    agents: snapshot,
    seatAssignments,
  };
};
