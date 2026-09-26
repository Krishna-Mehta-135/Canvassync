"use client";

import {
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignHorizontalSpaceBetween,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalSpaceBetween,
  type LucideIcon,
} from "lucide-react";
import type { AlignMode, DistributeAxis } from "@repo/canvas-engine";

type ArrangeBarProps = {
  selectedCount: number;
  isDark: boolean;
  onAlign: (mode: AlignMode) => void;
  onDistribute: (axis: DistributeAxis) => void;
};

const ALIGN_BUTTONS: Array<{ mode: AlignMode; label: string; Icon: LucideIcon }> = [
  { mode: "left", label: "Align left", Icon: AlignHorizontalJustifyStart },
  { mode: "hcenter", label: "Align horizontal centres", Icon: AlignHorizontalJustifyCenter },
  { mode: "right", label: "Align right", Icon: AlignHorizontalJustifyEnd },
  { mode: "top", label: "Align top", Icon: AlignVerticalJustifyStart },
  { mode: "vcenter", label: "Align vertical centres", Icon: AlignVerticalJustifyCenter },
  { mode: "bottom", label: "Align bottom", Icon: AlignVerticalJustifyEnd },
];

/** Align / distribute controls, shown while two or more shapes are selected. */
export function ArrangeBar({ selectedCount, isDark, onAlign, onDistribute }: ArrangeBarProps) {
  if (selectedCount < 2) return null;

  const surface = isDark
    ? "border-white/15 bg-[#171717]/92 text-white/90"
    : "border-slate-300/80 bg-white/92 text-slate-800";
  const button =
    "grid h-8 w-8 place-items-center rounded-lg text-base transition hover:bg-blue-500/20 disabled:opacity-35 disabled:hover:bg-transparent";

  return (
    <div
      role="toolbar"
      aria-label="Arrange selection"
      className={`pointer-events-auto absolute left-1/2 top-[5.6rem] z-30 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border px-1.5 py-1 shadow-lg backdrop-blur-2xl ${surface}`}
    >
      {ALIGN_BUTTONS.map((item) => (
        <button
          key={item.mode}
          type="button"
          title={item.label}
          aria-label={item.label}
          onClick={() => onAlign(item.mode)}
          className={button}
        >
          <item.Icon className="h-4 w-4" aria-hidden />
        </button>
      ))}
      <span className="mx-1 h-5 w-px bg-current opacity-20" />
      <button
        type="button"
        title="Distribute horizontally (3+ shapes)"
        aria-label="Distribute horizontally"
        disabled={selectedCount < 3}
        onClick={() => onDistribute("horizontal")}
        className={button}
      >
        <AlignHorizontalSpaceBetween className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        title="Distribute vertically (3+ shapes)"
        aria-label="Distribute vertically"
        disabled={selectedCount < 3}
        onClick={() => onDistribute("vertical")}
        className={button}
      >
        <AlignVerticalSpaceBetween className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
