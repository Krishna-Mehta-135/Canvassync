import Link from "next/link";
import { CanvasLogo } from "../CanvasLogo";

export function Footer() {
  return (
    <footer className="border-t border-rule px-5 py-10 sm:px-8">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
        <Link href="/" className="flex items-center gap-2.5 text-ink">
          <CanvasLogo className="h-6 w-6" />
          <span className="font-display text-[22px] leading-none">Canvas</span>
        </Link>
        <nav className="flex gap-6 text-[13px] text-ink-2">
          <Link href="/signin" className="hover:text-ink">Sign in</Link>
          <Link href="/signup" className="hover:text-ink">Sign up</Link>
          <a href="#assistant" className="hover:text-ink">The assistant</a>
        </nav>
        <p className="font-mono text-[11px] text-ink-3">© 2026 Canvas</p>
      </div>
    </footer>
  );
}
