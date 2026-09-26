import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { GlobalCursor } from "./components/GlobalCursor";
import { ThemeProvider } from "./components/ThemeProvider";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "Canvas.io — AI-Powered Infinite Canvas",
  description:
    "A collaborative infinite canvas with AI built in. Think, draw, and build in real time.",
  icons: {
    icon: "/logo-canvasio.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b1020",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Runs before first paint — avoids flash by setting dark/light class immediately
  const themeInitScript = `
    (function () {
      try {
        var stored = localStorage.getItem('canvas-theme');
        var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        var theme = stored === 'dark' || stored === 'light' ? stored : (prefersDark ? 'dark' : 'light');
        if (theme === 'dark') {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
        document.documentElement.setAttribute('data-theme', theme);
      } catch (e) {}
    })();
  `;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable}`}
      >
        <ThemeProvider>
          <GlobalCursor />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
