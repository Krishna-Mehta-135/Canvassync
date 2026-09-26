"use client";

import { motion, useInView } from "motion/react";
import { useRef } from "react";
import {
  Mic,
  MousePointer2,
  MessagesSquare,
  Timer,
  History,
  Wand2,
  ImagePlus,
  GitBranch,
  PenTool,
  LayoutTemplate,
  AlignHorizontalDistributeCenter,
  Presentation,
  Link2,
  ShieldCheck,
  Map,
  Video,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

type Item = { icon: LucideIcon; title: string; description: string };

type Group = {
  label: string;
  headline: string;
  accent: string; // text colour
  chip: string; // icon tile
  items: Item[];
};

// Grouped to mirror how the app menus are organised.
const groups: Group[] = [
  {
    label: "Collaborate",
    headline: "Feels like being in the same room.",
    accent: "text-indigo-600 dark:text-indigo-400",
    chip: "bg-indigo-50 border-indigo-200 dark:bg-indigo-900/20 dark:border-indigo-900/50",
    items: [
      { icon: MousePointer2, title: "Live cursors & follow", description: "See everyone's cursor, or follow someone's view across the board." },
      { icon: MessagesSquare, title: "Cursor chat & reactions", description: "Press / to type beside your cursor. Float an emoji over any idea." },
      { icon: Mic, title: "Voice chat", description: "Peer-to-peer audio right on the canvas. Never recorded, never stored." },
      { icon: Timer, title: "Shared timer", description: "One countdown for the whole room — with a chime when time's up." },
    ],
  },
  {
    label: "Create with AI",
    headline: "Start from a prompt, a photo or a scribble.",
    accent: "text-emerald-600 dark:text-emerald-400",
    chip: "bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-900/50",
    items: [
      { icon: Wand2, title: "Edit with AI", description: "Select shapes, say what should change. One undo brings it back." },
      { icon: ImagePlus, title: "Photo → shapes", description: "Snap a whiteboard or screenshot; get editable boxes, arrows and labels." },
      { icon: PenTool, title: "Sketch clean-up", description: "Rough rectangles, circles and lines snap to crisp shapes and bound arrows." },
      { icon: GitBranch, title: "Mermaid in & out", description: "Paste a flowchart to draw it, or copy your board back out as code." },
    ],
  },
  {
    label: "Organise & present",
    headline: "From messy board to clear story.",
    accent: "text-amber-600 dark:text-amber-400",
    chip: "bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-900/50",
    items: [
      { icon: LayoutTemplate, title: "Templates & sticky notes", description: "Kanban, retro, SWOT, mind map, journey map — ready in one click." },
      { icon: AlignHorizontalDistributeCenter, title: "Tidy layout & align", description: "Auto-arrange connected shapes; align and distribute with labels attached." },
      { icon: Presentation, title: "Slides", description: "Save views as slides and present them — everyone follows along live." },
      { icon: Map, title: "Minimap", description: "Jump anywhere on a huge board with a click." },
    ],
  },
  {
    label: "Share & control",
    headline: "The right access for every person.",
    accent: "text-rose-600 dark:text-rose-400",
    chip: "bg-rose-50 border-rose-200 dark:bg-rose-900/20 dark:border-rose-900/50",
    items: [
      { icon: ShieldCheck, title: "Editor & view-only roles", description: "Enforced on the server. Change or remove access any time." },
      { icon: Link2, title: "Public view links", description: "Share a read-only link that needs no sign-in. Rotate or revoke it instantly." },
      { icon: History, title: "Version history", description: "Scrub back through time and restore any version — everyone stays in sync." },
      { icon: Video, title: "Timelapse export", description: "Turn a board's whole history into a shareable video." },
    ],
  },
];

export function TeamFeaturesSection() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.08 });

  return (
    <section
      id="teams"
      ref={ref}
      className="relative overflow-hidden bg-white px-4 py-24 dark:bg-[#070b14] sm:px-6"
    >
      {/* Same structural grid as the AI section */}
      <div className="absolute inset-0 z-0 bg-[linear-gradient(rgba(0,0,0,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(0,0,0,0.03)_1px,transparent_1px)] bg-[size:32px_32px] dark:bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)]" />

      <div className="relative z-10 mx-auto max-w-6xl">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6 }}
          className="mb-16 text-center"
        >
          <div className="mb-6 inline-flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 shadow-sm dark:border-indigo-500/20 dark:bg-indigo-500/10">
            <Sparkles className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            <span className="text-[11px] font-bold uppercase tracking-widest text-indigo-900 dark:text-indigo-300">
              New &amp; improved
            </span>
          </div>
          <h2 className="mb-6 text-4xl font-black tracking-tight text-slate-900 dark:text-white md:text-5xl">
            One canvas. The whole team.
          </h2>
          <p className="mx-auto max-w-2xl text-lg font-medium text-slate-600 dark:text-slate-400">
            Talk, sketch, present and ship — without leaving the board.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          {groups.map((group, groupIndex) => (
            <motion.div
              key={group.label}
              initial={{ opacity: 0, y: 24 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: groupIndex * 0.12 }}
              className="rounded-2xl border border-slate-200 bg-white/80 p-6 shadow-sm backdrop-blur-sm dark:border-slate-800 dark:bg-[#101726]/80 sm:p-8"
            >
              <div className={`mb-1 text-[11px] font-bold uppercase tracking-widest ${group.accent}`}>
                {group.label}
              </div>
              <h3 className="mb-6 text-2xl font-black tracking-tight text-slate-900 dark:text-white">
                {group.headline}
              </h3>

              <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.title} className="group flex gap-3">
                      <span
                        className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border transition-transform group-hover:scale-110 ${group.chip}`}
                      >
                        <Icon className={`h-5 w-5 ${group.accent}`} />
                      </span>
                      <span>
                        <span className="block text-sm font-bold text-slate-900 dark:text-white">
                          {item.title}
                        </span>
                        <span className="mt-0.5 block text-sm font-medium leading-snug text-slate-600 dark:text-slate-400">
                          {item.description}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
