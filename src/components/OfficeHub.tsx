"use client";

import { useEffect, useMemo, useState } from "react";
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

interface OfficeHubProps {
  agents: OfficeAgent[];
  taskStatus: TaskStatus;
  speakingAgentId?: string | null;
  interactionTargetRole?: string | null;
  agentTokenUsage?: Record<string, number>;
  agentRuntimeState?: Record<string, OfficeAgentRuntimeState>;
  officeName?: string;
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

const statusMeta: Record<string, { label: string; className: string }> = {
  pending: { label: "В ожидании", className: "text-amber-200" },
  in_progress: { label: "В работе", className: "text-rose-200" },
  review: { label: "Ревью", className: "text-orange-200" },
  waiting_approval: { label: "Ждет подтверждения", className: "text-orange-200" },
  done: { label: "Готово", className: "text-emerald-200" },
  failed: { label: "Сбой", className: "text-red-200" },
};

const formatTokenCompact = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 50) return "<0.1к";
  const inK = value / 1000;
  if (value < 1000) return `${inK.toFixed(1)}к`;
  if (value < 10000) return `${inK.toFixed(1)}к`;
  return `${Math.round(inK)}к`;
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
  fallbackMode: AgentMode
): AgentMode => {
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
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.length <= 16 ? normalized : `${normalized.slice(0, 16).trim()}...`;
};

const resolveRenderMode = (mode: AgentMode, isMoving: boolean, isSeated: boolean): AgentMode => {
  if (isMoving) return "walking";
  if (mode === "discussing") return "discussing";
  if (isFocusedMode(mode)) return mode;
  if (isSeated) return "typing";
  if (mode === "celebrating") return "celebrating";
  return "watching_tv";
};

