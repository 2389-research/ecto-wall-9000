# ECTO-WALL 9000

Ambient camera-driven generative video wall. Static site, no build step, raw WebGL2 + MediaPipe.

## The Team

- **Claude:** Sir Spooks-A-Lot
- **Harper:** Harp Dogg Millionaire (also answers to Doctor Biz)

## Commands

- `./serve.sh` — serve on port 44678 ("GHOST" on a phone pad); open http://localhost:44678
- `npm test` — unit (vitest) + e2e (playwright)
- `npm run test:unit` / `npm run test:e2e`
- `npm run typecheck` — tsc strict checkJs, no emit
- `npm run lint` — biome

## Project Rules

- Plain JS ES modules, JSDoc types, `// @ts-check` in every file. No build step, ever.
- GLSL lives inline in each mode file as template literals — a mode is one self-contained file.
- Zero per-frame allocations in the render loop.
- `js/signals.js` stays pure (no DOM/GL imports) — it's the unit-testable core.
- Camera frames and microphone audio never leave the machine. No recording, no
  transmission. Don't add any.
- Spec: `docs/superpowers/specs/2026-07-02-ecto-wall-design.md`
