# Router UI redesign: desktop-first, terminal-safe

Status: built. This note records the design as it shipped.

Checked on screen: on desktop in dark mode, the band, the pane frame and the Now, Routes, Policy, Classifier and
Usage tabs (the Usage tab's empty states only); in the terminal, the band hover, the header and the five tabs. Not
checked by anyone: light mode, VS Code, mobile, and the Usage tab's data views (trend, breakdown bars, subagent
squares). Tests cover all three graphical surfaces by mounting them, but tests do not paint.

## Why

The router's band and pane were designed for a terminal and are drawn the same way on every surface. In Claude Code
Desktop that reads as pale, unorganized and jumpy:

- Desktop text is proportional unless a `Text` is `mono`. The router never sets it, so every space-padded column
  (`'  why   '`, `padEnd(30)`) and every block-character gauge (`▰▱`, `▂▄▆█`, `████░░`) drifts.
- The band fits itself by counting characters (`fitSegments`), which does not match pixel widths on desktop.
- Hovering the band reveals a row with `display: none → flex`. The band grows from one row to two or three and pushes
  the transcript up. This is the jump in the screenshots.
- Colours are raw hex and terminal names (`cyan`, `green`, `yellow`) tuned for a dark terminal. They ignore the app's
  theme and light mode.
- There is no hierarchy. A section is a caps word and a blank line; status, controls and data share lines; most text is
  dim. Buttons carry terminal habits (`1 Now`, `◉ on`, a `1 row` toggle).
- Rows appear only when they apply (mode, override, fallback, pending pin, recent decisions), so content below moves.

## Seen on desktop at 1.24.0

Screenshots of the installed 1.24.0 (band off, hovered, ready, hovered with pins; the docked pane, Now tab) confirm the
diagnosis and add specifics:

- **The jump is real in every state.** Hover adds a second row in the off state (just the `1 row` button) and a third
  in the ready state (pins, `Turn off`, `1 row`). The band's height changes with the pointer.
- **Space padding fails.** In the ready band, `cache 100% last` floats mid-row with a wide gap before `Router`,
  because the right-alignment pad is counted in characters. That gap is also where hover controls can sit.
- **Colour is lost in button labels.** The tier stairs on the pin buttons are white glyphs; the tier colour never
  reaches them. The `—` after each pin is noise when no reading exists.
- **Desktop already draws hotkey chips** (`O`, `F`, `1`–`5` beside the labels), so `1 Now` carries the digit twice.
  The graphical painter drops digits and letters from labels.
- **The session strip draws as dots** (`tiers ····`, `· not routed 30`): block characters in proportional text.
  Strips become Box cells with tier colours.
- **Pin buttons wrap unevenly** in the pane (two, then two), and the pane uses under half its width. Cards go
  side by side at wide widths.
- **Empty states are bare** (`why ready`, `ctx no reading yet`, `no priced replies: cost unknown`). Each card needs a
  designed empty state that says what will appear and when.
- **`Router` and `details` read as plain text** in the band; the pane's heavy white primary pills (`on`, `1 Now`) are
  the loudest things on screen while carrying the least information.

## Goals

1. On desktop the band and pane look native: cards, a type scale, theme colours in light and dark, real gauges and
   charts, aligned numbers.
2. Nothing moves unless the person asked for it. Hover never changes the band's height. A value changing never
   reflows its neighbours.
3. Each surface answers the same three questions in the same order: what runs next and why, what it costs, what I can
   change.
4. The terminal keeps working and improves where the fix is shared (stable band height, one place for warnings).
5. The terminal changes only where this note says so.

## Non-goals

- No change to routing decisions, classifier calls, stored data or `router.json`.
- No app theme (`$.theme.set`): a router should not restyle the person's app.
- No `Client` surface module: it has no `Svg` and does not run in VS Code or on mobile.
- No new metrics. This reorganizes what `RouterView` already holds.
- No change to when toasts fire.
- No layout for a pane placed as a desktop `widget`; it draws as the docked pane does.

## Anti-goals

- Any layout shift on hover or on a routine redraw.
- A terminal regression, or terminal output that changes in a change that claims to be a refactor.
- Rewriting `panel.mjs` and its tests at once, with no way to tell what moved.

## Constraints

- Upstream is `alexei-led/claude-router`. Many tests import the panel, band or display modules and assert on the
  terminal's text.
