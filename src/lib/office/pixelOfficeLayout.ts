import defaultLayoutJson from "../../../public/pixel-office/assets/default-layout-1.json";

export type PixelDirection = "down" | "up" | "left" | "right";

export interface FloorColor {
  h: number;
  s: number;
  b: number;
  c: number;
}

export interface TilePoint {
  col: number;
  row: number;
}

export interface PixelOfficeLayout {
  version: number;
  cols: number;
  rows: number;
  layoutRevision?: number;
  tiles: number[];
  tileColors?: Array<FloorColor | null>;
  furniture: PlacedFurniture[];
}

export interface PlacedFurniture {
  uid: string;
  type: string;
  col: number;
  row: number;
}

interface FurnitureDescriptor {
  id: string;
  src: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  category: "chairs" | "desks" | "electronics" | "decor" | "wall";
  backgroundTiles?: number;
  orientation?: "front" | "back" | "side" | "left" | "right";
  mirrorSide?: boolean;
  isDesk?: boolean;
  canPlaceOnSurfaces?: boolean;
}

export interface PixelOfficeSeat {
  uid: string;
  seatCol: number;
  seatRow: number;
  facingDir: PixelDirection;
}

export interface FurnitureInstance {
  uid: string;
  type: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zY: number;
  mirrored?: boolean;
  isMonitor?: boolean;
  isMonitorOn?: boolean;
}

export interface WallInstance {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zY: number;
  frameIndex: number;
  color: string;
}

export interface RenderTile {
  key: string;
  col: number;
  row: number;
  type: number;
  colorHex: string | null;
}

export interface PixelOfficeViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const TILE_SIZE = 16;
export const TILE_TYPE_WALL = 0;
export const TILE_TYPE_VOID = 255;
export const PIXEL_OFFICE_LAYOUT = defaultLayoutJson as PixelOfficeLayout;
export const PIXEL_OFFICE_WIDTH = PIXEL_OFFICE_LAYOUT.cols * TILE_SIZE;
export const PIXEL_OFFICE_HEIGHT = PIXEL_OFFICE_LAYOUT.rows * TILE_SIZE;

const WALL_SHEET_COLUMNS = 4;
const WALL_SHEET_ROWS = 4;
const WALL_TILE_WIDTH = 16;
const WALL_TILE_HEIGHT = 32;

