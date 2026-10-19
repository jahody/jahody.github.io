# CLAUDE.md

Astro 7 site (Node >= 22.12) that showcases a hand-picked selection of the projects in `C:\adam\projects`; which ones appear is the user's call, so don't add or drop entries unasked. Deployed to GitHub Pages by `.github/workflows/deploy.yml` on push to `main`. No test or lint tooling.

Architecture:
- `src/data/projects.ts` is the **single source of truth** for the showcase. Each `Project` has `slug`, `title`, `tagline`, `category` and `stats` (labels around its figure), `tags`, `status` (`'live'` = has a hosted `demo`, `'showcase'` = description only), optional `demo`/`repo`, optional `paper` (`{ title, venue }`: a "Paper" badge plus a citation on its page), `summary[]`, `highlights[]`. Adding a project to the site means adding an entry here.
- `src/components/Figure.astro` draws each project's monochrome dot/line SVG figure, keyed by `slug`. A new project needs its own case there; otherwise it falls back to a contribution-style dot grid.
- `public/apps/<name>/` holds self-contained static apps served as-is at `/apps/<name>/` (currently `cycle`, the CycleSync PWA). A `live` project's `demo` points here.
- `dist/` and `.astro/` are build output; don't edit.

When a sibling project changes meaningfully, keep its `projects.ts` entry consistent with that project's README/CLAUDE.md (the highlights are drawn from them).
