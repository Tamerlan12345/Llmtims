"use client";

import { KeyboardEvent, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import PixelAgentSprite, { BubbleType, SpriteDirection } from "@/components/PixelAgentSprite";
import {
  AgentMode,
  TaskStatus,
  resolveActivityLabel,
  resolveAgentMode,
  roleLabelRu,
} from "@/lib/office/engine";
import {
  PIXEL_OFFICE_VIEWPORT,
  TILE_TYPE_VOID,
  TILE_TYPE_WALL,
  buildAutoOnTiles,
  buildFurnitureInstances,
  getWallSpriteStyle,
  pixelOfficeRenderTiles,
  pixelOfficeSeatMap,
  pixelOfficeWalls,
} from "@/lib/office/pixelOfficeLayout";
import { useOfficeSimulation } from "@/lib/office/useOfficeSimulation";
import { repairMojibakeDeep, repairTextForDisplay } from "@/lib/text/repairMojibake";

interface OfficeAgent {
  id: string;
  name: string;
  role: string;
  is_active: boolean;
  skills?: string[];
}

interface OfficeAgentRuntimeState {
  status: string;
  current_action?: string | null;
  current_skill?: string | null;
  current_target_x?: number | null;
  current_target_y?: number | null;
  metadata?: Record<string, unknown> | null;
}

interface ActiveRoleTask {
  taskId: string;
  title: string;
  status: TaskStatus;
  workflowSignal?: string | null;
}

interface AgentTooltipState {
  agentId: string;
  x: number;
  y: number;
}

interface OfficeHubProps {
  agents: OfficeAgent[];
  taskStatus: TaskStatus;
  speakingAgentId?: string | null;
  interactionTargetRole?: string | null;
  agentTokenUsage?: Record<string, number>;
  agentRuntimeState?: Record<string, OfficeAgentRuntimeState>;
  activeTaskByRole?: Record<string, ActiveRoleTask>;
  officeName?: string;
  roomKey?: string | null;
  activeThreadId?: string | null;
}

type RoleKind = "coordinator" | "builder" | "qa" | "ops" | "general";

const pctX = (value: number) =>
  `${((value - PIXEL_OFFICE_VIEWPORT.x) / PIXEL_OFFICE_VIEWPORT.width) * 100}%`;
const pctY = (value: number) =>
  `${((value - PIXEL_OFFICE_VIEWPORT.y) / PIXEL_OFFICE_VIEWPORT.height) * 100}%`;
const pctW = (value: number) => `${(value / PIXEL_OFFICE_VIEWPORT.width) * 100}%`;
const pctH = (value: number) => `${(value / PIXEL_OFFICE_VIEWPORT.height) * 100}%`;

const paletteByRoleKind: Record<RoleKind, number> = {
  coordinator: 0,
  builder: 2,
  qa: 4,
  ops: 5,
  general: 1,
};

const roleAccentByKind: Record<RoleKind, string> = {
  coordinator: "#FDA4AF",
  builder: "#FB7185",
  qa: "#FDBA74",
  ops: "#F87171",
  general: "#FCA5A5",
};

interface McpServerNode {
  id: string;
  label: string;
  xPct: number;
  yPct: number;
  accent: string;
}

const MCP_SERVER_NODES: McpServerNode[] = [
  { id: "filesystem", label: "FS", xPct: 12, yPct: 84, accent: "#F59E0B" },
  { id: "github", label: "GitHub", xPct: 11, yPct: 15, accent: "#93C5FD" },
  { id: "railway", label: "Railway", xPct: 89, yPct: 16, accent: "#C4B5FD" },
  { id: "sandbox", label: "Sandbox", xPct: 89, yPct: 84, accent: "#86EFAC" },
  { id: "google-search", label: "Google", xPct: 51, yPct: 12, accent: "#FCA5A5" },
];

const statusMeta: Record<string, { label: string; className: string }> = repairMojibakeDeep({
  pending: { label: "В ожидании", className: "text-amber-200" },
  in_progress: { label: "В работе", className: "text-rose-200" },
  review: { label: "Ревью", className: "text-orange-200" },
  waiting_approval: { label: "Ждет подтверждения", className: "text-orange-200" },
  done: { label: "Готово", className: "text-emerald-200" },
  failed: { label: "Сбой", className: "text-red-200" },
});

const formatTokenCompact = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 50) return "<0.1к";
  const inK = value / 1000;
  if (value < 1000) return `${inK.toFixed(1)}к`;
  if (value < 10000) return `${inK.toFixed(1)}к`;
  return `${Math.round(inK)}к`;
};