- The screenshots that prompted this came from an installed 1.14.0; the repo is 1.24.0. At 1.24.0 the band already
  leaves out a missing context reading and no longer shows the list-price line. The hover jump, the padding, the
  colours and the pane layout are unchanged.
- The render hook receives `e.surface`; it is passed to `renderPanel` and `renderBand`.
- Element tables: every surface has `Box`, `Text`, `Button`, `Input`, `Select`, `Link`, `Code`, `Markdown`,
  `Progress`. Desktop, VS Code and mobile add `Svg`; the terminal does not. A level such as usage against a limit is
  drawn as a bar of Boxes. A mobile app may be sent an empty Box for `Input` or `Select`.
- A render hook cannot read whether the app is in light or dark mode, and `Svg` markup cannot use theme keys.
- An absolutely positioned Box is clipped to the band's own region, so a hover card cannot float above the band.
- `Svg` source is capped at 131,072 characters and needs an `alt`.

## Approaches considered

**A. Split what is shown from how it is drawn (chosen).** Tabs and the band produce plain data. A terminal renderer
reproduces today's tree. A graphical renderer draws the same data for desktop, VS Code and mobile. Costs a refactor of
`panel.mjs` and `band.mjs`; gives each surface its best form and keeps one source of truth for content.

**B. Polish in place.** Keep one tree; add `mono`, theme colours, reserved rows and gaps for desktop. One or two small
PRs. It fixes alignment and the hover jump but still draws a terminal inside the app, and adds surface conditionals
throughout a file that is already hard to change.

**C. A `Client` module pane.** Dropped: no `Svg`, no `Progress`, desktop and terminal only.

A shipped as models with two renderers, not as a painter interface that both surfaces call. The terminal had to stay
byte-identical until its own polish pass, and a shared painter could not reproduce its padded rows, so each tab
builds one model and each surface draws it with its own code.

## Design

### Structure

```
lib/panel.mjs                  models: Now, Routes, Policy, Classifier, save bar, help, notices
lib/ui/model/usage.mjs         the Usage model
lib/ui/model/words.mjs         shared wording helpers
lib/ui/strip.mjs               the tier strip, fitted to a width
lib/ui/tokens.mjs              tones and tier colours per surface
lib/ui/painter.mjs             paintersOf(elements, surface); orTerminal; the fallback reporter
lib/ui/terminal/               one renderer per tab (now, routes, policy, classifier, usage), kit.mjs, wrap.mjs
lib/ui/graphical/              one renderer per tab, plus band.mjs, shell.mjs, frame.mjs, painter.mjs,
                               charts.mjs, meter.mjs, tone.mjs, squares.mjs, divider.mjs
lib/band-segments.mjs          the band's segment data
lib/band.mjs                   the terminal band
```

Each tab has a model: plain data in which conditions, wording and number formatting are decided once. Where the words
differ by surface the model holds a `{ terminal, graphical }` pair. A renderer only lays the model out. `renderPanel`
passes `e.surface` through: `terminal` (or none) picks the terminal renderer, anything else the graphical one. If a
graphical renderer throws, `orTerminal` in `lib/ui/painter.mjs` draws the terminal tree instead, and tells a reporter
that tests set to fail on any unexpected fallback.

The band keeps its data form (`bandSegments` returns segments of parts). `lib/band.mjs` draws it for the terminal and
`lib/ui/graphical/band.mjs` for the other surfaces.

The graphical painter (`lib/ui/graphical/painter.mjs`, with `charts.mjs`) offers these methods:

- `tierMeter`: the four-bar tier icon, with a variant for use inside a button.
- `section`: a card with a title, an optional hint and an optional action.
- `field`: a label and its value, with an optional help line.
- `notice`: a toned message with an optional action.
- `choice`: segmented buttons for a set of options.
- `table`: flex columns with aligned figures.
- `meter`: a labelled bar of two Boxes, a track and a fill, with its figure beside it.
- `strip`: the tier strip as coloured Box cells.
- `trend`: an `Svg` line chart with an `alt` that states the numbers.
- `stat`: a headline figure with a delta and a caption.

### Band

Decided from a desktop prototype, validated in two rounds. Hover-revealed controls were tried as an overlay, a
popover and a reserved slot; on desktop each one clipped, wrapped or covered its neighbours, so the graphical band
has none.

