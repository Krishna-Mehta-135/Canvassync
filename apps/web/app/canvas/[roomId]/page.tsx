"use client";

/* File intent: Interactive canvas workspace with tools, presence, and room actions. */

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { AxiosError } from "axios";
import { jsPDF } from "jspdf";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  attachEvents,
  convertToPoints,
  dispatch,
  getArrowHeadPoints,
  getConnectorRoutePoints,
} from "@repo/canvas-engine";
import {
  CanvasState,
  mermaidToShapes,
  tidyLayout,
  snapSketches,
  buildTemplate,
  alignShapes,
  distributeShapes,
  type AlignMode,
  type DistributeAxis,
  MermaidParseError,
  type TemplateId,
} from "@repo/canvas-engine";
import type { Shape, Tool } from "@repo/canvas-engine";
import { HTTP_BACKEND } from "../../../config";
import { apiClient } from "../../lib/apiClient";
import { prepareImageForAi } from "../../lib/imageForAi";
import { ensureAuthenticated, logoutUser } from "../../lib/auth";
import { useTheme } from "../../components/ThemeToggle";
import { useCanvasChat } from "../../../hooks/useCanvasChat";
import { useCanvasSync } from "../../../hooks/useCanvasSync";
import { useAiGeneration, type AiResultMeta } from "../../../hooks/useAiGeneration";
import { RemotePresenceLayer } from "../../components/RemotePresenceLayer";
import { LiveCollabLayer } from "../../components/LiveCollabLayer";
import { HistoryPanel } from "../../components/HistoryPanel";
import { AiEditBar } from "../../components/AiEditBar";
import { MermaidModal } from "../../components/MermaidModal";
import { SummaryModal } from "../../components/SummaryModal";
import { TemplatesModal } from "../../components/TemplatesModal";
import { ArrangeBar } from "../../components/ArrangeBar";
import { AiChatModal, AiTriggerButton } from "../../components/AiPromptBar";
import { CanvasMessenger } from "../../components/CanvasMessenger";

const STYLE_SWATCHES = [
  "#1e1e1e",
  "#e03131",
  "#2f9e44",
  "#1971c2",
  "#f08c00",
  "#ffffff",
];
const RAINBOW_PICKER_BACKGROUND =
  "conic-gradient(from 180deg at 50% 50%, #ef4444, #f97316, #eab308, #22c55e, #06b6d4, #3b82f6, #8b5cf6, #ec4899, #ef4444)";

function normalizePickerColor(
  value: string | null | undefined,
  fallback: string,
) {
  if (!value) return fallback;
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ? value : fallback;
}

const FILL_STYLE_OPTIONS: Array<{
  value: NonNullable<Shape["fillStyle"]>;
  label: string;
}> = [
  { value: "solid", label: "Solid" },
  { value: "hachure", label: "Hachure" },
  { value: "cross-hatch", label: "Cross Hatch" },
  { value: "dots", label: "Dots" },
];
const STROKE_STYLE_OPTIONS: Array<{
  value: NonNullable<Shape["strokeStyle"]>;
  label: string;
}> = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
];
const DRAWING_PERSONAS = [
  {
    id: "architect",
    label: "Architect",
    roughness: 0,
    summary: "Crisp and precise strokes",
    examples: ["Blueprint", "Flowchart", "Wireframe"],
  },
  {
    id: "artist",
    label: "Artist",
    roughness: 1.2,
    summary: "Balanced hand-drawn feel",
    examples: ["Storyboard", "Sketch note", "Concept map"],
  },
  {
    id: "cartoonist",
    label: "Cartoonist",
    roughness: 3.4,
    summary: "Expressive and playful lines",
    examples: ["Comic panel", "Doodle scene", "Character board"],
  },
] as const;
const DEFAULT_ROUGHNESS_STORAGE_KEY = "canvas-default-roughness";

const TOOLS: Array<{
  id: Tool;
  label: string;
  shortcut: string;
  icon: ReactNode;
}> = [
  {
    id: "select",
    label: "Select",
    shortcut: "0",
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M6 3l11 7-5 1 3 7-2 1-3-7-4 4z" />
      </svg>
    ),
  },
  {
    id: "rect",
    label: "Rectangle",
    shortcut: "1",
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <rect x="4" y="6" width="16" height="12" rx="1" />
      </svg>
    ),
  },
  {
    id: "circle",
    label: "Ellipse",
    shortcut: "2",
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <ellipse cx="12" cy="12" rx="8" ry="6" />
      </svg>
    ),
  },
  {
    id: "rhombus",
    label: "Rhombus",
    shortcut: "3",
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M12 4l8 8-8 8-8-8z" />
      </svg>
    ),
  },
  {
    id: "line",
    label: "Line",
    shortcut: "4",
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M5 18L19 6" />
      </svg>
    ),
  },
  {
    id: "arrow",
    label: "Arrow",
    shortcut: "5",
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M5 18L18 6" />
        <path d="M12 6h6v6" />
      </svg>
    ),
  },
  {
    id: "text",
    label: "Text",
    shortcut: "6",
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M4 6h16" />
        <path d="M12 6v12" />
      </svg>
    ),
  },
  {
    id: "freehand",
    label: "Freehand",
    shortcut: "7",
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M3 16c3-8 8 4 12-4 1-2 3-2 6 0" />
      </svg>
    ),
  },
  {
    id: "eraser",
    label: "Eraser",
    shortcut: "8",
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 15.5l7.5-7.5a2 2 0 012.8 0l5.2 5.2-5.8 5.8H8.2l-4.2-4.2a2 2 0 010-2.8z" />
        <path d="M12.2 13.2l4.1 4.1" />
        <path d="M7.2 18.2h4.2" />
      </svg>
    ),
  },
];

type StoredViewport = {
  x: number;
  y: number;
  scale: number;
};

type DebugOverlaySnapshot = {
  version: number;
  shapeCount: number;
  shapeIds: string[];
  capturedAt: string;
};

type DebugPanelMode = "compact" | "verbose";

type Toast = {
  id: number;
  tone: "success" | "error" | "info";
  message: string;
};

type FloatingShapeComment = {
  id: string;
  shapeId: string;
  body: string;
  authorLabel: string;
  x: number;
  y: number;
};

type ExportFormat = "png" | "svg" | "pdf" | "json";

type IncomingAccessRequest = {
  id: number;
  createdAt: string;
  requester: {
    id: string;
    name: string;
    handle: string | null;
    email: string;
  };
  room: {
    id: number;
    slug: string;
  };
};

type CanvasSwitcherEntry = {
  target: string;
  label: string;
  visitedAt: number;
};

const RECENT_CANVASES_STORAGE_KEY = "canvas-recent-canvases";
const MAX_RECENT_CANVASES = 8;

function normalizeJoinTarget(rawValue: string) {
  const trimmed = rawValue.trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed, window.location.origin);
    const segments = url.pathname.split("/").filter(Boolean);
    const canvasIndex = segments.indexOf("canvas");
    const roomIndex = segments.indexOf("room");

    if (roomIndex >= 0 && segments[roomIndex + 1] && segments[roomIndex + 2]) {
      return `room/${segments[roomIndex + 1]}/${segments[roomIndex + 2]}`;
    }

    if (canvasIndex >= 0 && segments[canvasIndex + 1]) {
      return `canvas/${segments[canvasIndex + 1]}`;
    }

    return segments[segments.length - 1] ?? trimmed;
  } catch {
    return trimmed.replace(/^\/+|\/+$/g, "");
  }
}

function deriveCanvasLabel(target: string) {
  if (target.startsWith("room/")) {
    const parts = target.split("/");
    const owner = parts[1] ?? "";
    const slug = parts[2] ?? "";
    if (owner && slug) {
      return `@${owner} / ${slug}`;
    }
  }

  if (target.startsWith("canvas/")) {
    const slug = target.slice("canvas/".length);
    if (slug) {
      return slug;
    }
  }

  return target;
}

function readRecentCanvasesFromStorage() {
  if (typeof window === "undefined") return [] as CanvasSwitcherEntry[];

  try {
    const raw = window.localStorage.getItem(RECENT_CANVASES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((entry): entry is CanvasSwitcherEntry => {
        return (
          !!entry &&
          typeof entry === "object" &&
          typeof entry.target === "string" &&
          typeof entry.label === "string" &&
          typeof entry.visitedAt === "number" &&
          Number.isFinite(entry.visitedAt)
        );
      })
      .slice(0, MAX_RECENT_CANVASES);
  } catch {
    return [];
  }
}

function writeRecentCanvasesToStorage(entries: CanvasSwitcherEntry[]) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      RECENT_CANVASES_STORAGE_KEY,
      JSON.stringify(entries.slice(0, MAX_RECENT_CANVASES)),
    );
  } catch {
    // Ignore storage failures so the switcher remains functional.
  }
}

function getViewportStorageKey(roomKey: string) {
  return `canvas-viewport:${roomKey}`;
}

function loadStoredViewport(roomKey: string): StoredViewport | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(getViewportStorageKey(roomKey));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<StoredViewport>;
    if (
      typeof parsed.x !== "number" ||
      typeof parsed.y !== "number" ||
      typeof parsed.scale !== "number" ||
      !Number.isFinite(parsed.x) ||
      !Number.isFinite(parsed.y) ||
      !Number.isFinite(parsed.scale)
    ) {
      return null;
    }

    return {
      x: parsed.x,
      y: parsed.y,
      scale: parsed.scale,
    };
  } catch {
    return null;
  }
}

function saveStoredViewport(roomKey: string, viewport: StoredViewport) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      getViewportStorageKey(roomKey),
      JSON.stringify(viewport),
    );
  } catch {
    // Ignore storage failures; viewport persistence is best-effort.
  }
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function areStringArraysEqual(left: string[], right: string[]) {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

// File intent: keep AI-generated geometry safe/normalized so selection and dragging remain stable.
function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function ensurePositiveSpan(origin: number, span: number, minSpan: number) {
  if (span >= 0) {
    return { origin, span: Math.max(minSpan, span) };
  }

  return {
    origin: origin + span,
    span: Math.max(minSpan, Math.abs(span)),
  };
}

type NodeShape = Extract<Shape, { type: "rect" | "rhombus" | "circle" }>;

function getNodeArea(node: NodeShape) {
  if (node.type === "circle") {
    return Math.PI * node.radiusX * node.radiusY;
  }

  return node.width * node.height;
}

function textAnchorPoint(text: Extract<Shape, { type: "text" }>) {
  return {
    x: text.x + text.width / 2,
    y: text.y + text.height / 2,
  };
}

function containsPoint(node: NodeShape, point: { x: number; y: number }) {
  if (node.type === "rect") {
    return (
      point.x >= node.x &&
      point.x <= node.x + node.width &&
      point.y >= node.y &&
      point.y <= node.y + node.height
    );
  }

  if (node.type === "rhombus") {
    const halfW = node.width / 2;
    const halfH = node.height / 2;
    if (halfW <= 0 || halfH <= 0) return false;
    const centerX = node.x + halfW;
    const centerY = node.y + halfH;
    const nx = Math.abs(point.x - centerX) / halfW;
    const ny = Math.abs(point.y - centerY) / halfH;
    return nx + ny <= 1;
  }

  const rx = Math.max(1, node.radiusX);
  const ry = Math.max(1, node.radiusY);
  const dx = point.x - node.centerX;
  const dy = point.y - node.centerY;
  return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
}

function linkAiTextToContainingNodes(shapes: Shape[]) {
  const nodes = shapes.filter(
    (shape): shape is NodeShape =>
      shape.type === "rect" ||
      shape.type === "rhombus" ||
      shape.type === "circle",
  );

  if (nodes.length === 0) return shapes;

  return shapes.map((shape) => {
    if (shape.type !== "text") {
      return shape;
    }

    const anchor = textAnchorPoint(shape);
    const containing = nodes.filter((node) => containsPoint(node, anchor));
    if (containing.length === 0) {
      return {
        ...shape,
        parentId: undefined,
      };
    }

    const parent = containing.sort(
      (a, b) => getNodeArea(a) - getNodeArea(b),
    )[0];
    return {
      ...shape,
      parentId: parent?.id,
    };
  });
}

function sanitizeAiGeneratedShapes(rawShapes: unknown[]): Shape[] {
  const normalized: Shape[] = [];
  const usedIds = new Set<string>();

  rawShapes.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return;

    const shape = candidate as Record<string, unknown>;
    const type = shape.type;
    if (typeof type !== "string") return;

    const rawId = typeof shape.id === "string" ? shape.id.trim() : "";
    const id =
      rawId && !usedIds.has(rawId) ? rawId : `ai-${crypto.randomUUID()}`;
    usedIds.add(id);

    const baseStyle = {
      stroke: typeof shape.stroke === "string" ? shape.stroke : undefined,
      fill: typeof shape.fill === "string" ? shape.fill : undefined,
      strokeStyle:
        shape.strokeStyle === "solid" ||
        shape.strokeStyle === "dashed" ||
        shape.strokeStyle === "dotted"
          ? shape.strokeStyle
          : undefined,
      fillStyle:
        shape.fillStyle === "solid" ||
        shape.fillStyle === "hachure" ||
        shape.fillStyle === "cross-hatch" ||
        shape.fillStyle === "dots"
          ? shape.fillStyle
          : undefined,
      strokeWidth: Math.max(1, asFiniteNumber(shape.strokeWidth) ?? 2),
      roughness:
        asFiniteNumber(shape.roughness) ?? DRAWING_PERSONAS[1]?.roughness ?? 1,
      opacity: Math.max(1, Math.min(100, asFiniteNumber(shape.opacity) ?? 100)),
    } as const;

    if (type === "rect" || type === "rhombus") {
      const x = asFiniteNumber(shape.x);
      const y = asFiniteNumber(shape.y);
      const width = asFiniteNumber(shape.width);
      const height = asFiniteNumber(shape.height);
      if (x === null || y === null || width === null || height === null) return;

      const normalizedX = ensurePositiveSpan(x, width, 8);
      const normalizedY = ensurePositiveSpan(y, height, 8);

      normalized.push({
        id,
        type,
        x: normalizedX.origin,
        y: normalizedY.origin,
        width: normalizedX.span,
        height: normalizedY.span,
        ...baseStyle,
      } as Shape);
      return;
    }

    if (type === "circle") {
      const centerX = asFiniteNumber(shape.centerX);
      const centerY = asFiniteNumber(shape.centerY);
      const radiusX = asFiniteNumber(shape.radiusX);
      const radiusY = asFiniteNumber(shape.radiusY);
      if (
        centerX === null ||
        centerY === null ||
        radiusX === null ||
        radiusY === null
      )
        return;

      normalized.push({
        id,
        type: "circle",
        centerX,
        centerY,
        radiusX: Math.max(4, Math.abs(radiusX)),
        radiusY: Math.max(4, Math.abs(radiusY)),
        ...baseStyle,
      });
      return;
    }

    if (type === "line" || type === "arrow") {
      const x1 = asFiniteNumber(shape.x1);
      const y1 = asFiniteNumber(shape.y1);
      const x2 = asFiniteNumber(shape.x2);
      const y2 = asFiniteNumber(shape.y2);
      if (x1 === null || y1 === null || x2 === null || y2 === null) return;

      const endX = x1 === x2 && y1 === y2 ? x2 + 1 : x2;
      normalized.push({
        id,
        type,
        x1,
        y1,
        x2: endX,
        y2,
        startBinding: undefined,
        endBinding: undefined,
        ...baseStyle,
      } as Shape);
      return;
    }

    if (type === "text") {
      const x = asFiniteNumber(shape.x);
      const y = asFiniteNumber(shape.y);
      if (x === null || y === null) return;

      const text = typeof shape.text === "string" ? shape.text : "";
      const trimmedText = text.trim();
      if (!trimmedText) return;

      const requestedWidth = asFiniteNumber(shape.width);
      const requestedHeight = asFiniteNumber(shape.height);
      const fallbackWidth = Math.max(24, Math.min(420, trimmedText.length * 9));

      const normalizedWidth = ensurePositiveSpan(
        x,
        requestedWidth ?? fallbackWidth,
        12,
      );
      const normalizedHeight = ensurePositiveSpan(y, requestedHeight ?? 24, 12);

      normalized.push({
        id,
        type: "text",
        x: normalizedWidth.origin,
        y: normalizedHeight.origin,
        width: normalizedWidth.span,
        height: normalizedHeight.span,
        text: trimmedText,
        fontSize: Math.max(10, asFiniteNumber(shape.fontSize) ?? 18),
        // AI inserts must not inherit parent linkage from stale prompts.
        parentId: undefined,
        ...baseStyle,
      });
      return;
    }

    if (type === "freehand") {
      const rawPoints = Array.isArray(shape.points) ? shape.points : [];
      const points = rawPoints
        .map((point) => {
          if (!point || typeof point !== "object") return null;
          const p = point as Record<string, unknown>;
          const x = asFiniteNumber(p.x);
          const y = asFiniteNumber(p.y);
          if (x === null || y === null) return null;
          const t = asFiniteNumber(p.t);
          return t === null ? { x, y } : { x, y, t };
        })
        .filter(
          (point): point is { x: number; y: number; t?: number } =>
            point !== null,
        );

      if (points.length < 2) return;

      normalized.push({
        id,
        type: "freehand",
        points,
        ...baseStyle,
      });
      return;
    }

    // Ignore unknown shape types to avoid corrupting canvas state.
    console.warn("[Canvas] Ignoring unsupported AI shape", { index, type });
  });

  return linkAiTextToContainingNodes(normalized);
}

