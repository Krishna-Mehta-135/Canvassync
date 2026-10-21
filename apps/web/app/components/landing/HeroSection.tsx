import Link from "next/link";
import { ProductFrame } from "./ProductFrame";

export function HeroSection() {
  return (
    <section className="relative px-5 pb-20 pt-32 sm:px-8 sm:pt-40">
      <div className="mx-auto max-w-6xl">
        <p className="mb-6 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-3">
          Realtime whiteboard · Assistant that reads your files
        </p>
        <h1 className="max-w-4xl font-display text-[clamp(2.9rem,8vw,6.4rem)] leading-[0.95] tracking-[-0.02em] text-ink">
          The whiteboard that has{" "}
          <em className="italic text-signal">read</em> your documents.
        </h1>
        <p className="mt-8 max-w-xl text-[17px] leading-[1.55] text-ink-2">
          Draw with your team in real time. Drop in a PDF, a spec or a spreadsheet, then ask
          questions or say what to draw. Answers point at their source, and diagrams come out
          lined up.
        </p>
        <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-4">
          <Link
            href="/signup"
            className="rounded-[8px] bg-ink px-6 py-3.5 text-[15px] font-medium text-paper shadow-[4px_4px_0_var(--signal)] transition active:translate-x-px active:translate-y-px active:shadow-[3px_3px_0_var(--signal)]"
          >
            Start drawing, it&apos;s free
          </Link>
          <a href="#room" className="text-[15px] text-ink underline decoration-rule-strong underline-offset-[5px] transition hover:decoration-ink">
            See what&apos;s inside
          </a>
        </div>
        <p className="mt-5 font-mono text-[11.5px] text-ink-3">
          Runs in the browser. No install. Invite people with a link.
        </p>

        <div className="mt-16 sm:mt-20">
          <ProductFrame />
        </div>
      </div>
    </section>
  );
}
