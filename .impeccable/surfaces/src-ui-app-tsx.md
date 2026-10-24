---
version: 1
slug: "src-ui-app-tsx"
primary_target: "src/ui/app.tsx"
related_targets: ["src/ui/app.css"]
---

# Surface brief: Ottr board (src/ui/app.tsx)

Scope: the whole board app shell. It covers the overview bar, the alarm banner, the area (project) list, the project flow view, the overview table, the dialogs (New task, Add project, task drawer), and the settings page (General + one page per project, reached from the area list). Visitor mode: **Operate**.

Audience and job: one developer who supervises omp agents across 5+ local repos. They glance over from an IDE to see who needs them and whether the machine stays in its normal band. They dispatch tasks per project.

Constraints: native Windows app feel ("classic application"), with a sidebar and one project at a time plus an overview. It must not read like a website, must stay quiet when nothing needs the operator, and must not be dense. Dark only. WCAG 2.1 AA is binding (DESIGN.md "Accessibility"): contrast, visible steel focus, names on icon-only controls, announced status. The task drawer keeps its JSX, because tracker task 4ae5af02 reworks its turn/log structure. Prioritize is left out of New task (task 445d0fcd removes it).

Memorable moment: an all-grey board. The first amber is the alarm banner that names exactly which task needs you, one click from its card.

Unresolved: whether a light variant is ever needed (not now).

## Direction contract

THESIS: Ottr is a control-room overview for agents. Grey means every agent runs as it should. Colour appears only when a task needs the operator or the machine leaves its normal band. It refuses the category default, a GitHub-dark kanban where every column, badge, and chart is always coloured.

OWN-WORLD: an ISA-101 high-performance HMI in dark. A flat graphite field (#2b2e32) sits under a darker bar/nav layer (#24272b). Panels are #33373c and cards #3a3f45 on 1px lines, with 4px radii. There are no gradients, glass, or glow. Text is muted grey (#c9ced4), and values are brighter, in tabular figures. Colour is for alarms only and is always coded redundantly. An amber triangle "!" means needs you or above the normal band. A red square means critical. Shape shows state, never hue: a filled dot for running, a ring for queued, a check for done. Analog bar indicators mark their normal band. Steel blue is the single interaction/selection edge. The type is Segoe UI Variable, one family.

STORY: The operator glances over. If nothing is amber, all agents are fine. When amber appears, the alarm banner names the task and its project, and one click opens it. The operator picks a project in the area list, reads its four-stage flow, and dispatches work from the project header.

FIRST VIEWPORT (1440x900):
- Top: a 48px overview bar. The Ottr mark is on the left. Next come the CPU/RAM/VRAM bar indicators with bands and values, then the Agents in-use/total count.
- An alarm banner appears under the bar only while something needs the operator.
- Left: a 240px area list with Overview first, then the projects with their alarm/running counts. Each project row starts with its two-letter project tag. "Add project" sits at its foot.
- Main: the project header with a 44px project tag, the name at 20px, the release and review chips, and advisories. It shows no branch and no path: workers run the tasks, so the checkout of the board has no meaning. The primary "New task" is at the top right, and its dialog repeats the project tag and name. Below the header, four equal stage columns (Todo, In progress, Merging, Done) fill the height.

FORM: Control Room Overview (ISA-101 high-performance HMI). It is my top-ranked grounded candidate (1 of 7). The user took it as the pick over the assigned Slot Board (6 of 7). Seed key 420b06d0.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Direction contract — settings page

THESIS: Settings is a control-room config bench, not a modal afterthought — the operator configures the machine in the same visual language the machine reports in. It refuses the category default: a cramped dialog whose per-project fields hide behind "extras" toggles.

OWN-WORLD: Ottr's ISA-101 graphite unchanged — field/panel greys on 1px lines, well-filled inputs, steel #8fb0d0 as the only interactive colour (the active sub-nav edge, focus rings, primary Save), amber/red reserved for their existing alarm semantics. Tabular figures on numeric fields. No gradients, glass, or shadows beyond the native top-layer surfaces. The sub-nav reuses the area-list grammar: 36px rows, panel hover, steel edge on the active entry.

STORY: The operator sees every knob grouped by scope — machine-wide on General, one page per project — knows which scope a change affects before touching it, saves per section with announced feedback, and never fears a destructive action (Remove sits alone at a project page's end, behind the idle guard).

FIRST VIEWPORT (1440x900): the usual shell (bar + 240px area list, Settings now an entry under Live sessions); the main pane becomes a two-column bench: a 200px settings sub-nav (General, then one row per project) beside sectioned content. General opens on Runners (cap + configured meter), Access (API key: masked value, reveal, copy — always available, fetch-to-clipboard without reveal — regenerate), Notifications (push enable/test). Sections are panel blocks on soft 1px lines, 6px radius, label-dim/value-bright field pairs, per-section Save right-aligned in the section head.

FORM: paperclip's skeleton (sub-nav + sectioned page), built entirely from Ottr's components at the 4/8/14/20 rhythm. Signature interaction: switching sub-nav entries swaps the content pane in place (160ms fade-rise on the shared easing — a state arrival). Saved feedback is a role="status" Saved mark. A project page: Identity (display name + folder note), Runners (parallel), Worktrees (extra paths), Releases (command + env hint), Reviews (due cap, lens floor), Messages (images per message), and a danger section (Remove, idle-guarded, red-lined) last. Under 720px the sub-nav becomes a horizontal strip, targets 40px.

FINISH: same finish rules as the board contract; the copy action never renders the key.