Graphical (desktop, VS Code, mobile): one row, always, with nothing revealed on hover.

```
routing   ▂▄▆█ Opus 5.5 · xhigh  code  clearly stronger      ctx 40%  cache 99%  −31%  [Pin next turn ▾] [Router]
off       ○ Fable 5.2 · medium  routing off                                              [Turn on]  [Router]
```

- Left group shrinks and truncates (the reason first); the right group never shrinks, so `Router` is never pushed
  off or clipped. The row has a little padding so button corners are not cropped.
- Pinning is one native `Select`. Its empty option reads `Pin next turn`, or `No pin` once a pin is set; the other
  options are the tier routes (`Haiku · medium` ...). A pending pin shows as the Select's value.
- `Turn off` lives in the pane header only. `Turn on` stays on the band while routing is off.
- The tier meter is a small `Svg` of four rising bars at text height (Box heights are whole rows, which is too
  tall). Numbers are `tabular`.
- There is no `1 row`/`2 rows` button. The second (session) row is a setting on the pane's Now tab.
- Segments still drop by priority against `bodyColumns`.

| State | Left | Message | Right-side control |
| --- | --- | --- | --- |
| routed, ready | meter + route | activity, reason, readings | Pin select |
| choosing | accent meter + route | "choosing model" | none |
| pending pin | meter + route | reason, readings | Pin select showing the pin |
| native fallback | meter + route + "fallback" in warning tone | reason, readings | Pin select |
| classifier warning | meter + route | what is missing | Set up |
| unavailable | ✕ + Claude's model | why | Fix |
| off | ○ + Claude's model | "routing off" | Turn on |
| subagent view | "agent" + its model | how it was chosen | none |

`Router` is last in every state except the subagent view.

