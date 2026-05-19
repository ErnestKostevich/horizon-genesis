# Ultrareview — 2026-05-19

Honest design audit of three surfaces (Electron app, CLI/TUI,
marketplace site) commissioned by Ernest before the upcoming redesign
sprint. All findings come from agent-driven source-code analysis +
comparison against modern reference points (ChatGPT, Claude Desktop,
Cursor, Linear, Vercel, anthropic.com, gum / charm.sh, Hermes Agent
TUI). Sections are independently scored 1–10 against best-in-class.

## TL;DR — three sentences

1. **Functionality is at parity with Hermes Agent** — we ship the
   features; the surface area is comparable; tests pass.
2. **Visual polish lags 1-2 years behind the reference apps** —
   Settings is the worst offender on desktop; CLI lacks 24-bit
   gradients and interactive autocomplete popup; site has no scroll-
   triggered animations or skeleton loaders.
3. **No single fix is hard** — most issues are 4-hour CSS/animation
   tweaks. The total redesign sprint is ~2 weeks of focused work.

## Surface 1 — Electron desktop app

### Per-category scoring

| Category | Score | Note |
|---|---|---|
| Cohesive colour palette | 7/10 | Monochrome-heavy, accent colours timid |
| Typography (Plus Jakarta Sans + JetBrains Mono) | 8/10 | Good choice, scale exists, legacy inline px lingers |
| Spacing / breathing room | 6/10 | Settings cramped, ad-hoc margins (`margin-top: 6/10/14`) |
| Animations / micro-interactions | 7/10 | Solid baseline, no input-focus polish, no skeletons |
| Glassmorphism / blur | 9/10 | Excellent — apex-theme.css has it everywhere |
| Buttons | 7/10 | Three-tier `.btn` system good; legacy `.psv` / `.mt` not migrated |
| Composer (input area) | 6/10 | Functional but uninspired vs Claude Desktop's placeholder transitions |
| Sidebar / chat list | 5/10 | Skeleton list, no hover, no favourite stars |
| Settings UI | 5/10 | Accordion + cards + tabs mixed inconsistently |
| Icons (Lucide SVG) | 9/10 | Mostly excellent; emoji still in Settings labels |
| Dark-mode polish | 8/10 | Single theme, professional but flat |
| Loading / skeleton states | 2/10 | **Almost nothing.** Typing indicator only. |
| Toast notifications | 3/10 | Don't exist. |
| Modal entrance animation | 7/10 | Backdrop blur ✓, no fade-in/scale |
| Inspector panel | 7/10 | Well-integrated, tabs still cramped |
| Sound design | 0/10 | None. Wake word is a setting, not a feedback layer. |

### Top-10 priorities (in implementation order)

1. **Skeleton loading states** (Low effort, High UX impact) — pulse
   animation while messages arrive, file uploads, embedding backfill.
2. **Composer input polish** (Medium effort) — placeholder fade on
   focus, expand-on-multiline, send-button breathing on hover.
3. **Toast notifications** (Medium) — `.toast-container` with stacking,
   slide-in/fade-out animations. Used for save confirmations, errors.
4. **Settings UI redesign** (High effort) — replace accordion mess
   with consistent card grid; unify form styling.
5. **Sidebar hover effects** (Low) — subtle bg tint, favourite star
   on hover.
6. **Button contrast** (Trivial) — `rgba(255,255,255,.03)` → `.06`
   for WCAG AA.
7. **Animated gradient background** (Low-Medium) — replace static
   `#fractalBg` with CSS hue-rotation animation.
8. **Input focus rings** (Trivial) — all `.inp/.pi/.sel` need visible
   focus ring (outline + shadow).
9. **Modal entrance animation** (Trivial) — 200ms fade-in + scale-up
   on `.panel.show`.
10. **Legacy CSS migration** (High effort, low immediate impact) —
    `.psv` / `.sc-btn` / `.mt` → `.btn` with modifiers. Eliminates
    double-CSS battles.

### Critical files

```
src/renderer/pages/chat-base.css         core styles
src/renderer/pages/chat-shell-polish.css glassmorphism + chip overrides
src/renderer/pages/apex-theme.css        gradient + radial accent layer
src/renderer/pages/chat-cursor-v3.css    composer dock layout (V3)
src/renderer/pages/chat.html             4900+ lines, Settings ~434+
```

