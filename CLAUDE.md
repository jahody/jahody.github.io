# CLAUDE.md

Astro 7 site (Node >= 22.12) that showcases a hand-picked selection of the projects in `C:\adam\projects`; which ones appear is the user's call, so don't add or drop entries unasked. Deployed to GitHub Pages by `.github/workflows/deploy.yml` on push to `main`. No test or lint tooling.

Architecture:
- `src/data/projects.ts` is the **single source of truth** for the showcase. Each `Project` has `slug`, `title`, `tagline`, `category` and `stats` (labels around its figure), `tags`, `status` (`'live'` = has a hosted `demo`, `'showcase'` = description only), optional `demo`/`repo`, optional `paper` (`{ title, venue }`: a "Paper" badge plus a citation on its page), `summary[]`, `highlights[]`. Adding a project to the site means adding an entry here.
- `src/components/Figure.astro` draws each project's monochrome dot/line SVG figure, keyed by `slug`. A new project needs its own case there; otherwise it falls back to a contribution-style dot grid.
- `public/apps/<name>/` holds self-contained static apps served as-is at `/apps/<name>/` (currently `cycle`, the CycleSync PWA, and `agentswarm`, a bring-your-own-keys port of the agentSwarm router). A `live` project's `demo` points here.
- `public/apps/agentswarm/` is plain ES modules, no build: `providers.js` mirrors `agentswarm/scripts/providers.yaml` (only the providers that send CORS headers) and `bank.js` ports `bank.py`'s scoring and failover. Update them when the Python side changes.
- `/surveymaster/` (`src/pages/surveymaster.astro`) is a browser port of the whole SurveyMaster pipeline, the site's one Preact island (`@astrojs/preact`). `src/surveymaster/*.ts` is the engine, one module per Python stage of `survey6-classification` with prompts copied verbatim; `src/components/surveymaster/` is the UI. LLM calls go from the browser to OpenRouter with the visitor's own key; paper search uses OpenAlex. When the Python prompts, voting or metrics change, port the change here. `public/surveymaster/demo/` holds finished runs exported by `survey6-classification/export_web.py`; rerun it to refresh them.
- Every page uses one content column: 1072px with 24px gutters (16px on phones), set by `main` in `src/layouts/Base.astro`. The static apps in `public/apps/` match it by hand (including `scrollbar-gutter: stable`), so a new app should too.
- `dist/` and `.astro/` are build output; don't edit.

When a sibling project changes meaningfully, keep its `projects.ts` entry consistent with that project's README/CLAUDE.md (the highlights are drawn from them).
