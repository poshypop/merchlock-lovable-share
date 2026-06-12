// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// On Vercel, force the nitro deploy build with the `vercel` preset and emit the
// Build Output API layout (.vercel/output) that Vercel auto-detects. Without this,
// the Lovable config skips nitro entirely outside a Lovable context, producing a
// Vite-only build with no server function or static entry — so Vercel serves a 404.
// The explicit output paths mirror the vercel preset's own layout, since the
// Lovable wrapper otherwise forces output into `dist/` (which Vercel won't detect).
// Off Vercel (Lovable sandbox / local), this stays absent so defaults are untouched.
const vercelNitro = process.env.VERCEL
  ? {
      nitro: {
        preset: "vercel",
        output: {
          dir: ".vercel/output",
          serverDir: ".vercel/output/functions/__server.func",
          publicDir: ".vercel/output/static",
        },
      },
    }
  : {};

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  ...vercelNitro,
});
