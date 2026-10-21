/**
 * Active drawing/interaction mode selected from toolbar or shortcuts.
 */
export type Tool =
  | "select"
  | "rect"
  | "circle"
  | "rhombus"
  | "line"
  | "arrow"
  | "text"
  | "freehand"
  | "eraser";

export type DefaultShapeStyle = {
  stroke?: string;
  strokeStyle?: "solid" | "dashed" | "dotted";
  fill?: string;
  fillStyle?: "solid" | "hachure" | "cross-hatch" | "dots";
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
};

/**
 * Tools that currently create geometry via drag interactions.
 */
export function isDrawableTool(
  tool: Tool,
): tool is "rect" | "circle" | "rhombus" | "line" | "arrow" {
  return (
    tool === "rect" ||
    tool === "circle" ||
    tool === "rhombus" ||
    tool === "line" ||
    tool === "arrow"
  );
}

/**
 * Optional integration hooks so the host app can own tool state.
 */
export type AttachEventsOptions = {
  getTool?: () => Tool;
  getDefaultShapeStyle?: () => DefaultShapeStyle | undefined;
  onToolChange?: (tool: Tool) => void;
  onSelectionChange?: (selectedIds: string[]) => void;
  /** Current local cursor in world coordinates, or null when the pointer leaves the canvas. */
  onCursorChange?: (cursor: { x: number; y: number } | null) => void;
  initialViewport?: import("../utils").Viewport;
  onViewportChange?: (viewport: import("../utils").Viewport) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
};

/**
 * Imperative controls exposed by attachEvents for host UI integrations.
 */
export type AttachEventsController = {
  deleteSelection: () => void;
  hasSelection: () => boolean;
  getSelectedIds: () => string[];
  getViewport: () => import("../utils").Viewport;
  setViewport: (nextViewport: import("../utils").Viewport) => void;
  resetViewport: () => void;
  focusViewportToBounds: (
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    options?: {
      padding?: number;
      preserveScale?: boolean;
      smooth?: boolean;
      durationMs?: number;
      /** Upper bound for the fitted zoom (default 4). */
      maxScale?: number;
    },
  ) => void;
  setGridVisible: (visible: boolean) => void;
  isGridVisible: () => boolean;
  setSnapEnabled: (enabled: boolean) => void;
  isSnapEnabled: () => boolean;
  rerender: () => void;
  replayShape: (shapeId: string) => void;
  destroy: () => void;
};