const renderFloorTile = (tile: (typeof pixelOfficeRenderTiles)[number]) => {
  if (tile.type === TILE_TYPE_VOID) return null;

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
          ? `linear-gradient(${tile.colorHex}CC, ${tile.colorHex}CC), url('/pixel-office/assets/floors/floor_${tile.type}.png')`
          : `url('/pixel-office/assets/floors/floor_${tile.type}.png')`,
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
  officeName = "Pixel Office CIC",
}: OfficeHubProps) {
  const [monitorFrame, setMonitorFrame] = useState(0);
  const [activeAgentPopoverId, setActiveAgentPopoverId] = useState<string | null>(null);
  const simulation = useOfficeSimulation(agents, taskStatus, interactionTargetRole);
  const status = statusMeta[taskStatus] ?? { label: taskStatus, className: "text-white" };

  useEffect(() => {
    const timer = window.setInterval(() => {
      setMonitorFrame((previous) => (previous + 1) % 3);
    }, 200);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!activeAgentPopoverId) return;
    if (agents.some((agent) => agent.id === activeAgentPopoverId)) return;
    setActiveAgentPopoverId(null);
  }, [activeAgentPopoverId, agents]);

  const activeMonitorSeats = useMemo(
    () =>
      agents.flatMap((agent) => {
        const discussing = Boolean(
          interactionTargetRole &&
            (resolveRoleKind(agent.role) === "coordinator" || agent.role === interactionTargetRole)
        );
        const mode = resolveAgentMode(agent.role, agent.is_active, taskStatus, discussing);
        if (!isFocusedMode(mode)) return [];

        const seatId = simulation.seatAssignments[agent.id];
        if (!seatId) return [];
        const seat = pixelOfficeSeatMap.get(seatId);
        return seat ? [seat] : [];
      }),
    [agents, interactionTargetRole, simulation.seatAssignments, taskStatus]
  );

  const furnitureInstances = useMemo(
    () => buildFurnitureInstances(buildAutoOnTiles(activeMonitorSeats), monitorFrame),
    [activeMonitorSeats, monitorFrame]
  );

  return (
    <section className="relative h-[calc(100vh-260px)] min-h-[620px] overflow-hidden rounded-[28px] border border-[var(--office-border)] bg-[var(--office-panel)] pixel-office-shadow">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_12%,rgba(251,113,133,0.20),transparent_28%),radial-gradient(circle_at_84%_8%,rgba(239,68,68,0.18),transparent_30%),linear-gradient(180deg,#15080b_0%,#0e0607_58%,#080304_100%)]" />
      <div className="absolute inset-0 pixel-office-noise opacity-70" />
      <div className="absolute inset-0 pixel-office-scanlines opacity-20" />

      <div className="absolute left-4 top-4 z-50 rounded-sm border border-red-300/25 bg-black/55 px-3 py-2">
        <div className="pixel-office-font text-[11px] uppercase tracking-[0.18em] text-red-50">
          {officeName}
        </div>
        <div className="mt-1 text-[10px] uppercase tracking-[0.22em] text-red-100/60">
          1 этаж Кабинет 33
        </div>
      </div>

      <div className="absolute right-4 top-4 z-50 rounded-sm border border-red-300/25 bg-black/55 px-3 py-2 text-right">
        <div className="text-[10px] uppercase tracking-[0.22em] text-red-100/65">Стадия</div>
        <div className={`pixel-office-font mt-1 text-xs uppercase ${status.className}`}>{status.label}</div>
      </div>

      <div className="absolute inset-3 sm:inset-4 lg:inset-5">
        <motion.div
          initial={{ opacity: 0, scale: 0.985, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.42, ease: "easeOut" }}
          className="relative h-full w-full overflow-hidden rounded-[24px] border border-white/10 bg-[#11090b] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]"
        >
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_52%_44%,rgba(248,113,113,0.10),transparent_26%),linear-gradient(180deg,rgba(255,255,255,0.02),transparent_18%,rgba(0,0,0,0.12)_100%)]" />

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

            const discussing = Boolean(
              interactionTargetRole &&
                (resolveRoleKind(agent.role) === "coordinator" || agent.role === interactionTargetRole)
            );
            const baseMode = resolveAgentMode(agent.role, agent.is_active, taskStatus, discussing);
            const effectiveMode = resolveRuntimeMode(agent.role, runtimeState?.status, baseMode);
            const renderMode = resolveRenderMode(effectiveMode, actor.isMoving, actor.isSeated);
            const speaking = speakingAgentId === agent.id;
            const direction =
              actor.direction ??
              resolveFallbackDirection(agent.role, renderMode, interactionTargetRole);
            const bubbleType = resolveBubbleType(
              agent.role,
              effectiveMode,
              taskStatus,
              speaking,
              agent.is_active
            );
            const roleKind = resolveRoleKind(agent.role);
            const paletteIndex =
              roleKind === "general" ? index % 6 : paletteByRoleKind[roleKind];
            const accent = roleAccentByKind[roleKind];
            const skillLabel = compactSkillLabel(runtimeState?.current_skill);
            const activityLabel =
              runtimeState?.current_action?.trim() || resolveActivityLabel(agent.role, effectiveMode);
            const installedSkills = Array.isArray(agent.skills)
              ? agent.skills.filter((skill) => typeof skill === "string" && skill.trim().length > 0)
              : [];
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
                  onClick={() =>
                    setActiveAgentPopoverId((previous) => (previous === agent.id ? null : agent.id))
                  }
                />

                {activeAgentPopoverId === agent.id ? (
                  <div
                    className="absolute left-1/2 top-full mt-2 w-[220px] -translate-x-1/2 rounded-[10px] border border-red-200/25 bg-black/88 px-3 py-2 text-left shadow-[0_14px_30px_rgba(0,0,0,0.45)]"
                    style={{ zIndex: Math.round(actor.zY + 40) }}
                  >
                    <div className="text-xs font-semibold text-red-50">{agent.name}</div>
                    <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-rose-100/70">
                      Роль: {roleLabelRu(agent.role)}
                    </div>
                    <div className="mt-2 text-[10px] uppercase tracking-[0.14em] text-rose-100/55">
                      Установленные скиллы
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {installedSkills.length > 0 ? (
                        installedSkills.map((skill) => (
                          <span
                            key={`${agent.id}-${skill}`}
                            className="rounded-md px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]"
                            style={{
                              background: "rgba(194,21,90,0.16)",
                              border: "1px solid rgba(194,21,90,0.30)",
                              color: "rgba(255,228,235,0.9)",
                            }}
                          >
                            {skill}
                          </span>
                        ))
                      ) : (
                        <span className="text-[11px] text-rose-100/55">Скиллы не назначены</span>
                      )}
                    </div>
                  </div>
                ) : null}

                <div className="mt-1 min-w-[98px] max-w-[132px] rounded-[10px] border border-white/10 bg-black/72 px-2 py-1 text-center shadow-[0_10px_24px_rgba(0,0,0,0.22)] backdrop-blur-[2px]">
                  <div className="text-[10px] font-semibold leading-none text-red-50">
                    {agent.name} · {roleLabelRu(agent.role)} · {formatTokenCompact(agentTokenUsage[agent.id] ?? 0)}
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
        </motion.div>
      </div>
    </section>
  );
}