## Surface 2 — Terminal CLI / TUI

### Per-category scoring

| Category | Score | Note |
|---|---|---|
| ASCII banner | 8/10 | Gradient exists, uses 256-color (not 24-bit) |
| Spinner / loaders | 7/10 | GradientSpinner solid; underused outside agent mode |
| Truecolor support | 5/10 | No `COLORTERM=truecolor` detection — palette only |
| Box drawing / code-block borders | 6/10 | Monochrome `┌──┐` instead of language-coloured |
| Tab autocomplete UX | 5/10 | Functional but non-interactive list, no inline preview |
| Progress bars | 6/10 | Solid `█` blocks, no gradient fill or smooth ends |
| Tables | 7/10 | Aligned, padded reasonably |
| Markdown rendering | 8/10 | Headings/lists/code fences OK, no syntax highlighting in fences |
| Status banners (✓/✗/⚠) | 5/10 | Static — no pulse on success, no shake on error |
| Mouse hover effects | 4/10 | Mouse exists, no hover state |
| Type-writer / streaming | 8/10 | Works, no over-the-top polish |
| Welcome screen | 4/10 | Setup wizard exists but no "wow" first-launch reveal |
| Help screen | 6/10 | Plain list, no table, no example column |
| Sound bell | 0/10 | None — `\x07` only in timer command |

### Top-8 priorities

1. **24-bit truecolor gradients** — `process.env.COLORTERM ===
   'truecolor'` → switch to `\x1b[38;2;R;G;Bm`. Smoothest banner +
   spinner.
2. **Interactive autocomplete popup** — like gum: arrow nav,
   highlight match, inline dim preview of first hit.
3. **Coloured code-block borders** — Python = blue, JS = yellow, SQL
   = cyan. Detect by fence language tag.
4. **Gradient progress bars** — replace solid `█` with cyan→green
   gradient + smooth end via `▓▒░`.
5. **Mouse hover highlight** — invert bg on the row under cursor in
   `/skill list` / `/persona-list` menus.
6. **Animated status banners** — pulse on ✓, subtle shake on ✗.
7. **Rich help screen** — table with `Command | Args | Description |
   Example` columns, colour-coded by category.
8. **Animated welcome screen** — first launch only, `typeOut()` the
   banner with persona/provider picker.

### Critical files

```
bin/lib/banner.js          ASCII banner, GradientSpinner (256-color)
bin/lib/markdown.js        markdown → ANSI rendering
bin/lib/tty.js             color helpers, supportsColor detection
bin/lib/tui-engine.js      keypress + mouse engine (TUI v2)
bin/horizon-tui.js         main TUI loop
```

## Surface 3 — Marketplace site (horizonaai.dev)

### Per-category scoring

| Category | Score | Note |
|---|---|---|
| Hero section | 7/10 | Glassmorphism + radial gradient, no video / lottie |
| Typography hierarchy | 8/10 | Outfit + Inter + JetBrains, good scale |
| Colour palette | 7/10 | Amber + cyan accents on dark surface — clean |
| Navigation (sticky + blur) | 8/10 | Modern, hover transitions present |
| Animations on scroll | 4/10 | **Missing.** Only fade-in-up on initial load |
| Hover effects on cards | 8/10 | Lift + glow + border colour — good |
| Footer | 7/10 | Structured 6-column, legal in second row |
| Pricing page | 7/10 | Two-tier card layout, status banner |
| Docs page | ? | Visible but structure not fully audited |
| Marketplace catalog | 7/10 | Grid + filters, no skeleton-loading |
| Plugin detail page | 5/10 | Too sparse — no screenshots, reviews, related |
| CTA buttons | 8/10 | Gradient + shadow-glow, modern |
| Dark-mode toggle | 0/10 | Hardcoded dark, no toggle |
| Responsive (mobile) | 8/10 | Grid-cols-1 sm:2 lg:3 + hamburger |
| Loading states (skeletons) | 3/10 | `animate-pulse` text only, no shadcn skeleton |
| Empty states (illustrations) | 3/10 | Bordered text block, no SVG/lottie |
| 404 page personality | 6/10 | Minimal but on-brand |
| SEO / meta / OG tags | 3/10 | No `react-helmet-async`, no dynamic og:image |
| Performance / code-split | 4/10 | All routes top-level imports, no `React.lazy` |

