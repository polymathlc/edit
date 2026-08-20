# 🎨 Photo Editor

Paste a picture, edit it, take a file away.

**Nothing is uploaded and nothing is saved.** There is no account, no database
and no storage bucket in this app — the picture is read into a canvas in your
own browser and it never leaves the tab.

Two static files. Open `index.html` and it works.

---

## Where it came from

This is the image touch-up editor out of the **Science Learning Portal**
([polymathlc/cer](https://github.com/polymathlc/cer), `app.js` — search
`IMAGE TOUCH-UP & LABELS`), lifted into its own app.

Over there the editor is always reached *through* something — a question's
diagram, an answer-key picture, a Realm of Embers art slot — and ✓ Apply writes
the picture back to whatever it was opened from. Here there is nothing behind
it, so a picture comes in off the clipboard and leaves as a file.

The whole `_annot*` section of `editor.js` is a **verbatim copy** of the
portal's, so a bug fixed in one can be diffed straight across. Everything that
differs is called out in a comment where it sits, and there are only six such
places — see `CLAUDE.md`.

---

## Using it

### Getting a picture in

Three ways, and they all end at the same door:

- **Paste** — <kbd>Ctrl</kbd>+<kbd>V</kbd> / <kbd>⌘V</kbd> anywhere on the page
- **Drop** a file anywhere on the window
- **Click** the box and pick a file

### Editing

| | |
|---|---|
| 🩹 **Erase** | Cuts through to transparent by default — the ⬜/▨ button flips it to painting white, for rubbing a word off a scan |
| 🖌️ **Paint** / 🪣 **Fill** | Brush and paint bucket. Click then <kbd>Shift</kbd>-click joins two points with a straight line |
| 🧬 **Clone** | Set a source, then stamp it elsewhere — the ring under the pointer shows the exact patch it is about to lay down |
| 🕘 **History** | Brush the original picture back by hand, one stroke at a time |
| ⬚ **Select** / ➰ **Lasso** / 🪄 **Wand** | Mark out an area, then move / resize / rotate / skew / delete-to-transparent / fill it. <kbd>Alt</kbd>+click with the wand takes a colour across the **whole** picture — that is how you cut a background away cleanly |
| ⤢ **Resize** · 🔄 **Rotate** · ▱ **Skew** | Free transform with eight handles. 📐 **Straighten** levels a crooked scan by tracing a line along an edge it should be parallel to |
| 📏 **Line** · 🔤 **Text** | Labelling |
| 🧻 **Clean paper** | Snaps a grey scan background to pure white without touching the drawing. Refuses outright on a photograph |
| ✨ **Regenerate** | Type what you want changed and the AI redraws it — the whole picture, or only the area you selected |

Keys: <kbd>E</kbd> erase · <kbd>B</kbd> paint · <kbd>G</kbd> fill · <kbd>S</kbd>
clone · <kbd>Y</kbd> history · <kbd>M</kbd> select · <kbd>L</kbd> lasso ·
<kbd>W</kbd> wand · <kbd>V</kbd> move · <kbd>R</kbd> rotate · <kbd>K</kbd> skew ·
<kbd>F</kbd> resize · <kbd>U</kbd> line · <kbd>T</kbd> text ·
<kbd>[</kbd> <kbd>]</kbd> brush size · <kbd>Del</kbd> delete the selection ·
<kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>+</kbd> <kbd>−</kbd> zoom ·
<kbd>0</kbd> fit · <kbd>Esc</kbd> deselect · <kbd>Enter</kbd> apply

Scroll to zoom (down to individual pixels), hold <kbd>Space</kbd> and drag to
pan.

### Pasting a second picture on top

Press <kbd>Ctrl</kbd>+<kbd>V</kbd> while the editor is open and whatever is on
the clipboard lands **as its own layer** — scaled to fit inside the picture
rather than covering it, with the resize handles already on it. Drag a corner to
size it, drag the middle to move it, turn or slant it, then **✓ Apply** to burn
it in. <kbd>Esc</kbd> takes it away again and leaves no trace.

The layer keeps the pasted picture at its own resolution, so dragging a handle
back out resamples from the full bitmap instead of magnifying an
already-shrunken one.

### Getting it out

**⬇️ Export…** opens a panel:

- **Format** — PNG (lossless, keeps transparency), JPEG (much smaller, no
  transparency), WebP (small *and* keeps transparency)
- **Quality** for the two lossy formats
- **Size** — presets, a slider, or type a target for the longest side in pixels
- **File name**
- **The real file size**, which is a genuine encode at those settings and not an
  estimate — so the number you read is the file you get

Then **⬇️ Download**, or **📋 Copy image** to put it straight on your clipboard,
ready to paste into a document, a slide or a chat.

**⬇️ Quick PNG** in the editor skips all of that and saves a full-size PNG
immediately.

A picture that has transparent areas says so, loudly, the moment you pick a
format that cannot keep them — a cut-out saved as a JPEG comes back with a
white box round it, and that is the one export mistake you only notice later.

---

## The AI is optional

✨ **Regenerate** and ✨ **AI content-aware fill** are the only two things here
that touch the network. They run on the portal's Firebase AI Logic project.

If that is unavailable — offline, blocked, the project gone — both buttons
**hide themselves** and everything else works exactly as before. To turn the AI
off entirely, set `AI_ENABLED = false` at the top of `editor.js`; nothing is
then fetched from anywhere.

---

## Running it

Any static host. It is two files and there is no build step.

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

On GitHub Pages it lives at `polymathlc.github.io/edit/`, a sibling of the
other Polymath apps.

## Tests

```bash
node tools/handler-tests.mjs        # the wiring between the markup and the module
node tools/browser-smoke.mjs        # the app, driven in a real browser (needs Playwright)
```