const furnitureCatalog: Record<string, FurnitureDescriptor> = {
  TABLE_FRONT: {
    id: "TABLE_FRONT",
    src: "/pixel-office/assets/furniture/TABLE_FRONT/TABLE_FRONT.png",
    width: 48,
    height: 64,
    footprintW: 3,
    footprintH: 4,
    category: "desks",
    backgroundTiles: 1,
    orientation: "front",
    isDesk: true,
  },
  COFFEE_TABLE: {
    id: "COFFEE_TABLE",
    src: "/pixel-office/assets/furniture/COFFEE_TABLE/COFFEE_TABLE.png",
    width: 32,
    height: 32,
    footprintW: 2,
    footprintH: 2,
    category: "desks",
    isDesk: true,
  },
  SOFA_FRONT: {
    id: "SOFA_FRONT",
    src: "/pixel-office/assets/furniture/SOFA/SOFA_FRONT.png",
    width: 32,
    height: 16,
    footprintW: 2,
    footprintH: 1,
    category: "chairs",
    orientation: "front",
  },
  SOFA_BACK: {
    id: "SOFA_BACK",
    src: "/pixel-office/assets/furniture/SOFA/SOFA_BACK.png",
    width: 32,
    height: 16,
    footprintW: 2,
    footprintH: 1,
    category: "chairs",
    orientation: "back",
  },
  SOFA_SIDE: {
    id: "SOFA_SIDE",
    src: "/pixel-office/assets/furniture/SOFA/SOFA_SIDE.png",
    width: 16,
    height: 32,
    footprintW: 1,
    footprintH: 2,
    category: "chairs",
    orientation: "side",
    mirrorSide: true,
  },
  HANGING_PLANT: {
    id: "HANGING_PLANT",
    src: "/pixel-office/assets/furniture/HANGING_PLANT/HANGING_PLANT.png",
    width: 16,
    height: 32,
    footprintW: 1,
    footprintH: 2,
    category: "wall",
    backgroundTiles: 2,
  },
  DOUBLE_BOOKSHELF: {
    id: "DOUBLE_BOOKSHELF",
    src: "/pixel-office/assets/furniture/DOUBLE_BOOKSHELF/DOUBLE_BOOKSHELF.png",
    width: 32,
    height: 32,
    footprintW: 2,
    footprintH: 2,
    category: "wall",
    backgroundTiles: 2,
  },
  SMALL_PAINTING: {
    id: "SMALL_PAINTING",
    src: "/pixel-office/assets/furniture/SMALL_PAINTING/SMALL_PAINTING.png",
    width: 16,
    height: 32,
    footprintW: 1,
    footprintH: 2,
    category: "wall",
    backgroundTiles: 2,
  },
  SMALL_PAINTING_2: {
    id: "SMALL_PAINTING_2",
    src: "/pixel-office/assets/furniture/SMALL_PAINTING_2/SMALL_PAINTING_2.png",
    width: 16,
    height: 32,
    footprintW: 1,
    footprintH: 2,
    category: "wall",
    backgroundTiles: 2,
  },
  CLOCK: {
    id: "CLOCK",
    src: "/pixel-office/assets/furniture/CLOCK/CLOCK.png",
    width: 16,
    height: 32,
    footprintW: 1,
    footprintH: 2,
    category: "wall",
    backgroundTiles: 2,
  },
  PLANT: {
    id: "PLANT",
    src: "/pixel-office/assets/furniture/PLANT/PLANT.png",
    width: 16,
    height: 32,
    footprintW: 1,
    footprintH: 2,
    category: "decor",
    backgroundTiles: 1,
  },
  COFFEE: {
    id: "COFFEE",
    src: "/pixel-office/assets/furniture/COFFEE/COFFEE.png",
    width: 16,
    height: 16,
    footprintW: 1,
    footprintH: 1,
    category: "decor",
    canPlaceOnSurfaces: true,
  },
  WOODEN_CHAIR_SIDE: {
    id: "WOODEN_CHAIR_SIDE",
    src: "/pixel-office/assets/furniture/WOODEN_CHAIR/WOODEN_CHAIR_SIDE.png",
    width: 16,
    height: 32,
    footprintW: 1,
    footprintH: 2,
    category: "chairs",
    backgroundTiles: 1,
    orientation: "side",
    mirrorSide: true,
  },
  DESK_FRONT: {
    id: "DESK_FRONT",
    src: "/pixel-office/assets/furniture/DESK/DESK_FRONT.png",
    width: 48,
    height: 32,
    footprintW: 3,
    footprintH: 2,
    category: "desks",
    backgroundTiles: 1,
    orientation: "front",
    isDesk: true,
  },
  CUSHIONED_BENCH: {
    id: "CUSHIONED_BENCH",
    src: "/pixel-office/assets/furniture/CUSHIONED_BENCH/CUSHIONED_BENCH.png",
    width: 16,
    height: 16,
    footprintW: 1,
    footprintH: 1,
    category: "chairs",
  },
  PC_FRONT_OFF: {
    id: "PC_FRONT_OFF",
    src: "/pixel-office/assets/furniture/PC/PC_FRONT_OFF.png",
    width: 16,
    height: 32,
    footprintW: 1,
    footprintH: 2,
    category: "electronics",
    backgroundTiles: 1,
    orientation: "front",
    canPlaceOnSurfaces: true,
  },
  PC_FRONT_ON_1: {
    id: "PC_FRONT_ON_1",
    src: "/pixel-office/assets/furniture/PC/PC_FRONT_ON_1.png",
    width: 16,
    height: 32,
    footprintW: 1,
    footprintH: 2,
    category: "electronics",
    backgroundTiles: 1,
    orientation: "front",
    canPlaceOnSurfaces: true,
  },
  PC_FRONT_ON_2: {
    id: "PC_FRONT_ON_2",
    src: "/pixel-office/assets/furniture/PC/PC_FRONT_ON_2.png",
    width: 16,
    height: 32,
    footprintW: 1,
    footprintH: 2,
    category: "electronics",
    backgroundTiles: 1,
    orientation: "front",
    canPlaceOnSurfaces: true,
  },
  PC_FRONT_ON_3: {
    id: "PC_FRONT_ON_3",
    src: "/pixel-office/assets/furniture/PC/PC_FRONT_ON_3.png",
    width: 16,
    height: 32,
    footprintW: 1,
    footprintH: 2,
    category: "electronics",
    backgroundTiles: 1,
    orientation: "front",
    canPlaceOnSurfaces: true,
  },
  PC_SIDE: {
    id: "PC_SIDE",
    src: "/pixel-office/assets/furniture/PC/PC_SIDE.png",
    width: 16,
    height: 32,
    footprintW: 1,
    footprintH: 2,
    category: "electronics",
    backgroundTiles: 1,
    orientation: "side",
    mirrorSide: true,
    canPlaceOnSurfaces: true,
  },
  PLANT_2: {
    id: "PLANT_2",
    src: "/pixel-office/assets/furniture/PLANT_2/PLANT_2.png",
    width: 16,
    height: 32,
    footprintW: 1,
    footprintH: 2,
    category: "decor",
    backgroundTiles: 1,
  },
  LARGE_PAINTING: {
    id: "LARGE_PAINTING",
    src: "/pixel-office/assets/furniture/LARGE_PAINTING/LARGE_PAINTING.png",
    width: 32,
    height: 32,
    footprintW: 2,
    footprintH: 2,
    category: "wall",
    backgroundTiles: 2,
  },
  BIN: {
    id: "BIN",
    src: "/pixel-office/assets/furniture/BIN/BIN.png",
    width: 16,
    height: 16,
    footprintW: 1,
    footprintH: 1,
    category: "decor",
  },
  SMALL_TABLE_FRONT: {
    id: "SMALL_TABLE_FRONT",
    src: "/pixel-office/assets/furniture/SMALL_TABLE/SMALL_TABLE_FRONT.png",
    width: 32,
    height: 32,
    footprintW: 2,
    footprintH: 2,
    category: "desks",
    backgroundTiles: 1,
    orientation: "front",
    isDesk: true,
  },
  SMALL_TABLE_SIDE: {
    id: "SMALL_TABLE_SIDE",
    src: "/pixel-office/assets/furniture/SMALL_TABLE/SMALL_TABLE_SIDE.png",
    width: 16,
    height: 48,
    footprintW: 1,
    footprintH: 3,
    category: "desks",
    backgroundTiles: 1,
    orientation: "side",
    isDesk: true,
  },
};