function getShapeBounds(shape: Shape) {
  if (
    shape.type === "rect" ||
    shape.type === "rhombus" ||
    shape.type === "text"
  ) {
    return {
      minX: shape.x,
      minY: shape.y,
      maxX: shape.x + shape.width,
      maxY: shape.y + shape.height,
    };
  }

  if (shape.type === "circle") {
    return {
      minX: shape.centerX - shape.radiusX,
      minY: shape.centerY - shape.radiusY,
      maxX: shape.centerX + shape.radiusX,
      maxY: shape.centerY + shape.radiusY,
    };
  }

  if (shape.type === "line" || shape.type === "arrow") {
    return {
      minX: Math.min(shape.x1, shape.x2),
      minY: Math.min(shape.y1, shape.y2),
      maxX: Math.max(shape.x1, shape.x2),
      maxY: Math.max(shape.y1, shape.y2),
    };
  }

  if (shape.type === "freehand") {
    if (shape.points.length === 0) {
      return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }

    const xs = shape.points.map((point) => point.x);
    const ys = shape.points.map((point) => point.y);
    return {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    };
  }

  return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
}

function translateShapes(shapes: Shape[], dx: number, dy: number): Shape[] {
  if (dx === 0 && dy === 0) return shapes;
  return shapes.map((shape): Shape => {
    switch (shape.type) {
      case "rect":
      case "rhombus":
      case "text":
        return { ...shape, x: shape.x + dx, y: shape.y + dy };
      case "circle":
        return { ...shape, centerX: shape.centerX + dx, centerY: shape.centerY + dy };
      case "line":
      case "arrow":
        return {
          ...shape,
          x1: shape.x1 + dx,
          y1: shape.y1 + dy,
          x2: shape.x2 + dx,
          y2: shape.y2 + dy,
        };
      case "freehand":
        return {
          ...shape,
          points: shape.points.map((point) => ({
            ...point,
            x: point.x + dx,
            y: point.y + dy,
          })),
        };
    }
  });
}

function getBoundsForShapes(shapes: Shape[]) {
  if (shapes.length === 0) return null;

  let bounds = getShapeBounds(shapes[0]!);
  for (let i = 1; i < shapes.length; i += 1) {
    const b = getShapeBounds(shapes[i]!);
    bounds = {
      minX: Math.min(bounds.minX, b.minX),
      minY: Math.min(bounds.minY, b.minY),
      maxX: Math.max(bounds.maxX, b.maxX),
      maxY: Math.max(bounds.maxY, b.maxY),
    };
  }

  return bounds;
}

function buildSvgMarkup(shapes: Shape[]) {
  if (shapes.length === 0) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600"/>`;
  }

  const bounds = shapes.map(getShapeBounds);
  const minX = Math.min(...bounds.map((box) => box.minX));
  const minY = Math.min(...bounds.map((box) => box.minY));
  const maxX = Math.max(...bounds.map((box) => box.maxX));
  const maxY = Math.max(...bounds.map((box) => box.maxY));
  const padding = 32;
  const width = Math.max(1, maxX - minX + padding * 2);
  const height = Math.max(1, maxY - minY + padding * 2);
  const viewBox = `${minX - padding} ${minY - padding} ${width} ${height}`;

  const shapeElements = shapes
    .map((shape) => {
      const stroke = shape.stroke ?? "#1e1e1e";
      const strokeWidth = shape.strokeWidth ?? 2;
      const opacity = Math.max(0, Math.min(1, (shape.opacity ?? 100) / 100));
      const dashArray =
        shape.strokeStyle === "dashed"
          ? `${strokeWidth * 4} ${strokeWidth * 3}`
          : shape.strokeStyle === "dotted"
            ? `${strokeWidth} ${strokeWidth * 2}`
            : "none";

      let fill = shape.fill ?? "none";
      if (shape.fillStyle && shape.fillStyle !== "solid") {
        fill = "none";
      }

      if (shape.type === "rect") {
        return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-dasharray="${dashArray}" opacity="${opacity}" />`;
      }

      if (shape.type === "circle") {
        return `<ellipse cx="${shape.centerX}" cy="${shape.centerY}" rx="${shape.radiusX}" ry="${shape.radiusY}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-dasharray="${dashArray}" opacity="${opacity}" />`;
      }

      if (shape.type === "rhombus") {
        const points = [
          `${shape.x + shape.width / 2},${shape.y}`,
          `${shape.x + shape.width},${shape.y + shape.height / 2}`,
          `${shape.x + shape.width / 2},${shape.y + shape.height}`,
          `${shape.x},${shape.y + shape.height / 2}`,
        ].join(" ");
        return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-dasharray="${dashArray}" opacity="${opacity}" />`;
      }

      if (shape.type === "line") {
        const points = getConnectorRoutePoints(shape)
          .map((point) => `${point.x},${point.y}`)
          .join(" ");
        return `<polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-dasharray="${dashArray}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}" />`;
      }

      if (shape.type === "arrow") {
        const points = getConnectorRoutePoints(shape)
          .map((point) => `${point.x},${point.y}`)
          .join(" ");
        const arrowHead = getArrowHeadPoints(shape);
        const headLines = arrowHead
          ? `<line x1="${arrowHead.tip.x}" y1="${arrowHead.tip.y}" x2="${arrowHead.left.x}" y2="${arrowHead.left.y}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-dasharray="${dashArray}" stroke-linecap="round" opacity="${opacity}" />
  <line x1="${arrowHead.tip.x}" y1="${arrowHead.tip.y}" x2="${arrowHead.right.x}" y2="${arrowHead.right.y}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-dasharray="${dashArray}" stroke-linecap="round" opacity="${opacity}" />`
          : "";
        return `<polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-dasharray="${dashArray}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}" />
  ${headLines}`;
      }

      if (shape.type === "text") {
        const safeText = escapeXml(shape.text || "");
        return `<text x="${shape.x}" y="${shape.y + shape.fontSize}" fill="${stroke}" font-size="${shape.fontSize}" font-family="Arial, sans-serif" opacity="${opacity}">${safeText}</text>`;
      }

      if (shape.type === "freehand") {
        if (shape.points.length === 0) return "";
        const points = shape.points
          .map((point) => `${point.x},${point.y}`)
          .join(" ");
        return `<polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-dasharray="${dashArray}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}" />`;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n  ");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${Math.ceil(width)}" height="${Math.ceil(height)}">\n  ${shapeElements}\n</svg>`;
}

function FillStyleTile({
  value,
  selected,
  onClick,
  isDark,
}: {
  value: NonNullable<Shape["fillStyle"]>;
  selected: boolean;
  onClick: () => void;
  isDark: boolean;
}) {
  const base = "relative h-9 w-9 rounded-md border transition";
  const ring = selected
    ? "border-indigo-500 ring-2 ring-indigo-300 dark:border-indigo-300 dark:ring-indigo-700"
    : isDark
      ? "border-white/15 hover:border-white/30"
      : "border-slate-300 hover:border-slate-500";
  const bg = isDark ? "bg-[#1e1e1e]" : "bg-white";

  if (value === "solid") {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${base} ${ring} ${isDark ? "bg-slate-200" : "bg-slate-700"}`}
        title="Solid"
      />
    );
  }

  if (value === "hachure") {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${base} ${ring} ${bg}`}
        style={{
          backgroundImage:
            "repeating-linear-gradient(45deg, rgba(15,23,42,0.55) 0 2px, transparent 2px 7px)",
        }}
        title="Hachure"
      />
    );
  }

  if (value === "cross-hatch") {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${base} ${ring} ${bg}`}
        style={{
          backgroundImage:
            "repeating-linear-gradient(45deg, rgba(15,23,42,0.55) 0 2px, transparent 2px 7px), repeating-linear-gradient(-45deg, rgba(15,23,42,0.45) 0 2px, transparent 2px 7px)",
        }}
        title="Cross Hatch"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`${base} ${ring} ${bg}`}
      style={{
        backgroundImage:
          "radial-gradient(circle at 2px 2px, rgba(15,23,42,0.55) 1.4px, transparent 1.5px)",
        backgroundSize: "8px 8px",
      }}
      title="Dots"
    />
  );
}

