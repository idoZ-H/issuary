// Static assets for /admin/*. Currently only app.css — htmx and the font
// are loaded from CDN with SRI / browser caching.

import { APP_CSS } from "./assets";

const IMMUTABLE_HEADERS = {
  "cache-control": "public, max-age=31536000, immutable",
};

export function handleStatic(path: string): Response | null {
  switch (path) {
    case "/admin/static/app.css":
      return new Response(APP_CSS, {
        headers: {
          "content-type": "text/css; charset=utf-8",
          ...IMMUTABLE_HEADERS,
        },
      });
    default:
      return null;
  }
}
