---
name: "Ottr"
description: "ISA-101 high-performance HMI in dark: grey is normal, colour is spent only on alarms."
# Token refs use `path.to.token`; e.g. `colors.accent`.
colors:
  field: "#2b2e32"
  chrome: "#24272b"
  panel: "#303338"
  card: "#3a3f45"
  card-hover: "#41464d"
  well: "#1f2225"
  line: "#4a5057"
  line-soft: "#3d4248"
  text-strong: "#eceef1"
  text: "#c9ced4"
  dim: "#a8b0b9"
  accent: "#8fb0d0"
  accent-hover: "#a6c2de"
  accent-ink: "#14181d"
  normal-fill: "#8f979f"
  alarm: "#f0b429"
  alarm-bg: "#3b3322"
  alarm-line: "#6b5627"
  crit: "#e5534b"
  crit-bg: "#472326"
  crit-line: "#6b2d30"
  crit-ink: "#ffd0cc"
  on-alarm: "#14181d"
  on-crit: "#1d0d0c"
typography:
  heading:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif'
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "1.25"
  title:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif'
    fontSize: "14px"
    fontWeight: 600
    lineHeight: "1.35"
  body:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "1.5"
  label:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif'
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: "1.5"
rounded:
  sm: "3px"
  md: "4px"
  lg: "6px"
spacing:
  sm: "4px"
  md: "8px"
  lg: "14px"
  xl: "20px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    color: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    color: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
---

# Ottr

## Overview

Ottr is a control-room overview for coding agents, built as an ISA-101 high-performance HMI in dark. Grey means every agent runs as it should; colour appears only when a task needs the operator or the machine leaves its normal band. It deliberately refuses the category default — a GitHub-dark kanban where every column, badge, and chart is always coloured.

The world is flat graphite: a work-area field under a darker chrome layer for the app bar and area list, panels and cards on 1px lines. There are no gradients, no glass, no glow. Values are brighter than labels and always in tabular figures. Depth is not the signal — state is — so elevation stays flat 1px lines and shadows are reserved exclusively for things that leave the page layer: native dialogs, the drawer, the system popover.

The interface is quiet by default. One notification bell holds the bar's right end, grey at rest, and it lights only while something is new. A card landing in Done recedes instead of celebrating. Motion is limited to state arrival: an alarm mark enters once and never blinks; a queued or done mark traces itself once when its card lands; a card flies between stage columns and slides to its new place when its column reorders; indicators ramp smoothly to new values.

**Key Characteristics:**

- All-grey board at rest; the first amber is the event
- Redundant state coding: shape carries state, hue only severity
- Analog indicators that show their own normal band
- One steel-blue interaction/selection edge, nothing else
- Flat 1px-line elevation; shadow only on top-layer overlays
- Native platform surfaces: `<dialog>` top layer and Popover API

## Colors

The palette is four neutral greys plus a recessed well, one steel interaction accent, and two alarm colours. Every non-alarm colour is grey or steel; spending colour on anything that is not an alarm breaks the world.

**Primary — Steel** (`#8fb0d0`): the single interaction and selection edge. Links, focus rings, the active area border, the primary button. It is deliberately desaturated so it never competes with amber.

**Secondary — Alarm Amber** (`#f0b429`): needs-you and above-the-normal-band. Always paired with a shape (the "!" triangle) or a band tick, never hue alone. Its banner tints are `#3b3322` fill / `#6b5627` line.

**Tertiary — Critical Red** (`#e5534b`): offline, failed actions, critical load. Shape: the "!" square. Banner tints `#472326` / `#6b2d30`; on-red text `#ffd0cc`.

**Neutral — Field Grey** (`#c9ced4`): body text. Surfaces step darker-to-lighter: field `#2b2e32`, chrome `#24272b`, panel `#303338`, card `#3a3f45`, hover `#41464d`, recessed well `#1f2225`. Lines `#4a5057` (strong) and `#3d4248` (soft). Values read brighter at `#eceef1`; secondary text `#a8b0b9` holds at least 4.5:1 on cards. Indicator fill inside the normal band is `#8f979f` — visible, but grey.

**The Grey-Is-Normal Rule.** Colour is an alarm channel. If a state is fine, it renders in grey; amber and red are reserved for needs-you and critical, respectively.

**The Redundant-Coding Rule.** No alarm state is carried by hue alone. Needs-you is an amber triangle "!", critical is a red square "!", normal-band exceedance is a tick on the indicator plus the amber fill. Shape and text carry the meaning first.

**The One-Edge Rule.** Steel blue is the only interactive colour. Hover states lighten greys or add the steel edge; they never introduce a second hue.

## Typography

One family: Segoe UI Variable Text (fallback Segoe UI, system-ui), with Cascadia Code for paths, commands, and code. Numbers in indicators, tables, and counts are always tabular (`font-variant-numeric: tabular-nums`).