function StrokeStyleTile({
  value,
  selected,
  onClick,
  isDark,
}: {
  value: NonNullable<Shape["strokeStyle"]>;
  selected: boolean;
  onClick: () => void;
  isDark: boolean;
}) {
  const border = selected
    ? "border-indigo-500 ring-2 ring-indigo-300 dark:border-indigo-300 dark:ring-indigo-700"
    : isDark
      ? "border-white/15 hover:border-white/30"
      : "border-slate-300 hover:border-slate-500";

  const dashArray =
    value === "dashed" ? "10 6" : value === "dotted" ? "2 6" : undefined;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-9 w-14 rounded-md border transition ${border} ${isDark ? "bg-[#1e1e1e]" : "bg-white"}`}
      title={value}
    >
      <svg viewBox="0 0 48 24" className="h-full w-full" fill="none">
        <line
          x1="8"
          y1="12"
          x2="40"
          y2="12"
          className={isDark ? "stroke-slate-200" : "stroke-slate-700"}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={dashArray}
        />
      </svg>
    </button>
  );
}

function PersonaButtonGlyph({ personaId }: { personaId: string }) {
  if (personaId === "architect") {
    return (
      <svg
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="4" y="5" width="16" height="14" rx="1.5" />
        <path d="M4 10h16" />
        <path d="M10 5v14" />
      </svg>
    );
  }

  if (personaId === "artist") {
    return (
      <svg
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 15C6.5 12.5 8.5 16.8 11.5 14.3C13.7 12.5 15.5 9.5 20 10.8" />
        <path d="M5 9c1.5-.8 3.2-.6 4.5.4" className="opacity-60" />
        <circle
          cx="17.8"
          cy="7.2"
          r="1.4"
          fill="currentColor"
          stroke="none"
          className="opacity-85"
        />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 16C5.8 19.3 7.2 10.7 9.6 14.5C11.2 17 12.4 8.3 15 11.4C16.3 13 17.5 9.5 20 10.8" />
      <path
        d="M4.5 8.8C6.5 6.6 7.2 10.5 9.4 8.9C10.9 7.8 12.1 5.3 14.2 6.8C16.2 8.2 17.8 5.8 19.8 7.1"
        className="opacity-75"
      />
      <path d="M6.2 5.4l1.4 1.4M18.3 4.8l-.9 1.6" className="opacity-70" />
    </svg>
  );
}

export default function CanvasPage() {
  const params = useParams<{ roomId: string }>();
  const searchParams = useSearchParams();
  const roomId = Array.isArray(params?.roomId)
    ? params.roomId[0]
    : params?.roomId;
  const ownerHandleFromQuery = searchParams.get("owner")?.trim() ?? "";

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controlsRef = useRef<ReturnType<typeof attachEvents> | null>(null);
  const isHydratingRef = useRef(true);
  const resolvedRoomIdRef = useRef<number | null>(null);

  const toolRef = useRef<Tool>("select");
  const [activeTool, setActiveTool] = useState<Tool>("select");
  const [selectedCount, setSelectedCount] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectedIdsRef = useRef<string[]>([]);
  const [inspectorRevision, setInspectorRevision] = useState(0);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<
    "connected" | "disconnected" | "error"
  >("disconnected");
  const syncStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inspectorRevisionRafRef = useRef<number | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const stateRef = useRef<CanvasState | null>(null);
  const [canvasState, setCanvasState] = useState<CanvasState | null>(null);
  const [resolvedRoomId, setResolvedRoomId] = useState<number | null>(null);
  const [isAiOpen, setIsAiOpen] = useState(false);
  const canonicalRedirectIssuedRef = useRef(false);
  const canonicalUrlNormalizedRef = useRef(false);
  const [defaultRoughness, setDefaultRoughness] = useState<number>(
    DRAWING_PERSONAS[1]?.roughness ?? 1,
  );
  const defaultRoughnessRef = useRef<number>(
    DRAWING_PERSONAS[1]?.roughness ?? 1,
  );
  const [viewport, setViewport] = useState<StoredViewport | null>(null);
  const viewportLiveRef = useRef<StoredViewport | null>(null);
  const viewportUiSyncTimerRef = useRef<number | null>(null);
  const pendingViewportForUiRef = useRef<StoredViewport | null>(null);
  const viewportPersistTimerRef = useRef<number | null>(null);
  const pendingViewportForPersistRef = useRef<StoredViewport | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [summaryText, setSummaryText] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [mermaidMode, setMermaidMode] = useState<"import" | "export" | null>(null);
  const [isJoinCanvasModalOpen, setIsJoinCanvasModalOpen] = useState(false);
  const [joinCanvasInput, setJoinCanvasInput] = useState("");
  const [isJoiningCanvas, setIsJoiningCanvas] = useState(false);
  const [recentCanvases, setRecentCanvases] = useState<CanvasSwitcherEntry[]>(
    [],
  );
  const [isReloadingCanvas, setIsReloadingCanvas] = useState(false);
  const [isSavingCanvas, setIsSavingCanvas] = useState(false);
  const [showRoomInfo, setShowRoomInfo] = useState(false);
  const [isGridVisible, setIsGridVisible] = useState(true);
  const [isAccessDenied, setIsAccessDenied] = useState(false);
  const [showDebugOverlay, setShowDebugOverlay] = useState(false);
  const [debugPanelMode, setDebugPanelMode] =
    useState<DebugPanelMode>("compact");
  const [debugOverlaySnapshot, setDebugOverlaySnapshot] =
    useState<DebugOverlaySnapshot | null>(null);
  const [selectedExportFormat, setSelectedExportFormat] =
    useState<ExportFormat>("png");
  const [isSnapEnabled, setIsSnapEnabled] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [isInspectorMinimized, setIsInspectorMinimized] = useState(false);
  const [incomingRoomAccessRequests, setIncomingRoomAccessRequests] = useState<
    IncomingAccessRequest[]
  >([]);
  const [isLoadingIncomingRequests, setIsLoadingIncomingRequests] =
    useState(false);
  const [requestDecisionInFlightId, setRequestDecisionInFlightId] = useState<
    number | null
  >(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [isClearCanvasModalOpen, setIsClearCanvasModalOpen] = useState(false);
  const [floatingShapeComments, setFloatingShapeComments] = useState<
    FloatingShapeComment[]
  >([]);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuPanelRef = useRef<HTMLDivElement | null>(null);
  const menuFocusIndexRef = useRef(0);
  const toastIdRef = useRef(0);
  const skipNextViewportPersistRef = useRef(false);
  const seenRealtimeCommentIdsRef = useRef<Set<number>>(new Set());
  const recentFloatingCommentKeysRef = useRef<Map<string, number>>(new Map());
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  useEffect(() => {
    toolRef.current = activeTool;
  }, [activeTool]);

  useEffect(() => {
    setRecentCanvases(readRecentCanvasesFromStorage());
  }, []);

  const rememberCanvasTarget = useCallback((target: string, label?: string) => {
    const resolvedLabel = (label?.trim() || deriveCanvasLabel(target)).slice(
      0,
      90,
    );
    const visitedAt = Date.now();

    setRecentCanvases((current) => {
      const deduped = current.filter((entry) => entry.target !== target);
      const next = [
        { target, label: resolvedLabel, visitedAt },
        ...deduped,
      ].slice(0, MAX_RECENT_CANVASES);
      writeRecentCanvasesToStorage(next);
      return next;
    });
  }, []);

  const getMenuItems = useCallback(() => {
    if (!menuPanelRef.current) return [];
    return Array.from(
      menuPanelRef.current.querySelectorAll<HTMLButtonElement>(
        "[role='menuitem']:not([disabled])",
      ),
    );
  }, []);

  const syncMenuRovingFocus = useCallback(
    (nextIndex: number, focus = false) => {
      const menuItems = getMenuItems();
      if (menuItems.length === 0) return;

      const safeIndex =
        ((nextIndex % menuItems.length) + menuItems.length) % menuItems.length;
      menuFocusIndexRef.current = safeIndex;

      menuItems.forEach((item, index) => {
        item.tabIndex = index === safeIndex ? 0 : -1;
      });

      if (focus) {
        menuItems[safeIndex]?.focus();
      }
    },
    [getMenuItems],
  );

  const pushToast = useCallback((tone: Toast["tone"], message: string) => {
    const id = toastIdRef.current + 1;
    toastIdRef.current = id;
    setToasts((current) => [...current, { id, tone, message }]);

    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 3200);
  }, []);

  const loadIncomingRoomAccessRequests = useCallback(async () => {
    if (resolvedRoomId === null) {
      setIncomingRoomAccessRequests([]);
      return;
    }

    setIsLoadingIncomingRequests(true);
    try {
      const response = await apiClient.get(
        `${HTTP_BACKEND}/room/access/requests/incoming`,
      );
      const requestList = response.data?.data;
      const requests = Array.isArray(requestList)
        ? (requestList as IncomingAccessRequest[])
        : [];
      setIncomingRoomAccessRequests(
        requests.filter(
          (request) => Number(request.room?.id) === resolvedRoomId,
        ),
      );
    } catch (errorResponse) {
      const axiosError = errorResponse as AxiosError<{ message?: string }>;
      if (axiosError.response?.status !== 403) {
        setIncomingRoomAccessRequests([]);
      }
    } finally {
      setIsLoadingIncomingRequests(false);
    }
  }, [resolvedRoomId]);

  useEffect(() => {
    controlsRef.current?.rerender();
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const raw = window.localStorage.getItem(DEFAULT_ROUGHNESS_STORAGE_KEY);
    if (raw === null) return;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;

    const next = Math.max(0, Math.min(5, parsed));
    setDefaultRoughness(next);
    defaultRoughnessRef.current = next;
  }, []);

  useEffect(() => {
    defaultRoughnessRef.current = defaultRoughness;

    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        DEFAULT_ROUGHNESS_STORAGE_KEY,
        String(defaultRoughness),
      );
    }
  }, [defaultRoughness]);

  useEffect(() => {
    const preventBrowserZoom = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
      }
    };

    const preventGestureZoom = (event: Event) => {
      event.preventDefault();
    };

    window.addEventListener("wheel", preventBrowserZoom, {
      passive: false,
      capture: true,
    });
    window.addEventListener(
      "gesturestart",
      preventGestureZoom as EventListener,
      { passive: false, capture: true },
    );
    window.addEventListener(
      "gesturechange",
      preventGestureZoom as EventListener,
      { passive: false, capture: true },
    );

    return () => {
      window.removeEventListener("wheel", preventBrowserZoom, true);
      window.removeEventListener(
        "gesturestart",
        preventGestureZoom as EventListener,
        true,
      );
      window.removeEventListener(
        "gesturechange",
        preventGestureZoom as EventListener,
        true,
      );
    };
  }, []);

  useEffect(() => {
    if (!isMenuOpen) return;

    const raf = window.requestAnimationFrame(() => {
      syncMenuRovingFocus(0, true);
    });

    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [isMenuOpen, syncMenuRovingFocus]);

  useEffect(() => {
    if (!isMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        menuPanelRef.current?.contains(target) ||
        menuButtonRef.current?.contains(target)
      ) {
        return;
      }
      setIsMenuOpen(false);
      setShowRoomInfo(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setIsMenuOpen(false);
      setShowRoomInfo(false);
      menuButtonRef.current?.focus();
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMenuOpen]);

  useEffect(() => {
    if (resolvedRoomId === null) return;

    void loadIncomingRoomAccessRequests();
    const pollTimer = window.setInterval(() => {
      void loadIncomingRoomAccessRequests();
    }, 5000);

    return () => {
      window.clearInterval(pollTimer);
    };
  }, [resolvedRoomId, loadIncomingRoomAccessRequests]);

  useEffect(() => {
    if (!isMenuOpen) return;

    const root = document.documentElement;
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyTouchAction = document.body.style.touchAction;
    const previousRootOverflow = root.style.overflow;
    const previousRootOverscrollBehavior = root.style.overscrollBehavior;

    root.style.overflow = "hidden";
    root.style.overscrollBehavior = "none";
    document.body.style.overflow = "hidden";
    document.body.style.touchAction = "none";

    return () => {
      root.style.overflow = previousRootOverflow;
      root.style.overscrollBehavior = previousRootOverscrollBehavior;
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.touchAction = previousBodyTouchAction;
    };
  }, [isMenuOpen]);

  useEffect(() => {
    if (!roomId) return;

    isHydratingRef.current = true;
    setIsAccessDenied(false);
    resolvedRoomIdRef.current = null;
    setResolvedRoomId(null);
    setInviteLink(null);
    let isUnmounted = false;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const pixelRatio = window.devicePixelRatio || 1;

    // set size
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    canvas.width = Math.round(window.innerWidth * pixelRatio);
    canvas.height = Math.round(window.innerHeight * pixelRatio);

    const initialViewport = loadStoredViewport(roomId);
    viewportLiveRef.current = initialViewport ?? {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
      scale: 1,
    };
    setViewport(
      initialViewport ?? {
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
        scale: 1,
      },
    );

    const state = new CanvasState();
    stateRef.current = state;
    setCanvasState(state);

    /**
     * Fetch shapes with cursor-based pagination so large canvases don't block
     * the initial render behind a single giant DB round-trip.
     *
     * The server returns { shapes: Shape[], nextCursor: string | null }.
     * When nextCursor is non-null there are more shapes to load; we keep
     * requesting pages until it's null.  Each page is capped at 500 shapes
     * server-side to bound individual response sizes.
     */
    const getShapesChunked = async (id: number): Promise<Shape[]> => {
      const PAGE_SIZE = 500;
      const accumulated: Shape[] = [];
      let cursor: string | null = null;

      for (;;) {
        const url = new URL(`${HTTP_BACKEND}/room/${id}/shapes`);
        url.searchParams.set("limit", String(PAGE_SIZE));
        if (cursor) url.searchParams.set("cursor", cursor);

        const response = await apiClient.get(url.toString());
        const data = response.data?.data;

        // Backwards-compatible: server might return a plain array (old builds).
        if (Array.isArray(data)) {
          accumulated.push(...(data as Shape[]));
          break;
        }

        const pageShapes = Array.isArray(data?.shapes)
          ? (data.shapes as Shape[])
          : [];
        accumulated.push(...pageShapes);

        const nextCursor: string | null = data?.nextCursor ?? null;
        if (!nextCursor) break;
        cursor = nextCursor;
      }

      // Deduplicate by ID — guards against shapes with equal createdAt
      // timestamps landing on both sides of a cursor page boundary.
      const seen = new Map<string, Shape>();
      for (const s of accumulated)
        seen.set((s as Shape & { id: string }).id, s);
      return Array.from(seen.values());
    };

    const resolveRoomIdAndShapes = async (): Promise<{
      resolvedRoomId: number;
      shapes: Shape[];
    }> => {
      const requestedSlug = roomId.trim();
      const isSlugValid =
        requestedSlug.length >= 3 && requestedSlug.length <= 20;
      const effectiveSlug = isSlugValid
        ? requestedSlug
        : crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      const shouldCanonicalRedirect = ownerHandleFromQuery.length === 0;

      if (!isSlugValid) {
        window.history.replaceState(null, "", `/canvas/${effectiveSlug}`);
      }

      if (ownerHandleFromQuery.length > 0) {
        const resolvedRoom = await apiClient.get(
          `${HTTP_BACKEND}/room/resolve/${encodeURIComponent(ownerHandleFromQuery)}/${encodeURIComponent(effectiveSlug)}`,
        );

        const resolvedRoomId = Number(resolvedRoom.data?.data?.id);
        if (!Number.isFinite(resolvedRoomId)) {
          throw new Error(
            "Invalid room id returned from canonical owner+slug lookup",
          );
        }

        const shapes = await getShapesChunked(resolvedRoomId);
        return {
          resolvedRoomId,
          shapes,
        };
      }

      try {
        const roomBySlug = await apiClient.get(
          `${HTTP_BACKEND}/room/room/slug/${encodeURIComponent(effectiveSlug)}`,
        );
        const ownerHandle = roomBySlug.data?.data?.admin?.handle as
          | string
          | undefined;

        const resolvedRoomId = Number(roomBySlug.data?.data?.id);
        if (!Number.isFinite(resolvedRoomId)) {
          throw new Error("Invalid room id returned from slug lookup");
        }

        if (
          shouldCanonicalRedirect &&
          !canonicalRedirectIssuedRef.current &&
          typeof ownerHandle === "string" &&
          ownerHandle.length > 0
        ) {
          canonicalRedirectIssuedRef.current = true;
          window.location.replace(
            `/room/${encodeURIComponent(ownerHandle)}/${encodeURIComponent(effectiveSlug)}`,
          );
          return {
            resolvedRoomId,
            shapes: [],
          };
        }

        const shapes = await getShapesChunked(resolvedRoomId);

        return {
          resolvedRoomId,
          shapes,
        };
      } catch (error) {
        const axiosError = error as AxiosError<{ message?: string }>;
        if (axiosError.response?.status !== 404) {
          throw error;
        }

        try {
          const createRoomResponse = await apiClient.post(
            `${HTTP_BACKEND}/room`,
            { slug: effectiveSlug },
          );

          const ownerHandle = createRoomResponse.data?.data?.admin?.handle as
            | string
            | undefined;

          const resolvedRoomId = Number(createRoomResponse.data?.data?.id);
          if (!Number.isFinite(resolvedRoomId)) {
            throw new Error("Invalid room id returned while creating room");
          }

          if (
            shouldCanonicalRedirect &&
            !canonicalRedirectIssuedRef.current &&
            typeof ownerHandle === "string" &&
            ownerHandle.length > 0
          ) {
            canonicalRedirectIssuedRef.current = true;
            window.location.replace(
              `/room/${encodeURIComponent(ownerHandle)}/${encodeURIComponent(effectiveSlug)}`,
            );
          }

          return {
            resolvedRoomId,
            shapes: [],
          };
        } catch (createError) {
          const createAxiosError = createError as AxiosError<{
            message?: string;
          }>;
          if (createAxiosError.response?.status !== 409) {
            throw createError;
          }

          const roomBySlug = await apiClient.get(
            `${HTTP_BACKEND}/room/room/slug/${encodeURIComponent(effectiveSlug)}`,
          );
          const ownerHandle = roomBySlug.data?.data?.admin?.handle as
            | string
            | undefined;

          const resolvedRoomId = Number(roomBySlug.data?.data?.id);
          if (!Number.isFinite(resolvedRoomId)) {
            throw new Error("Invalid room id returned from slug lookup");
          }

          if (
            shouldCanonicalRedirect &&
            !canonicalRedirectIssuedRef.current &&
            typeof ownerHandle === "string" &&
            ownerHandle.length > 0
          ) {
            canonicalRedirectIssuedRef.current = true;
            window.location.replace(
              `/room/${encodeURIComponent(ownerHandle)}/${encodeURIComponent(effectiveSlug)}`,
            );
            return {
              resolvedRoomId,
              shapes: [],
            };
          }

          const shapes = await getShapesChunked(resolvedRoomId);

          return {
            resolvedRoomId,
            shapes,
          };
        }
      }
    };

    // Subscribe the page to CanvasState updates for UI refresh only.
    // Canvas persistence is handled by websocket sync to avoid races.
    const unsubscribe = state.subscribe(() => {
      // Ensure remote websocket updates repaint immediately without requiring focus.
      controlsRef.current?.rerender();

      // Only force React re-render if we actually have shapes selected (i.e. inspector is visible)
      // This prevents massive full-page re-renders at 60fps when remote users are drawing!
      if (selectedIdsRef.current.length === 0) {
        return;
      }

      if (inspectorRevisionRafRef.current !== null) {
        return;
      }

      inspectorRevisionRafRef.current = window.requestAnimationFrame(() => {
        inspectorRevisionRafRef.current = null;
        setInspectorRevision((current) => current + 1);
      });
    });

    const loadShapes = async (): Promise<boolean> => {
      try {
        const { resolvedRoomId, shapes } = await resolveRoomIdAndShapes();
        resolvedRoomIdRef.current = resolvedRoomId;
        setResolvedRoomId(resolvedRoomId);

        if (!isUnmounted) {
          state.hydrateShapes(shapes);
        }

        return true;
      } catch (error) {
        const axiosError = error as AxiosError<{ message?: string }>;
        if (axiosError.response?.status === 403) {
          setIsAccessDenied(true);
          return false;
        }

        if (axiosError.response?.status === 404) {
          return false;
        }

        console.error("Failed to load shapes", error);
        return false;
      } finally {
        isHydratingRef.current = false;
      }
    };

    const initializeCanvas = async () => {
      const isAuthenticated = await ensureAuthenticated(`/canvas/${roomId}`);
      if (!isAuthenticated || isUnmounted) {
        isHydratingRef.current = false;
        return;
      }

      const canAccessRoom = await loadShapes();

      if (isUnmounted || !canAccessRoom) {
        return;
      }

      controlsRef.current = attachEvents(canvas, ctx, state, {
        getTool: () => toolRef.current,
        getDefaultShapeStyle: () => ({
          roughness: defaultRoughnessRef.current,
        }),
        initialViewport: initialViewport ?? undefined,
        onToolChange: (tool) => {
          toolRef.current = tool;
          setActiveTool(tool);
        },
        onInteractionStart: () => {
          setIsInspectorMinimized(true);
        },
        onInteractionEnd: () => {
          // Stay minimized on mobile to avoid covering the screen again immediately.
          // The user can expand it manually when they need it.
        },
        onSelectionChange: (selectedIds) => {
          const hasSelectionChanged = !areStringArraysEqual(
            selectedIdsRef.current,
            selectedIds,
          );
          if (!hasSelectionChanged) {
            return;
          }

          setSelectedCount(selectedIds.length);
          setSelectedIds(selectedIds);
          selectedIdsRef.current = selectedIds;
        },
        onViewportChange: (viewport) => {
          viewportLiveRef.current = viewport;
          pendingViewportForUiRef.current = viewport;
          if (viewportUiSyncTimerRef.current === null) {
            viewportUiSyncTimerRef.current = window.setTimeout(() => {
              viewportUiSyncTimerRef.current = null;
              if (pendingViewportForUiRef.current) {
                setViewport(pendingViewportForUiRef.current);
              }
            }, 34);
          }

          if (skipNextViewportPersistRef.current) {
            skipNextViewportPersistRef.current = false;
            return;
          }

          pendingViewportForPersistRef.current = viewport;
          if (viewportPersistTimerRef.current === null) {
            viewportPersistTimerRef.current = window.setTimeout(() => {
              viewportPersistTimerRef.current = null;
              if (pendingViewportForPersistRef.current) {
                saveStoredViewport(
                  roomId,
                  pendingViewportForPersistRef.current,
                );
              }
            }, 140);
          }
        },
      });

      setIsGridVisible(controlsRef.current.isGridVisible());
      setIsSnapEnabled(controlsRef.current.isSnapEnabled());
    };

    void initializeCanvas();

    return () => {
      isUnmounted = true;

      controlsRef.current?.destroy();
      controlsRef.current = null;

      if (viewportUiSyncTimerRef.current !== null) {
        window.clearTimeout(viewportUiSyncTimerRef.current);
        viewportUiSyncTimerRef.current = null;
      }

      if (viewportPersistTimerRef.current !== null) {
        window.clearTimeout(viewportPersistTimerRef.current);
        viewportPersistTimerRef.current = null;
      }

      // Stop listening to state updates when this page unmounts.
      // Without this, a stale callback could keep firing saves.
      unsubscribe();

      if (inspectorRevisionRafRef.current !== null) {
        window.cancelAnimationFrame(inspectorRevisionRafRef.current);
        inspectorRevisionRafRef.current = null;
      }
    };
  }, [roomId, ownerHandleFromQuery]);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 640);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  useEffect(() => {
    if (!roomId || ownerHandleFromQuery.length === 0) {
      return;
    }

    if (canonicalUrlNormalizedRef.current) {
      return;
    }

    const canonicalPath = `/room/${encodeURIComponent(ownerHandleFromQuery)}/${encodeURIComponent(roomId)}`;
    const currentPath = window.location.pathname;
    const hasQuery = window.location.search.length > 0;

    if (currentPath !== canonicalPath || hasQuery) {
      window.history.replaceState(window.history.state, "", canonicalPath);
    }

    canonicalUrlNormalizedRef.current = true;
  }, [roomId, ownerHandleFromQuery]);

  // Initialize WebSocket sync when state and room are ready
  const syncResult = useCanvasSync({
    roomId: resolvedRoomId ?? 0,
    state: canvasState,
    enabled: canvasState !== null && resolvedRoomId !== null,
    localSelectionIds: selectedIds,
    localTool: activeTool,
  });

  const chat = useCanvasChat({
    roomId: resolvedRoomId,
    enabled: resolvedRoomId !== null,
    currentUserId: syncResult.currentUserId,
    presenceState: syncResult.presenceState,
    realtimeChatMessages: syncResult.realtimeChatMessages,
    sendWsMessage: syncResult.sendWsMessage,
    lastSyncError: syncResult.lastSyncError,
  });

  const handleAiShapesGenerated = useCallback((shapes: unknown[], meta?: AiResultMeta) => {
    if (!canvasState) return;
    const themed = sanitizeAiGeneratedShapes(shapes);
    if (themed.length === 0) {
      pushToast(
        "error",
        "AI generated invalid geometry. Please try a more specific prompt.",
      );
      return;
    }

    // Edit mode: swap the edited selection for the AI's rewrite in one
    // undoable step. Everything not selected is left exactly as it was.
    if (meta?.replaceIds) {
      const replaced = new Set(meta.replaceIds);
      canvasState.setShapes([
        ...canvasState.getShapes().filter((shape) => !replaced.has(shape.id)),
        ...themed,
      ]);
      controlsRef.current?.rerender();
      pushToast("success", `✦ AI updated ${themed.length} shapes (Ctrl/Cmd+Z to undo)`);
      return;
    }
    let toAdd = themed;
    if (meta?.placeBeside) {
      // Image imports are drawn in the model's own coordinate frame: move them
      // to the right of whatever is already on the board.
      const existingBounds = getBoundsForShapes(canvasState.getShapes());
      const importedBounds = getBoundsForShapes(themed);
      if (importedBounds) {
        const dx = existingBounds
          ? existingBounds.maxX + 120 - importedBounds.minX
          : 0;
        const dy = existingBounds ? existingBounds.minY - importedBounds.minY : 0;
        toAdd = translateShapes(themed, dx, dy);
      }
    }
    toAdd.forEach((shape) => {
      dispatch(canvasState, {
        type: "ADD_SHAPE",
        payload: shape,
      });
    });
    controlsRef.current?.rerender();
    const generatedBounds = getBoundsForShapes(toAdd);
    if (generatedBounds) {
      controlsRef.current?.focusViewportToBounds(generatedBounds, {
        padding: 140,
        preserveScale: true,
        smooth: true,
        durationMs: 340,
      });
    }
    const droppedCount = shapes.length - themed.length;
    pushToast(
      "success",
      droppedCount > 0
        ? `✦ AI added ${themed.length} shapes (${droppedCount} invalid skipped)`
        : `✦ AI added ${themed.length} shapes to your canvas`,
    );
  }, [canvasState, pushToast]);

  const handleAiError = useCallback((message: string) => {
    pushToast("error", message);
  }, [pushToast]);

  const ai = useAiGeneration({
    roomId: resolvedRoomId,
    httpBackend: HTTP_BACKEND,
    apiClient,
    onShapesGenerated: handleAiShapesGenerated,
    onError: handleAiError,
    onSummary: setSummaryText,
  });

  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const getViewCenter = () => {
    const viewport = viewportLiveRef.current;
    const canvas = canvasRef.current;
    return viewport && canvas
      ? {
          x: (canvas.clientWidth / 2 - viewport.x) / viewport.scale,
          y: (canvas.clientHeight / 2 - viewport.y) / viewport.scale,
        }
      : { x: 0, y: 0 };
  };

  const applyArrangement = (
    compute: (shapes: Shape[], ids: ReadonlySet<string>) => Shape[] | null,
  ) => {
    if (!canvasState) return;
    const next = compute(canvasState.getShapes(), new Set(selectedIds));
    if (!next) return; // nothing to move (already arranged)
    canvasState.setShapes(next);
    controlsRef.current?.rerender();
  };
  const handleAlign = (mode: AlignMode) =>
    applyArrangement((shapes, ids) => alignShapes(shapes, ids, mode));
  const handleDistribute = (axis: DistributeAxis) =>
    applyArrangement((shapes, ids) => distributeShapes(shapes, ids, axis));

  const handleInsertTemplate = (id: TemplateId) => {
    if (!canvasState) return;
    let shapes = buildTemplate(id, getViewCenter());
    // Don't land on top of existing content: slide right of it if they overlap.
    const existingBounds = getBoundsForShapes(canvasState.getShapes());
    const templateBounds = getBoundsForShapes(shapes);
    if (existingBounds && templateBounds) {
      const overlaps =
        templateBounds.minX < existingBounds.maxX &&
        templateBounds.maxX > existingBounds.minX &&
        templateBounds.minY < existingBounds.maxY &&
        templateBounds.maxY > existingBounds.minY;
      if (overlaps) {
        shapes = translateShapes(
          shapes,
          existingBounds.maxX + 120 - templateBounds.minX,
          existingBounds.minY - templateBounds.minY,
        );
      }
    }
    canvasState.setShapes([...canvasState.getShapes(), ...shapes]);
    controlsRef.current?.rerender();
    const bounds = getBoundsForShapes(shapes);
    if (bounds) {
      controlsRef.current?.focusViewportToBounds(bounds, {
        padding: 140,
        preserveScale: true,
        smooth: true,
        durationMs: 340,
      });
    }
    setShowTemplates(false);
    pushToast("success", "Template added (Ctrl/Cmd+Z to undo).");
  };

  const handleImageChosen = async (file: File | undefined) => {
    if (!file || !canvasState || ai.isGenerating) return;
    if (!file.type.startsWith("image/") || file.size > 15 * 1024 * 1024) {
      pushToast("error", "Choose an image file under 15 MB.");
      return;
    }
    try {
      const image = await prepareImageForAi(file);
      pushToast("info", "✦ Reading the image…");
      void ai.generate(
        "Recreate this image as shapes",
        `Recreate image: ${file.name}`,
        { mode: "image", image },
      );
    } catch (error) {
      pushToast(
        "error",
        error instanceof Error ? error.message : "Could not read that image.",
      );
    }
  };

  const handleSummarizeBoard = () => {
    if (!canvasState || ai.isGenerating) return;
    // Text carries the meaning; cap the payload the API accepts.
    const shapes = canvasState.getShapes();
    const texts = shapes.filter((shape) => shape.type === "text").slice(0, 100);
    const others = shapes.filter((shape) => shape.type !== "text").slice(0, 20);
    if (texts.length === 0) {
      pushToast("error", "Add some text labels to the board first — nothing to summarize.");
      return;
    }
    void ai.generate("Summarize this board", "Summarize this board", {
      mode: "summarize",
      selection: [...texts, ...others] as unknown as Array<
        Record<string, unknown> & { id: string }
      >,
    });
    pushToast("info", "✦ Summarizing the board…");
  };

  const handleInsertSummary = (markdown: string) => {
    if (!canvasState) return;
    // Park the note to the right of everything already on the board.
    const existing = canvasState.getShapes();
    const bounds = getBoundsForShapes(existing);
    const origin = bounds
      ? { x: bounds.maxX + 80, y: bounds.minY }
      : { x: 0, y: 0 };

    const plain = markdown
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/^## /gm, "")
      .replace(/^- \[ \] /gm, "☐ ")
      .replace(/^- \[x\] /gim, "☑ ")
      .replace(/^[-*] /gm, "• ");
    const width = 380;
    const lineCount = plain
      .split("\n")
      .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 42)), 0);
    const height = Math.min(1400, Math.max(40, lineCount * 20 + 8));

    canvasState.setShapes([
      ...canvasState.getShapes(),
      {
        id: crypto.randomUUID(),
        type: "text",
        x: origin.x,
        y: origin.y,
        width,
        height,
        text: plain,
        fontSize: 16,
        roughness: 1,
        strokeStyle: "solid",
      } as Shape,
    ]);
    controlsRef.current?.rerender();
    setSummaryText(null);
    pushToast("success", "Summary added to the canvas.");
  };

  useEffect(() => {
    if (syncStatusTimerRef.current) {
      clearTimeout(syncStatusTimerRef.current);
      syncStatusTimerRef.current = null;
    }

    const nextStatus: "connected" | "disconnected" | "error" =
      syncResult.lastSyncError
        ? "error"
        : syncResult.isConnected
          ? "connected"
          : "disconnected";

    // Keep red/yellow transitions slower than green transitions so transient
    // WS jitter does not cause visible status flapping.
    const delayMs =
      nextStatus === "connected"
        ? 120
        : syncStatus === "connected"
          ? 1200
          : 320;

    syncStatusTimerRef.current = setTimeout(() => {
      setSyncStatus(nextStatus);
      syncStatusTimerRef.current = null;
    }, delayMs);

    return () => {
      if (syncStatusTimerRef.current) {
        clearTimeout(syncStatusTimerRef.current);
        syncStatusTimerRef.current = null;
      }
    };
  }, [syncResult.isConnected, syncResult.lastSyncError, syncStatus]);

  useEffect(() => {
    if (!showDebugOverlay) return;

    const captureSnapshot = () => {
      const shapes = canvasState?.getShapes() ?? [];
      setDebugOverlaySnapshot({
        version: syncResult.syncVersion,
        shapeCount: shapes.length,
        shapeIds: shapes.slice(0, 25).map((shape) => shape.id),
        capturedAt: new Date().toLocaleTimeString(),
      });
    };

    captureSnapshot();
    const timer = window.setInterval(captureSnapshot, 220);

    return () => {
      window.clearInterval(timer);
    };
  }, [showDebugOverlay, canvasState, syncResult.syncVersion]);

  // Fetch and display invite link
  useEffect(() => {
    if (!roomId) return;

    if (ownerHandleFromQuery.length > 0) {
      setInviteLink(
        `${window.location.origin}/room/${ownerHandleFromQuery}/${roomId}`,
      );
      return;
    }

    setInviteLink(`${window.location.origin}/canvas/${roomId}`);
  }, [roomId, ownerHandleFromQuery]);

  useEffect(() => {
    if (!roomId) return;

    const target = ownerHandleFromQuery
      ? `room/${ownerHandleFromQuery}/${roomId}`
      : `canvas/${roomId}`;
    rememberCanvasTarget(target);
  }, [ownerHandleFromQuery, rememberCanvasTarget, roomId]);

  const handleDeleteSelected = () => {
    controlsRef.current?.deleteSelection();
  };

  const handleLogout = async () => {
    if (isLoggingOut) return;

    setIsLoggingOut(true);
    try {
      await logoutUser();
    } finally {
      window.location.href = "/";
    }
  };

  const handleOpenProfile = () => {
    window.location.href = "/profile";
  };

  const selectedShapes = (() => {
    if (!canvasState || selectedIds.length === 0) return [];

    // Depend on inspectorRevision via render so remote/local mutations refresh inspector values.
    void inspectorRevision;
    const selectedSet = new Set(selectedIds);
    return canvasState.getShapes().filter((shape) => selectedSet.has(shape.id));
  })();

  const primarySelectedShape =
    selectedShapes[selectedShapes.length - 1] ?? null;
  const isTextShapeSelection = primarySelectedShape?.type === "text";

  const spawnFloatingComment = useCallback(
    (shapeId: string, body: string, authorLabel: string, dedupeKey: string) => {
      if (!canvasState) return;

      const now = Date.now();
      const lastShownAt =
        recentFloatingCommentKeysRef.current.get(dedupeKey) ?? 0;
      if (now - lastShownAt < 2200) {
        return;
      }
      recentFloatingCommentKeysRef.current.set(dedupeKey, now);

      const targetShape = canvasState
        .getShapes()
        .find((shape) => shape.id === shapeId);
      if (!targetShape) {
        return;
      }

      const bounds = convertToPoints(targetShape);
      const nextComment: FloatingShapeComment = {
        id: `${now}-${Math.random().toString(16).slice(2, 8)}`,
        shapeId,
        body,
        authorLabel,
        x: (bounds.x1 + bounds.x2) / 2,
        y: bounds.y1 - 26,
      };

      setFloatingShapeComments((current) => [
        ...current.slice(-5),
        nextComment,
      ]);
      window.setTimeout(() => {
        setFloatingShapeComments((current) =>
          current.filter((comment) => comment.id !== nextComment.id),
        );
      }, 4200);
    },
    [canvasState],
  );

  useEffect(() => {
    for (const message of syncResult.realtimeChatMessages) {
      if (message.kind !== "comment" || !message.shapeId) {
        continue;
      }

      if (seenRealtimeCommentIdsRef.current.has(message.id)) {
        continue;
      }

      seenRealtimeCommentIdsRef.current.add(message.id);
      spawnFloatingComment(
        message.shapeId,
        message.body,
        message.sender.id === syncResult.currentUserId
          ? "You"
          : message.sender.name,
        `realtime:${message.id}`,
      );
    }
  }, [
    spawnFloatingComment,
    syncResult.currentUserId,
    syncResult.realtimeChatMessages,
  ]);

  const applyToSelectedShapes = (updates: Partial<Shape>) => {
    if (!canvasState || selectedIds.length === 0) return;

    const selectedSet = new Set(selectedIds);
    const nextShapes = canvasState.getShapes().map((shape) => {
      if (!selectedSet.has(shape.id)) return shape;
      return {
        ...shape,
        ...updates,
      } as Shape;
    });

    canvasState.setShapes(nextShapes);
    controlsRef.current?.rerender();
  };

  const strokeValue = primarySelectedShape?.stroke ?? "#f8fafc";
  const fillValue = primarySelectedShape?.fill ?? "#60a5fa";
  const strokeStyleValue = primarySelectedShape?.strokeStyle ?? "solid";
  const fillStyleValue = primarySelectedShape?.fillStyle ?? "solid";
  const roughnessValue = primarySelectedShape?.roughness ?? defaultRoughness;
  const opacityValue = primarySelectedShape?.opacity ?? 100;
  const showReplay = primarySelectedShape?.type === "freehand";
  const activePersona =
    DRAWING_PERSONAS.find(
      (persona) => Math.abs(persona.roughness - roughnessValue) < 0.25,
    ) ?? null;
  const shapeType = primarySelectedShape?.type ?? null;
  const showsFillControls =
    shapeType === "rect" ||
    shapeType === "circle" ||
    shapeType === "rhombus" ||
    shapeType === "text";

  const handleReplaySelected = () => {
    if (!primarySelectedShape) return;
    controlsRef.current?.replayShape(primarySelectedShape.id);
  };

  const handleCopyInvite = () => {
    if (!inviteLink) {
      pushToast("error", "Invite link is unavailable right now.");
      return;
    }

    navigator.clipboard
      .writeText(inviteLink)
      .then(() => {
        pushToast("success", "Invite link copied to clipboard.");
      })
      .catch(() => {
        pushToast("error", "Failed to copy invite link.");
      });
  };

  const handleClearCanvas = () => {
    if (!canvasState) return;
    setIsClearCanvasModalOpen(true);
  };

  const confirmClearCanvas = () => {
    if (!canvasState) return;

    canvasState.setShapes([]);
    controlsRef.current?.rerender();
    pushToast("info", "Canvas cleared.");
  };

  const handleResetView = () => {
    skipNextViewportPersistRef.current = true;
    controlsRef.current?.resetViewport();
  };

  const handleZoomByStep = (direction: "in" | "out") => {
    const controls = controlsRef.current;
    const canvas = canvasRef.current;
    if (!controls || !canvas) return;

    const currentViewport = controls.getViewport();
    const zoomFactor = direction === "in" ? 1.12 : 1 / 1.12;
    const nextScale = Math.max(
      0.2,
      Math.min(4, currentViewport.scale * zoomFactor),
    );
    if (Math.abs(nextScale - currentViewport.scale) < 0.001) {
      return;
    }

    const centerX = canvas.clientWidth / 2;
    const centerY = canvas.clientHeight / 2;
    const worldCenterX = (centerX - currentViewport.x) / currentViewport.scale;
    const worldCenterY = (centerY - currentViewport.y) / currentViewport.scale;

    skipNextViewportPersistRef.current = true;
    controls.setViewport({
      scale: nextScale,
      x: centerX - worldCenterX * nextScale,
      y: centerY - worldCenterY * nextScale,
    });
  };

  const handleMermaidImport = (source: string): string | null => {
    if (!canvasState) return "Canvas is not ready yet.";
    const viewport = viewportLiveRef.current;
    const canvas = canvasRef.current;
    const center =
      viewport && canvas
        ? {
            x: (canvas.clientWidth / 2 - viewport.x) / viewport.scale,
            y: (canvas.clientHeight / 2 - viewport.y) / viewport.scale,
          }
        : { x: 0, y: 0 };

    try {
      const imported = mermaidToShapes(source, { center });
      canvasState.setShapes([...canvasState.getShapes(), ...imported]);
      controlsRef.current?.rerender();
      const bounds = getBoundsForShapes(imported);
      if (bounds) {
        controlsRef.current?.focusViewportToBounds(bounds, {
          padding: 140,
          preserveScale: true,
          smooth: true,
          durationMs: 340,
        });
      }
      setMermaidMode(null);
      pushToast("success", "Mermaid diagram inserted (Ctrl/Cmd+Z to undo).");
      return null;
    } catch (error) {
      return error instanceof MermaidParseError
        ? error.message
        : "Could not read that diagram.";
    }
  };

  /** Shapes that belong to the current selection (nodes, their labels, connectors between them). */
  const getSelectionScope = (): Shape[] | null => {
    if (!canvasState || selectedIds.length === 0) return null;
    const selected = new Set(selectedIds);
    return canvasState.getShapes().filter((shape) => {
      if (selected.has(shape.id)) return true;
      if (shape.type === "text" && shape.parentId) return selected.has(shape.parentId);
      if (shape.type === "arrow" || shape.type === "line") {
        return (
          !!shape.startBinding &&
          !!shape.endBinding &&
          selected.has(shape.startBinding.shapeId) &&
          selected.has(shape.endBinding.shapeId)
        );
      }
      return false;
    });
  };

  const handleTidyLayout = (direction: "TD" | "LR") => {
    if (!canvasState) return;
    const scope = getSelectionScope() ?? canvasState.getShapes();
    const tidied = tidyLayout(scope, direction);
    if (!tidied) {
      pushToast(
        "error",
        "Nothing to tidy — select connected shapes (connectors must be attached).",
      );
      return;
    }
    const updated = new Map(tidied.map((shape) => [shape.id, shape]));
    canvasState.setShapes(
      canvasState.getShapes().map((shape) => updated.get(shape.id) ?? shape),
    );
    controlsRef.current?.rerender();
    pushToast("success", "Layout tidied (Ctrl/Cmd+Z to undo).");
  };

  const handleReloadCanvas = async () => {
    if (!canvasState || resolvedRoomId === null || isReloadingCanvas) return;

    setIsReloadingCanvas(true);
    try {
      const response = await apiClient.get(
        `${HTTP_BACKEND}/room/${resolvedRoomId}/shapes`,
      );
      const persistedShapes = response.data?.data;
      const candidateShapes = Array.isArray(persistedShapes)
        ? persistedShapes
        : persistedShapes &&
            typeof persistedShapes === "object" &&
            Array.isArray((persistedShapes as { shapes?: unknown }).shapes)
          ? (persistedShapes as { shapes: unknown[] }).shapes
          : null;

      if (!candidateShapes) {
        throw new Error("Invalid shapes payload from server");
      }

      const shapes = candidateShapes as Shape[];
      // Use manualHydrate from useCanvasSync result to prevent the reloaded shapes
      // from being immediately synced back to the server (sync-back loop).
      syncResult.manualHydrate(shapes);
      controlsRef.current?.rerender();
      pushToast("success", "Canvas reloaded from server.");
    } catch (error) {
      console.error("Failed to reload canvas", error);
      pushToast("error", "Reload failed. Current canvas was kept unchanged.");
    } finally {
      setIsReloadingCanvas(false);
    }
  };

  const handleManualSaveCanvas = async () => {
    if (!canvasState || resolvedRoomId === null || isSavingCanvas) return;

    setIsSavingCanvas(true);
    try {
      await apiClient.put(`${HTTP_BACKEND}/room/${resolvedRoomId}/shapes`, {
        shapes: canvasState.getShapes(),
      });
      pushToast("success", "Canvas saved.");
    } catch (error) {
      console.error("Failed to save canvas", error);
      pushToast("error", "Unable to save canvas right now.");
    } finally {
      setIsSavingCanvas(false);
    }
  };

  const handleToggleGridVisibility = () => {
    const next = !isGridVisible;
    controlsRef.current?.setGridVisible(next);
    setIsGridVisible(next);
  };

  const handleToggleSnap = () => {
    const next = !isSnapEnabled;
    controlsRef.current?.setSnapEnabled(next);
    setIsSnapEnabled(next);
  };

  const handleToggleDebugOverlay = () => {
    setShowDebugOverlay((current) => !current);
  };

  const handleToggleDebugPanelMode = () => {
    setDebugPanelMode((current) =>
      current === "compact" ? "verbose" : "compact",
    );
  };

  const handleJoinCanvasFromMenu = () => {
    setIsJoinCanvasModalOpen(true);
    setIsMenuOpen(false);
    setShowRoomInfo(false);
  };

  const handleGoToMyCanvases = () => {
    setIsMenuOpen(false);
    setShowRoomInfo(false);
    window.location.href = "/rooms";
  };

  const resolveCanvasDestination = useCallback((rawTarget: string) => {
    const target = normalizeJoinTarget(rawTarget);
    if (!target) return null;

    const destination =
      target.startsWith("room/") || target.startsWith("canvas/")
        ? `/${target}`
        : `/canvas/${target}`;

    return { target, destination };
  }, []);

  const handleSubmitJoinCanvasTarget = useCallback(
    async (rawTarget: string) => {
      const resolved = resolveCanvasDestination(rawTarget);
      if (!resolved) {
        pushToast("error", "Enter a valid invite link or room path.");
        return;
      }

      rememberCanvasTarget(resolved.target);

      setIsJoiningCanvas(true);
      try {
        await apiClient.get(`${HTTP_BACKEND}/auth/current-user`);
        window.location.href = resolved.destination;
      } catch {
        const redirectTarget = encodeURIComponent(resolved.destination);
        window.location.href = `/signin?redirect=${redirectTarget}`;
      } finally {
        setIsJoiningCanvas(false);
      }
    },
    [rememberCanvasTarget, pushToast, resolveCanvasDestination],
  );

  const handleSubmitJoinCanvas = async () => {
    await handleSubmitJoinCanvasTarget(joinCanvasInput);
  };

  const handleAccessRequestDecision = async (
    requestId: number,
    action: "approve" | "reject",
  ) => {
    if (requestDecisionInFlightId !== null) return;

    setRequestDecisionInFlightId(requestId);
    try {
      await apiClient.post(`${HTTP_BACKEND}/room/access/requests/decision`, {
        requestId,
        action,
      });

      setIncomingRoomAccessRequests((current) =>
        current.filter((request) => request.id !== requestId),
      );
      pushToast(
        "success",
        action === "approve"
          ? "Access request approved."
          : "Access request rejected.",
      );
    } catch (errorResponse) {
      const axiosError = errorResponse as AxiosError<{ message?: string }>;
      pushToast(
        "error",
        axiosError.response?.data?.message ??
          "Unable to update access request.",
      );
    } finally {
      setRequestDecisionInFlightId(null);
    }
  };

  const handleExportJson = () => {
    if (!canvasState) return;

    const payload = {
      roomSlug: roomId ?? "",
      roomId: resolvedRoomId,
      version: syncResult.syncVersion,
      exportedAt: new Date().toISOString(),
      shapes: canvasState.getShapes(),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    downloadBlob(blob, `${roomId ?? "canvas"}.json`);
  };

  const handleExportPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.toBlob((blob) => {
      if (!blob) {
        pushToast("error", "Unable to export PNG.");
        return;
      }

      downloadBlob(blob, `${roomId ?? "canvas"}.png`);
    }, "image/png");
  };

  const handleExportSvg = () => {
    if (!canvasState) return;

    const markup = buildSvgMarkup(canvasState.getShapes());
    const blob = new Blob([markup], { type: "image/svg+xml;charset=utf-8" });
    downloadBlob(blob, `${roomId ?? "canvas"}.svg`);
  };

  const handleExportPdf = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      const width = Math.max(canvas.clientWidth, 1);
      const height = Math.max(canvas.clientHeight, 1);
      const orientation = width >= height ? "landscape" : "portrait";
      const pdf = new jsPDF({
        orientation,
        unit: "px",
        format: [width, height],
      });

      const dataUrl = canvas.toDataURL("image/png", 1);
      pdf.addImage(dataUrl, "PNG", 0, 0, width, height);
      pdf.save(`${roomId ?? "canvas"}.pdf`);
    } catch (error) {
      console.error("Failed to export PDF", error);
      pushToast("error", "Unable to export PDF.");
    }
  };

  const handleExportSelected = () => {
    if (selectedExportFormat === "png") {
      handleExportPng();
      return;
    }

    if (selectedExportFormat === "svg") {
      handleExportSvg();
      return;
    }

    if (selectedExportFormat === "pdf") {
      handleExportPdf();
      return;
    }

    handleExportJson();
  };

  const remotePresenceState = syncResult.presenceState;
  const connectedUsersCount = Number.isFinite(syncResult.connectedUsersCount)
    ? syncResult.connectedUsersCount
    : 0;
  const participantNames = remotePresenceState.presences
    .map((presence) => presence.userName)
    .filter((name, index, all) => all.indexOf(name) === index);
  const canvasTitle = ownerHandleFromQuery
    ? `${ownerHandleFromQuery}/${roomId ?? "canvas"}`
    : (roomId ?? "Untitled canvas");
  const participantPreview = participantNames.slice(0, 4);
  const extraParticipantCount = Math.max(
    0,
    participantNames.length - participantPreview.length,
  );
  const zoomPercent = Math.round((viewport?.scale ?? 1) * 100);
  const shellBackground = isDark
    ? "bg-[#070b14] text-white"
    : "bg-[#f5f9ff] text-slate-900";
  const shellGlow = isDark
    ? "bg-[radial-gradient(circle_at_20%_15%,rgba(59,130,246,0.18),transparent_28%),radial-gradient(circle_at_80%_10%,rgba(139,92,246,0.14),transparent_25%),radial-gradient(circle_at_50%_90%,rgba(16,185,129,0.08),transparent_30%)]"
    : "bg-[radial-gradient(circle_at_20%_15%,rgba(59,130,246,0.22),transparent_40%),radial-gradient(circle_at_80%_12%,rgba(16,185,129,0.18),transparent_35%),radial-gradient(circle_at_50%_50%,rgba(99,102,241,0.12),transparent_60%)]";
  const topToolbarSurface = isDark
    ? "border border-white/10 bg-[#101724]/75 shadow-[0_20px_70px_rgba(2,6,23,0.45)]"
    : "border border-slate-200/80 bg-white/90 shadow-[0_12px_40px_rgba(15,23,42,0.1)]";
  const inspectorSurface = isDark
    ? "border border-white/10 bg-[#0e1622]/75 shadow-[0_24px_70px_rgba(2,6,23,0.5)]"
    : "border border-slate-200/80 bg-white/95 shadow-[0_15px_50px_rgba(15,23,42,0.06)]";
  const floatingPanelSurface = isDark
    ? "border border-white/10 bg-[#111827]/80 shadow-[0_18px_50px_rgba(2,6,23,0.35)]"
    : "border border-slate-200/80 bg-white/90 shadow-[0_8px_30px_rgba(15,23,42,0.04)] shadow-sm";
  useEffect(() => {
    // Lock body scroll for canvas page to prevent unwanted mobile scrolling
    const originalOverflow = document.body.style.overflow;
    const originalOverscroll = document.body.style.overscrollBehavior;

    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";

    return () => {
      document.body.style.overflow = originalOverflow;
      document.body.style.overscrollBehavior = originalOverscroll;
    };
  }, []);

  return (
    <div
      className={`relative h-[100dvh] w-full overflow-hidden overscroll-none ${shellBackground}`}
    >
      <div className={`pointer-events-none absolute inset-0 ${shellGlow}`} />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.22),rgba(255,255,255,0)_28%,rgba(255,255,255,0)_75%,rgba(255,255,255,0.12))] dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0)_24%,rgba(255,255,255,0)_80%,rgba(2,6,23,0.12))]" />
      {isAccessDenied && (
        <div className="pointer-events-none absolute left-1/2 top-24 z-50 w-[min(92vw,560px)] -translate-x-1/2">
          <div
            className={`rounded-xl border px-4 py-3 text-sm shadow-lg ${
              isDark
                ? "border-red-400/40 bg-red-500/15 text-red-100"
                : "border-red-300 bg-red-50 text-red-700"
            }`}
          >
            You do not have permission to access this room.
          </div>
        </div>
      )}

      {/* Workspace Metadata */}
      <div className="pointer-events-none absolute left-2 top-2 z-40 sm:left-4 sm:top-4">
        <div
          className={`pointer-events-auto flex max-w-[calc(100vw-9rem)] items-center gap-2 rounded-2xl border px-3 py-2 backdrop-blur-2xl sm:max-w-none sm:gap-4 sm:px-4 sm:py-3 ${floatingPanelSurface}`}
        >
          <div className="min-w-0 flex flex-col">
            {/* <div className={`mb-1 inline-flex w-fit rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.22em] ${isDark ? "bg-white/5 text-white/55" : "bg-slate-100 text-slate-500"}`}>
                            Canvas
                        </div> */}
            <div className="truncate text-[14px] font-semibold leading-none tracking-tight sm:text-[15px]">
              {canvasTitle}
            </div>
            <div
              className={`mt-1 truncate text-[10px] ${isDark ? "text-white/45" : "text-slate-500"}`}
            >
              {participantNames.length > 0
                ? `${participantNames.length} collaborator${participantNames.length === 1 ? "" : "s"} active${extraParticipantCount > 0 ? `, +${extraParticipantCount} more` : ""}`
                : "Workspace"}
            </div>
          </div>
          <div
            className={`h-7 w-px ${isDark ? "bg-white/10" : "bg-slate-200"}`}
          />
          <button
            type="button"
            onClick={handleCopyInvite}
            className={`shrink-0 rounded-full border px-3 py-2 text-[11px] font-semibold transition-all hover:scale-105 active:scale-95 sm:px-4 ${
              isDark
                ? "border-white/20 bg-white/10 text-white hover:bg-white/15"
                : "border-slate-200 bg-white text-slate-800 shadow-sm hover:border-slate-300 hover:shadow"
            }`}
          >
            Share
          </button>
        </div>
      </div>

      <div className="pointer-events-none absolute right-2 top-2 z-30 sm:right-4 sm:top-4">
        <div className="pointer-events-auto flex items-center gap-2">
          {/* AI Generate button */}
          <div className="relative">
            <AiTriggerButton
              onClick={() => setIsAiOpen((o) => !o)}
              isActive={isAiOpen}
              isDark={isDark}
            />
            {isAiOpen && (
              <AiChatModal
                roomId={resolvedRoomId}
                isOpen={isAiOpen}
                onClose={() => setIsAiOpen(false)}
                isDark={isDark}
                httpBackend={HTTP_BACKEND}
                apiClient={apiClient}
                getCurrentShapes={() => canvasState?.getShapes() ?? []}
                messages={ai.messages}
                isGenerating={ai.isGenerating}
                onSend={ai.generate}
              />
            )}
          </div>

          {/* ⋯ menu button */}
          <div className="relative">
            <button
              ref={menuButtonRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
              aria-controls="canvas-overflow-menu"
              onClick={() => {
                setIsMenuOpen((current) => {
                  const next = !current;
                  if (!next) {
                    setShowRoomInfo(false);
                  }
                  return next;
                });
              }}
              className={`grid h-11 w-11 place-items-center rounded-full border text-xl transition ${
                isDark
                  ? "border-white/15 bg-[#191919]/95 text-white hover:bg-[#252525]"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
              }`}
              title="More actions"
              aria-label="More actions"
            >
              <span aria-hidden="true">⋯</span>
              {incomingRoomAccessRequests.length > 0 && (
                <span
                  className={`absolute -right-1 -top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-semibold ${
                    isDark
                      ? "bg-emerald-400 text-black"
                      : "bg-emerald-600 text-white"
                  }`}
                >
                  {incomingRoomAccessRequests.length}
                </span>
              )}
            </button>

            {isMenuOpen && (
              <div
                ref={menuPanelRef}
                id="canvas-overflow-menu"
                role="menu"
                aria-label="Canvas actions"
                onFocusCapture={(event) => {
                  const menuItems = getMenuItems();
                  const focusTarget = event.target as EventTarget | null;
                  const focusedIndex = menuItems.findIndex(
                    (item) => item === focusTarget,
                  );
                  if (focusedIndex >= 0) {
                    syncMenuRovingFocus(focusedIndex, false);
                  }
                }}
                onKeyDown={(event) => {
                  const menuItems = getMenuItems();
                  if (menuItems.length === 0) return;

                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    syncMenuRovingFocus(menuFocusIndexRef.current + 1, true);
                    return;
                  }

                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    syncMenuRovingFocus(menuFocusIndexRef.current - 1, true);
                    return;
                  }

                  if (event.key === "Home") {
                    event.preventDefault();
                    syncMenuRovingFocus(0, true);
                    return;
                  }

                  if (event.key === "End") {
                    event.preventDefault();
                    syncMenuRovingFocus(menuItems.length - 1, true);
                    return;
                  }

                  if (event.key === "Enter" || event.key === " ") {
                    const activeElement =
                      document.activeElement as HTMLElement | null;
                    const activeIndex = menuItems.findIndex(
                      (item) => item === activeElement,
                    );
                    const targetIndex =
                      activeIndex >= 0
                        ? activeIndex
                        : menuFocusIndexRef.current;
                    if (targetIndex < 0) return;

                    event.preventDefault();
                    menuItems[targetIndex]?.click();
                  }
                }}
                onWheel={(event) => {
                  event.stopPropagation();
                }}
                className={`absolute right-0 top-14 max-h-[calc(100vh-5.5rem)] w-[min(92vw,20rem)] overflow-y-auto overscroll-contain rounded-3xl border p-2 backdrop-blur-2xl sm:w-80 ${floatingPanelSurface}`}
              >
                <div className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">
                  Profile & Account
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsMenuOpen(false);
                    setShowRoomInfo(false);
                    handleOpenProfile();
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                    isDark ? "hover:bg-white/10" : "hover:bg-slate-100"
                  }`}
                >
                  View profile
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsMenuOpen(false);
                    setShowRoomInfo(false);
                    void handleLogout();
                  }}
                  disabled={isLoggingOut}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                    isDark
                      ? "text-red-300 hover:bg-red-500/20"
                      : "text-red-700 hover:bg-red-100"
                  } ${isLoggingOut ? "cursor-not-allowed opacity-70" : ""}`}
                >
                  {isLoggingOut ? "Logging out..." : "Logout"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleGoToMyCanvases}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                    isDark ? "hover:bg-white/10" : "hover:bg-slate-100"
                  }`}
                >
                  <span>Switch Workspace</span>
                  <span className="text-xs opacity-60">/rooms</span>
                </button>

                <div
                  className={`my-2 h-px ${isDark ? "bg-white/10" : "bg-slate-200"}`}
                />
                <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">
                  Canvas Actions
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsMenuOpen(false);
                    setShowRoomInfo(false);
                    handleClearCanvas();
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                    isDark ? "hover:bg-white/10" : "hover:bg-slate-100"
                  }`}
                >
                  Clear canvas
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsMenuOpen(false);
                    setShowRoomInfo(false);
                    handleResetView();
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                    isDark ? "hover:bg-white/10" : "hover:bg-slate-100"
                  }`}
                >
                  Reset view
                </button>

                <div
                  className={`my-2 h-px ${isDark ? "bg-white/10" : "bg-slate-200"}`}
                />
                <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">
                  Diagram tools
                </div>
                {(
                  [
                    ["Templates & sticky notes…", "Kanban, retro…", () => setShowTemplates(true)],
                    ["Import Mermaid…", "Paste → shapes", () => setMermaidMode("import")],
                    ["Copy as Mermaid…", "Shapes → code", () => setMermaidMode("export")],
                    ["Tidy layout (top-down)", "Auto-arrange", () => handleTidyLayout("TD")],
                    ["Tidy layout (left-right)", "Auto-arrange", () => handleTidyLayout("LR")],
                    ["Summarize board ✦", "AI notes", () => handleSummarizeBoard()],
                    ["Image → shapes ✦", "Photo/screenshot", () => imageInputRef.current?.click()],
                  ] as const
                ).map(([label, hint, action]) => (
                  <button
                    key={label}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsMenuOpen(false);
                      setShowRoomInfo(false);
                      action();
                    }}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                      isDark ? "hover:bg-white/10" : "hover:bg-slate-100"
                    }`}
                  >
                    <span>{label}</span>
                    <span className="text-[11px] opacity-70">{hint}</span>
                  </button>
                ))}
                <div
                  className={`my-2 h-px ${isDark ? "bg-white/10" : "bg-slate-200"}`}
                />
                <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">
                  Data & Persistence
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsMenuOpen(false);
                    setShowRoomInfo(false);
                    setShowHistory(true);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                    isDark ? "hover:bg-white/10" : "hover:bg-slate-100"
                  }`}
                >
                  <span>Version history</span>
                  <span className="text-[11px] opacity-70">Time travel</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsMenuOpen(false);
                    setShowRoomInfo(false);
                    void handleReloadCanvas();
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                    isDark ? "hover:bg-white/10" : "hover:bg-slate-100"
                  } ${isReloadingCanvas ? "cursor-not-allowed opacity-70" : ""}`}
                  disabled={isReloadingCanvas}
                >
                  {isReloadingCanvas ? "Reloading canvas..." : "Reload canvas"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsMenuOpen(false);
                    setShowRoomInfo(false);
                    void handleManualSaveCanvas();
                  }}
                  disabled={isSavingCanvas}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                    isDark ? "hover:bg-white/10" : "hover:bg-slate-100"
                  }`}
                >
                  <span>
                    {isSavingCanvas
                      ? "Saving canvas..."
                      : "Save canvas manually"}
                  </span>
                  <span className="text-[11px] opacity-70">Force snapshot</span>
                </button>

                <div
                  className={`my-2 h-px ${isDark ? "bg-white/10" : "bg-slate-200"}`}
                />
                <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">
                  Collaboration
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    handleJoinCanvasFromMenu();
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                    isDark ? "hover:bg-white/10" : "hover:bg-slate-100"
                  }`}
                >
                  <span>Join a canvas</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    handleCopyInvite();
                    setIsMenuOpen(false);
                    setShowRoomInfo(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                    isDark ? "hover:bg-white/10" : "hover:bg-slate-100"
                  }`}
                >
                  Copy invite link
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShowRoomInfo((current) => !current);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                    isDark ? "hover:bg-white/10" : "hover:bg-slate-100"
                  }`}
                >
                  <span>Show room info</span>
                  <span className="text-xs opacity-70">
                    {showRoomInfo ? "Hide" : "Show"}
                  </span>
                </button>
                <div
                  className={`mx-2 mt-2 rounded-lg border px-3 py-2 text-xs ${
                    isDark
                      ? "border-white/10 bg-white/5"
                      : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-semibold">Pending room requests</span>
                    <span className="opacity-70">
                      {incomingRoomAccessRequests.length}
                    </span>
                  </div>
                  {isLoadingIncomingRequests ? (
                    <div className="opacity-70">Loading requests...</div>
                  ) : incomingRoomAccessRequests.length === 0 ? (
                    <div className="opacity-70">
                      No pending requests for this room.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {incomingRoomAccessRequests.map((request) => (
                        <div
                          key={request.id}
                          className={`rounded-md border p-2 ${
                            isDark ? "border-white/10" : "border-slate-200"
                          }`}
                        >
                          <div className="mb-2 opacity-80">
                            {request.requester.name} (
                            {request.requester.handle ??
                              request.requester.email}
                            )
                          </div>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              role="menuitem"
                              disabled={
                                requestDecisionInFlightId === request.id
                              }
                              onClick={() =>
                                void handleAccessRequestDecision(
                                  request.id,
                                  "approve",
                                )
                              }
                              className={`rounded-md border px-2 py-1 text-xs font-medium ${
                                isDark
                                  ? "border-emerald-300/30 bg-emerald-500/10 text-emerald-100"
                                  : "border-emerald-300 bg-emerald-50 text-emerald-800"
                              }`}
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              disabled={
                                requestDecisionInFlightId === request.id
                              }
                              onClick={() =>
                                void handleAccessRequestDecision(
                                  request.id,
                                  "reject",
                                )
                              }
                              className={`rounded-md border px-2 py-1 text-xs font-medium ${
                                isDark
                                  ? "border-red-300/30 bg-red-500/10 text-red-100"
                                  : "border-red-300 bg-red-50 text-red-800"
                              }`}
                            >
                              Reject
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {showRoomInfo && (
                  <div
                    className={`mx-2 mt-1 rounded-lg border px-3 py-2 text-xs ${
                      isDark
                        ? "border-white/10 bg-white/5"
                        : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <div className="mb-1">Room slug: {roomId ?? "-"}</div>
                    <div className="mb-1">Room id: {resolvedRoomId ?? "-"}</div>
                    <div className="mb-1">
                      Participants: {connectedUsersCount}
                    </div>
                    <div className="max-h-20 overflow-y-auto opacity-80">
                      {participantNames.length > 0
                        ? participantNames.join(", ")
                        : "No active participants"}
                    </div>
                  </div>
                )}

                <div
                  className={`my-2 h-px ${isDark ? "bg-white/10" : "bg-slate-200"}`}
                />
                <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">
                  Settings
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => toggleTheme()}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                    isDark ? "hover:bg-white/10" : "hover:bg-slate-100"
                  }`}
                >
                  <span>Toggle dark/light mode</span>
                  <span className="text-xs opacity-70">
                    {isDark ? "Dark" : "Light"}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleToggleGridVisibility}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                    isDark ? "hover:bg-white/10" : "hover:bg-slate-100"
                  }`}
                >
                  <span>Toggle grid visibility</span>
                  <span className="text-xs opacity-70">
                    {isGridVisible ? "On" : "Off"}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleToggleSnap}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                    isDark ? "hover:bg-white/10" : "hover:bg-slate-100"
                  }`}
                >
                  <span>Toggle snap</span>
                  <span className="text-[11px] opacity-70">
                    {isSnapEnabled ? "On" : "Off"}
                  </span>
                </button>

                <div
                  className={`my-2 h-px ${isDark ? "bg-white/10" : "bg-slate-200"}`}
                />
                <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">
                  Debug / System
                </div>
                <div
                  className={`mx-2 mb-1 rounded-lg px-3 py-2 text-xs ${
                    isDark
                      ? "bg-white/5 text-white/85"
                      : "bg-slate-100 text-slate-700"
                  }`}
                >
                  WS status: {syncStatus}
                  {syncResult.lastSyncError
                    ? ` (${syncResult.lastSyncError})`
                    : ""}
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleToggleDebugOverlay}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                    isDark ? "hover:bg-white/10" : "hover:bg-slate-100"
                  }`}
                >
                  <span>Toggle debug overlay</span>
                  <span className="text-xs opacity-70">
                    {showDebugOverlay ? "On" : "Off"}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleToggleDebugPanelMode}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                    isDark ? "hover:bg-white/10" : "hover:bg-slate-100"
                  }`}
                >
                  <span>Debug panel mode</span>
                  <span className="text-xs opacity-70">
                    {debugPanelMode === "compact" ? "Compact" : "Verbose"}
                  </span>
                </button>

                <div
                  className={`my-2 h-px ${isDark ? "bg-white/10" : "bg-slate-200"}`}
                />
                <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">
                  Export
                </div>
                <div
                  className={`mx-2 rounded-xl border p-2 ${
                    isDark
                      ? "border-white/10 bg-white/5"
                      : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <label className="mb-1 block px-1 text-[11px] font-medium opacity-70">
                    Export format
                  </label>
                  <div className="flex gap-2">
                    <select
                      value={selectedExportFormat}
                      onChange={(event) =>
                        setSelectedExportFormat(
                          event.target.value as ExportFormat,
                        )
                      }
                      className={`w-full rounded-lg border px-2 py-2 text-sm outline-none ${
                        isDark
                          ? "border-white/15 bg-[#252525] text-white"
                          : "border-slate-300 bg-white text-slate-800"
                      }`}
                    >
                      <option value="png">PNG - image snapshot</option>
                      <option value="svg">SVG - vector export</option>
                      <option value="pdf">PDF - ready to share</option>
                      <option value="json">JSON - raw scene data</option>
                    </select>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        handleExportSelected();
                        setIsMenuOpen(false);
                        setShowRoomInfo(false);
                      }}
                      className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${
                        isDark
                          ? "border-white/15 bg-[#252525] hover:bg-[#2f2f2f]"
                          : "border-slate-300 bg-white hover:bg-slate-100"
                      }`}
                    >
                      Export
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {isJoinCanvasModalOpen && (
        <div className="absolute inset-0 z-40 grid place-items-center bg-black/40 px-4 backdrop-blur-sm">
          <div
            className={`w-full max-w-xl rounded-3xl border p-5 shadow-2xl ${
              isDark
                ? "border-white/10 bg-[#111827]/95 text-white"
                : "border-slate-300 bg-white/95 text-slate-900"
            }`}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">
                  Join Someone&apos;s Canvas
                </h2>
                <p
                  className={`mt-1 text-sm ${isDark ? "text-white/70" : "text-slate-600"}`}
                >
                  Paste an invite URL from another user or enter their
                  owner/room route.
                </p>
              </div>
              <div
                className={`rounded-lg border px-2 py-1 text-xs ${isDark ? "border-white/15 text-white/70" : "border-slate-300 text-slate-600"}`}
              >
                Current: {roomId ?? "-"}
              </div>
            </div>

            <div
              className={`rounded-2xl border p-3 ${isDark ? "border-white/10 bg-white/5" : "border-slate-200 bg-slate-50"}`}
            >
              <label
                className={`mb-2 block text-xs font-semibold uppercase tracking-[0.14em] ${isDark ? "text-white/60" : "text-slate-500"}`}
              >
                Join by invite or owner route
              </label>
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={joinCanvasInput}
                  onChange={(event) => setJoinCanvasInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleSubmitJoinCanvas();
                    }
                  }}
                  placeholder="https://.../room/owner/slug or /room/owner/slug"
                  className={`w-full rounded-xl border px-3 py-2 text-sm outline-none ${
                    isDark
                      ? "border-white/15 bg-[#0b1220] text-white placeholder:text-white/40 focus:border-white/30"
                      : "border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 focus:border-slate-500"
                  }`}
                />
                <button
                  type="button"
                  disabled={isJoiningCanvas}
                  onClick={() => void handleSubmitJoinCanvas()}
                  className={`rounded-xl px-3 py-2 text-sm font-semibold ${
                    isDark
                      ? "bg-white text-black hover:bg-white/90 disabled:opacity-70"
                      : "bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-70"
                  }`}
                >
                  {isJoiningCanvas ? "Joining..." : "Join"}
                </button>
              </div>
            </div>
            <p
              className={`mt-3 text-xs ${isDark ? "text-white/55" : "text-slate-500"}`}
            >
              Tip: Ask collaborators to share their room invite link. Public
              owner routes also work.
            </p>
            <p
              className={`mt-1 text-[11px] ${isDark ? "text-white/45" : "text-slate-500/90"}`}
            >
              Saved recent canvases on this device: {recentCanvases.length}
            </p>
            <div className="mt-4 flex justify-end items-center gap-2">
              <button
                type="button"
                onClick={() => setIsJoinCanvasModalOpen(false)}
                className={`rounded-lg border px-3 py-2 text-sm ${
                  isDark
                    ? "border-white/15 hover:bg-white/10"
                    : "border-slate-300 hover:bg-slate-100"
                }`}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedCount > 0 && (
        <aside
          className={`absolute z-20 transition-all duration-300 backdrop-blur-2xl ${inspectorSurface} ${
            isMobile
              ? `bottom-4 left-1/2 w-[calc(100vw-2rem)] -translate-x-1/2 rounded-[28px] p-4 ${
                  isInspectorMinimized
                    ? "h-[54px] overflow-hidden"
                    : "max-h-[60vh] overflow-y-auto"
                }`
              : "left-4 top-1/2 w-72 -translate-y-1/2 rounded-2xl p-5"
          }`}
        >
          <div
            className={`mb-4 flex items-center justify-between ${isMobile ? "cursor-pointer select-none" : ""}`}
            onClick={() =>
              isMobile && setIsInspectorMinimized(!isInspectorMinimized)
            }
          >
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-bold uppercase tracking-widest opacity-50">
                Shape Properties
              </h3>
              {isMobile && (
                <div
                  className={`rounded-full p-0.5 transition-colors ${
                    isDark ? "bg-white/10" : "bg-slate-100"
                  }`}
                >
                  {isInspectorMinimized ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                </div>
              )}
            </div>
            <span
              className={`rounded px-2 py-0.5 text-[10px] font-bold ${isDark ? "bg-blue-500/20 text-blue-300" : "bg-blue-50 text-blue-600"}`}
            >
              {selectedCount} Selected
            </span>
          </div>

          <div className="mb-5">
            <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider opacity-60">
              {isTextShapeSelection ? "Text Color" : "Stroke Color"}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              {STYLE_SWATCHES.map((color) => {
                const isSelected = strokeValue.toLowerCase() === color;
                const hasVisibleBorder =
                  color === "#ffffff" || color === "#ffffff";
                return (
                  <button
                    key={`stroke-${color}`}
                    type="button"
                    onClick={() => applyToSelectedShapes({ stroke: color })}
                    className={`h-7 w-7 rounded-lg border transition-all hover:scale-110 active:scale-90 shadow-sm ${
                      hasVisibleBorder
                        ? isDark
                          ? "border-white/20"
                          : "border-slate-300"
                        : "border-transparent"
                    } ${isSelected ? "ring-2 ring-blue-500 ring-offset-2 dark:ring-offset-[#0e1622]" : ""}`}
                    style={{ backgroundColor: color }}
                  />
                );
              })}
              <label
                className={`relative h-7 w-7 cursor-pointer overflow-hidden rounded-lg border ${
                  isDark ? "border-white/20" : "border-slate-300"
                }`}
                style={{ background: RAINBOW_PICKER_BACKGROUND }}
                title="Pick custom stroke color"
                aria-label="Pick custom stroke color"
              >
                <input
                  type="color"
                  value={normalizePickerColor(strokeValue, "#1971c2")}
                  onChange={(event) =>
                    applyToSelectedShapes({ stroke: event.target.value })
                  }
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                />
              </label>
            </div>
          </div>

          {showsFillControls && (
            <div className="mb-5">
              <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider opacity-60">
                Fill Color
              </label>
              <div className="flex flex-wrap items-center gap-2">
                {STYLE_SWATCHES.map((color) => {
                  const isSelected = fillValue.toLowerCase() === color;
                  const hasVisibleBorder = color === "#ffffff";
                  return (
                    <button
                      key={`fill-${color}`}
                      type="button"
                      onClick={() => applyToSelectedShapes({ fill: color })}
                      className={`h-7 w-7 rounded-lg border transition-all hover:scale-110 active:scale-90 shadow-sm ${
                        hasVisibleBorder
                          ? isDark
                            ? "border-white/20"
                            : "border-slate-300"
                          : "border-transparent"
                      } ${isSelected ? "ring-2 ring-blue-500 ring-offset-2 dark:ring-offset-[#0e1622]" : ""}`}
                      style={{ backgroundColor: color }}
                    />
                  );
                })}

                <label
                  className={`relative h-7 w-7 cursor-pointer overflow-hidden rounded-lg border ${
                    isDark ? "border-white/20" : "border-slate-300"
                  }`}
                  style={{ background: RAINBOW_PICKER_BACKGROUND }}
                  title="Pick custom fill color"
                  aria-label="Pick custom fill color"
                >
                  <input
                    type="color"
                    value={normalizePickerColor(fillValue, "#60a5fa")}
                    onChange={(event) =>
                      applyToSelectedShapes({ fill: event.target.value })
                    }
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  />
                </label>
              </div>
            </div>
          )}

          {!isTextShapeSelection && (
            <div className="mb-5">
              <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider opacity-60">
                Fill Style
              </label>
              <div className="flex flex-nowrap items-center gap-2 overflow-x-auto pb-1">
                {FILL_STYLE_OPTIONS.map((opt) => (
                  <FillStyleTile
                    key={opt.value}
                    value={opt.value}
                    selected={fillStyleValue === opt.value}
                    onClick={() =>
                      applyToSelectedShapes({ fillStyle: opt.value })
                    }
                    isDark={isDark}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="mb-5">
            <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider opacity-60">
              Stroke Style
            </label>
            <div className="flex items-center gap-2">
              {STROKE_STYLE_OPTIONS.map((opt) => (
                <StrokeStyleTile
                  key={opt.value}
                  value={opt.value}
                  selected={strokeStyleValue === opt.value}
                  onClick={() =>
                    applyToSelectedShapes({ strokeStyle: opt.value })
                  }
                  isDark={isDark}
                />
              ))}
            </div>
          </div>

          <div className="mb-5">
            <label className="mb-3 block text-[10px] font-bold uppercase tracking-wider opacity-60">
              Drawing Persona
            </label>
            <div className="grid grid-cols-3 gap-1.5">
              {DRAWING_PERSONAS.map((persona) => {
                const isActive = activePersona?.id === persona.id;
                return (
                  <button
                    key={persona.id}
                    type="button"
                    onClick={() => {
                      setDefaultRoughness(persona.roughness);
                      if (selectedCount > 0) {
                        applyToSelectedShapes({ roughness: persona.roughness });
                      }
                    }}
                    className={`flex flex-col items-center rounded-xl border py-2.5 text-[10px] font-bold transition-all ${
                      isActive
                        ? isDark
                          ? "border-blue-500/50 bg-blue-600/30 text-white shadow-[0_0_20px_rgba(37,99,235,0.25)]"
                          : "border-blue-300 bg-blue-50 text-blue-700 shadow-sm shadow-blue-500/5"
                        : isDark
                          ? "border-white/5 bg-white/5 text-white/70 hover:border-white/20 hover:text-white"
                          : "border-slate-100 bg-white text-slate-600 hover:border-blue-200 hover:text-slate-900"
                    }`}
                  >
                    <span
                      className={`mb-1.5 inline-flex h-4 w-full items-center justify-center ${
                        isActive
                          ? isDark
                            ? "text-blue-300"
                            : "text-blue-600"
                          : isDark
                            ? "text-slate-400"
                            : "text-slate-500"
                      }`}
                    >
                      <PersonaButtonGlyph personaId={persona.id} />
                    </span>
                    {persona.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mb-6">
            <div className="mb-2 flex items-center justify-between">
              <label className="text-[10px] font-bold uppercase tracking-wider opacity-60">
                Opacity
              </label>
              <span className="text-[11px] font-bold text-blue-500">
                {opacityValue}%
              </span>
            </div>
            <input
              type="range"
              min={10}
              max={100}
              value={opacityValue}
              onChange={(e) =>
                applyToSelectedShapes({ opacity: Number(e.target.value) })
              }
              className="w-full accent-blue-600"
            />
          </div>

          {!isTextShapeSelection && showReplay && (
            <button
              type="button"
              onClick={handleReplaySelected}
              className={`w-full rounded-2xl border px-3 py-3 text-xs font-bold transition-all hover:scale-[1.02] active:scale-[0.98] ${
                isDark
                  ? "border-emerald-500/30 bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30"
                  : "border-emerald-100 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 shadow-sm shadow-emerald-500/5"
              }`}
            >
              Replay Stroke
            </button>
          )}
        </aside>
      )}

      {/* Top Center: Main Toolbar */}
      <div
        className={`absolute left-1/2 top-20 z-10 w-[calc(100vw-1rem)] -translate-x-1/2 rounded-2xl p-2 backdrop-blur-2xl transition-all duration-500 sm:top-4 sm:w-auto sm:p-3 ${topToolbarSurface}`}
      >
        <div className="flex flex-nowrap items-center gap-1.5 overflow-x-auto scrollbar-none px-1 pb-1 sm:overflow-visible sm:pb-0">
          {TOOLS.map((tool, idx) => {
            const isActive = activeTool === tool.id;
            return (
              <div key={tool.id} className="flex items-center">
                <button
                  type="button"
                  onClick={() => setActiveTool(tool.id)}
                  title={`${tool.label} (${tool.shortcut})`}
                  className={`group flex shrink-0 min-w-16 flex-col items-center rounded-xl border px-3 py-2.5 transition-all duration-200 ${
                    isActive
                      ? isDark
                        ? "border-blue-500/50 bg-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.4)]"
                        : "border-blue-400 bg-blue-50 text-blue-700 shadow-md shadow-blue-500/10"
                      : isDark
                        ? "border-transparent bg-white/5 text-white/85 hover:border-white/20 hover:text-white"
                        : "border-transparent bg-slate-100/50 text-slate-500 hover:bg-slate-200 hover:text-slate-900"
                  }`}
                >
                  <span
                    className={`transition-transform duration-200 ${isActive ? "scale-110" : "group-hover:scale-110"}`}
                  >
                    {tool.icon}
                  </span>
                  <span
                    className={`mt-1 text-[10px] font-bold ${
                      isActive
                        ? isDark
                          ? "text-white/90"
                          : "text-blue-700"
                        : "opacity-40"
                    }`}
                  >
                    {tool.shortcut}
                  </span>
                </button>
                {idx < TOOLS.length - 1 && (
                  <div
                    className={`mx-1.5 h-8 w-px opacity-10 ${isDark ? "bg-white/20" : "bg-slate-300"}`}
                  />
                )}
              </div>
            );
          })}
          <div
            className={`mx-1.5 h-8 w-px opacity-10 ${isDark ? "bg-white/20" : "bg-slate-300"}`}
          />
          <button
            type="button"
            onClick={handleDeleteSelected}
            disabled={selectedCount === 0}
            title="Delete selected shapes (Delete/Backspace)"
            className={`group flex shrink-0 min-w-16 flex-col items-center rounded-xl border px-3 py-2.5 transition-all duration-200 ${
              selectedCount > 0
                ? isDark
                  ? "border-red-500/30 bg-red-600/20 text-red-300 hover:border-red-500/50 hover:bg-red-600/30"
                  : "border-red-300 bg-red-50 text-red-600 hover:bg-red-100 shadow-sm"
                : isDark
                  ? "cursor-not-allowed opacity-20 border-transparent bg-white/5"
                  : "cursor-not-allowed opacity-30 border-transparent bg-slate-100/50"
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              className={`h-5 w-5 transition-transform duration-200 ${selectedCount > 0 ? "group-hover:scale-110" : ""}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path d="M3 6h18" />
              <path d="M8 6V4h8v2" />
              <path d="M19 6l-1 14H6L5 6" />
            </svg>
            <span
              className={`mt-1 text-[10px] font-bold ${
                selectedCount > 0 ? "opacity-90" : "opacity-40"
              }`}
            >
              Del
            </span>
          </button>
        </div>
      </div>
      <CanvasMessenger
        currentUserId={syncResult.currentUserId}
        roomKey={roomId ?? null}
        connectedUsersCount={connectedUsersCount}
        presenceState={remotePresenceState}
        selectedShapeIds={selectedIds}
        isDark={isDark}
        syncStatus={syncStatus}
        chat={chat}
      />

      <div className="pointer-events-none absolute bottom-4 left-2 z-30 hidden sm:block sm:left-4">
        <div
          className={`pointer-events-auto flex items-center gap-2 rounded-2xl border px-2 py-1.5 backdrop-blur-2xl ${floatingPanelSurface}`}
        >
          <button
            type="button"
            onClick={() => handleZoomByStep("out")}
            className={`grid h-8 w-8 place-items-center rounded-lg border text-base font-semibold transition ${
              isDark
                ? "border-white/20 bg-white/10 text-white hover:bg-white/15"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
            }`}
            aria-label="Zoom out"
            title="Zoom out"
          >
            -
          </button>
          <div
            className={`min-w-16 text-center text-sm font-semibold ${isDark ? "text-white/90" : "text-slate-700"}`}
          >
            {zoomPercent}%
          </div>
          <button
            type="button"
            onClick={() => handleZoomByStep("in")}
            className={`grid h-8 w-8 place-items-center rounded-lg border text-base font-semibold transition ${
              isDark
                ? "border-white/20 bg-white/10 text-white hover:bg-white/15"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
            }`}
            aria-label="Zoom in"
            title="Zoom in"
          >
            +
          </button>
        </div>
      </div>

      {viewport && floatingShapeComments.length > 0 && (
        <div className="pointer-events-none absolute inset-0 z-25">
          {floatingShapeComments.map((comment) => (
            <div
              key={comment.id}
              className={`absolute -translate-x-1/2 rounded-2xl border px-3 py-2 text-xs shadow-lg ${
                isDark
                  ? "border-white/15 bg-[#141414]/95 text-white"
                  : "border-slate-200 bg-white/96 text-slate-800"
              }`}
              style={{
                left: comment.x * viewport.scale + viewport.x,
                top: comment.y * viewport.scale + viewport.y,
                maxWidth: 220,
              }}
            >
              <div
                className={`mb-1 font-semibold ${isDark ? "text-blue-200" : "text-blue-700"}`}
              >
                {comment.authorLabel} commented
              </div>
              <div className="wrap-break-word">{comment.body}</div>
            </div>
          ))}
        </div>
      )}

      <RemotePresenceLayer
        presenceState={remotePresenceState}
        currentUserId={syncResult.currentUserId}
        viewportRef={viewportLiveRef}
        shapesRef={syncResult.latestShapesRef}
        isDark={isDark}
      />

      {showHistory && resolvedRoomId !== null && (
        <HistoryPanel
          roomId={resolvedRoomId}
          canvasState={canvasState}
          viewportRef={viewportLiveRef}
          isDark={isDark}
          onClose={() => setShowHistory(false)}
          onRestored={() => pushToast("success", "Version restored.")}
          onError={(message) => pushToast("error", message)}
        />
      )}

      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        aria-label="Choose an image to convert into shapes"
        onChange={(event) => {
          void handleImageChosen(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      {showTemplates && (
        <TemplatesModal
          isDark={isDark}
          onPick={handleInsertTemplate}
          onClose={() => setShowTemplates(false)}
        />
      )}

      {summaryText && (
        <SummaryModal
          summary={summaryText}
          isDark={isDark}
          onClose={() => setSummaryText(null)}
          onInsert={handleInsertSummary}
        />
      )}

      {mermaidMode && (
        <MermaidModal
          mode={mermaidMode}
          isDark={isDark}
          onImport={handleMermaidImport}
          shapes={canvasState ? (getSelectionScope() ?? canvasState.getShapes()) : []}
          scopeLabel={selectedIds.length > 0 ? "the selection" : "the whole canvas"}
          onClose={() => setMermaidMode(null)}
          onCopied={() => {
            setMermaidMode(null);
            pushToast("success", "Mermaid copied to clipboard.");
          }}
        />
      )}

      <ArrangeBar
        selectedCount={selectedIds.length}
        isDark={isDark}
        onAlign={handleAlign}
        onDistribute={handleDistribute}
      />

      <AiEditBar
        selectedCount={selectedIds.length}
        sketchCount={
          canvasState
            ? canvasState
                .getShapes()
                .filter(
                  (shape) =>
                    shape.type === "freehand" && selectedIds.includes(shape.id),
                ).length
            : 0
        }
        onSnapSketches={() => {
          if (!canvasState) return;
          const { shapes, recognized } = snapSketches(
            canvasState.getShapes(),
            new Set(selectedIds),
          );
          if (recognized === 0) {
            pushToast(
              "error",
              "Couldn't recognize a shape — try a clearer rectangle, ellipse, diamond or straight line.",
            );
            return;
          }
          canvasState.setShapes(shapes);
          controlsRef.current?.rerender();
          setSelectedIds([]);
          pushToast(
            "success",
            `Cleaned up ${recognized} sketch${recognized === 1 ? "" : "es"} (Ctrl/Cmd+Z to undo)`,
          );
        }}
        isGenerating={ai.isGenerating}
        isDark={isDark}
        onSubmit={(instruction) => {
          if (!canvasState) return;
          const selected = new Set(selectedIds);
          const selection = canvasState
            .getShapes()
            .filter((shape) => selected.has(shape.id));
          if (selection.length === 0) return;
          void ai.generate(
            instruction,
            `Edit ${selection.length} selected: ${instruction}`,
            {
              mode: "edit",
              selection: selection as unknown as Array<
                Record<string, unknown> & { id: string }
              >,
            },
          );
        }}
      />

      <LiveCollabLayer
        presenceState={remotePresenceState}
        currentUserId={syncResult.currentUserId}
        viewportRef={viewportLiveRef}
        canvasRef={canvasRef}
        sendEphemeral={syncResult.sendEphemeral}
        subscribeEphemeral={syncResult.subscribeEphemeral}
        applyViewport={(nextViewport) => {
          skipNextViewportPersistRef.current = true;
          controlsRef.current?.setViewport(nextViewport);
        }}
        isDark={isDark}
      />

      {showDebugOverlay && (
        <div
          onWheel={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          className={`pointer-events-auto absolute bottom-20 left-2 z-20 max-h-[min(60vh,28rem)] w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-3xl border px-3 py-2 text-xs backdrop-blur-2xl sm:bottom-4 sm:left-4 sm:w-80 ${
            isDark
              ? "border-white/15 bg-[#171717]/92 text-white/90"
              : "border-slate-300/80 bg-white/92 text-slate-700"
          }`}
        >
          <div className="mb-2 font-semibold">
            Debug Overlay ({debugPanelMode})
          </div>
          <div className="mb-1">Room slug: {roomId ?? "-"}</div>
          <div className="mb-1">Room id: {resolvedRoomId ?? "-"}</div>
          <div className="mb-1">WS status: {syncStatus}</div>
          <div className="mb-1">
            Sync version:{" "}
            {debugOverlaySnapshot?.version ?? syncResult.syncVersion}
          </div>
          <div className="mb-1">
            Captured: {debugOverlaySnapshot?.capturedAt ?? "-"}
          </div>
          <div className="mb-2">
            Shape count:{" "}
            {debugOverlaySnapshot?.shapeCount ??
              canvasState?.getShapes().length ??
              0}
          </div>
          {debugPanelMode === "verbose" && (
            <>
              <div className="mb-1">
                WS latency:{" "}
                {syncResult.websocketLatencyMs !== null
                  ? `${syncResult.websocketLatencyMs}ms`
                  : "-"}
              </div>
              <div className="mb-2">
                In-flight snapshots: {syncResult.inFlightSnapshotCount}
              </div>
            </>
          )}
          <div className="font-medium">Shape IDs</div>
          <div className="opacity-80">
            {(debugOverlaySnapshot?.shapeIds ?? []).join(", ") || "No shapes"}
          </div>
          {debugPanelMode === "verbose" && (
            <>
              <div className="mt-3 font-medium">Event timeline</div>
              <div className="mt-1 space-y-1 opacity-85">
                {syncResult.eventTimeline.length === 0 ? (
                  <div>No events yet</div>
                ) : (
                  syncResult.eventTimeline.slice(-12).map((entry) => (
                    <div
                      key={entry.id}
                      className="rounded-md bg-black/10 px-2 py-1"
                    >
                      <span className="mr-1 opacity-70">[{entry.at}]</span>
                      <span className="mr-1 font-semibold">{entry.type}</span>
                      <span>{entry.detail}</span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      )}

      <div className="pointer-events-none absolute left-2 right-2 top-36 z-40 flex flex-col gap-2 sm:left-auto sm:right-4 sm:top-20 sm:w-88">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto rounded-2xl border px-3 py-2 text-sm backdrop-blur-xl ${
              toast.tone === "success"
                ? isDark
                  ? "border-emerald-300/35 bg-emerald-500/15 text-emerald-100"
                  : "border-emerald-300 bg-emerald-50 text-emerald-800"
                : toast.tone === "error"
                  ? isDark
                    ? "border-red-300/35 bg-red-500/20 text-red-100"
                    : "border-red-300 bg-red-50 text-red-800"
                  : isDark
                    ? "border-blue-300/35 bg-blue-500/20 text-blue-100"
                    : "border-blue-300 bg-blue-50 text-blue-800"
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>

      {isClearCanvasModalOpen && (
        <div className="absolute inset-0 z-50 grid place-items-center bg-black/35 px-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-canvas-title"
            className={`w-full max-w-md rounded-[28px] border p-5 shadow-2xl backdrop-blur-2xl ${
              isDark
                ? "border-white/15 bg-[#1a1a1a] text-white"
                : "border-slate-300 bg-white text-slate-900"
            }`}
          >
            <h3 id="clear-canvas-title" className="text-base font-semibold">
              Clear canvas?
            </h3>
            <p className="mt-2 text-sm opacity-80">
              This removes all shapes from this room. This action cannot be
              undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsClearCanvasModalOpen(false)}
                className={`rounded-lg border px-3 py-2 text-sm transition ${
                  isDark
                    ? "border-white/20 hover:bg-white/10"
                    : "border-slate-300 hover:bg-slate-100"
                }`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  confirmClearCanvas();
                  setIsClearCanvasModalOpen(false);
                }}
                className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${
                  isDark
                    ? "border-red-300/40 bg-red-500/20 text-red-100 hover:bg-red-500/30"
                    : "border-red-300 bg-red-50 text-red-700 hover:bg-red-100"
                }`}
              >
                Clear canvas
              </button>
            </div>
          </div>
        </div>
      )}

      <canvas
        ref={canvasRef}
        className="relative z-0 block h-full w-full touch-none"
        style={{ background: "transparent" }}
      />
    </div>
  );
}