Terminal: the band keeps its one row (two with the session row) and its hover controls, but they no longer add a row.
They are absolutely placed Boxes on the first row, revealed on hover, that cover none of the row's Buttons. The row has
two free stretches. One is over the readings: from after the leading segments up to the last one holding a control
(the meter and model; a warning with **Set up** or **Details**; a pending pin with its ✕) to the gap before **Router**.
The other is after **Router**, to the band's end. **Router** sits at the band's end only when readings (context,
cache) fill the row's end; then the first stretch is all there is. The controls fill the wider stretch and what does
not fit goes to the other, each Box padded with spaces to blank what is beneath; a stretch under 12 columns holds
none. They drop as the old row's did, with one change while two rows show. With one row, the pins lose their route
names, then **2 rows** goes, then the pins, and **Turn off** stays longest. With two rows, the pins go, then **Turn
off**, and **1 row** stays longest (`/router off` and the pane's `f` also turn routing off). A band with no stretch of
12 columns has no hover controls; the Now tab's SESSION line always carries `[ band: 1 row ]` or `[ band: 2 rows ]`
(`band-detail-toggle`), the terminal's way out of two rows at any width.

### Pane shell (graphical)

```
Router                              ● Jev ready · 347 ms      [ On | Off ]
Now   Routes ●   Policy   Classifier   Usage                           ?
────────────────────────────────────────────────────────────────────────
<cards>
────────────────────────────────────────────────────────────────────────
● 2 unsaved changes                               [ Discard ]  [ Save ]
```

- Title, classifier status and the on/off control on one row; tabs below; hotkeys keep working but leave the labels.
- One notices slot directly under the tabs holds every warning (ignored project config, native fallback, missing
  key). Warnings stop appearing mid-card.
- The save bar keeps its place at the bottom; its diff opens as a card above it.

### Now tab (graphical)

```
┌ Next turn ─────────────────────────────────────────────┐
│ ▂▄▆█  Opus 5.5 · xhigh                  code 84%        │
│ ↑ clearly stronger · Jev 88% ≥ 82% · switch ≈ $0.48     │
│ Pin next turn  [ Haiku·med 2% | Haiku·high 3% | Opus·med 7% | Opus·xhigh 88% ]
└────────────────────────────────────────────────────────┘
┌ Plan ─────────────────────┐ ┌ Context ──────────────────┐
│ 5h  ████████░░░░  48%  18:00│ │ ████░░░░░░  40%  403K / 1M │
│ 7d  ███████░░░░░  43%  Fri  │ │ cache 100% last · 90% session│
└───────────────────────────┘ └───────────────────────────┘
┌ Session ───────────────────────────────────────────────┐
│ ≈ $8.97     −$4.09 (−31%) vs unrouted                   │
│ main ███████████████  agents █████     since 14:18      │
│ tier strip ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇  low 41 · medium 12 · high 33 │
└────────────────────────────────────────────────────────┘
┌ Recent decisions ──────────────────────────────────────┐
```

- The pin control always occupies its row; a pending pin highlights its option instead of adding a line.
- The mode and override lines fold into the "why" line as chips, so the card's height is constant.
- Plan and Context sit side by side when the pane is wide and stack when narrow.

### Other tabs (graphical)

- **Routes**: a real grid (activity × tier) with aligned columns; the selected cell's editor opens in a card under the
  grid rather than between rows.
- **Policy**: a form. Label, control, one caption line of help per row, grouped under "Switching down", "Switching
  up", "Activities", "Credits".
- **Classifier**: a full card for the active classifier (deadline, wait, health, credentials) and compact rows for the
  others under "Other classifiers", then "Across sessions".
- **Usage**: period buttons, Summary with a headline stat and delta, Trend as an `Svg` line, Breakdown with inline
  bars, What if, "Worth a look", Subagents as coloured squares, About these numbers, and Delete history on its own
  row behind its confirmation.

### Terminal

The terminal's output is byte-identical to before the redesign except in these places, which changed on purpose:

1. warnings move into a single notices slot under the tabs;
2. a pending pin is shown on its pin button instead of an extra row;
3. the band's hover controls are drawn on its first row, over its readings or after Router, instead of on a row of
   their own (see Band);
4. the header's classifier status reads `see below` while the notices slot names the same missing credentials, and
   on the Classifier tab that notice has no **Set up** (the Credentials row's **Edit** owns `key` and `k`);
5. a tab row wider than the pane drops the digits from its labels (the hotkeys stay), then moves `?` to the header
   line's end;
6. Policy fields, and the active classifier's settings in a narrow pane, hang their help lines in a column beside the
   label, so wrapped text keeps its indent;
7. where its widest row (Set up included) does not fit, or with no width, the Classifier tab draws each classifier
   on two lines (name, status, **Set up**; then host and probe result, muted) with no row of column titles;
8. the Now tab's SESSION line ends with `[ band: 1 row ]` / `[ band: 2 rows ]`, the band's second-row toggle;
9. the `?` help draws whole paragraphs that wrap to the pane, instead of lines cut for 68 columns.

Any other terminal difference is a regression. Doc images are regenerated with `scripts/render-doc-images.mjs`.

### Accessibility

Every `Svg` has an `alt` that states the numbers, and every bar has its figure beside it as text. Colour is never the only signal: tiers keep their bars and names,
warnings keep words. Hotkeys are unchanged. Dark mode has been checked on desktop; light mode has not.

## Testing

- Golden snapshots of the terminal tree for the band and each tab, covering every render branch
  (`test/ui-golden.test.mjs`). They stay unchanged except where the Terminal section says otherwise.
- Model and renderer unit tests against a stub element table (`test/ui-*-graphical.test.mjs`,
  `test/ui-painter.test.mjs`, `test/ui-tokens.test.mjs`).
- Engine mount tests on desktop, VS Code and mobile that act by key (`test/ui-*.test.ts`).
- A walk over every graphical tab that fails on a duplicate key or hotkey (`test/ui-keys-graphical.test.mjs`).
- A fallback reporter that fails any test in which a graphical renderer threw and the terminal tree was drawn
  unexpectedly (`test/ui-fallback.test.mjs`).
- A band test asserts the graphical band has no hover-revealed element and is one row (two with the session row).
- A person checks the look on screen; tests do not paint.

## Delivery

Delivered as one change set. The desktop band and pane were validated first with a throwaway prototype that confirmed
the facts under "Spike results"; it was not merged.

## Spike results (desktop, dark mode)

- Text is proportional by default; `mono` and `tabular` work.
- A hover-revealed absolute Box draws as a floating bordered card larger than a row; it does not reflow, but it
  covers neighbours and clips its own content. Not used.
- Buttons are tall filled pills; rows of them read as heavy. Box heights are whole rows.
- `rgba()` colours paint. An `Svg` at 16×12 sits well on a text line.
- At `bodyColumns` 99 two cards of bar rows do not fit side by side; the threshold is 110.
- Not checked: light mode, VS Code, mobile.