const clamp = (value: number, min: number, max: number) => {
  if (Number.isNaN(value)) return min;
  if (max <= min) return min;
  return Math.min(max, Math.max(min, value));
};

const resolveRoleKind = (role: string): RoleKind => {
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
  if (normalized.length > 0) {
    return "builder";
  }
  return "general";
};

const isFocusedMode = (mode: AgentMode) =>
  mode === "typing" || mode === "testing" || mode === "monitoring" || mode === "debugging";

const resolveFallbackDirection = (
  role: string,
  mode: AgentMode,
  interactionTargetRole?: string | null
): SpriteDirection => {
  const roleKind = resolveRoleKind(role);
  if (mode === "discussing") {
    if (roleKind === "coordinator") return "right";
    if (role === interactionTargetRole) return "left";
  }

  if (mode === "typing" || mode === "testing" || mode === "monitoring" || mode === "debugging") {
    return "up";
  }

  if (mode === "walking") {
    return roleKind === "coordinator" || roleKind === "qa" ? "right" : "left";
  }

  return "down";
};

const resolveBubbleType = (
  role: string,
  mode: AgentMode,
  taskStatus: TaskStatus,
  speaking: boolean,
  isActive: boolean
): BubbleType | null => {
  const roleKind = resolveRoleKind(role);
  if (speaking) return null;
  if (taskStatus === "waiting_approval" && (roleKind === "coordinator" || isActive)) return "permission";
  if (taskStatus === "review" && roleKind === "qa") return "waiting";
  if (taskStatus === "done" && (roleKind === "ops" || isActive)) return "waiting";
  if (mode === "monitoring" && isActive) return "waiting";
  return null;
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
  if (runtimeStatus === "working") {
    if (roleKind === "qa") return "testing";
    if (roleKind === "ops") return "monitoring";
    return "typing";
  }
  return fallbackMode;
};

const compactSkillLabel = (value?: string | null): string | null => {
  if (!value) return null;
  const normalized = repairTextForDisplay(value).trim();
  if (!normalized) return null;
  return normalized.length <= 16 ? normalized : `${normalized.slice(0, 16).trim()}...`;
};

const resolveMcpServerByRuntime = (
  skill?: string | null,
  action?: string | null
): McpServerNode | null => {
  const haystack = `${skill ?? ""} ${action ?? ""}`.toLowerCase();
  if (!haystack.trim()) return null;

  if (haystack.includes("google")) {
    return MCP_SERVER_NODES.find((node) => node.id === "google-search") ?? null;
  }
  if (haystack.includes("github")) {
    return MCP_SERVER_NODES.find((node) => node.id === "github") ?? null;
  }
  if (haystack.includes("railway")) {
    return MCP_SERVER_NODES.find((node) => node.id === "railway") ?? null;
  }
  if (haystack.includes("sandbox")) {
    return MCP_SERVER_NODES.find((node) => node.id === "sandbox") ?? null;
  }
  if (haystack.includes("filesystem") || haystack.includes("file")) {
    return MCP_SERVER_NODES.find((node) => node.id === "filesystem") ?? null;
  }
  if (haystack.includes("mcp")) {
    return MCP_SERVER_NODES.find((node) => node.id === "sandbox") ?? null;
  }
  return null;
};

const resolveRenderMode = (mode: AgentMode, isMoving: boolean, isSeated: boolean): AgentMode => {
  if (isMoving) return "walking";
  if (mode === "discussing") return "discussing";
  if (isFocusedMode(mode)) return mode;
  if (isSeated) return "typing";
  if (mode === "celebrating") return "celebrating";
  return "watching_tv";
};

const resolveAssignedTaskMode = (role: string): AgentMode => {
  const roleKind = resolveRoleKind(role);
  if (roleKind === "qa") return "testing";
  if (roleKind === "ops") return "monitoring";
  return "typing";
};

