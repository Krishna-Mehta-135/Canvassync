"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTheme } from "../ThemeProvider";
import { CanvasLogo } from "../CanvasLogo";

const LINKS = [
  { label: "What's in the room", href: "#room" },
  { label: "The assistant", href: "#assistant" },
  { label: "Everything else", href: "#details" },
];

export function Navbar() {
  const { theme, toggleTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 border-b transition-colors ${
        scrolled || open ? "border-rule bg-paper/92 backdrop-blur-md" : "border-transparent"
      }`}
    >
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5 text-ink">
          <CanvasLogo className="h-7 w-7" />
          <span className="font-display text-[26px] leading-none tracking-tight">Canvas</span>
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-[13.5px] text-ink-2 underline-offset-4 transition hover:text-ink hover:underline"
            >
              {link.label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light paper" : "Switch to dark paper"}
            title={theme === "dark" ? "Light paper" : "Dark paper"}
            className="grid h-9 w-9 place-items-center rounded-[7px] text-ink-2 transition hover:bg-paper-2 hover:text-ink"
          >
            <svg viewBox="0 0 20 20" className="h-[17px] w-[17px]" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              {theme === "dark" ? (
                <>
                  <circle cx="10" cy="10" r="3.4" />
                  <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
                </>
              ) : (
                <path d="M16 11.5A6.5 6.5 0 018.5 4a6.5 6.5 0 107.5 7.5z" />
              )}
            </svg>
          </button>
          <Link href="/signin" className="hidden px-3 text-[13.5px] text-ink-2 transition hover:text-ink sm:block">
            Sign in
          </Link>
          <Link
            href="/signup"
            className="rounded-[7px] bg-ink px-3.5 py-2 text-[13px] font-medium text-paper transition hover:bg-signal"
          >
            Start drawing
          </Link>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label="Menu"
            aria-expanded={open}
            className="grid h-9 w-9 place-items-center rounded-[7px] text-ink md:hidden"
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              {open ? <path d="M5 5l10 10M15 5L5 15" /> : <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />}
            </svg>
          </button>
        </div>
      </nav>
      {open && (
        <div className="border-t border-rule px-5 pb-4 pt-2 md:hidden">
          {[...LINKS, { label: "Sign in", href: "/signin" }].map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="block border-b border-rule py-3 text-[15px] text-ink last:border-0"
            >
              {link.label}
            </a>
          ))}
        </div>
      )}
    </header>
  );
}
