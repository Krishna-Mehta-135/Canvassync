import { dispatch } from "../../store";
import { Shape } from "../../types";
import { CanvasState } from "../../state";
import { createPreviewShape } from "../preview";
import { DEFAULT_SHAPE_ROUGHNESS } from "./eventHelpers";
import { DefaultShapeStyle, Tool } from "../tools";

type SetSelection = (ids: string[], primaryId?: string | null) => Shape[];

export function applyShiftSelectionToggle(
  shape: Shape,
  selectedShapeIds: string[],
  setSelection: SetSelection,
) {
  const exists = selectedShapeIds.includes(shape.id);
  const nextSelectionIds = exists
    ? selectedShapeIds.filter((id) => id !== shape.id)
    : [...selectedShapeIds, shape.id];

  return setSelection(nextSelectionIds);
}

export function finalizeEraserStroke(
  state: CanvasState,
  erasedShapeIds: Set<string>,
  resetToSelectTool: () => void,
  updateCursor: () => void,
  renderScene: () => void,
) {
  if (erasedShapeIds.size > 0) {
    dispatch(state, {
      type: "DELETE_SHAPES",
      payload: {
        ids: Array.from(erasedShapeIds),
      },
    });
  }

  resetToSelectTool();
  updateCursor();
  renderScene();

  return {
    eraserPoints: [] as Array<{ x: number; y: number }>,
    erasedShapeIds: new Set<string>(),
  };
}

export function finalizeFreehandStroke(
  state: CanvasState,
  freehandPoints: Array<{ x: number; y: number; t?: number }>,
  renderScene: () => void,
  defaultShapeStyle?: DefaultShapeStyle,
) {
  if (freehandPoints.length > 1) {
    const nextStyle = defaultShapeStyle ?? {};
    const freehandShape: Extract<Shape, { type: "freehand" }> = {
      id: crypto.randomUUID(),
      type: "freehand",
      points: freehandPoints,
      ...nextStyle,
      roughness: nextStyle.roughness ?? DEFAULT_SHAPE_ROUGHNESS,
      strokeStyle: nextStyle.strokeStyle ?? "solid",
    };

    dispatch(state, {
      type: "ADD_SHAPE",
      payload: freehandShape,
    });
  }

  // Pencil stays armed after a stroke (like Excalidraw): no tool reset, no selection.
  renderScene();

  return [] as Array<{ x: number; y: number; t?: number }>;
}

export function finalizeDrawCommit(params: {
  state: CanvasState;
  activeTool: Tool | null;
  startX: number;
  startY: number;
  x: number;
  y: number;
  preserveAspect: boolean;
  pendingShapeId: string | null;
  setSelection: (ids: string[], primaryId?: string | null) => void;
  resetToSelectTool: () => void;
  renderScene: () => void;
  hasDragged: (x1: number, y1: number, x2: number, y2: number) => boolean;
  defaultShapeStyle?: DefaultShapeStyle;
}) {
  const {
    state,
    activeTool,
    startX,
    startY,
    x,
    y,
    preserveAspect,
    pendingShapeId,
    setSelection,
    resetToSelectTool,
    renderScene,
    hasDragged,
    defaultShapeStyle,
  } = params;

  if (!hasDragged(startX, startY, x, y) || !activeTool) {
    renderScene();
    resetToSelectTool();
    return { didAddShape: false };
  }

  const preview = createPreviewShape(activeTool, startX, startY, x, y, {
    preserveAspect,
  });

  if (!preview) {
    renderScene();
    resetToSelectTool();
    return { didAddShape: false };
  }

  const newShapeId = pendingShapeId ?? crypto.randomUUID();

  dispatch(state, {
    type: "ADD_SHAPE",
    payload: {
      ...preview,
      id: newShapeId,
      ...(defaultShapeStyle ?? {}),
      roughness: defaultShapeStyle?.roughness ?? DEFAULT_SHAPE_ROUGHNESS,
      strokeStyle: defaultShapeStyle?.strokeStyle ?? "solid",
    },
  });

  setSelection([newShapeId], newShapeId);
  resetToSelectTool();
  renderScene();

  return { didAddShape: true };
}
