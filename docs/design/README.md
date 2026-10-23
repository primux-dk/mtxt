# mtxt design system

This is the implementation reference for the web library, the desktop recorder and mtxt.co. The visual source is Kristian Primdal's site, kristianprimdal.dk. It uses Mona Sans, near-monochrome surfaces and small sage accents. The app is denser than the site's reading layout.

**Guidelines.** [guidelines.html](guidelines.html) is the reference every screen is checked against: principles, live colour swatches, the theme panel, type, spacing, component samples, writing rules, the behaviour rules and the acceptance checklist. It renders from [tokens.css](tokens.css) and the mockup CSS, so it cannot drift from them. A screen is accepted when the checklist at the end of that page holds.

Open [the mockups](mockups/index.html) and the guidelines through a local static server; the locale files load over HTTP. All assets are local. The mockups have a light and dark switch and an English and Dansk switch. Every figure has its own width and caption. These are static design references, not working application flows. The company in the mockups is Primux, the author's own install. People, meetings and transcript text are invented.

## Information architecture

| Route | Surface | Access and purpose |
| --- | --- | --- |
| `/login` | Company login | Product name and company name come from the install. Only the configured provider is shown, as the one primary button: "Sign in with Microsoft" for Entra ID, "Sign in with Google" the same way for a Google install. The footer reads "An installation for {company}"; mtxt does not appear. No local accounts. |
| `/meetings` | Library | My meetings, Shared with me and Whole company are views of the same permitted library. Search uses the same permission scope. The primary action is "New meeting", which opens the choice between recording in the browser and uploading a file. |
| `/meetings/{id}` | Meeting | Audio, transcript, recap, export and versions. Only the owner changes visibility. Shared readers cannot share again. The primary action is "Export". |
| `/settings` | Settings | The whole admin surface from the spec, including Theme and Interface language, organised in tabs with one route each (`/settings/general` to `/settings/audit`). Reached from the user menu, for admins. Provider-specific credentials and region fields follow the selected adapter. Local adapters need no API key. Private meeting text stays private, including from admins. |
| `/design` | Design guidelines | For signed-in users. The app serves [guidelines.html](guidelines.html) rendered from the install's live tokens, so an install with its own accent sees its own page. |
| `/recorder` | Tauri desktop app | A native window, not a web navigation destination. Capture, upload queue and optional local live transcript. |
| `mtxt.co/` | Marketing home | English introduction, screenshot, source link and licence. No customer install data. Not part of the product locale files. |

## App shell and layout

The desktop shell has a 224 px sidebar and a flexible content area. The sidebar contains the install name, the 3 navigation items (My meetings, Shared with me, Whole company) and the signed-in user. The user is one row at the foot of the sidebar: avatar, name, company line and a chevron. The row is a button that opens a DropdownMenu with Settings (admins only), Recorders and Sign out, each with its icon; Escape closes the menu and returns focus to the row. While a settings page is open, the row has the selected look of a navigation item and `aria-current="page"`. The mobile Sheet ends with the same row. Content uses 32 px padding.

The library header is 2 rows on a desktop. Row 1 has the page title on the left, with no subtitle, and on the right the search field (320 px, 420 px on wide screens), "Upload audio" and "New meeting". Row 2 has the filter pills on the left, then, 24 px after the last pill, a quiet "Archived" text link with the number of archived meetings when it is not zero; on the right, the result count and the sort on one line. Rows are 16 px apart and the list starts 24 px below row 2. The archived view is titled "Archived meetings" and shows "Back to My meetings" in the link's place; the pills apply there too. Below 720 px the header is 4 rows: the title with "New meeting", the search at full width, the pills in a sideways scroll with the Archived link last, then the count and the sort. "Upload audio" is then in the New meeting menu and the first-use empty state. Cards and rows share a left edge. Use 1 outer content width; never constrain individual paragraphs with a character-based width or a second prose width.

The meeting page shows the recap and the transcript as 2 tabs, one panel at a time, at the full content width. The meeting page's content column is capped at 904 px so transcript lines stay readable; that cap is the page's single reading width. The audio player sits above the tabs and plays under either. The recap tab opens first when a recap exists; the transcript tab opens first while the meeting is still transcribing, and a link with a `?t=` position opens the transcript tab at that position. Tabs follow the full keyboard tab pattern: arrow keys move between tabs, Home and End jump to the first and last, and Tab moves into the panel.

