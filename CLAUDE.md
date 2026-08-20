# CLAUDE.md

Guidance for Claude when working in this repo.

## What this is

A standalone photo editor: `index.html` + `editor.js`, two static files, no
build step and no dependencies. A picture comes in off the clipboard, a drop or
a file picker; it is edited; it leaves as a downloaded file or as an image on
the clipboard.

**Nothing is uploaded and nothing is saved.** There is no account, no Firestore,
no Storage and no server in this app. The only network call it can make is the
optional image-AI one. If you find yourself adding a save path, stop and decide
first whose data it is — a picture somebody dropped in here is theirs, and the
promise on the landing page is that it never leaves the tab.

## It is the SAME editor as the portal's — keep it diffable

The whole `_annot*` section of `editor.js` is a **verbatim copy** of the image
touch-up editor in **`polymathlc/cer`** (`app.js`, search
`IMAGE TOUCH-UP & LABELS`). That repo's `CLAUDE.md` documents the editor's own
internals at length — the transform session, the M-frame resize maths, the
brush ring, the clone preview, the paste scope, `_annotResetCompose` — and all
of it applies here unchanged. **Read it there rather than restating it here.**

A fix made in either repo should be diffable straight into the other, which is
the whole reason the copy is verbatim. **There are exactly six places where
this app deliberately differs**, each carrying a comment where it sits:

1. **The door in** — `_peOpen` and the landing page. The portal reaches the
   editor through a question's image block, an answer-key diagram or a card-art
   slot; here there is one door and three ways to it (paste, drop, pick), all
   ending at `_peOpen`.
2. **The door out** — `applyAnnotTool`. There it wrote the picture back to
   whatever it was opened from, through five branches. Here **Done is the
   export**: it opens the export panel and nothing else.
3. **The canvas ceiling** — `ANNOT_MAX_PX` is 4096, not the portal's 1600. A
   question's diagram never needs more; this app is handed camera photos and the
   file you take away IS the product.
4. **The undo budget that pays for it** — `_annotPushHistory` caps the stack by
   **BYTES** (`ANNOT_HISTORY_BYTES`), not by a count. A full-frame snapshot of a
   4096px photo is 67 MB, so the portal's flat "keep the last ten" would hold two
   thirds of a gigabyte of RGBA. One step is always kept whatever it costs: an
   undo that silently is not there is worse than a slow one. **Raise the ceiling
   and re-check this budget.**
5. **What Erase leaves behind** — `eraseTo` starts on `'clear'`. Everything that
   leaves here is a PNG that keeps its alpha, so erasing means erasing. The ⬜/▨
   button still flips it to white for a scan of a printed page.
6. **The AI is optional and late** — see below.

Adding a seventh means writing it down here. A difference nobody recorded is a
difference that makes the next diff unreadable, and then the two editors drift.

## The AI fails soft, and that is load-bearing

✨ Regenerate and ✨ AI content-aware fill are the only things in this app that
touch a network. They use Firebase AI Logic on the portal's project, imported
**dynamically** so the editor is usable the instant the page paints rather than
behind a 300 KB SDK download.

- `imageAiReady()` is read at **call** time, never at module-eval time, because
  the models arrive late.
- If the init throws — offline, blocked, the project gone — `geminiImageModels`
  stays empty and **`_aiVisibilitySync` hides both buttons outright**. A button
  that costs a click and answers with an error toast is worse than a button that
  is not there.
- `_initImageAi` calls `_aiVisibilitySync`, **not** `_annotAiBarInit`: that one
  also clears the prompt box, and the SDK can land while somebody is typing in
  it.
- `AI_ENABLED = false` at the top of the file turns the whole thing off and
  fetches nothing from anywhere.

