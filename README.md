# Flag Plot

A lightweight Cold War naval tactics game for the browser (US vs Soviet, roughly 1970–1990): a 2D tactical
map, a deterministic simulation in a Web Worker, a tutorial and three free scenarios. Built to run on a
2 GB Chromebook or a mid-range phone, and offline once it has loaded. "Flag Plot" is a working title.

**Play it: https://flag-plot.pages.dev/**

All unit and weapon numbers are simplified game values derived from the public pages in each entry's `src`
field. They are not real performance data.

## Play, build, test

| Command | What it does |
| --- | --- |
| `npm install` | Install the development tools (the game itself has no runtime dependencies) |
| `npm run dev` | Game with hot reload at http://localhost:5173 |
| `npm run build` | Production build into `dist/`: static files plus a service worker for offline play |
| `npm test` | Unit tests: simulation, combat, aircraft, AI, scenarios, data rules |
| `npm run e2e` | Browser checks: menu, keyboard-only play, save/load, AI-versus-AI at 64×, offline |
| `npm run perf` | Resource budget check in headless Chrome (JS heap, sim step time at 4× CPU throttle, bundle and data sizes) |
| `npm run data` | Rebuild `public/data/free.json` from `data-src/` |

`npm run e2e` and `npm run perf` drive Google Chrome; set `CHROME_PATH` if it is not at the default macOS path.

## How it is built

- `src/sim/` — the simulation, with no DOM access: `sim.ts` (struct-of-arrays state for 2,048 entities,
  movement, spatial grid, detection, orders, save and replay), `combat.ts`, `air.ts`, `ai.ts`; `types.ts` is
  the unit data schema.
- `src/worker.ts` runs the simulation in a Web Worker at a fixed 0.5 s step. `src/main.ts`, `src/render.ts`
  and `src/ui.ts` are the page: Canvas 2D map, unit card, menus, keyboard map.
- `src/scenarios.ts` — the scenarios. `data-src/` — researched free-tier unit data per side;
  `public/data/free.json` is what ships.
- `public/map/` — Natural Earth 1:50m land as TopoJSON, and one 8-bit sea-depth image.
- A save is the scenario id, a seed and the order log; loading replays it. The simulation uses no
  trigonometry, only `+ - * /` and square roots, so a replay is identical on every JavaScript engine.

## Unit packs

The game can unlock paid unit packs (`src/store.ts`, `src/config.ts`). The packs' data is **not** in this
repository and is never part of the build: it is delivered by a separate entitlement service to players who
own a pack, and kept in the browser's storage for offline play. Everything here works without it. A test
(`test/data.test.ts`) allows only a fixed list of tracked files and the exact free roster, so a stray file or
an extra unit fails the build.

## Hosting

The build is static. Any HTTPS static host works (HTTPS is needed for offline play).

Link previews and search: `index.html` carries the Open Graph tags, a canonical address and structured data;
`public/og.png` is the preview picture (`node scripts/og-image.mjs` redraws it), and `public/robots.txt`,
`public/sitemap.xml` and `public/google*.html` (Google Search Console's ownership check) are for search engines. These need absolute addresses, so the site's address is written
out in those three places: change it there if the game moves to another domain.

Build-time settings, all public (they ship to the browser): copy `.env.example` to `.env.production` and set
`VITE_API_BASE` (the entitlement service) and the three `VITE_CHECKOUT_*` links. Left unset, the store shows
the packs as not on sale and the rest of the game is unaffected.

### Deployment pipeline (Cloudflare Pages)

`.github/workflows/deploy.yml` runs the type check, the unit tests and a build on every push and pull
request. On pushes to `main` it also deploys `dist/` to Cloudflare Pages, once these are set in the
repository's GitHub settings:

- secrets `CLOUDFLARE_API_TOKEN` (a token with *Cloudflare Pages: Edit*) and `CLOUDFLARE_ACCOUNT_ID`;
- variable `CLOUDFLARE_PAGES_PROJECT` (the Pages project name; create it once with
  `npx wrangler pages project create <name>`);
- variables `VITE_API_BASE`, `VITE_CHECKOUT_US_LATE`, `VITE_CHECKOUT_USSR_LATE`, `VITE_CHECKOUT_FULL`.

Until `CLOUDFLARE_PAGES_PROJECT` is set, the deploy job is skipped.

## Credits

- Coastlines: made with [Natural Earth](https://www.naturalearthdata.com/) 1:50m land (public domain), via
  the `world-atlas` TopoJSON build.
- Sea depth: derived from the GEBCO_2021 Grid, GEBCO Compilation Group (2021),
  doi:10.5285/c6612cbe-50b3-0cff-e053-6c86abc09f8f. Built by `scripts/make-depth.mjs`. Not for navigation.

## Licence

No licence has been chosen yet. Until a `LICENSE` file is added, default copyright applies: the code can be
read here, but it is not licensed for reuse.
