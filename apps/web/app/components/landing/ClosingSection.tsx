import Link from "next/link";

export function ClosingSection() {
  return (
    <section className="bg-ink px-5 py-24 text-paper sm:px-8">
      <div className="mx-auto flex max-w-6xl flex-col items-start gap-10 md:flex-row md:items-end md:justify-between">
        <h2 className="max-w-2xl font-display text-[clamp(2.2rem,6vw,4.4rem)] leading-[0.98] tracking-tight">
          Open a canvas. Invite someone. <em className="italic text-[var(--signal)]">Ask it something.</em>
        </h2>
        <Link
          href="/signup"
          className="shrink-0 rounded-[8px] bg-paper px-6 py-3.5 text-[15px] font-medium text-ink shadow-[4px_4px_0_var(--signal)] transition active:translate-x-px active:translate-y-px active:shadow-[3px_3px_0_var(--signal)]"
        >
          Start drawing, it&apos;s free
        </Link>
      </div>
    </section>
  );
}
