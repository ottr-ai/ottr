---
name: ui-ux-check
description: Use when a work turn, a PR review or a release review touches UI files (components, CSS, UI copy). Checks the diff and the rendered screens against 52 UI/UX rules and reports each finding with file, line, rule and fix.
---

# UI/UX check

A checklist for UI changes. It comes from the Ottr UI work of November 2026 and the public checklists named below: the TikTok checklist "20 Ways to Unslop AI Designs" (@charles.unemployed, 2026-11-07), the TikTok list "Die 15 UX-Regeln, die jede App braucht" (@timbuildingapps, 2026-11-08), the 101 carousel posts of the TikTok account @ux_dose and the 161 posts of the TikTok account @wadhah_the_uxer (2026-11-09), and the TikTok checklist "5 simple typography fixes that make UI numbers easier to scan" (@supercharge.design, 2026-11-11). Rules 1 to 20 name the defects that the work found and fixed; rules 21 to 25 are the unslop video's mechanically checkable tells; rule 26 restores the earlier proximity rule, which the video confirms and the work had dropped; rules 27 to 33 are the app-UX list's conventions. Rules 34 to 49 are the @ux_dose rules that the earlier rules did not cover: copy, forms, controls, readability, tokens and themes. Rules 50 to 52 and the additions to rules 24, 26, 31, 32, 35, 37, 39 to 43, 46, 48 and 49 come from @wadhah_the_uxer. Rule 45 gains the right-aligned comparison amounts and the fixed decimal precision from the @supercharge.design checklist; rules 25 and 45 already covered its other three checks. Rules 31 to 33 apply only to touch layouts.

## Precedence

1. The project's design document (`DESIGN.md`, a style guide, or design tokens) wins. When a rule here conflicts with it, follow the document and do not report the rule.
2. When the project has no design document, apply the rules below as written.
3. When a rule here is missing from the project's design document and the project breaks it, report it as a finding. Do not edit the design document in a review.

## Scope

- Work turn: check only the screens and the copy that the diff changes.
- Review: check the changed UI first. Then sweep the rest of the UI for the same defect classes.
- Read the code, then look at the rendered screen. A screenshot or a browser check is the proof for layout, color and motion findings. Without a rendered check, mark the finding `[from code]`.

## The rules

### Emphasis and color

1. **One primary per surface.** A screen, a dialog or a drawer state has at most one filled (accent) button. It is the decision, when one is open, else the next action. Two filled buttons on one screen is a finding.
2. **A destructive action is never the primary.** Delete, discard, cancel-the-task and similar actions use the danger style, and they confirm first. A destructive button with the primary style is a finding.
3. **Danger stays out of the primary row.** A danger button never sits next to the primary action. Move it to a separate row at the bottom of the surface.
4. **The accent color means "you can click this".** Do not use the accent fill for a status mark that is not interactive (unread badges, counters, chips). Use the neutral fill.
5. **Warning colors only when the user must act.** Amber and red are for states that need the user. Red marks only errors and destructive actions; any other warning is amber. A reminder or a nudge stays neutral. Each warning color also has a shape or an icon, never color alone.

### Labels and copy

6. **Sentence case for every label.** Buttons, links, menu items, titles, tooltips and confirm pairs capitalize only the first word and proper nouns ("New task", not "New Task"). Mixed case on one surface is a finding.
7. **Labels lead with the noun.** Headings, field labels and setting names start with the keyword ("Task", not "What should the agent do?"). Buttons start with a verb. A headline is specific: it names its content ("Release notes", not "Unlock your potential"). A vague marketing headline is a finding.
8. **A placeholder is never the label.** Each field has a visible label. A placeholder only shows an example.
9. **Mark optional fields, not required ones.** No asterisks. Put "(optional)" after the label of an optional field, in the muted text style.
10. **A toggle names the next state, and only for on/off.** "Turn on" / "Turn off". A choice between two views ("By topic" / "By time") is a segmented pair with `aria-pressed`, not a toggle.

### Layout and shape

11. **Equal segments.** Every segment of a segmented control or a tab strip has the same width (`flex: 1 1 0` or equal grid columns). A strip that is too narrow scrolls. It never cuts a label.
12. **Nested radii.** A rounded child never has a radius equal to or larger than its rounded parent. With 6px or less of padding between them: outer radius = inner radius + padding.
13. **Hit targets.** An interactive element has a target of at least 24 x 24 CSS px, and at least 44 x 44px on touch layouts. An icon-only button has an accessible name.

