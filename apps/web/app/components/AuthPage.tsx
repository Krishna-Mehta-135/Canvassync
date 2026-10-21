"use client";

/* File intent: Landing-style sign-in and sign-up surface for Canvas access. */

import { useState, FormEvent, useEffect } from "react";
import { AxiosError } from "axios";
import { Eye, EyeOff, Github, Loader2 } from "lucide-react";

const GoogleIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    <path d="M1 1h22v22H1z" fill="none"/>
  </svg>
);
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { HTTP_BACKEND } from "../../config";
import { apiClient } from "../lib/apiClient";
import { useTheme } from "./ThemeProvider";
import { CanvasLogo } from "./CanvasLogo";

const API_BASE = HTTP_BACKEND;

interface AuthPageProps {
  isSignIn: boolean;
}

export function AuthPage({ isSignIn }: AuthPageProps) {
  const searchParams = useSearchParams();
  const { theme, toggleTheme } = useTheme();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const handleOAuthSignIn = (provider: "github" | "google") => {
    const redirectTarget = searchParams.get("redirect") || "/rooms";
    window.location.href = `${API_BASE}/auth/${provider}?redirect=${encodeURIComponent(redirectTarget)}`;
  };

  // Map backend OAuth error slugs to human-readable messages.
  const OAUTH_ERROR_MAP: Record<string, string> = {
    oauth_not_configured: "Social sign-in is not yet configured.",
    oauth_denied: "Sign-in was cancelled.",
    oauth_token_exchange_failed: "Could not verify your account. Please retry.",
    oauth_no_email: "Your account has no public email. Please use email sign-in.",
    oauth_email_not_verified:
      "Your Google email is not verified. Please verify it first.",
    oauth_server_error: "Something went wrong. Please try again.",
  };

  useEffect(() => {
    const errorSlug = searchParams.get("error");
    if (errorSlug) {
      setError(
        OAUTH_ERROR_MAP[errorSlug] ??
          "Sign-in failed. Please try again.",
      );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let isUnmounted = false;
    const checkExistingSession = async () => {
      try {
        await apiClient.get(`${API_BASE}/auth/current-user`);
        if (isUnmounted) return;
        const redirectTarget = searchParams.get("redirect");
        window.location.href =
          redirectTarget && redirectTarget.length > 0
            ? redirectTarget
            : "/rooms";
      } catch {
        if (!isUnmounted) setCheckingSession(false);
      }
    };
    void checkExistingSession();
    return () => {
      isUnmounted = true;
    };
  }, [searchParams]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const endpoint = isSignIn
        ? `${API_BASE}/auth/signin`
        : `${API_BASE}/auth/signup`;
      const payload = isSignIn
        ? { email, password }
        : { name, email, password };
      await apiClient.post(endpoint, payload);
      const redirectTarget = searchParams.get("redirect");
      if (redirectTarget) {
        window.location.href = redirectTarget;
        return;
      }
      window.location.href = "/rooms";
    } catch (err) {
      const axiosError = err as AxiosError<{ message: string }>;
      const message =
        axiosError.response?.data?.message ||
        (isSignIn
          ? "Invalid email or password."
          : "Something went wrong. Please try again.");
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  if (checkingSession) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper text-ink-3">
        <div className="flex items-center gap-2.5 font-mono text-[12px]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Checking session…
        </div>
      </div>
    );
  }

  const field =
    "block w-full rounded-[7px] border border-rule-strong bg-surface px-3.5 py-3 text-[15px] text-ink outline-none transition placeholder:text-ink-3 focus:border-ink";
  const oauthBtn =
    "flex w-full items-center justify-center gap-2.5 rounded-[7px] border border-rule-strong bg-surface px-4 py-3 text-[14px] font-medium text-ink transition hover:bg-paper-2";

  return (
    <div className="grid min-h-screen bg-paper text-ink lg:grid-cols-[1fr_1.05fr]" style={{ fontFamily: "var(--font-ui)" }}>
      {/* Left: the pitch, on ink */}
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-ink p-12 text-paper lg:flex">
        <Link href="/" className="flex items-center gap-2.5">
          <CanvasLogo className="h-7 w-7" />
          <span className="font-display text-[26px] leading-none">Canvas</span>
        </Link>
        <div>
          <p className="font-display text-[clamp(2.6rem,4.6vw,4.2rem)] leading-[0.98] tracking-tight">
            {isSignIn ? (
              <>
                Pick up where the <em className="italic text-[var(--signal)]">board</em> left off.
              </>
            ) : (
              <>
                A blank board, a few files, and <em className="italic text-[var(--signal)]">someone to ask.</em>
              </>
            )}
          </p>
          <p className="mt-6 max-w-sm text-[15px] leading-relaxed text-paper/65">
            Realtime drawing with your team, and an assistant that answers from the documents you
            give it.
          </p>
        </div>
        <p className="font-mono text-[11px] text-paper/40">© 2026 Canvas</p>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage: "radial-gradient(var(--paper) 1.2px, transparent 1.3px)",
            backgroundSize: "24px 24px",
          }}
        />
      </aside>

      {/* Right: the form */}
      <main className="flex flex-col px-5 py-6 sm:px-10">
        <div className="flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 lg:invisible">
            <CanvasLogo className="h-6 w-6" />
            <span className="font-display text-[22px] leading-none">Canvas</span>
          </Link>
          <div className="flex items-center gap-4 text-[13.5px]">
            <span className="text-ink-3">{isSignIn ? "New here?" : "Already have an account?"}</span>
            <Link
              href={isSignIn ? "/signup" : "/signin"}
              className="font-medium text-ink underline decoration-rule-strong underline-offset-[5px] hover:decoration-ink"
            >
              {isSignIn ? "Create an account" : "Sign in"}
            </Link>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle theme"
              className="grid h-8 w-8 place-items-center rounded-[6px] text-ink-3 transition hover:bg-paper-2 hover:text-ink"
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
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
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-[26rem] flex-1 flex-col justify-center py-10">
          <h1 className="font-display text-[44px] leading-none tracking-tight">
            {isSignIn ? "Welcome back" : "Make an account"}
          </h1>
          <p className="mt-3 text-[14.5px] text-ink-2">
            {isSignIn ? "Sign in to open your canvases." : "It takes a minute. No card needed."}
          </p>

          <div className="mt-8 space-y-2.5">
            <button type="button" onClick={() => handleOAuthSignIn("github")} className={oauthBtn}>
              <Github className="h-[18px] w-[18px]" />
              Continue with GitHub
            </button>
            <button type="button" onClick={() => handleOAuthSignIn("google")} className={oauthBtn}>
              <GoogleIcon className="h-[18px] w-[18px]" />
              Continue with Google
            </button>
          </div>

          <div className="my-6 flex items-center gap-4 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-3">
            <span className="h-px flex-1 bg-rule" />
            or with email
            <span className="h-px flex-1 bg-rule" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4" noValidate={false}>
            {!isSignIn && (
              <label className="block">
                <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">Name</span>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Doe"
                  autoComplete="name"
                  className={field}
                />
              </label>
            )}
            <label className="block">
              <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">Email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@example.com"
                autoComplete="email"
                className={field}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 flex items-baseline justify-between text-[12.5px] font-medium text-ink-2">
                Password
                {isSignIn && (
                  <Link href="/forgot-password" className="font-normal text-ink-3 underline underline-offset-4 hover:text-ink">
                    Forgot it?
                  </Link>
                )}
              </span>
              <span className="relative block">
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={isSignIn ? "Your password" : "At least 8 characters"}
                  autoComplete={isSignIn ? "current-password" : "new-password"}
                  minLength={isSignIn ? undefined : 8}
                  className={`${field} pr-11`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-[5px] text-ink-3 hover:text-ink"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </span>
            </label>

            {error && (
              <p role="alert" className="rounded-[6px] border border-signal/40 bg-signal-soft px-3 py-2 text-[13px] text-signal">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-[8px] bg-ink px-4 py-3.5 text-[15px] font-medium text-paper shadow-[4px_4px_0_var(--signal)] transition active:translate-x-px active:translate-y-px active:shadow-[3px_3px_0_var(--signal)] disabled:opacity-60"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {isSignIn ? "Sign in" : "Create account"}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