const ROLE_SEAT_COORDINATES: Record<string, TilePoint[]> = {
  PM: [
    { col: 3, row: 14 },
    { col: 3, row: 17 },
    { col: 3, row: 19 },
    { col: 14, row: 16 },
  ],
  Developer: [
    { col: 7, row: 14 },
    { col: 7, row: 17 },
    { col: 7, row: 19 },
    { col: 15, row: 16 },
  ],
  QA: [
    { col: 3, row: 17 },
    { col: 3, row: 19 },
    { col: 14, row: 13 },
    { col: 13, row: 14 },
  ],
  DevOps: [
    { col: 7, row: 17 },
    { col: 7, row: 19 },
    { col: 15, row: 13 },
    { col: 16, row: 14 },
  ],
};

const deskFacingDirections: TilePoint[] = [
  { col: 0, row: -1 },
  { col: 0, row: 1 },
  { col: -1, row: 0 },
  { col: 1, row: 0 },
];

const toKey = ({ col, row }: TilePoint) => `${col},${row}`;

const parseFurnitureVariant = (type: string) => {
  const [baseType, variant] = type.split(":");
  return { baseType, variant: variant ?? null };
};

const getFurnitureDescriptor = (type: string): FurnitureDescriptor | null => {
  const { baseType } = parseFurnitureVariant(type);
  return furnitureCatalog[baseType] ?? null;
};

const getFurnitureOrientation = (type: string, descriptor: FurnitureDescriptor) => {
  const { variant } = parseFurnitureVariant(type);
  if (variant === "left") return "left";
  return descriptor.orientation;
};

const orientationToFacing = (orientation?: string): PixelDirection => {
  switch (orientation) {
    case "back":
      return "up";
    case "left":
      return "left";
    case "right":
    case "side":
      return "right";
    case "front":
    default:
      return "down";
  }
};

