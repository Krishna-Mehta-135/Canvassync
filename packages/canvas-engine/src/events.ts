/*
    events.ts

    Handles ALL user interaction.

    Responsibilities:
    - Convert mouse events → actions (dispatch)
    - Manage temporary interaction state
    - Coordinate between interaction helpers + geometry + rendering

    Key Design:
    - Priority: resize > drag > draw
    - No direct mutation (only dispatch)
    - Cursor = visual feedback only (never control flow)
    - Interaction-specific pure helpers live in ./interaction/*
    */

// File intent: route pointer interactions through a cached renderer without freezing linked text children.

import { render } from "./renderer";
import { Handle, Shape } from "./types";
import { Viewport, getMousePos, screenToWorldPoint } from "./utils";
import { CanvasState } from "./state";
import { getShapeAtPoint, getShapesAtPoint } from "./interaction/hitDetection";
import {
  dispatch,
  findTopBindableShapeAtPoint,
  getConnectorSnapEnabled,
  setConnectorSnapEnabled,
} from "./store";
import { convertToPoints, resizeShape } from "./geometry";
import {
  AttachEventsController,
  AttachEventsOptions,
  DefaultShapeStyle,
  isDrawableTool,
  Tool,
} from "./interaction/tools";
import { getCursorForHandle } from "./interaction/cursor";
import { getResizeTarget } from "./interaction/resizeTarget";
import { handleGlobalKeydown } from "./interaction/keyboard";
import { applySingleShapeDrag } from "./interaction/drag/dragging";
import { getDragAnchorsForShape } from "./interaction/drag/dragStart";
import { createTextEditingController } from "./interaction/text/textSession";
import { createReplayController } from "./interaction/replay/replayController";
import { attachViewportEvents } from "./interaction/events/viewportEvents";
import {
  applyShiftSelectionToggle,
  finalizeDrawCommit,
  finalizeEraserStroke,
  finalizeFreehandStroke,
} from "./interaction/events/pointerPhases";
import {
  renderDrawPreview,
  renderFreehandPreview,
  renderSelectionDragPreview,
} from "./interaction/events/pointerPreviews";
import {
  drawEraserTrail,
  getScenePixelRatio,
  SELECTION_PADDING,
} from "./interaction/events/eventHelpers";
import {
  getSelectedShapesByIds,
  hasDragged,
  SelectionBox,
} from "./interaction/selection";

/* ---------------- EVENTS ---------------- */

/**
 * Wires canvas input events to the engine interaction flow.
 *
 * The host app may either:
 * - provide tool state via options.getTool, or
 * - rely on internal tool state managed by keyboard shortcuts.
 */