### Loading and motion

14. **No flash for fast loads.** A spinner or a placeholder shows only after a delay (about 400ms for a busy button, about 1 s for a placeholder). A load that ends before the delay shows nothing.
15. **Skeletons for slow remote loads.** A remote load that can take more than about 1 s shows grey blocks in the rough shape of the content, not a blank area or only a spinner.
16. **One easing token.** All transitions use the project's shared easing and its duration tiers. A literal `ease`, `linear` or a one-off curve is a finding. Motion is feedback: every animation reports a state change the user caused, and a decorative animation with no feedback to report is a finding.
17. **Press feedback.** Every action answers at once (within about 100ms): a press state, the changed state itself, or a busy mark. Rule 14 delays only the spinner, never the press state. A pressed button scales to about 0.97 over the control-feedback duration. Hit areas that cover a whole card or row do not scale. An action that changes nothing visible on the screen (a save, a copy, a send) shows a short confirmation.
18. **Popovers enter from their trigger, and exits are shorter.** A popover or a menu fades and scales in from its trigger. An exit runs about 20% shorter than its entrance.
19. **Reduced motion.** Every animation has a `prefers-reduced-motion` variant that removes movement.

### Safety and accessibility

20. **Confirm before data loss, keep WCAG 2.1 AA.** An icon that deletes data asks for confirmation or offers an undo. Text contrast is at least 4.5:1, focus is visible, and the keyboard reaches each control.

### Decoration and typography

21. **No filler badges.** A badge or a chip carries a state or an action (a rank with its reason, unread, close, help). A badge that only decorates ("MOST POPULAR", a "NEW" chip with no state behind it) is a finding.
22. **No decorative italics.** Copy uses italics for emphasis on the words that need it, nothing else. An italic applied to random words as a style is a finding.
23. **Monospace only for code, data and numbers.** The project's mono token appears on code, identifiers, data and digits. Mono on headings, labels or body copy as a vibe is a finding.
24. **One icon family per surface.** The icons of one surface share a family, a weight and a style (all filled or all outlined). Mixing families or weights on one surface is a finding. The same holds for other components: the chips of one group, the two buttons of a pair and the social sign-in buttons share one shape and one style.
25. **Tabular numerals where digits align.** Tables, counters, timers and any aligned run of digits use `font-variant-numeric: tabular-nums`. Digits that shift width as they count are a finding.

### Grouping

26. **Proximity groups.** The gap inside a group is smaller than the gap between groups. A dialog's footer is its own group: it sits farther from the fields above it than the fields sit from each other. Gaps that blur where one group ends and the next begins are a finding. Items that share a style sit together (law of similarity), so a list never alternates styled and plain items. A label that repeats on every item ("Exercise 1", "Exercise 2") shows once as the group heading.

### States and conventions

27. **No empty screen without a next step.** A list, a board column, a search result or a page with no content says why it is empty and offers the next action ("No tasks yet. Create one", with the button). A blank area, or a bare "No data", is a finding.
28. **X closes, the back arrow goes back.** An X dismisses the whole dialog, sheet or flow. A left arrow (or "Back") returns one step inside it. An X that only steps back, or a back arrow that closes the whole flow, is a finding.
29. **Standard icons for standard meanings.** A magnifier means search, a gear means settings, a bell means notifications, an X means close, a trash can means delete. Do not invent a new icon for one of these meanings, and do not reuse one of these icons for another meaning.
30. **Ask for a permission when it is needed, and say why.** A browser or OS permission (notifications, camera, microphone, location, clipboard) is requested only when the user starts the action that needs it. One sentence next to the control says why. A permission prompt on page load, on first launch or before the user asked for the feature is a finding.

### Touch layouts

31. **Bottom tab bar conventions.** A bottom tab bar has 3 to 5 tabs. With fewer than 3 destinations, use no tab bar. Each tab shows a short text label (one word, "Search", not "Explore and search") under or beside its icon. The tabs share the bar width in equal columns, and the hit area of each tab fills its whole cell. A starting size: a 56dp bar, 24dp icons, 12dp labels, and a 2dp gap from icon to label. Home is the first tab on the left, the profile or account tab is the last on the right. A create action in the tab bar takes the middle slot. A tap on the active tab scrolls its view back to the top.
32. **Thumb reach.** The primary action of a touch screen sits in the lower half of the screen (a bottom bar or a sticky footer), and it spans the full content width. A button in a card spans the card's content width. A primary action that exists only in a top corner is a finding.
33. **Native gestures stay native.** A list of remote data supports pull to refresh. A swipe from the left edge goes back. A custom gesture that captures touches from the left edge and so blocks the back swipe is a finding.

