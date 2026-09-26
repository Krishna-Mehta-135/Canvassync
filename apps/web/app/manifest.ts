import type { MetadataRoute } from "next";

// Makes Canvas.io installable ("Add to Home Screen" / "Install app") so tablets
// and desktops can open boards in their own window.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Canvas.io",
    short_name: "Canvas.io",
    description: "Realtime collaborative whiteboard with AI diagramming.",
    start_url: "/rooms",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0b1020",
    theme_color: "#0b1020",
    categories: ["productivity", "collaboration"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