const renderFloorTile = (tile: (typeof pixelOfficeRenderTiles)[number]) => {
  if (tile.type === TILE_TYPE_VOID) return null;
  const safeType = tile.type === 9 ? 8 : tile.type;

  const baseStyle = {
    left: pctX(tile.col * 16),
    top: pctY(tile.row * 16),
    width: pctW(16),
    height: pctH(16),
    zIndex: 1,
  } as const;

  if (tile.type === TILE_TYPE_WALL) {
    return (
      <div
        key={tile.key}
        className="absolute pixel-office-image"
        style={{
          ...baseStyle,
          backgroundColor: tile.colorHex ?? "#3B4652",
        }}
      />
    );
  }

  return (
    <div
      key={tile.key}
      className="absolute pixel-office-image"
      style={{
        ...baseStyle,
        backgroundImage: tile.colorHex
          ? `linear-gradient(${tile.colorHex}CC, ${tile.colorHex}CC), url('/pixel-office/assets/floors/floor_${safeType}.png')`
          : `url('/pixel-office/assets/floors/floor_${safeType}.png')`,
        backgroundBlendMode: tile.colorHex ? "multiply" : undefined,
        backgroundRepeat: "no-repeat",
        backgroundSize: "100% 100%",
      }}
    />
  );
};