### Copy and messages

34. **Errors say what happened, why, and what to do next.** An error message names the problem in plain words, gives the cause or the real limit ("This file is 2.4 GB. The limit is 2 GB."), and offers one action that recovers ("Try another card", "Sign in again"). A bare code ("Error 403"), a bare "Something went wrong" or "Failed", and text that blames the user ("You uploaded an invalid file") are findings. When the error does not lose data, say so ("Your changes are saved on this device").
35. **Field errors show at the field.** A validation error marks the field that failed (border and icon, never colour alone) and shows its message directly under that field. The check runs when the user leaves the field or submits, not on each key press. A form-level banner as the only error for one field, or all field errors stacked under the submit button, is a finding. Exception: a requirement checklist (password rules such as "8 characters", "1 number") updates on each key press and ticks each met rule, because it shows progress, not errors.
36. **No generic button labels.** A button names its action and, when it helps, the result: "Delete project", "Pay $24.00", "Send message". "OK", "Yes", "No", "Submit", "Done", "Confirm" and "Click here" are findings. A confirm dialog names the object it acts on ("Delete the project "Demo"?"), and its two buttons name both outcomes ("Keep project" / "Delete project").
37. **Short messages, no filler.** Status and confirmation text drops filler words: "File uploaded", not "Your file has been successfully uploaded". Hints and list items lead with the keyword, because users read only the first two or three words. Write numbers as numerals ("7 new", not "Seven new"), use the active voice ("You can edit this document"), and avoid double negatives ("Notifications are on. Turn them off at any time.", not "You can't not get notifications"). A message that is longer than its content needs is a finding (P3).
38. **No dark patterns.** Leaving, cancelling or unsubscribing takes the same effort as joining, and its copy is neutral. Guilt copy ("No thanks, I don't want to grow"), a faint opt-out link beside a loud stay button, and a pre-checked opt-in are findings.

### Forms and controls

39. **Pick the control by the choice.** A binary on/off is a checkbox or a switch. Two to five exclusive options show all at once as radios or a segmented control, not a dropdown. Multiple selections are checkboxes or toggle chips. A list of more than about 15 options (countries, models) gets type-to-filter search, and the user can type or scroll. A value that the user knows by heart (a year, a number) is a typed input, and a numeric range is a slider with visible values or two number inputs. A dropdown with fewer than five options, or a long list with no search, is a finding.
40. **The input matches the data.** Each input uses its matching `type`, `inputmode` and `autocomplete` (email, tel, url, number, password, one-time code). Dates and times use the native picker (`type="date"`, `type="time"`), not three dropdowns. One value takes one field: one email field, one "Full name" field, not a split name and domain. A one-time code can look like separate digit boxes, but it stays one input with `autocomplete="one-time-code"`, so paste works. The field width hints at the expected length (a ZIP code is narrow). A format that the user must meet (password rules, a size limit, a date format) shows as visible text at the field, never only in a tooltip. An input mask ("MM/DD/YYYY", "+1 (___) ___-____") stays visible and fills while the user types. A search field's placeholder names what it searches ("Search artists, albums, songs"), and the field still has an accessible name.
41. **Forms read in one column.** A form asks only for the fields that the flow needs. It puts one field on each row, with the label above the field on one shared left edge. Related fields sit under a short section heading ("Contact", "Address"). Only fields that belong together (expiry and CVC, city and ZIP) share a row. The actions follow the last field. A starting rhythm: 12px from label to field, 24px between field groups, 32px before the button. A zig-zag of labels beside fields, or two unrelated columns of fields, is a finding.
42. **Long option sets start with a default.** Show as few options as the choice needs: merge fine-grained ranges into fewer, wider ones (six one-year ranges become "0-1", "1-3", "3-5", "5+"). When a choice has many options, recommend one ("Recommended") and show the rest after a "More options" step. A list of common answers can end with "Other" and a free-text field. A settings list with more than about eight entries gets a search or a filter.

### Feedback and data

