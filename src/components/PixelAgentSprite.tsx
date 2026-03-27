"use client";

import { useEffect, useMemo, useState } from "react";
import { AgentMode } from "@/lib/office/engine";

interface PixelAgentSpriteProps {
  role: string;
  mode: AgentMode;
  speaking?: boolean;
}

type PixelFrame = string[];

const pixelSize = 4;
const spriteSide = 12;

const FRAMES: Record<AgentMode, PixelFrame[]> = {
  walking: [
    [
      "....ssss....",
      "...ssssss...",
      "...ss..ss...",
      "....ssss....",
      "...cccccc...",
      "..ccaaaa.cc.",
      "..cc....cc..",
      "...cc..cc...",
      "..c.c..c.c..",
      "..c......c..",
      ".c........c.",
      "............",
    ],
    [
      "....ssss....",
      "...ssssss...",
      "...ss..ss...",
      "....ssss....",
      "...cccccc...",
      "..ccaaaa.cc.",
      "...cc..cc...",
      "..cc....cc..",
      ".c..c..c..c.",
      "...c....c...",
      "..c......c..",
      "............",
    ],
    [
      "....ssss....",
      "...ssssss...",
      "...ss..ss...",
      "....ssss....",
      "...cccccc...",
      "..ccaaaa.cc.",
      "..cc....cc..",
      "...cc..cc...",
      "...c....c...",
      "..c..cc..c..",
      ".c........c.",
      "............",
    ],
    [
      "....ssss....",
      "...ssssss...",
      "...ss..ss...",
      "....ssss....",
      "...cccccc...",
      "..ccaaaa.cc.",
      "...cc..cc...",
      "..cc....cc..",
      "..c......c..",
      ".c..c..c..c.",
      "...c....c...",
      "............",
    ],
  ],
  typing: [
    [
      "...ssss.....",
      "..ssssss....",
      "..ss..ss....",
      "...ssss.....",
      "..cccccc....",
      ".ccaaaa.cc..",
      ".cc....cc...",
      "..cc..cc....",
      "..c....c....",
      ".c.c..c.c...",
      ".c......c...",
      "............",
    ],
    [
      "...ssss.....",
      "..ssssss....",
      "..ss..ss....",
      "...ssss.....",
      "..cccccc....",
      ".ccaaaa.cc..",
      "..cc..cc....",
      ".cc....cc...",
      "..c....c....",
      ".c.c..c.c...",
      ".c......c...",
      "............",
    ],
  ],
  testing: [
    [
      "....ssss....",
      "...ssssss...",
      "...ss..ss...",
      "....ssss....",
      "...cccccc...",
      "..ccaaaa.cc.",
      "..cc....cc..",
      "...cc..cc...",
      "..c..kk..c..",
      "..c......c..",
      ".c........c.",
      "............",
    ],
    [
      "....ssss....",
      "...ssssss...",
      "...ss..ss...",
      "....ssss....",
      "...cccccc...",
      "..ccaaaa.cc.",
      "..cc....cc..",
      "...cc..cc...",
      "..c.kkk..c..",
      "..c......c..",
      ".c........c.",
      "............",
    ],
  ],
  monitoring: [
    [
      "....ssss....",
      "...ssssss...",
      "...ss..ss...",
      "....ssss....",
      "...cccccc...",
      "..ccaaaa.cc.",
      "..cc....cc..",
      "...cc..cc...",
      "..c....kc...",
      "..c......c..",
      ".c........c.",
      "............",
    ],
    [
      "....ssss....",
      "...ssssss...",
      "...ss..ss...",
      "....ssss....",
      "...cccccc...",
      "..ccaaaa.cc.",
      "..cc....cc..",
      "...cc..cc...",
      "..c...k.c...",
      "..c......c..",
      ".c........c.",
      "............",
    ],
  ],
  watching_tv: [
    [
      "............",
      "....ssss....",
      "...ssssss...",
      "....ssss....",
      "...cccccc...",
      "..ccaaaa.cc.",
      "...cc..cc...",
      "...c....c...",
      "..cccccccc..",
      "..c......c..",
      "..c......c..",
      "............",
    ],
    [
      "............",
      "....ssss....",
      "...ssssss...",
      "....ssss....",
      "...cccccc...",
      "..ccaaaa.cc.",
      "...cc..cc...",
      "...c....c...",
      "..cccccccc..",
      "..c......c..",
      "...c....c...",
      "............",
    ],
  ],
  celebrating: [
    [
      "....ssss....",
      "...ssssss...",
      "...ss..ss...",
      "....ssss....",
      "...cccccc...",
      ".a.ccaa.cc.a",
      "..cc....cc..",
      "...cc..cc...",
      "..c..cc..c..",
      ".c........c.",
      "..c......c..",
      "............",
    ],
    [
      "....ssss....",
      "...ssssss...",
      "...ss..ss...",
      "....ssss....",
      "...cccccc...",
      ".a.ccaa.cc.a",
      "..cc....cc..",
      "...cc..cc...",
      ".c..c..c..c.",
      "...c....c...",
      "..c......c..",
      "............",
    ],
  ],
  debugging: [
    [
      "....ssss....",
      "...ssssss...",
      "...ss..ss...",
      "...kssss....",
      "...cccccc...",
      "..ccaaaa.cc.",
      "..cc....cc..",
      "...cc..cc...",
      "..c..cc..c..",
      "..c......c..",
      ".c........c.",
      "............",
    ],
    [
      "....ssss....",
      "...ssssss...",
      "...ss..ss...",
      "....ssssk...",
      "...cccccc...",
      "..ccaaaa.cc.",
      "..cc....cc..",
      "...cc..cc...",
      "..c..cc..c..",
      "..c......c..",
      ".c........c.",
      "............",
    ],
  ],
  discussing: [
    [
      "....ssss....",
      "...ssssss...",
      "...ss..ss...",
      "....ssss....",
      "...cccccc...",
      "..ccaaaa.cc.",
      "..cc....cc..",
      "...cc..cc...",
      "...c....c...",
      "..c..cc..c..",
      ".c........c.",
      "............",
    ],
    [
      "....ssss....",
      "...ssssss...",
      "...ss..ss...",
      "....ssss....",
      "...cccccc...",
      "..ccaaaa.cc.",
      "...cc..cc...",
      "..cc....cc..",
      "...c....c...",
      "..c..cc..c..",
      ".c........c.",
      "............",
    ],
  ],
};

