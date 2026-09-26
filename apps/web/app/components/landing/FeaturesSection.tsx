"use client";

import { motion, useInView } from "motion/react";
import { useRef } from "react";
import { Layers, Users, Zap, Lock, Share2, Cpu } from "lucide-react";

const features = [
  {
    icon: Layers,
    title: "Structural Canvas",
    description:
      "Built for architecture. Not just drawing, but organizing complex systems logically.",
    color: "text-blue-600 dark:text-blue-400",
    bg: "bg-blue-50 dark:bg-blue-900/20",
    border: "border-blue-200 dark:border-blue-900/50",
  },
  {
    icon: Users,
    title: "Multiplayer Engine",
    description:
      "Low-latency WebSockets keep cursors, edits and voice in sync — follow a teammate or present to the whole room.",
    color: "text-indigo-600 dark:text-indigo-400",
    bg: "bg-indigo-50 dark:bg-indigo-900/20",
    border: "border-indigo-200 dark:border-indigo-900/50",
  },
  {
    icon: Cpu,
    title: "AI Co-pilot",
    description:
      "Generate diagrams from a prompt, edit a selection in place, summarize a board, or turn a photo into shapes.",
    color: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-50 dark:bg-emerald-900/20",
    border: "border-emerald-200 dark:border-emerald-900/50",
  },
  {
    icon: Zap,
    title: "Instant Persistence",
    description:
      "Durable queue-based persistence. Never lose a stroke, even on network drop.",
    color: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-50 dark:bg-amber-900/20",
    border: "border-amber-200 dark:border-amber-900/50",
  },
  {
    icon: Lock,
    title: "Enterprise Auth",
    description:
      "Invite-only rooms with editor and view-only roles, plus read-only public links you can revoke any time.",
    color: "text-rose-600 dark:text-rose-400",
    bg: "bg-rose-50 dark:bg-rose-900/20",
    border: "border-rose-200 dark:border-rose-900/50",
  },
  {
    icon: Share2,
    title: "Vector Export",
    description:
      "Export crisp SVG, PDF and PNG — or a timelapse video of how the board came together.",
    color: "text-purple-600 dark:text-purple-400",
    bg: "bg-purple-50 dark:bg-purple-900/20",
    border: "border-purple-200 dark:border-purple-900/50",
  },
];

export function FeaturesSection() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.1 });

  return (
    <section
      id="features"
      ref={ref}
      className="py-24 px-6 relative bg-slate-50/50 dark:bg-[#0a0f1a]"
    >
      <div className="max-w-6xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6 }}
          className="mb-16 md:flex md:items-end md:justify-between"
        >
          <div className="max-w-2xl">
            <h2 className="text-4xl md:text-5xl font-black text-slate-900 dark:text-white mb-6 tracking-tight">
              Tools that don&apos;t get in the way.
            </h2>
            <p className="text-lg font-medium text-slate-600 dark:text-slate-400">
              We stripped away the clutter. What&apos;s left is a fast, reliable
              engine for visual thought.
            </p>
          </div>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, index) => (
            <FeatureCard
              key={feature.title}
              feature={feature}
              index={index}
              isInView={isInView}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureCard({
  feature,
  index,
  isInView,
}: {
  feature: (typeof features)[0];
  index: number;
  isInView: boolean;
}) {
  const Icon = feature.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, delay: index * 0.1 }}
      whileHover={{ y: -5 }}
      className="group"
    >
      <div className="h-full bg-white dark:bg-[#101726] border border-slate-200 dark:border-slate-800 rounded-xl p-8 transition-shadow hover:shadow-xl hover:shadow-slate-200/50 dark:hover:shadow-black/50">
        <div
          className={`inline-flex p-3 rounded-lg border ${feature.bg} ${feature.border} mb-6 transition-transform group-hover:scale-110`}
        >
          <Icon className={`w-6 h-6 ${feature.color}`} />
        </div>

        <h3 className="text-xl font-bold mb-3 text-slate-900 dark:text-white">
          {feature.title}
        </h3>
        <p className="text-slate-600 dark:text-slate-400 font-medium leading-relaxed">
          {feature.description}
        </p>
      </div>
    </motion.div>
  );
}