### Top-10 priorities

1. **Framer Motion + scroll-trigger animations** — `whileInView` on
   feature/howitworks sections; staggered children for cards.
2. **Dark-mode toggle** — `ThemeProvider` + Header button. Light theme
   isn't a small change but a single-property `data-theme` swap.
3. **Code-splitting via `React.lazy` + Suspense** — every route a
   separate chunk; cuts initial bundle ~60%.
4. **Skeleton loaders** — replace `animate-pulse` text with proper
   pulsing rectangles for plugin cards / pricing.
5. **Empty state illustrations** — SVG (Lucide composite) for "no
   results", "empty cart", "first plugin".
6. **Plugin detail richness** — screenshot carousel, reviews section,
   related plugins, installation snippet.
7. **`react-helmet-async` + dynamic og:image** — per-page SEO; OG
   image generator for plugin pages.
8. **Toast UI** — `@radix-ui/react-toast` already in deps, just not
   wired. Wrap App.js in `<ToastProvider>`, fire `toast()` from API
   handlers.
9. **Docs sidebar navigation** — `grid-cols-[240px_1fr]` layout with
   sticky sidebar like Vercel/Anthropic.
10. **Scroll-triggered Hero animation** — text reveal as user scrolls
    past hero, like Cursor.com.

### Critical files

```
HorizonWebMarketplace/marketplace-frontend/src/pages/Home.jsx
HorizonWebMarketplace/marketplace-frontend/src/pages/Browse.jsx
HorizonWebMarketplace/marketplace-frontend/src/pages/Pricing.jsx
HorizonWebMarketplace/marketplace-frontend/src/components/Header.jsx
HorizonWebMarketplace/marketplace-frontend/tailwind.config.js
HorizonWebMarketplace/marketplace-frontend/src/index.css
```

## Cross-cutting recommendations

1. **Hire / build a consistent illustration style.** Lucide icons are
   great but generic. Custom SVG mark for hero / empty states / 404
   would lift everything ~one point.

2. **Adopt a motion library where you don't have one.** Framer Motion
   for the site (Brand impression), pure CSS for desktop (perf),
   24-bit gradients for CLI (developer impression).

3. **Skeleton states everywhere.** This is the single biggest gap
   across all three surfaces. Users currently can't tell if the app
   is loading or stuck.

4. **Audit colour contrast.** Multiple rgba alpha values <.06 fail
   WCAG AA. One pass to bump everything to ≥.06 fixes accessibility
   for vision-impaired users.

5. **Sound design pass.** Optional but very modern — quiet click on
   send, subtle ding on successful agent finish, fail sound on error.
   ChatGPT just shipped this.

## Suggested redesign sprint (2 weeks)

| Week | Focus |
|---|---|
| **W1 day 1-2** | Skeleton loaders + toast notifications across desktop + site |
| **W1 day 3-4** | Settings UI redesign in Electron (the worst offender) |
| **W1 day 5** | Site: Framer Motion + scroll triggers + dark-mode toggle |
| **W2 day 1-2** | CLI: 24-bit gradients + interactive autocomplete popup + welcome screen |
| **W2 day 3-4** | Site: plugin detail richness + skeleton loaders + helmet SEO |
| **W2 day 5** | Cross-cutting polish — contrast pass, sound design, illustration style |

## Reference apps surveyed

- ChatGPT desktop + web
- Claude Desktop + claude.ai
- Cursor (cursor.com / app)
- Linear (linear.app)
- Vercel (vercel.com)
- Anthropic (anthropic.com)
- OpenAI (openai.com)
- gum / charm.sh (Charm CLI tooling)
- Hermes Agent TUI (Nous Research)

## How to use this document

This is the source-of-truth roadmap for the redesign. Each priority
above is small enough to ship as one PR. The "Suggested redesign
sprint" section is a working calendar — adjust days based on
calendar reality.

For each fix, the relevant file paths are listed in the per-surface
"Critical files" subsections; line ranges live in the original
sub-agent reports if needed for archaeological reasons.