The settings page is organised in tabs under its title, one route per tab: General, Login, Transcription, Recap, Sharing and retention, Webhooks and Audit log. The strip uses the same tab look and keyboard pattern; arrows move focus and Enter or Space opens a tab, because opening one is a navigation. Each tab with fields is its own form with one Save at the bottom. A tab with unsaved changes has a dot on its label, and leaving it asks first. On a phone the strip scrolls sideways with the selected tab in view.

Below 720 px, the sidebar becomes a Sheet opened by the menu button. Keep the install name and user avatar in a 56 px top bar. Use 20 px content padding and 44 px touch targets. Library rows stack metadata under the title. Meeting actions wrap. The meeting page keeps the same 2 tabs on a phone. Never squeeze 2 text columns onto a phone.

The reference includes 1280 px canvases for every surface. The recorder is 360 × 520 px inside its canvas. The live window is 420 × 200 px. The library and meeting also have 390 px references. The empty library has its own figure. Figure 07 is the settings page on its General tab and figure 07b on its Transcription tab. Figure 11 is the General tab again with a different accent, to show the derivation. Use the theme switch to inspect the same layouts in dark mode.

## Colour and shadcn mapping

[tokens.css](tokens.css) is the source of truth. Colours are complete CSS values, for example `var(--background)`, not HSL channel triples. With modern shadcn and Tailwind, map semantic utilities through `@theme inline`, for example `--color-background: var(--background)` and `--color-primary: var(--primary)`. With older templates, replace `hsl(var(...))` wrappers with `var(...)`. Do not wrap these values in `hsl()`.

Add `.dark` to `html` for dark mode, as shadcn does. `.light` forces light tokens on a subtree; the guidelines use it to show both themes side by side. The preview switch is a design review tool; an implementation can follow the operating system. Theme in the spec is the two colours below, not a light or dark choice.

The table gives the values for the default theme inputs. Accent and primary rows are derived; see Theming.

| shadcn variable | Light | Dark | Role |
| --- | --- | --- | --- |
| `--background` / `--foreground` | #fafafa / #222222 | #111111 / #f5f5f5 | Canvas and body text |
| `--card` / `--card-foreground` | #ffffff / #222222 | #1a1a1a / #f5f5f5 | Cards and editor panels |
| `--popover` / `--popover-foreground` | #ffffff / #222222 | #1a1a1a / #f5f5f5 | Menus, Command and template picker |
| `--primary` / `--primary-foreground` | #111111 / #ffffff | #f4f4f4 / #111111 | Main action, never a large green fill. Derived from `--theme-primary` |
| `--primary-hover` (mtxt) | #323232 | #dedede | Main action on hover |
| `--secondary` / `--secondary-foreground` | #f5f5f5 / #444444 | #242424 / #e5e5e5 | Quiet controls |
| `--muted` / `--muted-foreground` | #eeeeee / #666666 | #292929 / #b3b3b3 | Subtle fill and secondary text |
| `--accent` / `--accent-foreground` | #f4f6f3 / #566b45 | #23291f / #8a9a7f | Selected items and keyterm highlights. Derived from `--theme-accent` |
| `--destructive` / `--destructive-foreground` | #ad5437 / #ffffff | #d4876a / #111111 | Warning and destructive action; use text labels too |
| `--border` / `--input` | #e5e5e5 / #e5e5e5 | #333333 / #444444 | 1 px boundaries |
| `--ring` | #566b45 | #8a9a7f | 2 px focus outline with 2 px offset |
| `--radius` | 0.6rem | 0.6rem | shadcn base radius; use explicit shape tokens below |
| `--chart-1` | #566b45 | #8a9a7f | First series |
| `--chart-2` | #8a9a7f | #bac3b3 | Second series |
| `--chart-3` | #333333 | #eeeeee | Third series |
| `--chart-4` | #666666 | #b3b3b3 | Fourth series |
| `--chart-5` | #999999 | #888888 | Fifth series |
| `--sidebar` / `--sidebar-foreground` | #ffffff / #444444 | #1a1a1a / #e5e5e5 | Navigation surface and text |
| `--sidebar-primary` / `--sidebar-primary-foreground` | #111111 / #ffffff | #f4f4f4 / #111111 | Sidebar main action, follows `--primary` |
| `--sidebar-accent` / `--sidebar-accent-foreground` | #f4f6f3 / #566b45 | #23291f / #8a9a7f | Active navigation item |
| `--sidebar-border` / `--sidebar-ring` | #eeeeee / #566b45 | #333333 / #8a9a7f | Sidebar divider and keyboard focus |

