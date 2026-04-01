"use client";

import { KeyboardEvent, MouseEvent, useEffect, useMemo, useState } from "react";
import { AgentMode } from "@/lib/office/engine";

export type SpriteDirection = "down" | "up" | "left" | "right";
export type BubbleType = "permission" | "waiting";

interface PixelAgentSpriteProps {
  role: string;
  mode: AgentMode;
  speaking?: boolean;
  paletteIndex?: number;
  direction?: SpriteDirection;
  bubbleType?: BubbleType | null;
  onClick?: (event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) => void;
}

const FRAME_WIDTH = 16;
const FRAME_HEIGHT = 32;
const FRAME_SCALE = 2;
const FRAMES_PER_ROW = 7;
const SPRITE_SHEET_ROWS = 3;

const bubblePalette = {
  permission: {
    _: "transparent",
    B: "#555566",
    F: "#EEEEFF",
    A: "#CCA700",
  },
  waiting: {
    _: "transparent",
    B: "#555566",
    F: "#EEEEFF",
    G: "#44BB66",
  },
} as const;

const bubblePixels = {
  permission: [
    ["B", "B", "B", "B", "B", "B", "B", "B", "B", "B", "B"],
    ["B", "F", "F", "F", "F", "F", "F", "F", "F", "F", "B"],
    ["B", "F", "F", "F", "F", "F", "F", "F", "F", "F", "B"],
    ["B", "F", "F", "F", "F", "F", "F", "F", "F", "F", "B"],
    ["B", "F", "F", "F", "F", "F", "F", "F", "F", "F", "B"],
    ["B", "F", "F", "A", "F", "A", "F", "A", "F", "F", "B"],
    ["B", "F", "F", "F", "F", "F", "F", "F", "F", "F", "B"],
    ["B", "F", "F", "F", "F", "F", "F", "F", "F", "F", "B"],
    ["B", "F", "F", "F", "F", "F", "F", "F", "F", "F", "B"],
    ["B", "B", "B", "B", "B", "B", "B", "B", "B", "B", "B"],
    ["_", "_", "_", "_", "B", "B", "B", "_", "_", "_", "_"],
    ["_", "_", "_", "_", "_", "B", "_", "_", "_", "_", "_"],
    ["_", "_", "_", "_", "_", "_", "_", "_", "_", "_", "_"],
  ],
  waiting: [
    ["_", "B", "B", "B", "B", "B", "B", "B", "B", "B", "_"],
    ["B", "F", "F", "F", "F", "F", "F", "F", "F", "F", "B"],
    ["B", "F", "F", "F", "F", "F", "F", "F", "F", "F", "B"],
    ["B", "F", "F", "F", "F", "F", "F", "F", "G", "F", "B"],
    ["B", "F", "F", "F", "F", "F", "F", "G", "F", "F", "B"],
    ["B", "F", "F", "G", "F", "F", "G", "F", "F", "F", "B"],
    ["B", "F", "F", "F", "G", "G", "F", "F", "F", "F", "B"],
    ["B", "F", "F", "F", "F", "F", "F", "F", "F", "F", "B"],
    ["B", "F", "F", "F", "F", "F", "F", "F", "F", "F", "B"],
    ["_", "B", "B", "B", "B", "B", "B", "B", "B", "B", "_"],
    ["_", "_", "_", "_", "B", "B", "B", "_", "_", "_", "_"],
    ["_", "_", "_", "_", "_", "B", "_", "_", "_", "_", "_"],
    ["_", "_", "_", "_", "_", "_", "_", "_", "_", "_", "_"],
  ],
} as const;

const frameSequences: Record<AgentMode, number[]> = {
  walking: [0, 1, 2, 1],
  typing: [3, 4],
  testing: [5, 6],
  monitoring: [5, 6],
  watching_tv: [1],
  celebrating: [0, 1, 2, 1],
  debugging: [5, 6],
  discussing: [3, 4],
};

