import type { MetadataRoute } from "next";

/** PWA manifest — install Apps Холодосов on a phone as a standalone app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Apps Холодосов",
    short_name: "Холодосы",
    description: "Что, откуда и куда перенести между холодильниками",
    start_url: "/m",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b0c0e",
    theme_color: "#0b0c0e",
    lang: "ru",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Задачи", url: "/m/tasks" },
      { name: "Холодильники", url: "/m/fridges" },
    ],
  };
}