const hslToHex = (h: number, s: number, l: number) => {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hp < 1) {
    r1 = c;
    g1 = x;
  } else if (hp < 2) {
    r1 = x;
    g1 = c;
  } else if (hp < 3) {
    g1 = c;
    b1 = x;
  } else if (hp < 4) {
    g1 = x;
    b1 = c;
  } else if (hp < 5) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  const m = l - c / 2;
  const clamp = (value: number) =>
    Math.max(0, Math.min(255, Math.round((value + m) * 255)));

  return `#${clamp(r1).toString(16).padStart(2, "0")}${clamp(g1)
    .toString(16)
    .padStart(2, "0")}${clamp(b1).toString(16).padStart(2, "0")}`.toUpperCase();
};

const colorizeToHex = (color: FloorColor | null | undefined) => {
  if (!color) return null;

  let lightness = 0.5;
  if (color.c !== 0) {
    const factor = (100 + color.c) / 100;
    lightness = 0.5 + (lightness - 0.5) * factor;
  }
  if (color.b !== 0) {
    lightness += color.b / 200;
  }

  return hslToHex(color.h, color.s / 100, Math.max(0, Math.min(1, lightness)));
};

export const pixelOfficeTileMap = (() => {
  const map: number[][] = [];
  for (let row = 0; row < PIXEL_OFFICE_LAYOUT.rows; row += 1) {
    const nextRow: number[] = [];
    for (let col = 0; col < PIXEL_OFFICE_LAYOUT.cols; col += 1) {
      nextRow.push(PIXEL_OFFICE_LAYOUT.tiles[row * PIXEL_OFFICE_LAYOUT.cols + col]);
    }
    map.push(nextRow);
  }
  return map;
})();

export const pixelOfficeRenderTiles: RenderTile[] = PIXEL_OFFICE_LAYOUT.tiles.map((type, index) => ({
  key: `tile-${index}`,
  col: index % PIXEL_OFFICE_LAYOUT.cols,
  row: Math.floor(index / PIXEL_OFFICE_LAYOUT.cols),
  type,
  colorHex: colorizeToHex(PIXEL_OFFICE_LAYOUT.tileColors?.[index]),
}));

export const PIXEL_OFFICE_VIEWPORT: PixelOfficeViewport = (() => {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const include = (x: number, y: number, width: number, height: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  };

  for (const tile of pixelOfficeRenderTiles) {
    if (tile.type === TILE_TYPE_VOID) continue;
    include(tile.col * TILE_SIZE, tile.row * TILE_SIZE, TILE_SIZE, TILE_SIZE);

    if (tile.type === TILE_TYPE_WALL) {
      include(
        tile.col * TILE_SIZE,
        tile.row * TILE_SIZE + (TILE_SIZE - WALL_TILE_HEIGHT),
        WALL_TILE_WIDTH,
        WALL_TILE_HEIGHT
      );
    }
  }

  for (const item of PIXEL_OFFICE_LAYOUT.furniture) {
    const descriptor = getFurnitureDescriptor(item.type);
    if (!descriptor) continue;
    include(item.col * TILE_SIZE, item.row * TILE_SIZE, descriptor.width, descriptor.height);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { x: 0, y: 0, width: PIXEL_OFFICE_WIDTH, height: PIXEL_OFFICE_HEIGHT };
  }

  const paddingX = 12;
  const paddingTop = 18;
  const paddingBottom = 12;
  const x = Math.max(0, minX - paddingX);
  const y = Math.max(0, minY - paddingTop);
  const maxBoundX = Math.min(PIXEL_OFFICE_WIDTH, maxX + paddingX);
  const maxBoundY = Math.min(PIXEL_OFFICE_HEIGHT, maxY + paddingBottom);

  return {
    x,
    y,
    width: maxBoundX - x,
    height: maxBoundY - y,
  };
})();

