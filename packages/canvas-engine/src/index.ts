/**
 * Public canvas-engine API surface consumed by apps.
 */
export { attachEvents } from "./events";
export { CanvasState } from "./state";
export { convertToPoints } from "./geometry";
export { getConnectorRoutePoints, getArrowHeadPoints } from "./connectors";
export { dispatch } from "./store";
export { render } from "./renderer";
export type { Viewport } from "./utils";
export type { Shape } from "./types";
export {
  parseMermaidFlowchart,
  buildShapesFromDiagram,
  mermaidToShapes,
  shapesToMermaid,
  MermaidParseError,
} from "./diagram/mermaid";
export { tidyLayout } from "./diagram/tidy";
export type { LayoutDirection } from "./diagram/layout";
export type { Tool } from "./interaction/tools";
export type { AttachEventsController } from "./interaction/tools";