- **Heading** (20px, weight 600, line-height 1.25, letter-spacing −0.01em): page titles — project name, Overview, empty state. Bright text colour.
- **Title** (14px, weight 600, line-height 1.35): card titles, dialog headings at 16px, section heads at 13.5px.
- **Body** (14px, weight 400, line-height 1.5): the base ramp; buttons run 13.5px.
- **Label** (12.5px, weight 400): meter labels, area counts, metadata, table headers; captions at 12px.

**The Values-Read-First Rule.** Data a supervisor reads at a glance — meter values, counts, table cells — uses bright text and tabular figures; their labels stay dim.

## Layout

A fixed app frame: 48px overview bar across the top with the notification bell at its right end, then a 240px area list beside the main pane that scrolls on its own. The main pane is a size container; the four stage columns collapse 4 → 2 → 1 at 760px and 440px container width, and the whole shell stacks under 720px viewport (the area list becomes a horizontal strip; touch targets grow to 40px; inputs to 16px so iOS will not zoom).

Spacing sits on a small rhythm: 4/8 inside components, 10–14 between them, 18–20 page padding. Gaps of 6–8px inside cards and rows.

**The Operator's-Frame Rule.** The bar and navigation hold position; only the work pane scrolls. The operator's eye never loses its anchor points.

## Elevation & Depth

Flat by default. Panels, cards, and the active area are separated by 1px lines (`--line` / `--line-soft`) and surface steps — never shadows. `--shadow-overlay` (0 18px 44px rgba(0,0,0,0.5)) exists for exactly three surfaces: native `<dialog>`, the task drawer, and the bar popovers, i.e. things that occupy the top layer above the page.

**The Shadow-Is-Overlayer Rule.** A shadow appears only where an element leaves the page layer. In-page depth is expressed by surface lightness and 1px lines.

## Shapes

Small radii, technical not friendly: 3px for chips and micro-badges, 4px for buttons, inputs, cards, and area rows, 6px for large containers (stages, overview table, dialogs, popover). State marks are exact: filled dot (running), ring (queued), check (done), triangle (needs-you), square (critical) — all 16px viewBox, 12–14px rendered, with dark "!" ink strokes; on the red square the ink flips to near-white. The single exception: the phone-only New task FAB is a 56px full circle — a floating action only reads as a primary target when it is a circle.

**The Shape-Says-It Rule.** State marks are a closed set of five glyphs. New states pick a glyph, not a colour.

## Components

- **Buttons** — 32px min-height, 4px radius, card-grey stock with a 1px line. Variants: primary (steel fill, dark ink, weight 600), danger (red line, transparent fill, red text that gains a red wash on hover), ghost and icon (transparent until hover). Disabled is 50% opacity, never reflowed.
- **New task FAB** — phones only (≤720px viewport): 56px full circle fixed bottom-right 16px inside the safe area, steel fill, dark ink plus icon, 1px line edge, no shadow — an in-page control, not an overlay. It replaces the header New task button in that tier, keeping one steel-filled control on screen (One-Edge); 160ms rise on the shared easing, collapsed under reduced motion.
- **Inputs** — recessed `--well` fill, 1px line, 4px radius; hover lightens the line, focus-visible turns it steel.
- **Area list item** — 36px row, transparent line; hover shows panel grey; the current page carries the steel border — the One-Edge in navigation.
- **Project tag** — a two-letter plate (initials of the first two words of the project name, else its first two letters) in bright bold ink on the recessed `--well` fill, 1px strong line, 3px radius. It is 22px in the area list, the overview table and the New task and Add draft dialogs, and 44px in the project header. A project with an icon shows the icon in the plate instead of the letters: an uploaded icon (project Settings) wins, then the source's icon (the GitHub owner's avatar, else the host's favicon), and only a project with neither shows the two letters. Projects differ by letter shape, never by hue: hue stays an alarm channel. The project header shows no branch and no path, because workers run the tasks. Under 720px the header's meta line (release, image, source link) flows beside the name and wraps below only when the row is full.
- **Meter** — 56×8px recessed track with a 1px band-limit tick at 85%; fill ramps via transform (0.4s, `--ease`) and turns amber above the band, red at critical. The value beside it gains the matching mark.
- **Notifications** — one bell holds the bar's right end on every viewport; the bar never adds or removes notification icons. The bell has three states. Clear: no entries, grey. Standing: entries exist and all are acknowledged; the bell shows the most urgent entry's state mark (a red square, an amber triangle, a steel question mark, none for notices) and the count in bright tabular figures, grey for notices only. Lit: a solid fill in the hue of the most urgent NEW entry — red, amber or steel, with `--on-crit` / `--on-alarm` / `--accent-ink` ink, the mark inverted, and "N new" (under 720px the fill carries "new" and the bar shows only N). The mark enters once in 220ms and never blinks. Opening the Popover API panel acknowledges every entry; the acknowledgement persists per browser, and an entry that clears loses it, so a recurrence lights the bell again. The panel lists entries by priority (Critical, Action required, Questions, Upstream updates, Notices, Advisories), with needs-you tasks as row links and a steel "New" chip (3px radius) on rows that were new when the panel opened. An "All clear" state ("Tasks that need you, failed actions and Ottr notices appear here.") fills the empty panel, and the desktop-notifications switch sits at its foot, hidden on touch screens, which use push.
- **Card** — 4px radius, `--card` stock, soft line; hover lifts to card-hover and the strong line; the whole card is the hit area for opening. A head line holds the state mark, the task key in quiet mono, and the chips. Below it, the name uses the full width of the card, flush with the excerpt and the meta line. needs-you cards take the amber border; landed (idle) cards recede to panel stock and weight-500 title.
- **Dialogs and drawer** — native `<dialog>` in the top layer: field-grey surface, 1px line, 6px radius, overlay shadow, 60%-black backdrop, 160ms rise. The drawer slides from the right in 200ms.
- **System popover** — Popover API panel anchored under the bar meters (CSS anchor positioning where supported), showing a key-value readout of the 15-minute CPU and RAM averages in tabular figures, and provider quota: one grid of meters (label, track, value, reset countdown) grouped by provider, so every track lines up. The bar carries only the tightest quota window — the one that stops agents first. The panel scrolls inside the viewport and spans the screen on phones.