export const pixelOfficeSeats: PixelOfficeSeat[] = (() => {
  const seats: PixelOfficeSeat[] = [];
  const deskTiles = new Set<string>();

  for (const item of PIXEL_OFFICE_LAYOUT.furniture) {
    const descriptor = getFurnitureDescriptor(item.type);
    if (!descriptor || !descriptor.isDesk) continue;

    for (let row = 0; row < descriptor.footprintH; row += 1) {
      for (let col = 0; col < descriptor.footprintW; col += 1) {
        deskTiles.add(`${item.col + col},${item.row + row}`);
      }
    }
  }

  for (const item of PIXEL_OFFICE_LAYOUT.furniture) {
    const descriptor = getFurnitureDescriptor(item.type);
    if (!descriptor || descriptor.category !== "chairs") continue;

    const bgRows = descriptor.backgroundTiles ?? 0;
    let seatCount = 0;

    for (let row = bgRows; row < descriptor.footprintH; row += 1) {
      for (let col = 0; col < descriptor.footprintW; col += 1) {
        const seatCol = item.col + col;
        const seatRow = item.row + row;
        let facingDir = orientationToFacing(getFurnitureOrientation(item.type, descriptor));

        if (!descriptor.orientation) {
          for (const candidate of deskFacingDirections) {
            if (deskTiles.has(`${seatCol + candidate.col},${seatRow + candidate.row}`)) {
              if (candidate.col === 1) facingDir = "right";
              if (candidate.col === -1) facingDir = "left";
              if (candidate.row === 1) facingDir = "down";
              if (candidate.row === -1) facingDir = "up";
              break;
            }
          }
        }

        seats.push({
          uid: seatCount === 0 ? item.uid : `${item.uid}:${seatCount}`,
          seatCol,
          seatRow,
          facingDir,
        });
        seatCount += 1;
      }
    }
  }

  return seats;
})();

export const pixelOfficeSeatMap = new Map(pixelOfficeSeats.map((seat) => [seat.uid, seat]));
export const pixelOfficeSeatByTileKey = new Map(
  pixelOfficeSeats.map((seat) => [`${seat.seatCol},${seat.seatRow}`, seat.uid])
);

export const pixelOfficeSeatIdsByRole = (() => {
  const resolved: Record<string, string[]> = {};

  for (const [role, coordinates] of Object.entries(ROLE_SEAT_COORDINATES)) {
    resolved[role] = coordinates
      .map((coordinate) => pixelOfficeSeatByTileKey.get(toKey(coordinate)) ?? null)
      .filter((seatId): seatId is string => Boolean(seatId));
  }

  return resolved;
})();

export const pixelOfficeBlockedTiles = (() => {
  const blocked = new Set<string>();

  for (const item of PIXEL_OFFICE_LAYOUT.furniture) {
    const descriptor = getFurnitureDescriptor(item.type);
    if (!descriptor) continue;

    const bgRows = descriptor.backgroundTiles ?? 0;
    for (let row = 0; row < descriptor.footprintH; row += 1) {
      if (row < bgRows) continue;
      for (let col = 0; col < descriptor.footprintW; col += 1) {
        blocked.add(`${item.col + col},${item.row + row}`);
      }
    }
  }

  return blocked;
})();

export const buildAgentSeatAssignments = (
  agents: Array<{ id: string; role: string }>
): Record<string, string | null> => {
  const assigned = new Set<string>();
  const allSeatIds = pixelOfficeSeats.map((seat) => seat.uid);
  const byAgentId: Record<string, string | null> = {};

  for (const agent of agents) {
    const roleSeatIds = pixelOfficeSeatIdsByRole[agent.role] ?? [];
    const preferredSeatId =
      roleSeatIds.find((seatId) => !assigned.has(seatId)) ??
      allSeatIds.find((seatId) => !assigned.has(seatId)) ??
      null;

    if (preferredSeatId) {
      assigned.add(preferredSeatId);
    }
    byAgentId[agent.id] = preferredSeatId;
  }

  return byAgentId;
};

export const toWorldCenter = ({ col, row }: TilePoint) => ({
  x: col * TILE_SIZE + TILE_SIZE / 2,
  y: row * TILE_SIZE + TILE_SIZE / 2,
});

export const isWalkable = (col: number, row: number, blockedTiles: Set<string>) => {
  const rows = pixelOfficeTileMap.length;
  const cols = rows > 0 ? pixelOfficeTileMap[0].length : 0;
  if (row < 0 || row >= rows || col < 0 || col >= cols) return false;

  const tile = pixelOfficeTileMap[row][col];
  if (tile === TILE_TYPE_WALL || tile === TILE_TYPE_VOID) return false;
  if (blockedTiles.has(`${col},${row}`)) return false;
  return true;
};