export default function OfficeHub({
  agents,
  taskStatus,
  speakingAgentId,
  interactionTargetRole,
  agentTokenUsage = {},
  agentRuntimeState = {},
  activeTaskByRole = {},
  officeName = "Pixel Office CIC",
  roomKey,
  activeThreadId,
}: OfficeHubProps) {
  const [monitorFrame, setMonitorFrame] = useState(0);
  const [agentTooltip, setAgentTooltip] = useState<AgentTooltipState | null>(null);
  const officeSurfaceRef = useRef<HTMLDivElement | null>(null);
  const simulation = useOfficeSimulation(
    agents,
    taskStatus,
    activeTaskByRole,
    interactionTargetRole,
    agentRuntimeState,
    roomKey,
    activeThreadId
  );
  const status = statusMeta[taskStatus] ?? { label: repairTextForDisplay(taskStatus), className: "text-white" };
  const displayOfficeName = repairTextForDisplay(officeName);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setMonitorFrame((previous) => (previous + 1) % 3);
    }, 200);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!agentTooltip) return;
    if (agents.some((agent) => agent.id === agentTooltip.agentId)) return;
    setAgentTooltip(null);
  }, [agentTooltip, agents]);

  const activeMonitorSeats = useMemo(
    () =>
      agents.flatMap((agent) => {
        const discussing = Boolean(
          interactionTargetRole &&
            (resolveRoleKind(agent.role) === "coordinator" || agent.role === interactionTargetRole)
        );
        const assignedTask = activeTaskByRole[agent.role];
        const baseMode = discussing
          ? "discussing"
          : assignedTask
            ? resolveAssignedTaskMode(agent.role)
            : resolveAgentMode(agent.role, agent.is_active, taskStatus, false);
        const runtime = agentRuntimeState[agent.id];
        const mode = resolveRuntimeMode(
          agent.role,
          runtime?.status,
          runtime?.current_skill,
          runtime?.current_action,
          baseMode
        );
        if (!isFocusedMode(mode)) return [];
        if (!assignedTask || assignedTask.status !== "in_progress") return [];

        const seatId = simulation.seatAssignments[agent.id];
        if (!seatId) return [];
        const seat = pixelOfficeSeatMap.get(seatId);
        return seat ? [seat] : [];
      }),
    [activeTaskByRole, agentRuntimeState, agents, interactionTargetRole, simulation.seatAssignments, taskStatus]
  );

  const furnitureInstances = useMemo(
    () => buildFurnitureInstances(buildAutoOnTiles(activeMonitorSeats), monitorFrame),
    [activeMonitorSeats, monitorFrame]
  );

  const activeMcpLinks = useMemo(() => {
    return agents
      .map((agent) => {
        const actor = simulation.agents[agent.id];
        if (!actor) return null;
        const runtime = agentRuntimeState[agent.id];
        const server = resolveMcpServerByRuntime(runtime?.current_skill, runtime?.current_action);
        if (!server) return null;

        return {
          id: `${agent.id}-${server.id}`,
          agentId: agent.id,
          fromX: ((actor.x - PIXEL_OFFICE_VIEWPORT.x) / PIXEL_OFFICE_VIEWPORT.width) * 100,
          fromY:
            ((actor.y + (actor.isSeated ? 6 : 0) - PIXEL_OFFICE_VIEWPORT.y) / PIXEL_OFFICE_VIEWPORT.height) * 100,
          toX: server.xPct,
          toY: server.yPct,
          accent: server.accent,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  }, [agentRuntimeState, agents, simulation.agents]);

  const tooltipAgent = useMemo(
    () => (agentTooltip ? agents.find((agent) => agent.id === agentTooltip.agentId) ?? null : null),
    [agentTooltip, agents]
  );
  const tooltipSkills = useMemo(
    () =>
      Array.isArray(tooltipAgent?.skills)
        ? tooltipAgent.skills.filter((skill): skill is string => typeof skill === "string" && skill.trim().length > 0)
        : [],
    [tooltipAgent]
  );
  const tooltipAssignedTask = useMemo(
    () => (tooltipAgent ? activeTaskByRole[tooltipAgent.role] ?? null : null),
    [activeTaskByRole, tooltipAgent]
  );

  const openAgentTooltip = (
    agentId: string,
    event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>
  ) => {
    const rect = officeSurfaceRef.current?.getBoundingClientRect();
    const rawX = "clientX" in event ? event.clientX - (rect?.left ?? 0) : (rect?.width ?? 0) / 2;
    const rawY = "clientY" in event ? event.clientY - (rect?.top ?? 0) : (rect?.height ?? 0) / 2;
    const width = rect?.width ?? 0;
    const height = rect?.height ?? 0;
    const nextX = clamp(rawX + 12, 12, width > 260 ? width - 252 : 12);
    const nextY = clamp(rawY + 12, 12, height > 220 ? height - 208 : 12);

    setAgentTooltip((previous) => {
      if (previous?.agentId === agentId) return null;
      return { agentId, x: nextX, y: nextY };
    });
  };

  return (
    <section className="relative h-[calc(100vh-260px)] min-h-[620px] overflow-hidden rounded-[28px] border border-[var(--office-border)] bg-[var(--office-panel)] pixel-office-shadow">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_12%,rgba(251,113,133,0.20),transparent_28%),radial-gradient(circle_at_84%_8%,rgba(239,68,68,0.18),transparent_30%),linear-gradient(180deg,#15080b_0%,#0e0607_58%,#080304_100%)]" />
      <div className="absolute inset-0 pixel-office-noise opacity-70" />
      <div className="absolute inset-0 pixel-office-scanlines opacity-20" />

      <div className="absolute left-4 top-4 z-50 rounded-sm border border-red-300/25 bg-black/55 px-3 py-2">
        <div className="pixel-office-font text-[11px] uppercase tracking-[0.18em] text-red-50">
          {displayOfficeName}
        </div>
        <div className="mt-1 text-[10px] uppercase tracking-[0.22em] text-red-100/60">
          1 этаж кабинет 33
        </div>
      </div>

      <div className="absolute right-4 top-4 z-50 rounded-sm border border-red-300/25 bg-black/55 px-3 py-2 text-right">
        <div className="text-[10px] uppercase tracking-[0.22em] text-red-100/65">Стадия</div>
        <div className={`pixel-office-font mt-1 text-xs uppercase ${status.className}`}>{status.label}</div>
      </div>

      <div className="absolute inset-3 sm:inset-4 lg:inset-5">
        <motion.div
          ref={officeSurfaceRef}
          initial={{ opacity: 0, scale: 0.985, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.42, ease: "easeOut" }}
          className="relative h-full w-full overflow-hidden rounded-[24px] border border-white/10 bg-[#11090b] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setAgentTooltip(null);
            }
          }}
        >
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_52%_44%,rgba(248,113,113,0.10),transparent_26%),linear-gradient(180deg,rgba(255,255,255,0.02),transparent_18%,rgba(0,0,0,0.12)_100%)]" />

          {activeMcpLinks.length > 0 ? (
            <svg className="absolute inset-0 z-[12] h-full w-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
              {activeMcpLinks.map((link) => (
                <line
                  key={link.id}
                  x1={link.fromX}
                  y1={link.fromY}
                  x2={link.toX}
                  y2={link.toY}
                  stroke={link.accent}
                  strokeOpacity={0.68}
                  strokeWidth={0.22}
                  strokeDasharray="1.8 1.2"
                  className="office-link-pulse"
                />
              ))}
            </svg>
          ) : null}

          <div className="absolute inset-0 z-[13] pointer-events-none">
            {MCP_SERVER_NODES.map((node) => {
              const active = activeMcpLinks.some((link) => link.id.endsWith(`-${node.id}`));
              return (
                <div
                  key={node.id}
                  className="absolute -translate-x-1/2 -translate-y-1/2 rounded-md border px-2 py-1 text-[8px] uppercase tracking-[0.14em] backdrop-blur-sm"
                  style={{
                    left: `${node.xPct}%`,
                    top: `${node.yPct}%`,
                    borderColor: active ? `${node.accent}` : "rgba(255,255,255,0.22)",
                    background: active ? `${node.accent}22` : "rgba(0,0,0,0.46)",
                    color: active ? "#fff6f7" : "rgba(255,228,235,0.78)",
                    boxShadow: active ? `0 0 14px ${node.accent}55` : undefined,
                  }}
                >
                  {node.label}
                </div>
              );
            })}
          </div>

          {pixelOfficeRenderTiles.map(renderFloorTile)}

          {pixelOfficeWalls.map((wall) => (
            <div
              key={wall.key}
              className="absolute pixel-office-image"
              style={{
                left: pctX(wall.x),
                top: pctY(wall.y),
                width: pctW(wall.width),
                height: pctH(wall.height),
                zIndex: wall.zY,
                ...getWallSpriteStyle(wall.frameIndex),
              }}
            />
          ))}

          {furnitureInstances.map((item) => (
            <img
              key={item.uid}
              src={item.src}
              alt=""
              aria-hidden="true"
              className={`absolute pixel-office-image ${item.isMonitorOn ? "pixel-office-monitor-on" : ""}`}
              style={{
                left: pctX(item.x),
                top: pctY(item.y),
                width: pctW(item.width),
                height: pctH(item.height),
                zIndex: item.zY,
                transform: item.mirrored ? "scaleX(-1)" : undefined,
                transformOrigin: "center",
              }}
              draggable={false}
            />
          ))}

          {agents.map((agent, index) => {
            const actor = simulation.agents[agent.id];
            if (!actor) return null;
            const runtimeState = agentRuntimeState[agent.id];
            const assignedTask = activeTaskByRole[agent.role];

            const discussing = Boolean(
              interactionTargetRole &&
                (resolveRoleKind(agent.role) === "coordinator" || agent.role === interactionTargetRole)
            );
            const baseMode = discussing
              ? "discussing"
              : assignedTask
                ? resolveAssignedTaskMode(agent.role)
                : resolveAgentMode(agent.role, agent.is_active, taskStatus, false);
            const effectiveMode = resolveRuntimeMode(
              agent.role,
              runtimeState?.status,
              runtimeState?.current_skill,
              runtimeState?.current_action,
              baseMode
            );
            const renderMode = resolveRenderMode(effectiveMode, actor.isMoving, actor.isSeated);
            const speaking = speakingAgentId === agent.id;
            const direction =
              actor.direction ??
              resolveFallbackDirection(agent.role, renderMode, interactionTargetRole);
            const bubbleType = assignedTask
              ? resolveBubbleType(agent.role, effectiveMode, assignedTask.status, speaking, true)
              : null;
            const roleKind = resolveRoleKind(agent.role);
            const paletteIndex =
              roleKind === "general" ? index % 6 : paletteByRoleKind[roleKind];
            const accent = roleAccentByKind[roleKind];
            const skillLabel = compactSkillLabel(runtimeState?.current_skill);
            const activityLabel =
              repairTextForDisplay(runtimeState?.current_action ?? "").trim() ||
              (assignedTask
                ? `Сейчас работает над: ${repairTextForDisplay(assignedTask.title)}`
                : resolveActivityLabel(agent.role, effectiveMode));
            const left = pctX(actor.x);
            const top = pctY(actor.y + (actor.isSeated ? 6 : 0));

            return (
              <div
                key={agent.id}
                className="absolute flex flex-col items-center"
                style={{
                  left,
                  top,
                  zIndex: Math.round(actor.zY + 6),
                  transform: "translate(-50%, -100%)",
                }}
              >
                {speaking ? (
                  <div className="pixel-office-font mb-1 rounded-sm border border-red-200/55 bg-red-500/20 px-2 py-0.5 text-[9px] uppercase tracking-[0.15em] text-red-50">Говорит</div>
                ) : null}
                {skillLabel ? (
                  <div
                    className="pixel-office-font mb-1 rounded-sm border px-2 py-0.5 text-[8px] uppercase tracking-[0.12em]"
                    style={{
                      borderColor: `${accent}99`,
                      background: `${accent}22`,
                      color: "#fff4f5",
                    }}
                  >
                    {skillLabel}
                  </div>
                ) : null}
                {simulation.thoughtByAgentId[agent.id]?.text ? (
                  <div className="pixel-office-font mb-1 rounded-md border border-white/20 bg-black/75 px-2 py-1 text-[8px] text-rose-50 shadow-[0_6px_16px_rgba(0,0,0,0.35)]">
                    {simulation.thoughtByAgentId[agent.id].text}
                  </div>
                ) : null}

                <div
                  className="absolute bottom-2 h-8 w-8 rounded-full blur-xl"
                  style={{ backgroundColor: `${accent}40`, zIndex: -1 }}
                />

                <PixelAgentSprite
                  role={agent.role}
                  mode={renderMode}
                  speaking={speaking}
                  paletteIndex={paletteIndex}
                  direction={direction}
                  bubbleType={bubbleType}
                  onClick={(event) => openAgentTooltip(agent.id, event)}
                />

                <div className="mt-1 min-w-[98px] max-w-[132px] rounded-[10px] border border-white/10 bg-black/72 px-2 py-1 text-center shadow-[0_10px_24px_rgba(0,0,0,0.22)] backdrop-blur-[2px]">
                  <div className="text-[10px] font-semibold leading-none text-red-50">
                    {repairTextForDisplay(agent.name)} • {roleLabelRu(agent.role)} • {formatTokenCompact(agentTokenUsage[agent.id] ?? 0)}
                  </div>
                  <div
                    className="pixel-office-font mt-1 text-[8px] uppercase tracking-[0.14em]"
                    style={{ color: accent }}
                  >
                    {activityLabel}
                  </div>
                </div>
              </div>
            );
          })}

          {agentTooltip && tooltipAgent ? (
            <div
              className="pointer-events-none absolute z-[999] w-[240px] rounded-[10px] border border-red-200/35 bg-black/90 px-3 py-2 text-left shadow-[0_14px_30px_rgba(0,0,0,0.45)]"
              style={{
                left: `${agentTooltip.x}px`,
                top: `${agentTooltip.y}px`,
              }}
            >
              <div className="text-xs font-semibold text-red-50">{repairTextForDisplay(tooltipAgent.name)}</div>
              <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-rose-100/70">
                Роль: {roleLabelRu(tooltipAgent.role)}
              </div>
              {tooltipAssignedTask ? (
                <>
                  <div className="mt-2 text-[10px] uppercase tracking-[0.14em] text-rose-100/55">
                    Сейчас работает над
                  </div>
                  <div className="mt-1 text-[11px] text-rose-50/90">{repairTextForDisplay(tooltipAssignedTask.title)}</div>
                </>
              ) : null}
              <div className="mt-2 text-[10px] uppercase tracking-[0.14em] text-rose-100/55">
                Установленные скиллы
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {tooltipSkills.length > 0 ? (
                  tooltipSkills.map((skill) => (
                    <span
                      key={`${tooltipAgent.id}-${skill}`}
                      className="rounded-md px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]"
                      style={{
                        background: "rgba(194,21,90,0.16)",
                        border: "1px solid rgba(194,21,90,0.30)",
                        color: "rgba(255,228,235,0.9)",
                      }}
                    >
                      {repairTextForDisplay(skill)}
                    </span>
                  ))
                ) : (
                  <span className="text-[11px] text-rose-100/55">Скиллы не назначены</span>
                )}
              </div>
            </div>
          ) : null}
        </motion.div>
      </div>
    </section>
  );
}