43. **Long waits show progress.** A wait that can last more than about 10 s shows what is done ("3 of 8", a progress bar with a percent), the time left when it is known, and a cancel control when the work can stop. A spinner as the only feedback for a long wait is a finding. Every progress bar, also for goals and downloads, shows its value as text ("70%", "700 of 1,000 XP").
44. **Selection is unmistakable.** The selected row, card, tab or menu item changes more than a small check mark: a fill, a border, or a weight change, in the project's selection colour. An active navigation item shows the current page.
45. **Numbers are grouped and carry units.** Large numbers use the locale's thousands separator (`Intl.NumberFormat`). Long codes (card numbers, phone numbers, IDs) show in groups of three or four. A value carries its unit ("120 MB", "42%", "3 min left"). A run of seven or more ungrouped digits in visible text is a finding. Amounts that the user compares in a column (prices, balances, totals) align right, and the header copies the alignment of its data. One column or one metric keeps one decimal precision (money 2, percentages 1 or 2, counts none). Left-aligned amounts in a comparison column, or two precisions in one column ("9.5" beside "9.50"), are findings.

### Readability, tokens and themes

46. **Readable text.** Body text uses weight 400 or more and a line height of about 1.4 to 1.6. A prose block (a report, a description, rendered markdown) has a line length of at most about 75 characters (`max-width` in `ch`). Text of four or more lines aligns left. Centre only short text (three lines or fewer, for example a headline). A long block breaks into short sections with sub-headings, and a card truncates long text after four or five lines with a "Read more" link. A link inside body text has a second cue beside its colour, an underline (WCAG 1.4.1). Letter spacing stays at the default on body text. All caps appear only on short labels, with a small size and wide tracking. A thin weight (100 to 300) on body or button text is a finding.
47. **Tokens, not raw values.** Colours, font sizes, spacing and radii come from the project's tokens. When the project has no scale, spacing uses multiples of 4px and a type scale of four to six sizes. A raw hex value in a component, a size off the scale, or two near-equal greys (for example `#6e6e6e` beside `#707070`) are findings.
48. **Exact alignment.** Elements in one row share a baseline or a centre line, and elements in one column share an edge. An offset of 1 to 4px is a finding, because users see it without knowing why. A grid of cards or tiles uses the same gap between rows as between columns. In an icon and sub-heading block, the body text aligns with the sub-heading text, not with the icon. In a button with a leading icon, the padding on the icon side is smaller than on the label side, so the content looks centred. A button label stays on one line at the narrowest supported width. When it wraps, make the label shorter.
49. **Both themes, no pure black or white.** A dark theme uses a dark grey surface (for example `#121212`), not `#000000`, and its body text is an off-white, not `#ffffff`. It shows elevation with lighter surfaces, and it uses less saturated accents that still meet 4.5:1 for text. A light theme avoids pure `#000000` text on `#ffffff` (use for example `#242424` on `#faf9f6`). No theme uses a fully saturated primary hue (`#ff0000`, `#00ff00`, `#0000ff`, `#ff00ff`) as a UI colour: use a softer tone such as `#e03030`. When the project has two themes, check every changed screen in both. Logos, icons, shadows and text over images break first. Text over an image sits on a scrim or a gradient that keeps 4.5:1.

### Steps, icons and buttons

50. **Long forms go in steps.** A form with more than about six fields splits into steps of about three fields, with a stepper that shows the done, current and next steps ("Step 2 of 4"). An onboarding step that the product does not need offers "Skip" as a secondary action beside the primary "Next".
51. **Icons are simple glyphs.** Icons are vector glyphs (SVG or an icon font) in one colour, drawn flat and front-on, not detailed illustrations, perspective or 3D. An icon beside a label is about the cap height of the label text. A text-only menu or navigation list of places or actions puts an icon before each item. A raster icon, or a detailed multi-colour picture used as a control icon, is a finding.
52. **A button ladder with all states.** Buttons use three levels: primary (filled) for the main action, secondary (outline or light fill) for other actions, and tertiary (text only) for minor actions such as "Forgot password?". Each level has all its states: default, hover, focus (a visible ring), pressed, busy, and disabled. Horizontal padding is larger than vertical padding (for example 16px by 32px). A button with a missing state, or two levels that look the same, is a finding.

## Report

Give one line for each finding, sorted by severity:

```
<severity> | <file>:<line> | rule <n> <short name> | <what is wrong> | <fix>
```

- Severity: **P1** data loss, an action that the user cannot reach, or a WCAG AA failure. **P2** a wrong emphasis, a destructive action that looks safe, or a misleading label. **P3** consistency and polish.
- When the project uses Ottr review cards, file each P1 and P2 finding as its own card. Group P3 findings of one rule into one card.
- When no rule is broken, say so in one line, and name the screens that you checked.
