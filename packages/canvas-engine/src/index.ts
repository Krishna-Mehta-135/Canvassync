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
export { snapSketches, recognizeStroke } from "./diagram/sketch";
export { TEMPLATES, buildTemplate } from "./diagram/templates";
export { bindTextToContainers, bindConnectorsToContainers } from "./diagram/labels";
export { alignShapes, distributeShapes } from "./diagram/arrange";
export type { AlignMode, DistributeAxis } from "./diagram/arrange";
export type { TemplateId, TemplateInfo } from "./diagram/templates";
export type { LayoutDirection } from "./diagram/layout";
export type { Tool } from "./interaction/tools";
export type { AttachEventsController } from "./interaction/tools";