**The Native-Platform Rule.** Modality uses the platform: `<dialog>` for focus, Esc, backdrop, and inertness; the Popover API for light-dismiss detail. No JS re-implements what the browser ships.

**The Lit-Is-New Rule.** A fill on the bell means unacknowledged and nothing else. The inverted mark and the word "new" carry the state without colour.

**Motion.** Everything uses one easing, `cubic-bezier(0.2, 0.7, 0.3, 1)`. Durations: 120ms control feedback, 160ms dialogs, 200ms drawer, 220ms alarm-mark arrival and in-column card slides (FLIP), 340ms card flights between stages (FLIP via WAAPI), 400ms indicator ramps, 420ms mark traces when a card lands. Under `prefers-reduced-motion`, all animation collapses to 0.01ms except the spinner, which keeps turning at its normal 0.7s so progress feedback stays legible; the mark trace and the card slides do not run at all.

## Accessibility

The board targets **WCAG 2.1 AA**, enforced through the design system itself, the impeccable detector scan before each commit that changes the UI, and `impeccable audit` before releases touch the UI. The ISA-101 world already carries most of it; these are the binding rules:

- **Contrast (1.4.3, 1.4.11):** body text ≥ 4.5:1, text ≥ 24px (or 19px bold) ≥ 3:1, and non-text boundaries — lines, focus rings, indicator fills against their track — ≥ 3:1. The committed pairs hold this: `--text`/`--text-strong` on field, panel and card; `--dim` only at ≥ 4.5:1 on its surface; steel focus rings on every surface they cross.
- **Use of color (1.4.1):** already law — hue never carries state alone; the redundant-coding rule is the AA mechanism.
- **Keyboard (2.1.1, 2.1.2, 2.4.7):** every action reachable and operable by keyboard; native `<dialog>` owns focus and traps it deliberately and releases it back; focus is always visible — the steel ring is the only focus treatment and must never be removed.
- **Names and labels (2.4.6, 3.3.2, 4.1.2):** every icon-only control carries `aria-label` (the New task buttons do); inputs have visible labels or `sr` text; state marks ship a screen-reader line (`<span class="sr">`).
- **Status messages (4.1.3):** loading, saved and error feedback render in `role="status"`/`role="alert"` regions, not transient toasts.
- **Resize and reflow (1.4.4, 1.4.10):** 200% zoom and 320px width keep every control reachable without two-axis scrolling — the column collapse tiers and stacked shell exist for this; new surfaces must name their breakpoints.
- **Motion and input (2.3.1, 2.5.1):** all motion honors `prefers-reduced-motion` (already tiered); any drag-only interaction (queued card reorder) ships a pointer-free alternative.

## Do's and Don'ts

### Do's

- Do render every healthy state in grey, with bright tabular values for anything numeric.
- Do pair every amber or red with its shape — triangle, square, or band tick.
- Do keep the steel accent as the only interactive colour; one edge per screen for selection.
- Do use native `<dialog>` and the Popover API for modality and light-dismiss detail.
- Do let landed work recede: recessed stock, lighter title weight, no celebration.
- Do keep all motion on the shared easing, and respect the reduced-motion tiers.
- Do keep WCAG 2.1 AA: contrast, visible focus, names on icon-only controls, announced status — the detector and `impeccable audit` check it.

### Don'ts

- Don't colour charts, columns, badges, or counts that are not alarming — this is not a GitHub-dark kanban.
- Don't add gradients, glass, blur, or glow; surfaces are flat fills on 1px lines.
- Don't make alarms blink, pulse, or repeat; an alarm arrives once, like an unacknowledged HMI alarm.
- Don't put shadows on in-page surfaces; shadow means top-layer overlay.
- Don't invent a second accent hue; links, focus, and selection are all the same steel.
- Don't drop the redundant coding — a colour-only alarm fails the world and colour-blind operators alike.
- Don't ship a UI change that fails WCAG 2.1 AA — a contrast, focus, name, or status-message regression is a defect, not a tweak.