`--sidebar-background` aliases `--sidebar` for older shadcn versions. Sidebar foreground pairs follow the same contrast rules as the main shell.

The accent family keeps the roles of the source site's sage shades. With the default accent #566b45: `--accent-strong` #566b45, `--accent-secondary` #5c6f4e, `--accent-text` #617551, `--accent-light` #8a9a7f; tints `--accent-tint` #f4f6f3, `--accent-tint-soft` #f6f7f5, `--accent-tint-strong` #eff1ed; lines `--accent-line` #e7ebe5, `--accent-line-strong` #e2e6df, `--accent-line-control` #dde1d9; `--accent-deep` #262c21. Each has a dark counterpart. Use them for highlights, callouts and meters, always by variable.

`--line-subtle` is #eeeeee in light mode. `--text-strong` is #333333. `--text-muted` is #999999 and is only for decorative or redundant metadata. Essential labels use `--muted-foreground` or stronger. `--overlay` is the backdrop behind a Dialog or Sheet. Warning labels are coloured text with an icon in both themes, never a filled chip; dark mode uses the lighter #d4876a for legibility. Chart colours need direct labels or patterns, since monochrome values can be hard to distinguish. They do not introduce dashboard features.

## Theming

An install sets two values in settings: the accent colour and the button colour. They become `--theme-accent` (default #566b45) and `--theme-primary` (default #111111) at the top of tokens.css. Everything else follows:

- The accent family, `--accent`, `--accent-foreground`, `--ring`, `--chart-1`, `--chart-2` and the sidebar accent tokens derive from `--theme-accent` with `color-mix()` in oklab: towards white for tints and lines, towards #111111 for dark-mode tints and lines, towards #888888 for the secondary shade. Dark mode lifts the accent itself 33 percent towards white.
- `--primary` is `--theme-primary`; `--primary-hover` mixes in 17 percent white. In dark mode the main action is 4 percent of the button colour in white (12 percent for hover), so it stays near-white with a hint of its hue and keeps #111111 text.
- The neutral scale and the warning hue are fixed for every install.

A value is refused when any of these pairs falls below 4.5:1 in either theme: `--accent-text` on `--background`, `--primary-foreground` on `--primary`, `--accent-foreground` on `--card`. The guidelines page computes the same check live. Custom properties resolve where they are declared, so a subtree that previews other values (the settings preview, figure 11) carries `data-theme-preview` to have the derived tokens recomputed.

The recorder reads the same two values at login and derives its colours the same way.

The derived defaults sit close to the site's own sage shades; the largest difference is `--accent-light`, which mixes to #8a9a7f against the site's #8c9e74, because mixing with white also lowers chroma.

## Locales

The interface is written in English and translated; Danish is the first translation. [locales/en.json](locales/en.json) is the source and [locales/da.json](locales/da.json) the translation. They are the first real locale files of the product: `apps/web` is seeded from them, and `apps/recorder` gets its own set. Since v0.1 packet 1, the app's own files in `apps/web/messages/` are authoritative for its strings; the files here stay the mockups' copy, have drifted from the app on purpose, and are not to be synced with it in either direction.

- Keys are flat and namespaced by screen or component: `nav.myMeetings`, `library.search.placeholder`, `meeting.tabs.recap`, `settings.theme.accent`, `recorder.queue.pendingNetwork`. Shared words live under `common.*`, `visibility.*`, `status.*` and `format.*`.
- Messages use ICU syntax. Arguments carry names and counts; plurals are `{count, plural, one {# meeting} other {# meetings}}`. Never concatenate strings.
- Dates, times, durations and lists go through the locale (`locale.intl` is en-GB or da-DK): "22 Oct 2026" and "22. okt. 2026", "09:00" and "09.00", "42 min" and "42 min.".
- Interface is every label, button, placeholder, `aria-label`, `title`, option text, state word, error and help text. Data is what users and the company create: people's names, meeting titles, transcript text, recap content, template names and bodies, keyterms, the product name and the company name. Data is never translated and carries its own `lang` attribute when it differs from the interface.
- The mockups mark text with `data-i18n="key"` and attributes with `data-i18n-attr="aria-label:key,placeholder:key2"`; a small script applies the chosen language and sets `<html lang>`. The gallery chrome around the screens is documentation and stays English.
- mtxt.co is English only and is not in these files.

## Density, spacing and shape

| Token or pattern | Value | Use |
| --- | --- | --- |
| `--space-1` through `--space-6` | 4, 8, 12, 16, 20, 24 px | Icon gaps, control padding, card interiors |
| `--space-8`, `--space-10`, `--space-12`, `--space-16` | 32, 40, 48, 64 px | Page padding and section separation |
| Desktop control | 40 px minimum height | Buttons, inputs and selects |
| Mobile control | 44 px minimum height | Touch targets, including icon buttons |
| Library row | About 88 px | Title, date, duration, speakers, visibility and state |
| `--radius-control` | 0.6rem | Inputs, secondary buttons |
| `--radius-card` | 0.75rem | Meeting lists and cards |
| `--radius-panel` | 1rem | Editor, login and native window panels |
| `--radius-pill` | 2rem | Filter pills, badges and primary buttons |
| Border | 1 px | All panels and control boundaries |
| `--floating-shadow` | Soft 16 px / 48 px shadow | Native floating windows only |

Keep spacing on the 4 px grid. Compact native queue rows can use 12 px type but retain a visible status label. Native title bars are platform chrome and do not follow the app spacing grid.

## Typography

Mona Sans is the only product face. Use variable weights, 400 for body, 550 for controls and 650 for headings. The app root is 16 px. Marketing body text is 18 px. Let browser zoom enlarge both. Use tabular numerals for timestamps, dates and meters.

| Role | Size | Line height | Tracking |
| --- | --- | --- | --- |
| Caption / metadata | 12 px | 1.5 | 0 |
| Control / secondary label | 14 px | 1.5 | 0 |
| App body / transcript | 16 px | 1.65 | -0.01em |
| Marketing body | 18 px | 1.7 | -0.01em |
| Panel heading | 20 px | 1.3 | -0.03em |
| Mobile page heading | 24 px | 1.2 | -0.03em |
| Desktop page heading | 32 px | 1.15 | -0.04em |
| Marketing display | 56 px | 1.06 | -0.055em |

The font file is copied unchanged from the supplied site asset. Copyright 2022 The Mona Sans Project Authors (https://github.com/github/mona-sans), with Reserved Font Name "Mona". It is licensed under the SIL Open Font License 1.1; the full text is in [fonts/LICENSE-mona-sans.txt](fonts/LICENSE-mona-sans.txt). It is a font exception to the code dependency policy. It is not licensed under PolyForm. Retain its embedded copyright and licence metadata when distributing it. No other third-party code or image assets are copied into these mockups.

## Component inventory

| Pattern | shadcn component | Behaviour and states |
| --- | --- | --- |
| Main action, provider login, export | Button | Dark primary, bordered secondary, text tertiary. Loading keeps its label. |
| Visibility and processing state | Badge | Private, Shared, Company; Ready, Transcribing. Icons and words accompany colour. |
| Search, title, product name, keys | Input | Persistent label, visible focus and inline errors. Secret fields stay masked. |
| Provider, language, visibility, template | Select | Owner-only visibility. Named sharing opens a Dialog with directory selection. |
| Accent and button colour | Input (colour) | Native colour input with the hex beside it. Refuses a value below 4.5:1 and says why. |
| Recap / transcript on the meeting page; the settings page's sections | Tabs | Exclusive panels with the full keyboard tab pattern. Same tabs on desktop and phone; the mockups switch tabs. Settings tabs are routes and scroll sideways on a phone. |
| Share, rename speaker, export, retention confirmation | Dialog | Restore focus on close. Destructive actions require a named confirmation. |
| Mobile navigation | Sheet | Menu button exposes state. Trap focus and close on Escape. |
| Recap data and audit metadata | Table | Semantic column headers; horizontal scroll only within a wide table. |
| Live transcript, keep flag, MCP | Toggle | Text label and pressed state. Never communicate state with colour alone. |
| Linked speaker and signed-in user | Avatar | Initials fallback; linked speaker opens colleague details. Unlinked label offers rename and directory linking. |
| Search across permitted meetings | Command | Keyboard navigation and result context. Never show private results to an admin without access. |
| Filter pills | Button | `aria-pressed` on independent filters; accent tint selected state. |
| Audio timeline | Slider with Button | Named play, seek, elapsed time, duration and playback rate. Keyboard accessible. |
| Upload queue | Badge with Progress | Count, progress, retry and acknowledgement states. |
| Recap editor | Open Tiptap core with Toolbar | No Pro extensions. Heading, bold, italic, list, link and Undo as labelled buttons with inline icons. Block handles, slash menu and colleague mentions. |

The recap supports headings, quotes, note and warning callouts, lists, checklists, toggles, table of contents, tables, divider, code and images. The reference shows a heading, note, decisions with owners, a table and a toggle. Each quiet save after 1.5 seconds creates a version. The UI separates AI draft v1 from named human edits. Export offers Markdown and Word. Template selection belongs to the meeting; template editing belongs to settings.

## State and data rules

Visibility uses words and a small icon. Private is the default in the reference install. The meeting owner sees the visibility control. A reader sees only a badge. Admins can see private meeting metadata and audit events, never its transcript or recap. The keep flag exempts audio, transcript and recap from retention.

The recorder confirms only after the server verifies the whole file and its SHA-256 hash. Its local 7-day timer starts at confirmation. Without confirmation it retains the file and retries. It warns after 24 hours and asks the user after 7 days. The queue reference shows uploading, confirmed, network pending and a 24-hour warning. The 7-day question uses a Dialog. Do not silently discard an unconfirmed recording.

Live text is an optional local preview. It is off by default and discarded when the meeting ends. The server transcript is the record. The recorder's model picker offers downloaded Parakeet or Whisper. This user setting is separate from the admin's final STT provider.

The data-flow panel must name the selected provider and the destination of audio. Show R2 EU audio storage and EU upload sessions. Explain that the install tooling creates D1 and the queues with EU jurisdiction, that Worker placement is best effort without the Enterprise localization add-on, and Workers AI and AI Gateway are not covered by Regional Services. Do not promise EU-only processing. AssemblyAI receives audio and keyterms directly; supported providers and the recap model can use AI Gateway. Retention remains explicit.

## Icons, motion and accessibility

Use Lucide at 20 px with a 1.5 px stroke. Small metadata icons can be 16 px. Icons inherit text colour. The mockups use a small inline SVG symbol set with the same stroke treatment and no remote icon dependency. Provider marks are monochrome text, not external logo assets. Icon-only buttons have accessible names from the locale files.

State changes use 150 ms ease-out transitions for background, colour and border. Do not animate layout, transcript scrolling or audio activity in this reference. `prefers-reduced-motion: reduce` removes animation and transitions. Use a visible 2 px focus ring in the accent colour. Forms have labels and help text. Player controls and toggles use native keyboard behaviour. The preview provides tab navigation, theme and language switching and a mobile navigation Sheet. Other actions illustrate layout only.

## Native recorder windows

| Platform | Main window | Live transcript window |
| --- | --- | --- |
| macOS | Native title bar and standard close, minimize and zoom controls. Use system traffic lights, never web imitations in production. Closing hides the window while an active capture or upload continues in the menu bar. | Utility panel, always on top, 420 × 200 logical px initially. A draggable title area excludes buttons. Hide returns it to the menu bar. |
| Windows | Native title bar with minimize, maximize and close. Respect DPI scaling and the snap system. Closing hides to the tray during capture or upload. | Always-on-top tool window with normal focus behaviour. The title area supports dragging. Hide leaves capture running. |

The main recorder starts at 360 × 520 logical px. Allow resizing and scrolling when text scaling needs more space. The red live dot uses the single destructive hue. It means recording is active and always has the word "Live" beside it. Pause pauses the local text preview; it does not stop the recording. Hide hides only the preview. Stop recording remains an explicit control in the main recorder. Respect operating system capture permissions. Do not add global hotkeys or dictation controls.

## Reference validation

Serve the repository root with a static server and open `docs/design/mockups/index.html` and `docs/design/guidelines.html`. Check local CSS, font and locale loading, each caption and frame size, both themes, both languages, the 390 px layouts, keyboard focus and reduced motion. `?theme=dark` and `?lang=da` open the mockups in that state; `?accent=%23rrggbb` presets the guidelines' theme panel. The pages are static references, so provider login, recording, editing, saving and export are not functional.