export const pixelOfficeWalkableTiles = (() => {
  const walkable: TilePoint[] = [];

  for (let row = 0; row < pixelOfficeTileMap.length; row += 1) {
    for (let col = 0; col < pixelOfficeTileMap[row].length; col += 1) {
      if (isWalkable(col, row, pixelOfficeBlockedTiles)) {
        walkable.push({ col, row });
      }
    }
  }

  return walkable;
})();

export const findPath = (
  start: TilePoint,
  target: TilePoint,
  blockedTiles: Set<string>,
  allowedBlockedEndKey?: string | null
): TilePoint[] => {
  if (start.col === target.col && start.row === target.row) return [];

  const startKey = toKey(start);
  const endKey = toKey(target);
  const queue: TilePoint[] = [start];
  const visited = new Set<string>([startKey]);
  const previous = new Map<string, string>();
  const directions = [
    { col: 0, row: -1 },
    { col: 1, row: 0 },
    { col: 0, row: 1 },
    { col: -1, row: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentKey = toKey(current);

    if (currentKey === endKey) {
      const path: TilePoint[] = [];
      let cursor = endKey;

      while (cursor !== startKey) {
        const [col, row] = cursor.split(",").map(Number);
        path.unshift({ col, row });
        cursor = previous.get(cursor)!;
      }

      return path;
    }

    for (const direction of directions) {
      const next = { col: current.col + direction.col, row: current.row + direction.row };
      const nextKey = toKey(next);
      if (visited.has(nextKey)) continue;

      const canEnter =
        nextKey === allowedBlockedEndKey ? true : isWalkable(next.col, next.row, blockedTiles);
      if (!canEnter) continue;

      visited.add(nextKey);
      previous.set(nextKey, currentKey);
      queue.push(next);
    }
  }

  return [];
};

export const directionBetween = (from: TilePoint, to: TilePoint): PixelDirection => {
  if (to.col > from.col) return "right";
  if (to.col < from.col) return "left";
  if (to.row > from.row) return "down";
  return "up";
};

export const buildAutoOnTiles = (seats: PixelOfficeSeat[]) => {
  const autoOnTiles = new Set<string>();

  for (const seat of seats) {
    const dCol = seat.facingDir === "right" ? 1 : seat.facingDir === "left" ? -1 : 0;
    const dRow = seat.facingDir === "down" ? 1 : seat.facingDir === "up" ? -1 : 0;

    for (let depth = 1; depth <= 3; depth += 1) {
      autoOnTiles.add(`${seat.seatCol + dCol * depth},${seat.seatRow + dRow * depth}`);
    }

    for (let depth = 1; depth <= 2; depth += 1) {
      const baseCol = seat.seatCol + dCol * depth;
      const baseRow = seat.seatRow + dRow * depth;
      if (dCol !== 0) {
        autoOnTiles.add(`${baseCol},${baseRow - 1}`);
        autoOnTiles.add(`${baseCol},${baseRow + 1}`);
      } else {
        autoOnTiles.add(`${baseCol - 1},${baseRow}`);
        autoOnTiles.add(`${baseCol + 1},${baseRow}`);
      }
    }
  }

  return autoOnTiles;
};

export const buildFurnitureInstances = (
  autoOnTiles?: Set<string>,
  monitorAnimationFrame = 0
): FurnitureInstance[] => {
  const deskZByTile = new Map<string, number>();

  for (const item of PIXEL_OFFICE_LAYOUT.furniture) {
    const descriptor = getFurnitureDescriptor(item.type);
    if (!descriptor || !descriptor.isDesk) continue;

    const deskZ = item.row * TILE_SIZE + descriptor.height;
    for (let row = 0; row < descriptor.footprintH; row += 1) {
      for (let col = 0; col < descriptor.footprintW; col += 1) {
        const key = `${item.col + col},${item.row + row}`;
        const previous = deskZByTile.get(key);
        if (previous === undefined || deskZ > previous) {
          deskZByTile.set(key, deskZ);
        }
      }
    }
  }

  const monitorFrames = ["PC_FRONT_ON_1", "PC_FRONT_ON_2", "PC_FRONT_ON_3"] as const;

  return PIXEL_OFFICE_LAYOUT.furniture
    .map((item) => {
      const descriptor = getFurnitureDescriptor(item.type);
      if (!descriptor) return null;

      const { variant } = parseFurnitureVariant(item.type);
      const resolvedType =
        descriptor.id === "PC_FRONT_OFF" &&
        autoOnTiles &&
        Array.from({ length: descriptor.footprintH }).some((_, row) =>
          Array.from({ length: descriptor.footprintW }).some((_, col) =>
            autoOnTiles.has(`${item.col + col},${item.row + row}`)
          )
        )
          ? monitorFrames[monitorAnimationFrame % monitorFrames.length]
          : descriptor.id;
      const resolvedDescriptor = furnitureCatalog[resolvedType] ?? descriptor;
      const x = item.col * TILE_SIZE;
      const y = item.row * TILE_SIZE;
      let zY = y + resolvedDescriptor.height;

      if (resolvedDescriptor.category === "chairs") {
        const orientation = getFurnitureOrientation(item.type, descriptor);
        zY =
          orientation === "back"
            ? (item.row + resolvedDescriptor.footprintH) * TILE_SIZE + 1
            : (item.row + 1) * TILE_SIZE;
      }

      if (resolvedDescriptor.canPlaceOnSurfaces) {
        for (let row = 0; row < resolvedDescriptor.footprintH; row += 1) {
          for (let col = 0; col < resolvedDescriptor.footprintW; col += 1) {
            const deskZ = deskZByTile.get(`${item.col + col},${item.row + row}`);
            if (deskZ !== undefined && deskZ + 0.5 > zY) {
              zY = deskZ + 0.5;
            }
          }
        }
      }

      return {
        uid: item.uid,
        type: resolvedType,
        src: resolvedDescriptor.src,
        x,
        y,
        width: resolvedDescriptor.width,
        height: resolvedDescriptor.height,
        zY,
        mirrored: Boolean(resolvedDescriptor.mirrorSide && variant === "left"),
        isMonitor: resolvedDescriptor.category === "electronics",
        isMonitorOn: resolvedType.startsWith("PC_FRONT_ON_"),
      } satisfies FurnitureInstance;
    })
    .filter((item): item is Exclude<typeof item, null> => item !== null)
    .sort((left, right) => left.zY - right.zY);
};

const buildWallMask = (col: number, row: number) => {
  let mask = 0;
  if (row > 0 && pixelOfficeTileMap[row - 1][col] === TILE_TYPE_WALL) mask |= 1;
  if (col < PIXEL_OFFICE_LAYOUT.cols - 1 && pixelOfficeTileMap[row][col + 1] === TILE_TYPE_WALL) mask |= 2;
  if (row < PIXEL_OFFICE_LAYOUT.rows - 1 && pixelOfficeTileMap[row + 1][col] === TILE_TYPE_WALL) mask |= 4;
  if (col > 0 && pixelOfficeTileMap[row][col - 1] === TILE_TYPE_WALL) mask |= 8;
  return mask;
};

export const pixelOfficeWalls: WallInstance[] = pixelOfficeRenderTiles
  .filter((tile) => tile.type === TILE_TYPE_WALL)
  .map((tile) => ({
    key: `wall-${tile.col}-${tile.row}`,
    x: tile.col * TILE_SIZE,
    y: tile.row * TILE_SIZE + (TILE_SIZE - WALL_TILE_HEIGHT),
    width: WALL_TILE_WIDTH,
    height: WALL_TILE_HEIGHT,
    zY: (tile.row + 1) * TILE_SIZE,
    frameIndex: buildWallMask(tile.col, tile.row),
    color: tile.colorHex ?? "#3B4652",
  }));

export const getWallSpriteStyle = (frameIndex: number) => {
  const column = frameIndex % WALL_SHEET_COLUMNS;
  const row = Math.floor(frameIndex / WALL_SHEET_COLUMNS);
  return {
    backgroundImage: "url('/pixel-office/assets/walls/wall_0.png')",
    backgroundRepeat: "no-repeat",
    backgroundSize: `${WALL_SHEET_COLUMNS * 100}% ${WALL_SHEET_ROWS * 100}%`,
    backgroundPosition: `${(column / (WALL_SHEET_COLUMNS - 1)) * 100}% ${
      (row / (WALL_SHEET_ROWS - 1)) * 100
    }%`,
  };
};