const paceByMode: Record<AgentMode, number> = {
  walking: 150,
  typing: 300,
  testing: 300,
  monitoring: 300,
  watching_tv: 320,
  celebrating: 150,
  debugging: 300,
  discussing: 300,
};

const directionRow: Record<Exclude<SpriteDirection, "left">, number> = {
  down: 0,
  up: 1,
  right: 2,
};

const bubbleScale = 2;

const resolveFrameDirection = (direction: SpriteDirection): { row: number; mirrored: boolean } => {
  if (direction === "left") {
    return { row: directionRow.right, mirrored: true };
  }

  return { row: directionRow[direction], mirrored: false };
};

const PixelBubble = ({ type }: { type: BubbleType }) => {
  const pixels = bubblePixels[type];
  const palette = bubblePalette[type];

  return (
    <div
      className="absolute -top-8 left-1/2 -translate-x-1/2 grid pixel-office-image"
      style={{
        gridTemplateColumns: `repeat(${pixels[0].length}, ${bubbleScale}px)`,
        gridTemplateRows: `repeat(${pixels.length}, ${bubbleScale}px)`,
      }}
    >
      {pixels.flatMap((row, rowIndex) =>
        row.map((pixel, columnIndex) => (
          <span
            key={`${type}-${rowIndex}-${columnIndex}`}
            style={{
              width: bubbleScale,
              height: bubbleScale,
              backgroundColor: palette[pixel],
            }}
          />
        ))
      )}
    </div>
  );
};

export default function PixelAgentSprite({
  role,
  mode,
  speaking = false,
  paletteIndex = 0,
  direction = "down",
  bubbleType = null,
  onClick,
}: PixelAgentSpriteProps) {
  const frames = frameSequences[mode] ?? frameSequences.typing;
  const pace = paceByMode[mode] ?? 180;
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
    if (frames.length <= 1) {
      return;
    }

    const timer = window.setInterval(() => {
      setIndex((prev) => (prev + 1) % frames.length);
    }, pace);

    return () => window.clearInterval(timer);
  }, [frames, pace]);

  const { row, mirrored } = useMemo(() => resolveFrameDirection(direction), [direction]);
  const frame = frames[index % frames.length] ?? 0;
  const spriteUrl = `/pixel-office/assets/characters/char_${paletteIndex % 6}.png`;

  const interactive = typeof onClick === "function";

  return (
    <div
      className={`relative ${interactive ? "cursor-pointer" : ""}`}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `Показать профиль агента ${role}` : undefined}
      onClick={interactive ? (event) => onClick?.(event) : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick?.(event);
              }
            }
          : undefined
      }
    >
      {bubbleType ? <PixelBubble type={bubbleType} /> : null}

      <div
        className="pixel-office-image"
        style={{
          width: FRAME_WIDTH * FRAME_SCALE,
          height: FRAME_HEIGHT * FRAME_SCALE,
          backgroundImage: `url(${spriteUrl})`,
          backgroundRepeat: "no-repeat",
          backgroundSize: `${FRAME_WIDTH * FRAMES_PER_ROW * FRAME_SCALE}px ${
            FRAME_HEIGHT * SPRITE_SHEET_ROWS * FRAME_SCALE
          }px`,
          backgroundPosition: `-${frame * FRAME_WIDTH * FRAME_SCALE}px -${
            row * FRAME_HEIGHT * FRAME_SCALE
          }px`,
          filter: speaking ? "drop-shadow(0 0 12px rgba(248,113,113,0.75))" : "none",
          transform: mirrored ? "scaleX(-1)" : undefined,
          transformOrigin: "center",
        }}
      />

      {speaking && !bubbleType ? (
        <div className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 bg-rose-300 pixel-office-image animate-ping" />
      ) : null}

      <div
        className="absolute inset-x-1 bottom-0 h-2 rounded-full blur-md"
        style={{ background: "rgba(0, 0, 0, 0.45)" }}
      />
    </div>
  );
}