const paceByMode: Record<AgentMode, number> = {
  walking: 95,
  typing: 150,
  testing: 150,
  monitoring: 170,
  watching_tv: 260,
  celebrating: 110,
  debugging: 150,
  discussing: 130,
};

const toneByRole: Record<string, { coat: string; accent: string }> = {
  PM: { coat: "#ef4444", accent: "#fca5a5" },
  Developer: { coat: "#fb7185", accent: "#fecdd3" },
  QA: { coat: "#f97316", accent: "#fdba74" },
  DevOps: { coat: "#b91c1c", accent: "#fca5a5" },
};

const resolvePixelColor = (pixel: string, role: string): string => {
  const tone = toneByRole[role] ?? toneByRole.DevOps;

  if (pixel === "s") return "#f8d2b3";
  if (pixel === "c") return tone.coat;
  if (pixel === "a") return tone.accent;
  if (pixel === "k") return "#0b0b0b";
  return "transparent";
};

export default function PixelAgentSprite({ role, mode, speaking = false }: PixelAgentSpriteProps) {
  const frames = FRAMES[mode] ?? FRAMES.typing;
  const [index, setIndex] = useState(0);
  const pace = paceByMode[mode] ?? 170;

  useEffect(() => {
    setIndex(0);
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % frames.length);
    }, pace);

    return () => clearInterval(timer);
  }, [frames, pace]);

  const current = frames[index % frames.length];
  const pixels = useMemo(() => current.join("").split(""), [current]);

  return (
    <div className="relative">
      <div
        className="grid pixel-sprite"
        style={{
          width: spriteSide * pixelSize,
          height: spriteSide * pixelSize,
          gridTemplateColumns: `repeat(${spriteSide}, ${pixelSize}px)`,
          gridTemplateRows: `repeat(${spriteSide}, ${pixelSize}px)`,
          imageRendering: "pixelated",
          filter: speaking ? "drop-shadow(0 0 12px rgba(248,113,113,0.75))" : "none",
          transform: mode === "walking" ? "translateY(1px)" : "translateY(0)",
        }}
      >
        {pixels.map((px, i) => (
          <span
            key={i}
            style={{
              width: pixelSize,
              height: pixelSize,
              backgroundColor: resolvePixelColor(px, role),
            }}
          />
        ))}
      </div>
      {speaking ? (
        <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-2 h-2 bg-rose-300 pixel-sprite animate-ping" />
      ) : null}
    </div>
  );
}