**No API key belongs in this repo.** These files are served to every visitor;
the Firebase web config is not a secret (it is protected by App Check and the
project's rules), an OpenAI-style key would be. `tools/handler-tests.mjs` fails
on an `sk-`-shaped string in either file.

## The export panel

`ex*` in `editor.js` — the one thing here the portal does not have, because
there the export was a single full-size PNG.

- **The size shown is a REAL ENCODE, never an estimate.** The picture is
  genuinely re-encoded at the chosen settings and the resulting Blob measured,
  so "1.4 MB" is the file you are about to get. A guess from pixel count × a
  fudge factor is wrong by a factor of ten on a photo versus a diagram, which is
  exactly the pair of cases this app handles.
- …so it is **debounced** (`EX_ENCODE_DEBOUNCE`) and the panel says it is
  working, and **`_exRun` is what stops a slow encode of an older setting
  landing on top of a newer one** — the panel would then show a size for a file
  nobody is about to download. Pressing Download while an encode is unsettled
  re-encodes rather than saving the previous settings (`_exCurrentBlob`).
- **PNG is the default and keeps transparency.** A cut-out saved as a JPEG comes
  back with a box round it, which is the one export failure that looks fine in
  the panel and is discovered later — so a picture that actually HAS transparent
  pixels (`_exHasAlpha`, sampled) says so the moment a lossy format is picked,
  and offers the fill colour rather than letting the browser default it to
  black.
- **Scaling is DOWN only.** Every percentage over 100 is invented detail. The
  longest-side box and the percentage are the same knob read two ways, so they
  can never disagree.
- **The clipboard is always PNG.** `image/png` is the one type every OS and
  browser agrees on for a copied picture — a JPEG on the clipboard is silently
  dropped by most of them — so 📋 Copy encodes a PNG whatever the download
  format is, and says so rather than pretending the quality slider did
  something. The `ClipboardItem` is handed the **promise**, not an awaited blob,
  or Safari refuses the write for happening outside the gesture.
- It only ever **reads** the canvas, so Esc puts you back in the editor with
  everything intact.

## The module has its own scope

`editor.js` is loaded as `<script type="module">`, so nothing in it is visible
to an `onclick=""` in the markup. Every function the HTML calls by name has to
be in the `Object.assign(window, {…})` block at the bottom of the file. Miss one
and the button draws, the pointer changes, and the click throws
`x is not defined` into a console nobody has open.

`tools/handler-tests.mjs` is the only thing that catches it — it reads both
files and pins the wiring in both directions (every inline handler is exported;
every export exists; every `getElementById` id is in the markup). **Run it after
touching either file.**

## Two CSS traps carried over from the portal

- **A `<button>` does not inherit `color`** the way a div does — it falls back
  to the browser's own near-black button text, which disappears the moment a
  surface goes dark. Any card-shaped button must set `color: var(--text)`
  itself.
- **A bare `<input type=radio>` / `checkbox` needs `appearance: auto`** anywhere
  a CSS reset has been near it, or it renders as an invisible white box.

## Design convention — breathing space

Generous, consistent padding inside cards and panels; clear vertical spacing
between title → description → controls; comfortable line-height. Cards are
rounded rectangles constrained to a sensible max-width, not dense full-bleed
blocks. When something reads as "too big / thick / messy", the fix is usually
*more* whitespace and a tighter width, not smaller type.

## House rules

- After editing `editor.js`, validate it: `cp editor.js /tmp/c.mjs && node --check /tmp/c.mjs`
  (the `.mjs` copy makes Node parse it as a module, so a top-level `import` is
  accepted).
- Run **`node tools/handler-tests.mjs`** after touching `index.html` or
  `editor.js`. Both failures it catches are completely silent from the outside.
- Run **`node tools/browser-smoke.mjs`** after touching anything structural. It
  needs Playwright (`npm install --no-save playwright`) and a server on :8899.
  It is the only check that catches the failures living in the joins.
- Do not commit `node_modules/` — Playwright is a `--no-save` install for the
  smoke test, not a dependency of the app. The app has none.
- Commit messages and pushed artifacts must not contain the model identifier.