export function attachEvents(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  state: CanvasState,
  options: AttachEventsOptions = {},
): AttachEventsController {
  const getDefaultViewport = () => ({
    x: canvas.clientWidth / 2,
    y: canvas.clientHeight / 2,
    scale: 1,
  });

  let viewport: Viewport = options.initialViewport ?? getDefaultViewport();
  let isGridVisible = true;
  let isSnapEnabled = getConnectorSnapEnabled();

  let selectedShape: Shape | null = null;
  let selectionBox: SelectionBox | null = null;
  let selectedShapeIds: string[] = [];

  let staticCacheCanvas: HTMLCanvasElement | null = null;
  let staticCacheCtx: CanvasRenderingContext2D | null = null;
  let isStaticCacheValid = false;

  let renderRaf: number | null = null;
  const requestRender = () => {
    if (renderRaf !== null) return;
    renderRaf = requestAnimationFrame(() => {
      renderRaf = null;
      renderScene();
    });
  };

  const getDependentShapeIds = (shapes: Shape[]) => {
    const dependentsById = new Map<string, Set<string>>();

    const addDependency = (
      sourceId: string | undefined,
      dependentId: string,
    ) => {
      if (!sourceId) return;

      let dependents = dependentsById.get(sourceId);
      if (!dependents) {
        dependents = new Set<string>();
        dependentsById.set(sourceId, dependents);
      }

      dependents.add(dependentId);
    };

    for (const shape of shapes) {
      if (shape.type === "text") {
        addDependency(shape.parentId, shape.id);
        continue;
      }

      if (shape.type === "line" || shape.type === "arrow") {
        addDependency(shape.startBinding?.shapeId, shape.id);
        addDependency(shape.endBinding?.shapeId, shape.id);
      }
    }

    return dependentsById;
  };

  const collectLiveDragShapeIds = (shapes: Shape[], selectedIds: string[]) => {
    if (selectedIds.length === 0) {
      return new Set<string>();
    }

    const dependentsById = getDependentShapeIds(shapes);
    const liveIds = new Set<string>(selectedIds);
    const pendingIds = [...selectedIds];

    while (pendingIds.length > 0) {
      const sourceId = pendingIds.pop();
      if (!sourceId) continue;

      const dependents = dependentsById.get(sourceId);
      if (!dependents) continue;

      for (const dependentId of dependents) {
        if (liveIds.has(dependentId)) continue;
        liveIds.add(dependentId);
        pendingIds.push(dependentId);
      }
    }

    return liveIds;
  };

  const renderScene = () => {
    const pixelRatio = getScenePixelRatio();
    const shapes = state.getShapes();
    const renderedShapes =
      isErasing || erasedShapeIds.size > 0
        ? shapes.map((shape) =>
            erasedShapeIds.has(shape.id)
              ? {
                  ...shape,
                  opacity: Math.min(shape.opacity ?? 100, 25),
                }
              : shape,
          )
        : shapes;

    const useCache = (isDragging || isResizing) && selectedShapeIds.length > 0;

    if (useCache) {
      const liveDragShapeIds = collectLiveDragShapeIds(
        renderedShapes,
        selectedShapeIds,
      );

      if (!staticCacheCanvas) {
        staticCacheCanvas = document.createElement("canvas");
        staticCacheCtx = staticCacheCanvas.getContext("2d");
      }
      if (
        staticCacheCanvas.width !== canvas.width ||
        staticCacheCanvas.height !== canvas.height
      ) {
        staticCacheCanvas.width = canvas.width;
        staticCacheCanvas.height = canvas.height;
        isStaticCacheValid = false;
      }

      if (!isStaticCacheValid && staticCacheCtx) {
        const staticShapes = renderedShapes.filter(
          (s) => !liveDragShapeIds.has(s.id),
        );
        render(
          staticCacheCtx,
          staticCacheCanvas,
          staticShapes,
          null,
          null,
          [],
          viewport,
          pixelRatio,
          [],
          isGridVisible,
          true,
        );
        isStaticCacheValid = true;
      }

      if (staticCacheCanvas) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(staticCacheCanvas, 0, 0);
        ctx.restore();
      }

      const activeShapes = renderedShapes.filter((shape) =>
        liveDragShapeIds.has(shape.id),
      );
      render(
        ctx,
        canvas,
        activeShapes,
        selectedShape,
        selectionBox,
        activeShapes,
        viewport,
        pixelRatio,
        connectorTargetHighlightIds,
        isGridVisible,
        false,
      );

      if (isErasing && eraserPoints.length > 0) {
        drawEraserTrail(ctx, eraserPoints, viewport, pixelRatio);
      }
      return;
    }

    isStaticCacheValid = false;

    render(
      ctx,
      canvas,
      renderedShapes,
      selectedShape,
      selectionBox,
      getSelectedShapesByIds(renderedShapes, selectedShapeIds),
      viewport,
      pixelRatio,
      connectorTargetHighlightIds,
      isGridVisible,
      true,
    );

    if (isErasing && eraserPoints.length > 0) {
      drawEraserTrail(ctx, eraserPoints, viewport, pixelRatio);
    }
  };

  const setViewport = (nextViewport: Viewport) => {
    viewport = nextViewport;
    isStaticCacheValid = false;
    options.onViewportChange?.(viewport);
    options.onCursorChange?.(
      lastPointer ? screenToWorldPoint(lastPointer, viewport) : null,
    );
  };

  let isDrawing = false;
  let startX = 0;
  let startY = 0;
  let pendingShapeId: string | null = null;
  let isDragging = false;

  let offsetX = 0;
  let offsetY = 0;

  let prevX = 0;
  let prevY = 0;

  let isResizing = false;
  let isFreehandDrawing = false;
  let freehandPoints: Array<{ x: number; y: number; t?: number }> = [];
  let freehandStrokeStyle: DefaultShapeStyle | undefined;
  let isErasing = false;
  let eraserPoints: Array<{ x: number; y: number }> = [];
  let erasedShapeIds = new Set<string>();
  let isPanning = false;
  let spacePressed = false;
  let panStartX = 0;
  let panStartY = 0;
  let panOriginX = 0;
  let panOriginY = 0;

  let resizeSession: {
    shape: Shape;
    handle: Handle;
  } | null = null;

  let currentTool: Tool = options.getTool?.() ?? "select";
  let activeTool: Tool | null = null;
  let connectorTargetHighlightIds: string[] = [];

  let isSelecting = false;

  let selectionStartX = 0;
  let selectionStartY = 0;
  let dragMode: "single" | "multi" | null = null;
  let lastPointer: { x: number; y: number } | null = null;
  const activePointers = new Map<number, { x: number; y: number }>();
  let isDestroyed = false;

  const getActiveTool = () => options.getTool?.() ?? currentTool;
  const getDefaultShapeStyle = () => options.getDefaultShapeStyle?.();

  const updateTool = (tool: Tool) => {
    currentTool = tool;
    options.onToolChange?.(tool);
  };

  const resetToSelectTool = () => {
    if (getActiveTool() === "select") return;
    updateTool("select");
  };

  const emitSelectionChange = () => {
    options.onSelectionChange?.([...selectedShapeIds]);
  };

  const setSelection = (ids: string[], primaryId?: string | null) => {
    selectedShapeIds = [...ids];

    const shapes = state.getShapes();
    const selectedShapes = getSelectedShapesByIds(shapes, selectedShapeIds);

    if (primaryId) {
      selectedShape =
        selectedShapes.find((shape) => shape.id === primaryId) ||
        selectedShapes[selectedShapes.length - 1] ||
        null;
    } else {
      selectedShape = selectedShapes[selectedShapes.length - 1] || null;
    }

    emitSelectionChange();
    return selectedShapes;
  };

  const clearSelection = () => {
    selectedShapeIds = [];
    selectedShape = null;
    emitSelectionChange();
  };

  const isInteractionActive = () =>
    isPanning ||
    isErasing ||
    isFreehandDrawing ||
    isDrawing ||
    isDragging ||
    isSelecting ||
    isResizing;

  const stopTransientInteractions = () => {
    const wasActive = isInteractionActive();
    isPanning = false;
    isErasing = false;
    isFreehandDrawing = false;
    isDrawing = false;
    isDragging = false;
    isSelecting = false;
    isResizing = false;
    dragMode = null;
    resizeSession = null;
    eraserPoints = [];
    erasedShapeIds = new Set();
    activeTool = null;
    connectorTargetHighlightIds = [];
    freehandPoints = [];
    freehandStrokeStyle = undefined;

    if (wasActive) {
      options.onInteractionEnd?.();
    }
  };

  const collectConnectorTargetHighlights = (params: {
    shapes: Shape[];
    excludeId?: string | null;
    points: Array<{ x: number; y: number }>;
  }) => {
    const { shapes, excludeId, points } = params;
    const ids = new Set<string>();

    points.forEach((point) => {
      const target = findTopBindableShapeAtPoint(
        shapes,
        point.x,
        point.y,
        excludeId,
      );
      if (!target) return;
      ids.add(target.id);
    });

    connectorTargetHighlightIds = [...ids];
  };

  const touchEraserPoint = (point: { x: number; y: number }) => {
    const touchedShapes = getShapesAtPoint(
      state.getShapes(),
      point.x,
      point.y,
      ctx,
    );

    let changed = false;
    for (const shape of touchedShapes) {
      if (erasedShapeIds.has(shape.id)) continue;
      erasedShapeIds.add(shape.id);
      changed = true;
    }

    if (changed) {
      selectedShapeIds = selectedShapeIds.filter(
        (id) => !erasedShapeIds.has(id),
      );
      if (
        selectedShape &&
        selectedShapeIds.indexOf(selectedShape.id) === -1 &&
        erasedShapeIds.has(selectedShape.id)
      ) {
        selectedShape = null;
      }
      emitSelectionChange();
    }
  };

  requestRender();

  const updateCursor = () => {
    if (isPanning) {
      canvas.style.cursor = "grabbing";
      return;
    }

    if (spacePressed) {
      canvas.style.cursor = "grab";
      return;
    }

    if (!lastPointer) {
      canvas.style.cursor = "default";
      return;
    }

    const worldPoint = screenToWorldPoint(lastPointer, viewport);
    const shapes = state.getShapes();
    const resizeTarget = getResizeTarget(
      shapes,
      worldPoint.x,
      worldPoint.y,
      selectedShape,
      SELECTION_PADDING,
      ctx,
    );
    const shape = getShapeAtPoint(shapes, worldPoint.x, worldPoint.y, ctx);
    const selectionBounds =
      selectedShapeIds.length > 0 ? getSelectionBounds(selectedShapeIds) : null;
    const isInsideSelectionBounds =
      !!selectionBounds &&
      worldPoint.x >= selectionBounds.x1 &&
      worldPoint.x <= selectionBounds.x2 &&
      worldPoint.y >= selectionBounds.y1 &&
      worldPoint.y <= selectionBounds.y2;

    if (resizeTarget) {
      canvas.style.cursor = getCursorForHandle(resizeTarget.handle);
    } else if (
      getActiveTool() === "select" &&
      isInsideSelectionBounds &&
      selectedShapeIds.length > 0
    ) {
      canvas.style.cursor = "move";
    } else if (shape) {
      canvas.style.cursor = "move";
    } else if (getActiveTool() === "select") {
      canvas.style.cursor = "default";
    } else if (getActiveTool() === "text") {
      canvas.style.cursor = "text";
    } else {
      canvas.style.cursor = "crosshair";
    }
  };

  const getSelectionBounds = (ids: string[]) => {
    if (ids.length === 0) return null;

    const selectedShapes = getSelectedShapesByIds(state.getShapes(), ids);
    if (selectedShapes.length === 0) return null;

    const first = convertToPoints(selectedShapes[0]!);
    let minX = first.x1;
    let minY = first.y1;
    let maxX = first.x2;
    let maxY = first.y2;

    for (let i = 1; i < selectedShapes.length; i++) {
      const shape = selectedShapes[i];
      if (!shape) continue;
      const box = convertToPoints(shape);
      minX = Math.min(minX, box.x1);
      minY = Math.min(minY, box.y1);
      maxX = Math.max(maxX, box.x2);
      maxY = Math.max(maxY, box.y2);
    }

    // Expanded by selection padding so hit area matches visible selection outline.
    return {
      x1: minX - SELECTION_PADDING,
      y1: minY - SELECTION_PADDING,
      x2: maxX + SELECTION_PADDING,
      y2: maxY + SELECTION_PADDING,
    };
  };

  const isPointNearShapeEdge = (shape: Shape, x: number, y: number) => {
    const EDGE_TOLERANCE = 10;

    if (shape.type === "rect" || shape.type === "text") {
      const box = convertToPoints(shape);
      const isInside = x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2;
      if (!isInside) return false;

      const distToEdge = Math.min(
        Math.abs(x - box.x1),
        Math.abs(box.x2 - x),
        Math.abs(y - box.y1),
        Math.abs(box.y2 - y),
      );
      return distToEdge <= EDGE_TOLERANCE;
    }

    if (shape.type === "circle") {
      const rx = Math.max(1, shape.radiusX);
      const ry = Math.max(1, shape.radiusY);
      const dx = x - shape.centerX;
      const dy = y - shape.centerY;
      const normalized = Math.sqrt(
        (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry),
      );
      const radialTolerance = EDGE_TOLERANCE / Math.max(rx, ry);
      return (
        normalized >= 1 - radialTolerance && normalized <= 1 + radialTolerance
      );
    }

    if (shape.type === "rhombus") {
      const width = Math.max(1, shape.width);
      const height = Math.max(1, shape.height);
      const centerX = shape.x + width / 2;
      const centerY = shape.y + height / 2;
      const nx = Math.abs(x - centerX) / (width / 2);
      const ny = Math.abs(y - centerY) / (height / 2);
      const diamondDistance = nx + ny;
      const tolerance = EDGE_TOLERANCE / Math.max(width / 2, height / 2);
      return (
        diamondDistance >= 1 - tolerance && diamondDistance <= 1 + tolerance
      );
    }

    return false;
  };

  const deleteSelection = () => {
    if (selectedShapeIds.length === 0) return;

    dispatch(state, {
      type: "DELETE_SHAPES",
      payload: {
        ids: selectedShapeIds,
      },
    });

    clearSelection();
    requestRender();
  };

  const textEditingController = createTextEditingController({
    canvas,
    ctx,
    state,
    getViewport: () => viewport,
    renderScene: requestRender,
    setSelection: (ids, primaryId) => {
      setSelection(ids, primaryId);
    },
    clearSelection,
    resetToSelectTool,
  });
  const startTextEditing = textEditingController.startTextEditing;

  const replayController = createReplayController({
    state,
    ctx,
    canvas,
    getSelectedShape: () => selectedShape,
    getSelectionBox: () => selectionBox,
    getSelectedShapeIds: () => [...selectedShapeIds],
    getViewport: () => viewport,
    getScenePixelRatio,
    renderScene: requestRender,
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    const keyboardTarget = e.target as HTMLElement | null;
    if (
      keyboardTarget &&
      (keyboardTarget.tagName === "TEXTAREA" ||
        keyboardTarget.tagName === "INPUT" ||
        keyboardTarget.isContentEditable)
    ) {
      return;
    }

    if (e.code === "Space") {
      e.preventDefault();
      spacePressed = true;
      updateCursor();
      return;
    }

    handleGlobalKeydown(e, {
      updateTool,
      hasSelection: () => selectedShapeIds.length > 0,
      deleteSelection,
      nudgeSelection: (dx, dy) => {
        dispatch(state, {
          type: "NUDGE_SHAPES",
          payload: {
            ids: selectedShapeIds,
            dx,
            dy,
          },
        });

        const updatedShapes = state.getShapes();
        selectedShape =
          updatedShapes.find((shape) => shape.id === selectedShape?.id) ||
          selectedShape;

        requestRender();
      },
      undo: () => {
        state.undo();
        clearSelection();
        requestRender();
      },
      redo: () => {
        state.redo();
        clearSelection();
        requestRender();
      },
    });
  };

  const handleMouseDown = (e: PointerEvent) => {
    const wasActiveBefore = isInteractionActive();
    const result = handleMouseDownInternal(e);
    if (!wasActiveBefore && isInteractionActive()) {
      options.onInteractionStart?.();
    }
    return result;
  };

  const handleMouseDownInternal = (e: PointerEvent) => {
    // Right-click opens the context menu, which swallows the matching pointerup;
    // starting a gesture here would leave it stuck to the mouse.
    if (e.button === 2) return;
    canvas.setPointerCapture(e.pointerId);
    const screenPoint = getMousePos(canvas, e);
    activePointers.set(e.pointerId, screenPoint);

    lastPointer = screenPoint;
    options.onCursorChange?.(screenToWorldPoint(screenPoint, viewport));
    const { x, y } = screenToWorldPoint(screenPoint, viewport);
    const shapes = state.getShapes();

    if (e.button === 1 || spacePressed || activePointers.size >= 2) {
      isPanning = true;

      const points = Array.from(activePointers.values());
      const avgX = points.reduce((acc, p) => acc + p.x, 0) / points.length;
      const avgY = points.reduce((acc, p) => acc + p.y, 0) / points.length;

      panStartX = avgX;
      panStartY = avgY;
      panOriginX = viewport.x;
      panOriginY = viewport.y;
      canvas.style.cursor = "grabbing";
      return;
    }

    if (getActiveTool() === "eraser") {
      e.preventDefault();
      isErasing = true;
      eraserPoints = [{ x, y }];
      erasedShapeIds = new Set();
      clearSelection();
      touchEraserPoint({ x, y });
      requestRender();
      return;
    }

    const active = getActiveTool();
    const resizeTarget =
      active === "select"
        ? getResizeTarget(shapes, x, y, selectedShape, SELECTION_PADDING, ctx)
        : null;
    const isConnectorResizeTarget =
      !!resizeTarget &&
      (resizeTarget.shape.type === "line" ||
        resizeTarget.shape.type === "arrow");
    const allowConnectorResize =
      isConnectorResizeTarget && selectedShape?.id === resizeTarget?.shape.id;

    if (resizeTarget && (!isConnectorResizeTarget || allowConnectorResize)) {
      isResizing = true;
      resizeSession = resizeTarget;
      setSelection([resizeTarget.shape.id], resizeTarget.shape.id);
      return;
    }

    const shape = getShapeAtPoint(shapes, x, y, ctx);

    if (!shape && getActiveTool() === "select" && selectedShapeIds.length > 1) {
      const bounds = getSelectionBounds(selectedShapeIds);
      const isInsideBounds =
        !!bounds &&
        x >= bounds.x1 &&
        x <= bounds.x2 &&
        y >= bounds.y1 &&
        y <= bounds.y2;

      if (isInsideBounds) {
        isDragging = true;
        dragMode = "multi";
        prevX = x;
        prevY = y;

        requestRender();
        return;
      }
    }

    if (
      !shape &&
      getActiveTool() === "select" &&
      selectedShapeIds.length === 1
    ) {
      const bounds = getSelectionBounds(selectedShapeIds);
      const isInsideBounds =
        !!bounds &&
        x >= bounds.x1 &&
        x <= bounds.x2 &&
        y >= bounds.y1 &&
        y <= bounds.y2;

      if (isInsideBounds) {
        const selectedId = selectedShapeIds[0];
        const currentSelectedShape = selectedId
          ? shapes.find((item) => item.id === selectedId)
          : null;

        if (currentSelectedShape) {
          selectedShape = currentSelectedShape;
          isDragging = true;
          dragMode = "single";

          const anchors = getDragAnchorsForShape(
            currentSelectedShape,
            { x, y },
            { offsetX, offsetY, prevX, prevY },
          );
          offsetX = anchors.offsetX;
          offsetY = anchors.offsetY;
          prevX = anchors.prevX;
          prevY = anchors.prevY;

          render(
            ctx,
            canvas,
            state.getShapes(),
            currentSelectedShape,
            null,
            getSelectedShapesByIds(state.getShapes(), selectedShapeIds),
            viewport,
            getScenePixelRatio(),
            [],
            isGridVisible,
          );
          return;
        }
      }
    }

    if (shape && getActiveTool() === "select" && e.shiftKey) {
      applyShiftSelectionToggle(shape, selectedShapeIds, setSelection);
      requestRender();
      return;
    }

    if (getActiveTool() === "text") {
      e.stopPropagation();
      e.preventDefault();

      if (shape?.type === "text") {
        startTextEditing(shape.x, shape.y, shape);
      } else {
        startTextEditing(x, y, undefined, shape || undefined);
      }

      return;
    }

    if (!shape && getActiveTool() === "freehand") {
      isFreehandDrawing = true;
      freehandPoints = [{ x, y, t: performance.now() }];
      freehandStrokeStyle = getDefaultShapeStyle();
      return;
    }

    if (
      shape &&
      (active === "line" || active === "arrow") &&
      shape.type !== "line" &&
      shape.type !== "arrow"
    ) {
      if (!isPointNearShapeEdge(shape, x, y)) {
        setSelection([shape.id], shape.id);
        requestRender();
        return;
      }
    }

    if (shape && getActiveTool() === "select") {
      selectedShape = shape;
      isDragging = true;

      const isShapeInSelection = selectedShapeIds.includes(shape.id);
      if (isShapeInSelection && selectedShapeIds.length > 1) {
        dragMode = "multi";
        prevX = x;
        prevY = y;

        requestRender();
        return;
      }

      setSelection([shape.id], shape.id);
      dragMode = "single";

      const anchors = getDragAnchorsForShape(
        shape,
        { x, y },
        { offsetX, offsetY, prevX, prevY },
      );
      offsetX = anchors.offsetX;
      offsetY = anchors.offsetY;
      prevX = anchors.prevX;
      prevY = anchors.prevY;

      requestRender();
      return;
    }

    if (!shape && getActiveTool() === "select") {
      isSelecting = true;

      selectionStartX = x;
      selectionStartY = y;

      clearSelection();

      requestRender();
      return;
    }

    if (!isDrawableTool(active)) {
      connectorTargetHighlightIds = [];
      return;
    }

    activeTool = active;
    isDrawing = true;
    startX = x;
    startY = y;
    pendingShapeId = crypto.randomUUID();
    connectorTargetHighlightIds = [];
    clearSelection();
    requestRender();
  };

  const handleMouseMove = (e: PointerEvent) => {
    const screenPoint = getMousePos(canvas, e);
    activePointers.set(e.pointerId, screenPoint);

    lastPointer = screenPoint;
    options.onCursorChange?.(screenToWorldPoint(screenPoint, viewport));
    const { x, y } = screenToWorldPoint(screenPoint, viewport);

    const shapes = state.getShapes();

    if (isPanning) {
      const points = Array.from(activePointers.values());
      const avgX = points.reduce((acc, p) => acc + p.x, 0) / points.length;
      const avgY = points.reduce((acc, p) => acc + p.y, 0) / points.length;

      setViewport({
        ...viewport,
        x: panOriginX + (avgX - panStartX),
        y: panOriginY + (avgY - panStartY),
      });

      updateCursor();
      requestRender();
      return;
    }

    if (isErasing) {
      eraserPoints = [...eraserPoints, { x, y }];
      touchEraserPoint({ x, y });
      requestRender();
      return;
    }

    updateCursor();

    const connectorDrawingTool = activeTool ?? getActiveTool();

    if (
      isResizing &&
      resizeSession &&
      (resizeSession.shape.type === "line" ||
        resizeSession.shape.type === "arrow")
    ) {
      const movingStart = resizeSession.handle === "start";
      const movingEnd = resizeSession.handle === "end";

      if (movingStart || movingEnd) {
        collectConnectorTargetHighlights({
          shapes,
          excludeId: resizeSession.shape.id,
          points: [
            {
              x: movingStart ? x : resizeSession.shape.x1,
              y: movingStart ? y : resizeSession.shape.y1,
            },
            {
              x: movingEnd ? x : resizeSession.shape.x2,
              y: movingEnd ? y : resizeSession.shape.y2,
            },
          ],
        });
      }
    } else if (
      isDrawing &&
      (connectorDrawingTool === "line" || connectorDrawingTool === "arrow")
    ) {
      collectConnectorTargetHighlights({
        shapes,
        excludeId: pendingShapeId,
        points: [
          { x: startX, y: startY },
          { x, y },
        ],
      });
    } else if (connectorTargetHighlightIds.length > 0) {
      connectorTargetHighlightIds = [];
    }

    if (isResizing && resizeSession) {
      const { shape, handle } = resizeSession;

      const updates = resizeShape(shape, handle, x, y, {
        fromCenter: e.altKey,
        preserveAspect: e.shiftKey,
      });

      dispatch(state, {
        type: "MOVE_SHAPE",
        payload: {
          id: shape.id,
          updates,
        },
      });

      const updated = state.getShapes().find((s) => s.id === shape.id);
      render(
        ctx,
        canvas,
        state.getShapes(),
        updated || null,
        null,
        getSelectedShapesByIds(state.getShapes(), selectedShapeIds),
        viewport,
        getScenePixelRatio(),
        connectorTargetHighlightIds,
        isGridVisible,
      );
      return;
    }

    if (isDragging && selectedShape) {
      if (dragMode === "multi") {
        const dx = x - prevX;
        const dy = y - prevY;

        if (dx !== 0 || dy !== 0) {
          dispatch(state, {
            type: "MOVE_SHAPES",
            payload: {
              ids: selectedShapeIds,
              dx,
              dy,
            },
          });
        }

        prevX = x;
        prevY = y;

        const updatedShapes = state.getShapes();
        selectedShape =
          updatedShapes.find((shape) => shape.id === selectedShape?.id) ||
          selectedShape;

        requestRender();
        return;
      }

      const selected = selectedShape;

      const dragResult = applySingleShapeDrag({
        state,
        selected,
        pointer: { x, y },
        offsetX,
        offsetY,
        prevX,
        prevY,
      });
      if (!dragResult.handled) return;

      prevX = dragResult.prevX;
      prevY = dragResult.prevY;

      requestRender();
      return;
    }

    if (isSelecting) {
      const selectionPreview = renderSelectionDragPreview({
        x,
        y,
        selectionStartX,
        selectionStartY,
        shapes,
        ctx,
        canvas,
        viewport,
        getScenePixelRatio,
      });
      selectionBox = selectionPreview.selectionBox;
      selectedShapeIds = selectionPreview.selectedShapeIds;
      emitSelectionChange();
      return;
    }

    if (isFreehandDrawing) {
      freehandPoints = renderFreehandPreview({
        x,
        y,
        freehandPoints,
        shapes,
        selectedShape,
        selectedShapeIds,
        ctx,
        canvas,
        viewport,
        getScenePixelRatio,
        defaultShapeStyle: freehandStrokeStyle,
      });
      return;
    }

    if (!isDrawing || !activeTool || !isDrawableTool(activeTool)) return;

    renderDrawPreview({
      state,
      activeTool,
      startX,
      startY,
      x,
      y,
      preserveAspect: e.shiftKey,
      pendingShapeId,
      selectedShape,
      selectedShapeIds,
      shapes,
      ctx,
      canvas,
      viewport,
      getScenePixelRatio,
      connectorTargetHighlightIds,
      defaultShapeStyle: getDefaultShapeStyle(),
    });
  };

  const handleMouseUp = (e: PointerEvent) => {
    const wasActiveBefore = isInteractionActive();
    const result = handleMouseUpInternal(e);
    if (wasActiveBefore && !isInteractionActive()) {
      options.onInteractionEnd?.();
    }
    return result;
  };

  const handleMouseUpInternal = (e: PointerEvent) => {
    canvas.releasePointerCapture(e.pointerId);
    activePointers.delete(e.pointerId);

    const screenPoint = getMousePos(canvas, e);
    lastPointer = screenPoint;
    options.onCursorChange?.(screenToWorldPoint(screenPoint, viewport));
    const { x, y } = screenToWorldPoint(screenPoint, viewport);

    if (isPanning) {
      if (activePointers.size > 0) {
        // Still panning with other fingers, reset origin to current average to avoid jumps
        const points = Array.from(activePointers.values());
        const avgX = points.reduce((acc, p) => acc + p.x, 0) / points.length;
        const avgY = points.reduce((acc, p) => acc + p.y, 0) / points.length;

        panStartX = avgX;
        panStartY = avgY;
        panOriginX = viewport.x;
        panOriginY = viewport.y;
      } else {
        isPanning = false;
        connectorTargetHighlightIds = [];
        updateCursor();
      }
      return;
    }

    if (isErasing) {
      isErasing = false;
      connectorTargetHighlightIds = [];

      const resetEraser = finalizeEraserStroke(
        state,
        erasedShapeIds,
        resetToSelectTool,
        updateCursor,
        requestRender,
      );
      eraserPoints = resetEraser.eraserPoints;
      erasedShapeIds = resetEraser.erasedShapeIds;
      return;
    }

    if (isFreehandDrawing) {
      isFreehandDrawing = false;
      connectorTargetHighlightIds = [];

      freehandPoints = finalizeFreehandStroke(
        state,
        freehandPoints,
        requestRender,
        freehandStrokeStyle,
      );
      freehandStrokeStyle = undefined;
      return;
    }

    if (isSelecting) {
      const didDragSelection = hasDragged(
        selectionStartX,
        selectionStartY,
        x,
        y,
      );
      isSelecting = false;
      selectionBox = null;
      connectorTargetHighlightIds = [];

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const selectedShapes = didDragSelection
        ? setSelection(selectedShapeIds)
        : [];
      if (!didDragSelection) {
        clearSelection();
      }

      requestRender();
      return;
    }

    if (isResizing) {
      isResizing = false;
      resizeSession = null;
      connectorTargetHighlightIds = [];
      return;
    }

    finalizeDrawCommit({
      state,
      activeTool,
      startX,
      startY,
      x,
      y,
      preserveAspect: e.shiftKey,
      pendingShapeId,
      setSelection,
      resetToSelectTool,
      renderScene: requestRender,
      hasDragged,
      defaultShapeStyle: getDefaultShapeStyle(),
    });

    isDrawing = false;
    activeTool = null;
    pendingShapeId = null;
    connectorTargetHighlightIds = [];
  };

  const handleDoubleClick = (e: MouseEvent) => {
    const screenPoint = getMousePos(canvas, e);
    lastPointer = screenPoint;
    options.onCursorChange?.(screenToWorldPoint(screenPoint, viewport));
    const { x, y } = screenToWorldPoint(screenPoint, viewport);
    const shape = getShapeAtPoint(state.getShapes(), x, y, ctx);
    if (!shape || shape.type !== "text") return;

    startTextEditing(shape.x, shape.y, shape);
  };

  window.addEventListener("keydown", handleKeyDown);

  const detachViewportEvents = attachViewportEvents({
    canvas,
    getViewport: () => viewport,
    setViewport,
    setLastPointer: (point) => {
      lastPointer = point;
    },
    updateCursor,
    renderScene: requestRender,
    isInteractionActive: () =>
      isPanning ||
      isErasing ||
      isFreehandDrawing ||
      isDrawing ||
      isDragging ||
      isSelecting ||
      isResizing,
    shouldRepaintOnReset: () =>
      isErasing ||
      isFreehandDrawing ||
      isDrawing ||
      isDragging ||
      isSelecting ||
      isResizing,
    resetInteractions: stopTransientInteractions,
    resetToSelectTool,
    releaseSpacePan: () => {
      spacePressed = false;
    },
  });

  const handlePointerCancel = (e: PointerEvent) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size === 0) {
      stopTransientInteractions();
      updateCursor();
    }
  };

  const handleContextMenu = () => {
    activePointers.clear();
    selectionBox = null;
    stopTransientInteractions();
    updateCursor();
    requestRender();
  };

  const handleMouseLeave = () => {
    lastPointer = null;
    options.onCursorChange?.(null);
  };

  canvas.addEventListener("pointerdown", handleMouseDown);
  canvas.addEventListener("pointermove", handleMouseMove);
  canvas.addEventListener("pointerup", handleMouseUp);
  canvas.addEventListener("pointercancel", handlePointerCancel);
  canvas.addEventListener("dblclick", handleDoubleClick);
  canvas.addEventListener("pointerleave", handleMouseLeave);
  canvas.addEventListener("contextmenu", handleContextMenu);

  return {
    deleteSelection,
    hasSelection: () => selectedShapeIds.length > 0,
    getSelectedIds: () => [...selectedShapeIds],
    getViewport: () => ({ ...viewport }),
    setViewport: (nextViewport: Viewport) => {
      stopTransientInteractions();
      selectionBox = null;
      setViewport(nextViewport);
      updateCursor();
      requestRender();
    },
    resetViewport: () => {
      stopTransientInteractions();
      selectionBox = null;
      setViewport(getDefaultViewport());
      updateCursor();
      requestRender();
    },
    focusViewportToBounds: (
      bounds: { minX: number; minY: number; maxX: number; maxY: number },
      options: {
        padding?: number;
        preserveScale?: boolean;
        /** Upper bound for the fitted zoom (default 4). */
        maxScale?: number;
        smooth?: boolean;
        durationMs?: number;
      } = {},
    ) => {
      stopTransientInteractions();
      selectionBox = null;

      const padding = options.padding ?? 120;
      const preserveScale = options.preserveScale ?? true;
      const smooth = options.smooth ?? true;
      const durationMs = Math.max(120, options.durationMs ?? 320);

      const canvasWidth = Math.max(1, canvas.clientWidth);
      const canvasHeight = Math.max(1, canvas.clientHeight);
      const width = Math.max(1, bounds.maxX - bounds.minX);
      const height = Math.max(1, bounds.maxY - bounds.minY);
      const safePadding = Math.max(
        24,
        Math.min(
          padding,
          Math.floor(Math.min(canvasWidth, canvasHeight) * 0.35),
        ),
      );

      const fitScaleX = (canvasWidth - safePadding * 2) / width;
      const fitScaleY = (canvasHeight - safePadding * 2) / height;
      const fitScale = Math.max(
        0.2,
        Math.min(options.maxScale ?? 4, Math.min(fitScaleX, fitScaleY)),
      );
      const nextScale = preserveScale ? viewport.scale : fitScale;

      const centerX = (bounds.minX + bounds.maxX) / 2;
      const centerY = (bounds.minY + bounds.maxY) / 2;
      const targetViewport: Viewport = {
        scale: nextScale,
        x: canvasWidth / 2 - centerX * nextScale,
        y: canvasHeight / 2 - centerY * nextScale,
      };

      if (!smooth) {
        setViewport(targetViewport);
        updateCursor();
        requestRender();
        return;
      }

      const startViewport = { ...viewport };
      const startedAt = performance.now();
      const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

      const animate = (now: number) => {
        const rawT = Math.min(1, (now - startedAt) / durationMs);
        const t = easeOutCubic(rawT);

        setViewport({
          scale:
            startViewport.scale +
            (targetViewport.scale - startViewport.scale) * t,
          x: startViewport.x + (targetViewport.x - startViewport.x) * t,
          y: startViewport.y + (targetViewport.y - startViewport.y) * t,
        });
        requestRender();

        if (rawT < 1) {
          requestAnimationFrame(animate);
        } else {
          updateCursor();
        }
      };

      requestAnimationFrame(animate);
    },
    setGridVisible: (visible: boolean) => {
      isGridVisible = visible;
      requestRender();
    },
    isGridVisible: () => isGridVisible,
    setSnapEnabled: (enabled: boolean) => {
      isSnapEnabled = enabled;
      setConnectorSnapEnabled(enabled);

      if (!enabled) {
        const shapes = state.getShapes().map((shape) => {
          if (shape.type !== "line" && shape.type !== "arrow") return shape;
          return {
            ...shape,
            startBinding: undefined,
            endBinding: undefined,
          };
        });
        state.setShapes(shapes);
      }

      requestRender();
    },
    isSnapEnabled: () => isSnapEnabled,
    rerender: () => {
      const shapes = state.getShapes();
      const selected = getSelectedShapesByIds(shapes, selectedShapeIds);
      render(
        ctx,
        canvas,
        shapes,
        selectedShape,
        selectionBox,
        selected,
        viewport,
        getScenePixelRatio(),
        connectorTargetHighlightIds,
        isGridVisible,
      );
    },
    replayShape: replayController.replayShape,
    destroy: () => {
      if (isDestroyed) {
        return;
      }

      isDestroyed = true;
      window.removeEventListener("keydown", handleKeyDown);
      canvas.removeEventListener("pointerdown", handleMouseDown);
      canvas.removeEventListener("pointermove", handleMouseMove);
      canvas.removeEventListener("pointerup", handleMouseUp);
      canvas.removeEventListener("pointercancel", handlePointerCancel);
      canvas.removeEventListener("dblclick", handleDoubleClick);
      canvas.removeEventListener("pointerleave", handleMouseLeave);
      canvas.removeEventListener("contextmenu", handleContextMenu);
      detachViewportEvents();
      textEditingController.dispose();
    },
  };
}
