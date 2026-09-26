"use client";

import { motion, AnimatePresence } from "motion/react";
import { useState, useEffect } from "react";
import { Menu, X, Sun, Moon } from "lucide-react";
import { useTheme } from "../ThemeProvider";
import Link from "next/link";
import { CanvasLogo } from "../CanvasLogo";

export function LogoIcon() {
  return <CanvasLogo className="w-10 h-10" />;
}

export function Navbar() {
  const { theme, toggleTheme } = useTheme();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <motion.header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-white/90 dark:bg-[#0a0f1a]/90 backdrop-blur-xl border-b border-slate-200 dark:border-slate-800/80 shadow-sm"
          : "bg-transparent"
      }`}
      initial={{ y: -80, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
    >
      <nav className="mx-auto flex h-20 max-w-7xl items-center justify-between gap-4 px-4 sm:h-24 sm:px-6">
        {/* Left: Logo */}
        <div className="shrink-0">
          <motion.div
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="inline-block"
          >
            <Link href="/" className="flex items-center gap-3">
              <LogoIcon />
              <span className="text-[26px] font-black tracking-tighter text-slate-900 dark:text-white sm:text-[32px]">
                Canvas.
              </span>
            </Link>
          </motion.div>
        </div>

        {/* Center: Desktop Nav */}
        <div className="hidden md:flex items-center justify-center gap-2 bg-slate-100/50 dark:bg-slate-800/30 border border-slate-200/60 dark:border-slate-700/50 backdrop-blur-md rounded-full px-3 py-2 shadow-sm">
          {[
            { label: "How it works", href: "#how-it-works" },
            { label: "Features", href: "#features" },
            { label: "Teams", href: "#teams" },
            { label: "Try it out", href: "#demo" },
          ].map((item) => (
            <a
              key={item.label}
              href={item.href}
              onClick={(e) => {
                e.preventDefault();
                document
                  .querySelector(item.href)
                  ?.scrollIntoView({ behavior: "smooth" });
              }}
              className="px-4 py-2.5 text-[15px] font-bold text-slate-600 lg:px-6 lg:text-[16px] dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-white dark:hover:bg-slate-700/50 rounded-full transition-all"
            >
              {item.label}
            </a>
          ))}
        </div>

        {/* Right: Actions */}
        <div className="shrink-0 flex items-center justify-end gap-3 h-full">
          {/* Theme toggle */}
          <motion.button
            onClick={toggleTheme}
            className="p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            aria-label="Toggle theme"
          >
            <AnimatePresence mode="wait">
              {theme === "dark" ? (
                <motion.div
                  key="moon"
                  initial={{ opacity: 0, rotate: -90, scale: 0.5 }}
                  animate={{ opacity: 1, rotate: 0, scale: 1 }}
                  exit={{ opacity: 0, rotate: 90, scale: 0.5 }}
                  transition={{ duration: 0.2 }}
                >
                  <Moon className="w-4 h-4" />
                </motion.div>
              ) : (
                <motion.div
                  key="sun"
                  initial={{ opacity: 0, rotate: 90, scale: 0.5 }}
                  animate={{ opacity: 1, rotate: 0, scale: 1 }}
                  exit={{ opacity: 0, rotate: -90, scale: 0.5 }}
                  transition={{ duration: 0.2 }}
                >
                  <Sun className="w-4 h-4" />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.button>

          {/* Sign In */}
          <motion.div
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="hidden md:flex items-center"
          >
            <Link
              href="/signin"
              className="px-4 py-2.5 text-sm font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors whitespace-nowrap"
            >
              Sign In
            </Link>
          </motion.div>

          {/* Get Started */}
          <motion.div
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="hidden md:flex items-center"
          >
            <Link
              href="/signup"
              className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-xl shadow-md shadow-indigo-500/20 transition-colors whitespace-nowrap"
            >
              Sign Up
            </Link>
          </motion.div>

          {/* Mobile hamburger */}
          <motion.button
            className="rounded-xl border border-slate-200 p-2 text-slate-700 dark:border-slate-800 dark:text-slate-300 md:hidden"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            whileTap={{ scale: 0.9 }}
          >
            {isMenuOpen ? (
              <X className="w-5 h-5" />
            ) : (
              <Menu className="w-5 h-5" />
            )}
          </motion.button>
        </div>
      </nav>

      {/* Mobile menu */}
      <AnimatePresence>
        {isMenuOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="md:hidden overflow-hidden bg-white/95 dark:bg-[#0a0f1a]/95 backdrop-blur-xl border-t border-slate-200 dark:border-slate-800"
          >
            <div className="px-6 py-6 flex flex-col gap-6">
              {[
                { label: "How it works", href: "#how-it-works" },
                { label: "Features", href: "#features" },
                { label: "Teams", href: "#teams" },
                { label: "Try it out", href: "#demo" },
              ].map((item) => (
                <a
                  key={item.label}
                  href={item.href}
                  onClick={(e) => {
                    e.preventDefault();
                    setIsMenuOpen(false);
                    document
                      .querySelector(item.href)
                      ?.scrollIntoView({ behavior: "smooth" });
                  }}
                  className="text-slate-700 dark:text-slate-300 font-bold text-lg"
                >
                  {item.label}
                </a>
              ))}
              <div className="border-t border-slate-200 dark:border-slate-800 pt-6 flex flex-col gap-4">
                <Link
                  href="/signin"
                  className="text-center py-3 border-2 border-slate-200 dark:border-slate-800 rounded-xl text-slate-800 dark:text-white font-bold"
                >
                  Sign In
                </Link>
                <Link
                  href="/signup"
                  className="text-center py-3 bg-indigo-600 text-white rounded-xl font-bold"
                >
                  Sign Up Free
                </Link>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.header>
  );
}
