// =====================================================================
// POLYMATH PHOTO EDITOR — the touch-up tool, on its own
// =====================================================================
// This is the image editor out of the Science Learning Portal
// (polymathlc/cer, `app.js`, search "IMAGE TOUCH-UP & LABELS"), lifted into
// its own app. Over there it is always reached THROUGH something — a
// question's diagram, an answer-key picture, a Realm of Embers art slot — and
// ✓ Apply writes the picture back to whatever it was opened from.
//
// Here there is nothing behind it. A picture comes in off the clipboard, a
// drop or a file picker; it is edited; it leaves as a file you download or as
// an image on your clipboard. NOTHING IS UPLOADED AND NOTHING IS SAVED — the
// picture never leaves the tab, and there is no account, no database and no
// storage bucket in this app at all.
//
//  • IT IS THE SAME EDITOR, DELIBERATELY. The whole `_annot*` section below is
//    a verbatim copy of the portal's, so a bug fixed in one can be diffed
//    straight across. What differs is called out in a comment where it sits,
//    and there are only six such places: the door in (`_peOpen`), the door out
//    (`applyAnnotTool` → the export panel), the canvas ceiling, the undo
//    budget that pays for it, what Erase leaves behind, and this header.
//    Keep it that way. A second editor is a second editor to fix everything in.
//  • THE AI IS OPTIONAL AND FAILS SOFT. ✨ Regenerate and ✨ AI content-aware
//    fill are the only things here that need a network at all, and they need
//    the portal's Firebase project. If that init throws — offline, blocked,
//    the project gone — `imageAiReady()` is false, the purple bar hides
//    itself and the AI fill button goes with it. Everything else works with
//    the network unplugged, which is the point of a tool like this.
// =====================================================================

// ── The optional AI ──────────────────────────────────────────────────────
// Firebase AI Logic on the same project the portal uses. No auth, no
// Firestore, no Storage — just App Check (which protects the image quota) and
// the image models. The reCAPTCHA key is registered for polymathlc.github.io,
// and these four apps are sibling folders on that one origin, so it covers
// this app without a second registration.
//
// To run this app with NO AI at all, set AI_ENABLED to false: everything below
// is skipped, nothing is fetched from gstatic, and the two AI buttons hide.
const AI_ENABLED = true;
const AI_IMAGE_MODELS = ["gemini-3.1-flash-image-preview", "gemini-2.5-flash-image"];
const RECAPTCHA_SITE_KEY = "6Le98gwtAAAAAAzkjJTZXFM5D8tpjx_P4rtRuhuH";
const firebaseConfig = {
  apiKey: "AIzaSyAUSI3Uh28IeqASEp0JhH4QPaVt-O3meBo",
  authDomain: "mathgen--app.firebaseapp.com",
  projectId: "mathgen--app",
  storageBucket: "mathgen--app.firebasestorage.app",
  messagingSenderId: "165654161198",
  appId: "1:165654161198:web:16c8bd60eb3a2aa7edbcbf"
};

let geminiImageModels = [];
// `imageAiReady` is read at CALL time by the editor, never at module-eval
// time, so the models can arrive late — which they do, because the whole
// Firebase import is dynamic. That is what keeps the editor itself usable the
// instant the page loads instead of behind a 300 KB SDK download.
const imageAiReady = () => geminiImageModels.length > 0;

async function _initImageAi() {
  if (!AI_ENABLED) return;
  try {
    const V = "https://www.gstatic.com/firebasejs/11.10.0/";
    const [{ initializeApp }, { initializeAppCheck, ReCaptchaV3Provider }, { getAI, getGenerativeModel, GoogleAIBackend, ResponseModality }] =
      await Promise.all([
        import(V + "firebase-app.js"),
        import(V + "firebase-app-check.js"),
        import(V + "firebase-ai.js")
      ]);
    const fbApp = initializeApp(firebaseConfig);
    try {
      initializeAppCheck(fbApp, { provider: new ReCaptchaV3Provider(RECAPTCHA_SITE_KEY), isTokenAutoRefreshEnabled: true });
    } catch (e) { console.warn("App Check init failed:", e); }
    const ai = getAI(fbApp, { backend: new GoogleAIBackend() });
    geminiImageModels = AI_IMAGE_MODELS.map(model => getGenerativeModel(ai, {
      model,
      generationConfig: { responseModalities: [ResponseModality.TEXT, ResponseModality.IMAGE] }
    }));
  } catch (e) {
    console.warn("Image AI unavailable — everything else still works:", e);
    geminiImageModels = [];
  }
  // The purple ✨ Regenerate bar and the ✨ AI fill button ask imageAiReady()
  // when they are drawn, so if the models landed after the editor was already
  // open they have to be asked again. NOT _annotAiBarInit(), which also clears
  // the prompt box — the SDK can land while somebody is typing in it.
  _aiVisibilitySync();
}
function extractInlineImage(result) {
  const inlineParts = result?.response?.inlineDataParts ? result.response.inlineDataParts() : [];
  for (const p of inlineParts || []) {
    const img = p.inlineData || p;
    if (img?.data && img?.mimeType?.startsWith('image/')) return img;
  }
  const candidates = result?.response?.candidates || result?.candidates || [];
  for (const c of candidates) {
    for (const p of (c?.content?.parts || [])) {
      const img = p.inlineData || p.inline_data;
      if (img?.data && img?.mimeType?.startsWith('image/')) return img;
      if (img?.data && img?.mime_type?.startsWith('image/')) return { data: img.data, mimeType: img.mime_type };
    }
  }
  return null;
}

// kind of quiet damage the game-art cutters are so careful about.
// =====================================================================

// A background darker than this is not paper — a photo, a dark artwork, a
// screenshot of a dark UI — and the pass is refused rather than dragging its
// mid-tones up to white.
const PAPER_WHITE_MIN = 200;
// How much of the picture the near-white background has to be. A bright patch
// in a photograph is not a page.
const PAPER_BG_MIN = 0.30;
// How far below the measured white point still counts as background. The weave
// is only a few units deep and a grey scan a couple of dozen; a deliberate pale
// grey fill in a diagram sits well below this and is kept.
const PAPER_TEX_DEPTH = 20;
// …and how far from grey a background pixel may drift. A pale wash of real
// colour — the blue of water in a beaker — is part of the drawing, whatever
// its brightness.
const PAPER_TEX_CHROMA = 22;
// The picture must have line work to be worth protecting: below this there is
// no drawing here, so there is nothing this pass can be said to be cleaning.
const PAPER_INK_MIN = 0.004;
// Ink is what must survive the pass untouched. Nothing at or below this
// brightness is ever written to, by construction — the assertion is in the
// harness, because "the pass ate the diagram" is the one failure that would
// look like a beautifully clean picture.
const PAPER_INK_MAX = 128;

// Where the paper's white sits. The 98th percentile rather than the maximum:
// one stray blown-out pixel must not set the white point for the whole page,
// and with a background covering most of the picture the 98th percentile lands
// squarely in it. Transparent pixels are not paper and are left out entirely.
function _paperWhitePoint(px) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 8) continue;
    const l = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 | 0;
    hist[l]++; n++;
  }
  if (!n) return { white: 0, n: 0 };
  const want = n * 0.98;
  let seen = 0, white = 255;
  for (let l = 0; l < 256; l++) { seen += hist[l]; if (seen >= want) { white = l; break; } }
  return { white, n, hist };
}

// The pass itself, over a raw RGBA buffer, in place. Returns a report; the
// caller decides what to say about it. `ok:false` means NOTHING was written —
// a refusal is all-or-nothing on purpose, because a picture that has been
// half-cleaned is worse than one that was left alone.
function _paperCleanPixels(px, w, h) {
  const { white, n, hist } = _paperWhitePoint(px);
  if (!n) return { ok: false, reason: 'empty', white: 0, changed: 0 };
  if (white < PAPER_WHITE_MIN) return { ok: false, reason: 'no-white', white, changed: 0 };

  const floor = white - PAPER_TEX_DEPTH;
  let bg = 0, ink = 0;
  for (let l = 0; l < 256; l++) { if (l >= floor) bg += hist[l]; else if (l <= PAPER_INK_MAX) ink += hist[l]; }
  if (bg / n < PAPER_BG_MIN) return { ok: false, reason: 'not-paper', white, changed: 0 };
  if (ink / n < PAPER_INK_MIN) return { ok: false, reason: 'no-ink', white, changed: 0 };

  let changed = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 8) continue;                       // a hole stays a hole
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const l = (r * 299 + g * 587 + b * 114) / 1000 | 0;
    if (l < floor) continue;                           // the drawing
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (chroma > PAPER_TEX_CHROMA) continue;           // a pale wash of real colour
    if (r === 255 && g === 255 && b === 255) continue; // already paper
    px[i] = 255; px[i + 1] = 255; px[i + 2] = 255;
    changed++;
  }
  return { ok: true, reason: 'cleaned', white, changed, bg: bg / n, ink: ink / n };
}

async function generateEnhancedImageDataUrl(prompt, media) {
  if (!imageAiReady()) throw new Error('AI image enhancement is not configured yet');
  const m = Array.isArray(media) ? media[0] : media;
  if (!m || !m.data) throw new Error('no image to enhance');
  const parts = [prompt, { inlineData: { mimeType: m.mimeType, data: m.data } }];
  let lastError = null;
  for (const model of geminiImageModels) {
    try {
      const result = await model.generateContent(parts);
      const img = extractInlineImage(result);
      if (img) return 'data:' + (img.mimeType || 'image/png') + ';base64,' + img.data;
      const text = result?.response?.text ? result.response.text() : '';
      throw new Error(text || 'the AI did not return an image');
    } catch (e) { lastError = e; console.warn('image enhancement model failed', e); }
  }
  throw lastError || new Error('AI image enhancement failed');
}

async function _urlToDataUrl(url) {
  // cache:'no-store' matters: if the page already showed this URL in a plain
  // <img>, the cached response has no CORS headers and a cache hit here would
  // fail the fetch (and taint any canvas the fallback image is drawn onto).
  const resp = await fetch(url, { mode: 'cors', cache: 'no-store' });
  if (!resp.ok) throw new Error('could not load the image');
  const blob = await resp.blob();
  return await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('could not read the image'));
    r.readAsDataURL(blob);
  });
}

// _urlToDataUrl with fallbacks. A plain fetch() can die with a bare
// "Failed to fetch" (CORS preflight/cache quirks, blockers) even though the
// very same URL displays fine in an <img>. Ladder: direct fetch → reload via
// a CORS-enabled <img> re-encoded through a canvas → the wsrv.nl image proxy,
// which serves any public image WITH CORS headers.
async function _urlToDataUrlRobust(url) {
  try { return await _urlToDataUrl(url); }
  catch (e) { if (/^(data|blob):/i.test(url || '')) throw e; console.warn('image fetch failed, trying fallbacks', e); }
  try {
    const im = await new Promise((res, rej) => {
      const i = new Image();
      i.crossOrigin = 'anonymous';
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('cors img load'));
      i.src = url + (url.includes('?') ? '&' : '?') + 'corscb=' + Date.now();
    });
    const cv = document.createElement('canvas');
    cv.width = im.naturalWidth || im.width || 1;
    cv.height = im.naturalHeight || im.height || 1;
    cv.getContext('2d').drawImage(im, 0, 0);
    return cv.toDataURL('image/png');
  } catch (e2) { console.warn('CORS <img> fallback failed, trying proxy', e2); }
  try { return await _urlToDataUrl('https://wsrv.nl/?url=' + encodeURIComponent(url)); }
  catch (e3) { throw new Error('could not load the image (the host blocked the request) — try re-uploading it'); }
}

function _loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not load the image'));
    img.src = src;
  });
}

const TOAST_MAX = 4;
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const same = Array.from(container.children).find(el => el.dataset && el.dataset.msg === message && el.dataset.type === type);
  if (same) {
    same.dataset.n = String((parseInt(same.dataset.n, 10) || 1) + 1);
    let tag = same.querySelector('.toast-count');
    if (!tag) { tag = document.createElement('b'); tag.className = 'toast-count'; same.appendChild(tag); }
    tag.textContent = ' ×' + same.dataset.n;
    clearTimeout(same._hide);
    same._hide = setTimeout(() => _toastFade(same), 3000);
    return;
  }
  while (container.children.length >= TOAST_MAX) container.removeChild(container.firstElementChild);
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.dataset.msg = message;
  toast.dataset.type = type;
  toast.dataset.n = '1';

  let icon = '';
  switch (type) {
    case 'success': icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>'; break;
    case 'error': icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'; break;
    default: icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
  }
  
  toast.innerHTML = icon + message;
  container.appendChild(toast);
  toast._hide = setTimeout(() => _toastFade(toast), 3000);
}
function _toastFade(toast) {
  if (!toast) return;
  toast.style.opacity = '0';
  toast.style.transform = 'translateX(30px)';
  toast.style.transition = '0.3s ease';
  setTimeout(() => toast.remove(), 300);
}
// =====================================================================
// IMAGE TOUCH-UP & LABELS — erase (paint white) or paint over words, draw
// straight label lines, and drop text labels onto an image block; then flatten
// the canvas and re-upload. Works on the image currently in the block.
// =====================================================================
(function injectAnnotStyles() {
  const css = `
  .annot-tools { display:flex; gap:8px; flex-wrap:wrap; align-items:center; justify-content:center; margin-bottom:12px; }
  .annot-tool { padding:6px 12px; border:1.5px solid var(--border,#e3e6e4); background:#fff; border-radius:8px; cursor:pointer; font-size:0.82rem; }
  .annot-tool:hover { border-color:var(--primary,#0b6b4f); }
  .annot-tool.active { border-color:var(--primary,#0b6b4f); background:var(--primary-light,#e8f3ec); color:var(--primary,#0b6b4f); font-weight:700; }
  /* The paint bucket shows what it will pour: the strip along its base (and the
     drip) are the exact colour currently chosen, updated live with the picker. */
  .annot-bucket { width:17px; height:18px; vertical-align:-4px; margin-right:2px; overflow:visible; }
  .annot-bucket-paint { fill:var(--annot-paint,#e23c3c); stroke:rgba(0,0,0,0.28); stroke-width:0.7; }
  .annot-tools kbd, .hint kbd { font-family:'Space Mono',monospace; font-size:0.72em; padding:1px 5px; border:1px solid var(--border,#e3e6e4);
    border-bottom-width:2px; border-radius:4px; background:var(--surface,#fff); white-space:nowrap; }
  #annotStage.moving #annotCanvas { cursor:move; }
  /* Bigger than the portal's stage. There the editor is a modal over a page of
     other work and 56vh is polite; here the picture is the entire app, so it
     gets the room. */
  #annotStage { position:relative; display:block; margin:0 auto; width:calc(100vw - 72px); max-width:1560px; height:min(66vh, 760px); overflow:hidden; line-height:0; background:#eef0ee; border:1px solid var(--border,#e3e6e4); border-radius:6px; touch-action:none; }
  /* The canvas keeps its alpha, so a sprite that has already had its background
     removed is edited transparent. This grey check behind it is how you can SEE
     which parts are empty — a card-art slot is often a cut-out. It is only ever
     visible where the picture is transparent, so an ordinary opaque question
     image looks exactly as it always did. (This is the editor's own backdrop,
     not something painted into a picture — the chequerboard an image model
     paints is a different thing entirely, and still banned in prompts.) */
  #annotCanvas { position:absolute; top:0; left:0; transform-origin:0 0; touch-action:none; cursor:crosshair; image-rendering:auto;
    background-color:#fbfbfb;
    background-image:linear-gradient(45deg,#dfe2df 25%,transparent 25%,transparent 75%,#dfe2df 75%),linear-gradient(45deg,#dfe2df 25%,transparent 25%,transparent 75%,#dfe2df 75%);
    background-size:16px 16px; background-position:0 0,8px 8px; }
  #annotSelCanvas { position:absolute; top:0; left:0; transform-origin:0 0; pointer-events:none; z-index:4; }
  #annotCanvas.pixelated { image-rendering:pixelated; image-rendering:crisp-edges; }
  #annotStage.panning, #annotStage.panning #annotCanvas { cursor:grabbing; }
  #annotStage.canpan #annotCanvas { cursor:grab; }
  .annot-textbox { position:absolute; z-index:5; }
  /* With the Move tool active the whole label is a drag target, not just its
     handle — that is what "move" means, and hunting for a 6px tab is not it. */
  .annot-textbox.movable .annot-textbox-input { cursor:move; }
  .annot-textbox-input { border:1px dashed var(--primary,#0b6b4f); background:rgba(255,255,255,0.92); border-radius:4px; outline:none; font-family:'DM Sans',sans-serif; font-weight:600; padding:1px 4px; line-height:1.3; min-width:60px; color:inherit; }
  .annot-textbox-handle { position:absolute; top:-19px; left:-1px; cursor:move; user-select:none; touch-action:none; background:var(--primary,#0b6b4f); color:#fff; font-size:11px; line-height:1; padding:3px 6px; border-radius:4px 4px 0 0; white-space:nowrap; }
  #annotCloneSrc { position:absolute; z-index:6; width:16px; height:16px; margin:-8px 0 0 -8px; border-radius:50%; border:2px solid #2d6ca8; background:rgba(37,99,235,0.18); box-shadow:0 0 0 1px rgba(255,255,255,0.8); pointer-events:none; }
  #annotCloneSrc::before, #annotCloneSrc::after { content:''; position:absolute; background:#2d6ca8; }
  #annotCloneSrc::before { left:6px; top:1px; width:2px; height:12px; }
  #annotCloneSrc::after { top:6px; left:1px; height:2px; width:12px; }
  /* The brush cursor: a ring the exact size of the mark about to be made, at
     the current zoom. Black ring inside a white one, so it stays visible on a
     white page and on black card art alike. */
  #annotBrushRing { position:absolute; z-index:7; box-sizing:border-box; border-radius:50%; pointer-events:none; display:none;
    border:1px solid rgba(0,0,0,0.9); box-shadow:0 0 0 1px rgba(255,255,255,0.9), inset 0 0 0 1px rgba(255,255,255,0.9); }
  /* Under a few screen pixels a circle is just a blob — draw a crosshair, the
     way every paint program does for a tiny brush. */
  #annotBrushRing.tiny { border-color:transparent; box-shadow:none; }
  #annotBrushRing.tiny::before, #annotBrushRing.tiny::after { content:''; position:absolute; background:rgba(0,0,0,0.85); box-shadow:0 0 0 1px rgba(255,255,255,0.9); }
  #annotBrushRing.tiny::before { left:50%; top:50%; width:1px; height:11px; margin:-5.5px 0 0 -0.5px; }
  #annotBrushRing.tiny::after { left:50%; top:50%; height:1px; width:11px; margin:-0.5px 0 0 -5.5px; }
  /* Clone stamp: the ring is FILLED with the pixels that would be stamped, so
     the mark is aimed by looking at it rather than by counting across from the
     source pin. The ring goes white-on-black while it is showing a picture —
     a black hairline over arbitrary artwork is the one thing that disappears. */
  #annotBrushRing.peeking { border-color:rgba(255,255,255,0.95); box-shadow:0 0 0 1px rgba(0,0,0,0.85), 0 2px 10px rgba(0,0,0,0.35); }
  #annotClonePeek { position:absolute; inset:0; width:100%; height:100%; border-radius:50%; display:none; pointer-events:none; }
  #annotBrushRing.peeking #annotClonePeek { display:block; }
  #annotClonePeek.pixelated { image-rendering:pixelated; image-rendering:crisp-edges; }
  #annotBrushHud { position:absolute; z-index:8; pointer-events:none; opacity:0; transition:opacity 0.16s ease; transform:translateX(-50%);
    background:rgba(17,20,18,0.88); color:#fff; font-family:'DM Sans',sans-serif; font-size:11px; font-weight:700; line-height:1;
    padding:5px 8px; border-radius:6px; white-space:nowrap; font-variant-numeric:tabular-nums; }
  #annotBrushHud.show { opacity:1; }`;
  const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
})();

let _annot = null;


// The editor itself, opened on a picture from anywhere. `target` is kept from
// the portal — there it says which of five places ✓ Apply writes the picture
// back to — but in this app there is only ever one kind, `standalone`, and the
// field is left in so the two editors stay diffable against each other.
function _annotOpenSrc(srcP, target, title) {
  srcP.then(_loadImageEl).then(img => {
    const canvas = document.getElementById('annotCanvas');
    // The working ceiling. This app is handed real photographs and the whole
    // point of it is the file you take away, so it is far higher than the
    // portal's — see ANNOT_MAX_PX, and the adaptive undo stack that pays for
    // it. A download that is quietly smaller than what went in is the one
    // thing a picture editor must never do without saying so, so a picture
    // that DID have to be scaled says so in a toast.
    const cap = ANNOT_MAX_PX;
    const wasW = img.naturalWidth || 1, wasH = img.naturalHeight || 1;
    const scale = Math.min(1, cap / Math.max(wasW, wasH));
    canvas.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
    canvas.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const selCanvas = document.getElementById('annotSelCanvas');
    if (selCanvas) { selCanvas.width = canvas.width; selCanvas.height = canvas.height; }
    // The picture exactly as it was opened, kept for the history brush to paint
    // back from. It is never written to, so "the original" stays the original
    // however many edits are stacked on top.
    const orig = document.createElement('canvas');
    orig.width = canvas.width; orig.height = canvas.height;
    orig.getContext('2d').drawImage(canvas, 0, 0);
    _annot = { standalone: true,
      // WHAT ERASE LEAVES BEHIND. In the portal a scanned exam question is
      // paper, so rubbing a word out means painting it white; game art stands
      // on nothing, so there erasing means erasing. Here the file that leaves
      // is a PNG that keeps its alpha, so the default is a real cut — the
      // ⬜/▨ button in the toolbar flips it back to white for a scan.
      eraseTo: 'clear',
      canvas, ctx, tool: 'erase', color: '#e23c3c', size: 6, tol: 32, drawing: false, history: [], start: null, snap: null,
      zoom: 1, fit: 1, panX: 0, panY: 0, space: false, panning: false, cloneSrc: null, cloneSnap: null, cloneOff: null,
      anchor: null, sel: null, selPts: null, selCanvas, aiFillBusy: false, origSnap: orig, float: null, xform: null, xfStart: null,
      // Where the pointer is, in STAGE coordinates, and how long the size badge
      // stays up after a change — see the brush cursor below.
      ptr: null, ptrIn: false, hudUntil: 0, hudTimer: null };
    _annotSelSyncBar();
    _annotAiBarInit();
    if (!_annotAntsRunning) _annotAntsLoop();
    _annotSyncControls();
    _annotBindSliderWheel();
    _annotSetTool('erase');
    _annotSyncEraseTo();
    const head = document.querySelector('#annotOverlay .overlay-head h3');
    if (head) head.innerHTML = title || '🎨 Photo Editor';
    document.getElementById('annotOverlay').classList.add('show');
    // Fit the image after the overlay is visible so the stage has real dimensions.
    requestAnimationFrame(() => { annotZoomFit(); });
    _annotBindZoomListeners();
    if (scale < 1) {
      showToast('This picture was scaled to ' + canvas.width + '×' + canvas.height +
        ' to edit (it came in at ' + wasW + '×' + wasH + ') — anything you save will be that size', 'info');
    }
  }).catch(e => {
    console.warn('open annot', e);
    _peStatus('Could not open that picture — it may be a format this browser cannot read.', true);
    showToast('Could not open that picture', 'error');
  });
}
// Does the eraser CUT rather than paint white?
function annotEraseClears() { return !!(_annot && _annot.eraseTo === 'clear'); }
function annotToggleEraseTo() {
  if (!_annot) return;
  _annot.eraseTo = annotEraseClears() ? 'white' : 'clear';
  _annotSyncEraseTo();
  showToast(annotEraseClears()
    ? '🩹 Erase now cuts the picture away — transparent, not white'
    : '🩹 Erase now paints white, for erasing words off paper', 'info');
}
function _annotSyncEraseTo() {
  const b = document.getElementById('annotEraseTo');
  if (!b) return;
  const clear = annotEraseClears();
  b.innerHTML = clear ? '▨ Erase to: <b>transparent</b>' : '⬜ Erase to: <b>white</b>';
  b.classList.toggle('on', clear);
  b.title = clear
    ? 'Erase, the paint bucket and Delete all cut the picture away to nothing — the right thing for card art, sprites and effect frames, which stand on a transparent background. Click to paint white instead.'
    : 'Erase and the paint bucket paint WHITE — the right thing for rubbing a word off a scanned question. Click to cut the picture away to transparent instead.';
}
// Put the canvas into the right mode for the tool about to draw, and set the
// colour. `destination-out` is what turns a brush stroke into a real hole
// instead of a white one; _annotUp puts the mode back.
function _annotPaintCompose(ctx) {
  const clear = _annot.tool === 'erase' && annotEraseClears();
  ctx.strokeStyle = clear ? '#000000' : (_annot.tool === 'erase' ? '#ffffff' : _annot.color);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.globalCompositeOperation = clear ? 'destination-out' : 'source-over';
  return clear;
}
function _annotResetCompose() {
  if (_annot && _annot.ctx) _annot.ctx.globalCompositeOperation = 'source-over';
}
function _annotSyncControls() {
  const col = document.getElementById('annotColor'), sz = document.getElementById('annotSize'), tl = document.getElementById('annotTol');
  const _sizeWas = _annot ? _annot.size : 0;
  if (_annot) {
    if (col) _annot.color = col.value || _annot.color;
    if (sz) _annot.size = parseInt(sz.value, 10) || _annot.size;
    if (tl) { const t = parseInt(tl.value, 10); _annot.tol = isNaN(t) ? _annot.tol : t; }
    const lbl = document.getElementById('annotSizeVal');
    if (lbl) lbl.innerHTML = _annot.size + '&nbsp;px';
    const tlbl = document.getElementById('annotTolVal');
    if (tlbl) tlbl.textContent = _annot.tol;
    // Every route to the size — the slider, the wheel, [ and ] — lands here, so
    // this is the one place that has to say what it did on the picture itself.
    if (_annot.size !== _sizeWas) _annotBrushFlash(); else _annotUpdateBrushRing();
  }
  // The bucket icon always shows the colour it would pour, open tool or not.
  const bucket = document.querySelector('.annot-tool[data-atool="fill"]');
  if (bucket && col) bucket.style.setProperty('--annot-paint', col.value || '#e23c3c');
}
// Nudge the brush size from a key or the mouse wheel, keeping the slider,
// the label and _annot in step.
function _annotStepSize(delta) {
  const sz = document.getElementById('annotSize');
  if (!sz) return;
  const min = parseInt(sz.min, 10) || 1, max = parseInt(sz.max, 10) || 60;
  sz.value = String(Math.min(max, Math.max(min, (parseInt(sz.value, 10) || 1) + delta)));
  _annotSyncControls();
}
function _annotStepTol(delta) {
  const tl = document.getElementById('annotTol');
  if (!tl) return;
  const min = parseInt(tl.min, 10) || 0, max = parseInt(tl.max, 10) || 120;
  tl.value = String(Math.min(max, Math.max(min, (parseInt(tl.value, 10) || 0) + delta)));
  _annotSyncControls();
}
// Scroll over either slider to change it — the wheel is the natural gesture for
// a value you are adjusting by feel, and the page must not scroll underneath.
function _annotBindSliderWheel() {
  const xstep = field => d => { const x = _annot && _annot.xform; if (x) annotXformSet(field, (x[field] || 0) + d); };
  // The size boxes step in percent, so a wheel over them resizes by feel too.
  const sstep = field => d => {
    const x = _annot && _annot.xform; if (!x) return;
    const cur = Math.abs(field === 'sx' ? _annotXformSx(x) : _annotXformSy(x)) * 100;
    annotXformSetScale(field, cur + d);
  };
  [['annotSize', _annotStepSize, 1], ['annotTol', _annotStepTol, 4],
   ['annotXformAngle', xstep('angle'), 1], ['annotXformSkewX', xstep('skewX'), 1], ['annotXformSkewY', xstep('skewY'), 1],
   ['annotXformSxNum', sstep('sx'), 1], ['annotXformSyNum', sstep('sy'), 1]
  ].forEach(([id, step, mult]) => {
    const el = document.getElementById(id);
    if (!el || el._wheelBound) return;
    el._wheelBound = true;
    el.addEventListener('wheel', e => {
      e.preventDefault(); e.stopPropagation();
      step((e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? mult * 5 : mult));
    }, { passive: false });
  });
}
// ---- Zoom & pan (Photoshop-style): the canvas is transformed inside a fixed
// viewport; scroll zooms toward the cursor, Space/middle-drag pans. ----
const ANNOT_MAX_DISPLAY = 40;   // up to 40 screen px per image pixel — see individual pixels
function _annotDisplayScale() { return _annot ? _annot.fit * _annot.zoom : 1; }
function _annotUpdateTransform() {
  if (!_annot) return;
  const c = _annot.canvas, s = _annotDisplayScale();
  c.style.transform = 'translate(' + _annot.panX + 'px,' + _annot.panY + 'px) scale(' + s + ')';
  c.classList.toggle('pixelated', s >= 3);   // crisp pixels once magnified
  if (_annot.selCanvas) _annot.selCanvas.style.transform = c.style.transform;   // marching ants ride along
  const zl = document.getElementById('annotZoomVal');
  if (zl) zl.textContent = Math.round(s * 100) + '%';
  _annotUpdateCloneMarker();   // the source pin rides along with zoom / pan
  _annotUpdateBrushRing();     // ... and so does the brush ring: it is drawn at the zoomed size
}
// A small pin marking the clone-stamp source point, kept aligned under zoom/pan.
function _annotUpdateCloneMarker() {
  const st = document.getElementById('annotStage'); if (!st) return;
  let m = document.getElementById('annotCloneSrc');
  const show = _annot && _annot.tool === 'clone' && _annot.cloneSrc;
  if (!show) { if (m) m.style.display = 'none'; return; }
  if (!m) { m = document.createElement('div'); m.id = 'annotCloneSrc'; st.appendChild(m); }
  const s = _annotDisplayScale();
  m.style.display = 'block';
  m.style.left = (_annot.panX + _annot.cloneSrc.x * s) + 'px';
  m.style.top = (_annot.panY + _annot.cloneSrc.y * s) + 'px';
}
// ---- The brush cursor — what you are about to paint with, drawn on the picture
// -----------------------------------------------------------------------------
// A brush whose size you can only read as a number on a slider is a brush you
// are guessing with: "12 px" at 40% zoom is a quarter of the mark "12 px" makes
// at 400%. So every size-driven tool shows its real footprint under the pointer,
// at the current zoom, the way Photoshop does — erase, paint, clone, history and
// the line tool, whose thickness IS the brush size. The tools that take no size
// (fill, wand, select, lasso, move, the transforms, text) keep their own cursor
// and deliberately show no ring; a circle round a paint bucket would be a lie.
const ANNOT_RING_TOOLS = { erase: 1, paint: 1, clone: 1, history: 1, line: 1 };
const ANNOT_RING_TINY = 7;     // under this many screen px a circle is a blob: draw a crosshair instead
const ANNOT_HUD_MS = 1200;     // how long the "12 px" badge stays up after a size change
// The ring and its badge live in the STAGE, like the clone-source pin — not on
// the canvas, which is scaled and panned underneath them.
function _annotRingEls(make) {
  const st = document.getElementById('annotStage');
  if (!st) return null;
  let ring = document.getElementById('annotBrushRing'), hud = document.getElementById('annotBrushHud');
  if (!ring && make) {
    ring = document.createElement('div'); ring.id = 'annotBrushRing';
    // The clone preview lives INSIDE the ring, so it is positioned, sized and
    // hidden by exactly the code that already does all three for the ring.
    const pk = document.createElement('canvas'); pk.id = 'annotClonePeek'; ring.appendChild(pk);
    st.appendChild(ring);
  }
  if (!hud && make) { hud = document.createElement('div'); hud.id = 'annotBrushHud'; st.appendChild(hud); }
  return ring ? { st, ring, hud } : null;
}
function _annotBrushRingVisible() {
  if (!_annot || !ANNOT_RING_TOOLS[_annot.tool]) return false;
  if (_annot.space || _annot.panning) return false;                 // pan mode has its own hand cursor
  // Mid-stroke it stays up even if the drag has run off the edge; otherwise it
  // follows the pointer, or shows briefly while the size is being changed.
  return _annot.drawing || _annot.ptrIn || _annot.hudUntil > Date.now();
}
// Remember where the pointer is, in stage coordinates, and redraw the ring.
function _annotTrackPointer(e) {
  if (!_annot) return;
  const box = _annotStageBox();
  const x = e.clientX - box.left, y = e.clientY - box.top;
  // A text label inside the stage is its own thing to click and drag, so the
  // brush cursor gets out of the way over it.
  const overLabel = !!(e.target && e.target.closest && e.target.closest('.annot-textbox'));
  _annot.ptr = { x, y };
  _annot.ptrIn = !overLabel && x >= 0 && y >= 0 && x <= box.width && y <= box.height;
  _annotUpdateBrushRing();
}
function _annotUpdateBrushRing() {
  const want = _annotBrushRingVisible();
  const els = _annotRingEls(want);
  if (!els) return;
  const ring = els.ring, hud = els.hud, st = els.st, c = document.getElementById('annotCanvas');
  // The system cursor is only ever hidden for a tool that HAS a ring — the
  // resize handles and the transform tools set their own cursor and must keep it.
  if (c && ANNOT_RING_TOOLS[_annot ? _annot.tool : '']) {
    c.style.cursor = (want && _annot.ptrIn) ? 'none' : (ANNOT_CURSORS[_annot.tool] || 'crosshair');
  }
  if (!want) {
    ring.style.display = 'none';
    ring.classList.remove('peeking');
    if (hud) hud.classList.remove('show');
    return;
  }
  const box = _annotStageBox();
  // While the pointer is away (a slider drag) the preview sits in the middle of
  // the view, so the size still shows on the picture rather than only on a label.
  const p = (_annot.ptrIn || _annot.drawing) && _annot.ptr ? _annot.ptr : { x: box.width / 2, y: box.height / 2 };
  const px = Math.max(1, Math.round(_annot.size));
  const d = px * _annotDisplayScale();
  ring.style.display = 'block';
  ring.classList.toggle('tiny', d < ANNOT_RING_TINY);
  ring.style.width = ring.style.height = Math.max(1, d) + 'px';
  ring.style.left = (p.x - d / 2) + 'px';
  ring.style.top = (p.y - d / 2) + 'px';
  _annotUpdateClonePeek(ring, d);
  if (hud) {
    const on = _annot.hudUntil > Date.now();
    hud.classList.toggle('show', on);
    if (on) {
      hud.textContent = px + ' px';
      hud.style.left = Math.min(box.width - 8, Math.max(8, p.x)) + 'px';
      hud.style.top = Math.min(box.height - 26, p.y + d / 2 + 12) + 'px';
    }
  }
}
// ---- The clone stamp's live preview ----------------------------------------
// The source pin says where the copy comes FROM and the ring says how big the
// mark will be. Neither says what the mark will BE, so lining a stamp up meant
// clicking and then looking at what landed — and undoing it when it was half a
// letter out. The ring is therefore filled with the patch that would be stamped
// this instant: a lens on the source, carried under the pointer, at the same
// zoom as everything else. That is what turns "cover this word with the paper
// beside it" into something you aim rather than guess at.
const ANNOT_PEEK_MIN = 14;    // under this many screen px there is nothing to see inside the ring

// Where the pixels under the brush would be copied FROM, right now. Mid-stroke
// the offset was locked in at pointer-down; before the first dab, starting the
// drag here is what would put the source point itself under the pointer — so
// the preview is centred on the source, which is exactly what would land.
function _annotClonePeekSrc() {
  if (!_annot || _annot.tool !== 'clone' || !_annot.cloneSrc || !_annot.ptr) return null;
  if (!_annot.cloneOff) return { x: _annot.cloneSrc.x, y: _annot.cloneSrc.y };
  const s = _annotDisplayScale();
  const ix = (_annot.ptr.x - _annot.panX) / s, iy = (_annot.ptr.y - _annot.panY) / s;
  return { x: ix - _annot.cloneOff.x, y: iy - _annot.cloneOff.y };
}
function _annotUpdateClonePeek(ring, d) {
  const peek = ring && ring.firstElementChild;
  if (!peek || peek.tagName !== 'CANVAS') return;
  const src = d >= ANNOT_PEEK_MIN ? _annotClonePeekSrc() : null;
  ring.classList.toggle('peeking', !!src);
  if (!src) return;
  // Mid-stroke the stamp reads the FROZEN snapshot, so the preview must read it
  // too — dragging back over ground already covered would otherwise preview the
  // copy instead of the source, and the two diverge exactly where it matters.
  const from = _annot.cloneSnap || _annot.canvas;
  const px = Math.max(1, Math.round(_annot.size));
  // The backing store is the brush in IMAGE pixels, so what is drawn here is
  // pixel-for-pixel what the dab will put down, however far the view is zoomed.
  if (peek.width !== px || peek.height !== px) { peek.width = px; peek.height = px; }
  const g = peek.getContext('2d');
  g.clearRect(0, 0, px, px);
  g.imageSmoothingEnabled = false;
  try { g.drawImage(from, Math.round(src.x - px / 2), Math.round(src.y - px / 2), px, px, 0, 0, px, px); } catch (_) {}
  peek.classList.toggle('pixelated', d / px >= 3);
}
// Show the ring and its "12 px" badge for a moment after the size changes, so
// the slider, the wheel and [ ] all say what they did even when the pointer is
// nowhere near the picture.
function _annotBrushFlash() {
  if (!_annot) return;
  _annot.hudUntil = Date.now() + ANNOT_HUD_MS;
  _annotUpdateBrushRing();
  clearTimeout(_annot.hudTimer);
  _annot.hudTimer = setTimeout(() => { if (_annot) _annotUpdateBrushRing(); }, ANNOT_HUD_MS + 40);
}
// hex → [r,g,b]
function _annotHexToRgb(hex) {
  hex = String(hex || '').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const n = parseInt(hex || '000000', 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
// Paint-bucket flood fill: from the clicked pixel, recolour every connected
// pixel whose colour is within tolerance of it — fills enclosed shapes/regions.
function _annotFloodFill(sx, sy) {
  const cv = _annot.canvas, ctx = _annot.ctx, W = cv.width, H = cv.height;
  sx = Math.floor(sx); sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;
  const img = ctx.getImageData(0, 0, W, H), out = img.data;
  const src = new Uint8ClampedArray(out);   // stable copy for matching
  const at = (x, y) => (y * W + x) * 4;
  const s0 = at(sx, sy);
  const tr = src[s0], tg = src[s0 + 1], tb = src[s0 + 2], ta = src[s0 + 3];
  // Erasing with the bucket CUTS when the session is set to transparent — the
  // fastest way to take a flat plate off a sprite: click it, it is gone.
  const cut = _annot.tool === 'erase' && annotEraseClears();
  const fill = _annot.tool === 'erase' ? [255, 255, 255] : _annotHexToRgb(_annot.color);
  const fr = fill[0], fg = fill[1], fb = fill[2];
  if (!cut && Math.abs(tr - fr) < 2 && Math.abs(tg - fg) < 2 && Math.abs(tb - fb) < 2 && ta === 255) return; // already that colour
  if (cut && ta === 0) return;                    // already empty here
  const t = Math.max(1, _annot.tol || 32);
  const TOL = t * t * 3;   // squared colour distance a pixel may differ and still count
  const match = i => { const dr = src[i] - tr, dg = src[i + 1] - tg, db = src[i + 2] - tb, da = src[i + 3] - ta; return dr * dr + dg * dg + db * db + da * da <= TOL; };
  const seen = new Uint8Array(W * H);
  const stack = [[sx, sy]];
  while (stack.length) {
    let [x, y] = stack.pop();
    while (x > 0 && match(at(x - 1, y))) x--;   // walk to the left edge of this span
    let up = false, dn = false;
    for (; x < W && match(at(x, y)); x++) {
      const k = y * W + x; if (seen[k]) continue; seen[k] = 1;
      const i = k * 4;
      if (cut) { out[i + 3] = 0; }
      else { out[i] = fr; out[i + 1] = fg; out[i + 2] = fb; out[i + 3] = 255; }
      if (y > 0) { const mu = match(at(x, y - 1)); if (mu && !up && !seen[k - W]) stack.push([x, y - 1]); up = mu; }
      if (y < H - 1) { const md = match(at(x, y + 1)); if (md && !dn && !seen[k + W]) stack.push([x, y + 1]); dn = md; }
    }
  }
  ctx.putImageData(img, 0, 0);
}
// ---- MOVE: lift the selection off the picture and drop it anywhere ---------
// Photoshop's Move tool. Dragging inside a selection cuts those pixels out onto
// a floating layer that follows the pointer; the hole they left follows the
// ⬜/▨ Erase-to setting — white on a scanned page, a real hole on art. Hold
// Alt to copy instead of cut, leaving the original where it was. The float is
// only burned in on release, so nothing is committed until you let go.
function _annotSelLift(copy) {
  const m = _annotSelMask(); if (!m) return null;
  const cv = _annot.canvas, ctx = _annot.ctx;
  const layer = document.createElement('canvas');
  layer.width = m.w; layer.height = m.h;
  const lx = layer.getContext('2d');
  const src = ctx.getImageData(m.x, m.y, m.w, m.h);
  const cut = lx.createImageData(m.w, m.h);
  for (let k = 0; k < m.mask.length; k++) {
    if (!m.mask[k]) continue;
    const i = k * 4;
    cut.data[i] = src.data[i]; cut.data[i + 1] = src.data[i + 1];
    cut.data[i + 2] = src.data[i + 2]; cut.data[i + 3] = src.data[i + 3];
  }
  lx.putImageData(cut, 0, 0);
  if (!copy) {
    // The hole the pixels left behind follows the same rule Erase does: white
    // on a scanned page, a real hole on a piece of art that stands on nothing.
    const clear = annotEraseClears();
    for (let k = 0; k < m.mask.length; k++) {
      if (!m.mask[k]) continue;
      const i = k * 4;
      if (clear) { src.data[i + 3] = 0; }
      else { src.data[i] = 255; src.data[i + 1] = 255; src.data[i + 2] = 255; src.data[i + 3] = 255; }
    }
    ctx.putImageData(src, m.x, m.y);
  }
  // The picture with the hole in it, so each drag frame redraws from a clean base.
  const base = document.createElement('canvas');
  base.width = cv.width; base.height = cv.height;
  base.getContext('2d').drawImage(cv, 0, 0);
  return { layer, base, mask: m, dx: 0, dy: 0 };
}
function _annotFloatDraw() {
  const f = _annot && _annot.float; if (!f) return;
  const ctx = _annot.ctx;
  ctx.putImageData(f.base.getContext('2d').getImageData(0, 0, f.base.width, f.base.height), 0, 0);
  ctx.drawImage(f.layer, f.mask.x + f.dx, f.mask.y + f.dy);
}
// Drop it: the float becomes part of the picture and the selection travels with
// it, so it can be moved again, filled, or nudged further.
function _annotFloatCommit() {
  const f = _annot && _annot.float; if (!f) return;
  _annotFloatDraw();
  const m = f.mask;
  _annot.sel = { x: m.x + f.dx, y: m.y + f.dy, w: m.w, h: m.h, mask: m.mask };
  _annot.sel.outline = _annotMaskOutline(_annot.sel);
  _annot.float = null;
  _annotSelSyncBar();
}

// ---- ROTATE & SKEW (free transform) ---------------------------------------
// Turning and slanting, for the two things that actually go wrong with a
// scanned science paper: the whole page went in crooked, or one object inside
// it (an arrow, a label, a pasted diagram) sits at the wrong angle.
//
// With a selection live the selected pixels are lifted onto their own layer —
// the hole behind them is filled the way Move fills one (⬜/▨ Erase to) — so the object
// turns on its own. With nothing selected the WHOLE picture is the object, and
// the canvas grows so no corner is ever cut off.
//
// Nothing is committed while you drag: the preview redraws from the untouched
// layer every frame, so turning 30° and back to 0° leaves the pixels as sharp
// as they started. Only Apply burns it in.
const ANNOT_XFORM_MAX_PX = 4000;   // never let "grow to fit" run away with memory
const ANNOT_SCALE_MIN = 0.05;      // 5% — small enough to shrink a stamp, big enough to still grab
const ANNOT_SCALE_MAX = 8;
const _annotRad = d => (d || 0) * Math.PI / 180;
function _annotWrapDeg(d) { d = ((d + 180) % 360 + 360) % 360 - 180; return Math.abs(d) < 1e-9 ? 0 : d; }
function _annotClampNum(v, lo, hi) { return Math.min(hi, Math.max(lo, isNaN(v) ? 0 : v)); }
function _annotXformSx(x) { return (x && typeof x.sx === 'number' && x.sx) ? x.sx : 1; }
function _annotXformSy(x) { return (x && typeof x.sy === 'number' && x.sy) ? x.sy : 1; }
function _annotXformIsIdentity(x) {
  // A PASTED picture is never "nothing to do": the object itself is new, so
  // even at 100% and 0° there is something to burn in. Reading it as identity
  // would make ✓ Apply — and every tool switch — throw the paste away.
  if (x && x.scope === 'paste') return false;
  return !x || (!x.angle && !x.skewX && !x.skewY && _annotXformSx(x) === 1 && _annotXformSy(x) === 1 && !x.moved);
}

// Start a transform session. Snapshots history once, up front, so Cancel (and
// Ctrl+Z afterwards) puts the picture back exactly as it was.
function _annotXformBegin() {
  if (!_annot || _annot.xform) return;
  // Burn any label still being typed: a whole-picture turn resizes the canvas
  // underneath it, and a floating label would be left pointing at nothing.
  document.querySelectorAll('#annotStage .annot-textbox-input').forEach(i => i.blur());
  _annotPushHistory();
  const cv = _annot.canvas;
  let layer, ox, oy, base, scope;
  const prevSel = _annot.sel;
  if (_annot.sel) {
    const lift = _annotSelLift(false);   // cut the object out; the hole follows ⬜/▨ Erase to
    if (!lift) { showToast('That selection is empty — nothing to turn', 'info'); _annot.history.pop(); return; }
    layer = lift.layer; ox = lift.mask.x; oy = lift.mask.y; base = lift.base; scope = 'sel';
    _annot.sel = null; _annotSelSyncBar();   // the old outline no longer describes anything
  } else {
    layer = document.createElement('canvas');
    layer.width = cv.width; layer.height = cv.height;
    layer.getContext('2d').drawImage(cv, 0, 0);
    ox = 0; oy = 0; base = null; scope = 'image';
  }
  _annot.xform = {
    scope, layer, base, ox, oy,
    cx: ox + layer.width / 2, cy: oy + layer.height / 2,
    angle: 0, skewX: 0, skewY: 0,
    sx: 1, sy: 1, lock: true, moved: false,
    grow: scope === 'image',
    baseW: cv.width, baseH: cv.height,
    straighten: false, strLine: null, prevSel
  };
  _annotXformSyncBar();
  _annotXformPreview();
}

// ---- PASTE a picture straight into the editor ------------------------------
// The picture somebody wants to drop onto a diagram is nearly always already on
// the clipboard — a screenshot, a photo, a figure lifted out of another
// question. Ctrl+V (or 📋 Paste) puts it on the canvas scaled to FIT the
// picture it is landing on, and opens the transform box on it straight away, so
// the eight handles are live from the first moment: drag a corner to resize,
// drag the middle to move, then ✓ Apply. That is the PowerPoint gesture, which
// is the one everybody already has in their fingers.
//
// It is its OWN transform scope (`paste`) rather than a selection lift, because
// the pixels do not come off the canvas: `base` is the picture untouched, so
// Cancel — and the history step taken here — simply leave no trace of it.
// ── THE WORKING CEILING ─────────────────────────────────────────────────────
// The biggest a picture may be while it is being edited. The portal caps a
// question's diagram at 1600px because a diagram never needs more and the undo
// stack behind it has to stay affordable; this app is handed camera photos and
// the file you take away IS the product, so it is far higher.
//
// What pays for it is the adaptive undo stack in _annotPushHistory: the number
// of steps kept falls as the canvas grows, so a 4096px photo does not put two
// thirds of a gigabyte of RGBA in memory. Raise this and check that budget.
//
// A picture bigger than this is scaled to fit and the editor SAYS SO — a
// download quietly smaller than what went in is the one thing a picture editor
// must never do without saying.
const ANNOT_MAX_PX = 4096;
const ANNOT_HISTORY_MAX = 12;                    // never more steps than this…
const ANNOT_HISTORY_BYTES = 320 * 1024 * 1024;   // …and never more RGBA than this
const ANNOT_PASTE_FIT = 0.9;       // land inside this much of the canvas, so the handles have room
const ANNOT_PASTE_MAX_PX = 4096;   // never hold a layer bitmap bigger than this
// The image file on the clipboard, if there is one. `items` is what a
// screenshot arrives as; `files` is what a copied file arrives as.
function _annotClipboardImageFile(e) {
  const dt = e && e.clipboardData;
  if (!dt) return null;
  const items = dt.items ? Array.from(dt.items) : [];
  for (const it of items) {
    if (it && it.kind === 'file' && String(it.type || '').startsWith('image/')) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  const files = dt.files ? Array.from(dt.files) : [];
  for (const f of files) if (f && String(f.type || '').startsWith('image/')) return f;
  return null;
}
// Bound in CAPTURE while the editor is open, so it beats the page-level paste
// handlers (the exam paper builder, Mark Paper, the contenteditable guard) —
// any of which could be on the page underneath the overlay.
function _annotPasteHandler(e) {
  if (!_annot) return;
  const ov = document.getElementById('annotOverlay');
  if (!ov || !ov.classList.contains('show')) return;
  // A label being typed keeps its own paste: pasting WORDS into a text box is
  // the other honest meaning of Ctrl+V in here.
  if (_annotTypingInField(e)) return;
  const file = _annotClipboardImageFile(e);
  if (!file) return;
  e.preventDefault();
  e.stopPropagation();
  const r = new FileReader();
  r.onload = () => _annotPasteDataUrl(String(r.result || ''));
  r.onerror = () => showToast('Could not read that picture from the clipboard', 'error');
  r.readAsDataURL(file);
}
function _annotPasteDataUrl(url) {
  if (!url || !_annot) return;
  _loadImageEl(url).then(img => _annotPasteImage(img))
    .catch(err => { console.warn('annot paste', err); showToast('Could not open that pasted picture', 'error'); });
}
// The 📋 button: the keyboard shortcut is invisible, and a toolbar full of
// tools is where somebody looks for "put a picture in". Reading the clipboard
// needs permission, and Safari/Firefox may refuse outright — so a refusal says
// to use Ctrl+V instead rather than failing silently.
async function annotPasteFromClipboard() {
  if (!_annot) return;
  if (!navigator.clipboard || !navigator.clipboard.read) {
    showToast('Press Ctrl+V (⌘V) to paste a picture in from the clipboard', 'info');
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = (it.types || []).find(t => String(t).startsWith('image/'));
      if (!type) continue;
      const blob = await it.getType(type);
      const url = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result || '')); r.onerror = rej;
        r.readAsDataURL(blob);
      });
      _annotPasteDataUrl(url);
      return;
    }
    showToast('There is no picture on the clipboard — copy one first', 'info');
  } catch (err) {
    console.warn('clipboard read', err);
    showToast('This browser will not let a page read the clipboard — press Ctrl+V (⌘V) instead', 'info');
  }
}
function _annotPasteImage(img) {
  if (!_annot) return;
  const iw = img.naturalWidth || img.width || 0, ih = img.naturalHeight || img.height || 0;
  if (!iw || !ih) { showToast('That clipboard picture was empty', 'error'); return; }
  // Settle whatever transform was open first — a paste is a NEW object and must
  // never inherit the last one's angle, nor silently discard its work.
  if (_annot.xform) {
    if (_annotXformIsIdentity(_annot.xform)) annotXformCancel(true); else annotXformApply(true);
  }
  // A label mid-type would be left pointing at a picture that has moved on.
  document.querySelectorAll('#annotStage .annot-textbox-input').forEach(i => i.blur());
  _annotPushHistory();
  const cv = _annot.canvas;
  // The layer holds the pasted picture at its OWN resolution (capped), and what
  // fits it into the window is the transform's scale — which is exactly what
  // the handles then edit. So dragging a corner back out stays sharp instead of
  // magnifying an already-shrunken bitmap.
  const cap = Math.min(1, ANNOT_PASTE_MAX_PX / Math.max(iw, ih));
  const lw = Math.max(1, Math.round(iw * cap)), lh = Math.max(1, Math.round(ih * cap));
  const layer = document.createElement('canvas');
  layer.width = lw; layer.height = lh;
  const lx = layer.getContext('2d');
  lx.imageSmoothingEnabled = true;
  try { lx.imageSmoothingQuality = 'high'; } catch (_) {}
  lx.drawImage(img, 0, 0, lw, lh);
  // The picture as it stands, so every preview frame redraws from a clean base.
  const base = document.createElement('canvas');
  base.width = cv.width; base.height = cv.height;
  base.getContext('2d').drawImage(cv, 0, 0);
  // Fit it inside what it is landing on — never blown UP past its own pixels,
  // and never so large that the corner handles sit off the edge of the stage.
  const fit = Math.min(1, (cv.width * ANNOT_PASTE_FIT) / lw, (cv.height * ANNOT_PASTE_FIT) / lh);
  const s = _annotXformClampScale(null, fit, Math.max(lw, lh));
  const prevSel = _annot.sel;
  _annot.sel = null; _annot.selPts = null; _annotSelSyncBar();
  const cx = cv.width / 2, cy = cv.height / 2;
  _annot.xform = {
    scope: 'paste', layer, base, ox: cx - lw / 2, oy: cy - lh / 2,
    cx, cy, angle: 0, skewX: 0, skewY: 0,
    sx: s, sy: s, lock: true, moved: false,
    grow: false,
    baseW: cv.width, baseH: cv.height,
    straighten: false, strLine: null, prevSel
  };
  // Resize is the tool the handles belong to, so the pasted picture arrives
  // ready to drag rather than waiting to be discovered.
  _annotSetTool('scale');
  _annotXformSyncBar();
  _annotXformPreview();
  showToast('📋 Pasted ' + iw + '×' + ih + ' — drag the handles to resize, drag the middle to move, then ✓ Apply', 'success');
}
// Scale first, then skew, then rotate — the same order the canvas applies them
// below, so the corner maths and the render can never drift apart. (u, v) are
// layer pixels measured from the pivot, BEFORE scaling.
function _annotXformMapper(x) {
  const a = _annotRad(x.angle), cos = Math.cos(a), sin = Math.sin(a);
  const tx = Math.tan(_annotRad(x.skewX)), ty = Math.tan(_annotRad(x.skewY));
  const sx = _annotXformSx(x), sy = _annotXformSy(x);
  return (u, v) => {
    const zu = u * sx, zv = v * sy;
    const su = zu + tx * zv, sv = ty * zu + zv;
    return { x: x.cx + su * cos - sv * sin, y: x.cy + su * sin + sv * cos };
  };
}
// The other direction, for turning a pointer position back into the object's
// own coordinates while a handle is being dragged. Two stops on the way back:
// the M-FRAME (rotation and slant undone, scaling still applied) is what the
// resize maths works in, and layer coordinates are one divide further.
function _annotXformMFrameVec(x, vx, vy) {
  const a = -_annotRad(x.angle), cos = Math.cos(a), sin = Math.sin(a);
  const rx = vx * cos - vy * sin, ry = vx * sin + vy * cos;
  const tx = Math.tan(_annotRad(x.skewX)), ty = Math.tan(_annotRad(x.skewY));
  const det = (1 - tx * ty) || 1e-6;
  return { x: (rx - tx * ry) / det, y: (ry - ty * rx) / det };
}
function _annotXformMFrame(x, px, py) { return _annotXformMFrameVec(x, px - x.cx, py - x.cy); }
function _annotXformUnmapVec(x, vx, vy) {
  const m = _annotXformMFrameVec(x, vx, vy);
  return { x: m.x / (_annotXformSx(x) || 1e-6), y: m.y / (_annotXformSy(x) || 1e-6) };
}
function _annotXformCorners(x) {
  const map = _annotXformMapper(x);
  const u0 = x.ox - x.cx, v0 = x.oy - x.cy;
  const u1 = u0 + x.layer.width, v1 = v0 + x.layer.height;
  return [map(u0, v0), map(u1, v0), map(u1, v1), map(u0, v1)];
}
function _annotXformDrawInto(ctx, x, offX, offY) {
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  try { ctx.imageSmoothingQuality = 'high'; } catch (_) {}
  ctx.translate(x.cx + offX, x.cy + offY);
  ctx.rotate(_annotRad(x.angle));
  ctx.transform(1, Math.tan(_annotRad(x.skewY)), Math.tan(_annotRad(x.skewX)), 1, 0, 0);
  ctx.scale(_annotXformSx(x), _annotXformSy(x));
  ctx.drawImage(x.layer, x.ox - x.cx, x.oy - x.cy);
  ctx.restore();
}
// Redraw the canvas for the current angle/slant. Whole-picture transforms
// recompute the canvas size each frame so you see the real result, corners and
// all, and the view re-fits so the picture doesn't wander off the stage.
function _annotXformPreview() {
  const x = _annot && _annot.xform; if (!x) return;
  const cv = _annot.canvas;
  let W = x.baseW, H = x.baseH, offX = 0, offY = 0, refit = false;
  if (x.scope === 'image' && x.grow) {
    const c = _annotXformCorners(x);
    const minX = Math.min(...c.map(p => p.x)), maxX = Math.max(...c.map(p => p.x));
    const minY = Math.min(...c.map(p => p.y)), maxY = Math.max(...c.map(p => p.y));
    W = _annotClampNum(Math.ceil(maxX - minX), 1, ANNOT_XFORM_MAX_PX);
    H = _annotClampNum(Math.ceil(maxY - minY), 1, ANNOT_XFORM_MAX_PX);
    offX = -minX; offY = -minY;
  }
  if (cv.width !== W || cv.height !== H) { _annotResizeCanvas(W, H); refit = true; }
  const ctx = _annot.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Turning the WHOLE picture opens up new corners. On a scanned page those are
  // paper, so they go white; on a piece of art that stands on nothing they must
  // stay empty, or straightening a sprite boxes it in a white rectangle.
  ctx.clearRect(0, 0, W, H);
  if (!annotEraseClears()) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); }
  if (x.base) ctx.drawImage(x.base, offX, offY);
  _annotXformDrawInto(ctx, x, offX, offY);
  x.offX = offX; x.offY = offY;
  if (refit) annotZoomFit();
}
// ---- Free transform: the eight handles round the box ----------------------
// Corners resize both ways at once, edge handles one way, and the corner
// opposite the one you drag stays exactly where it is — the thing everybody
// expects of a resize box and the reason the maths below anchors rather than
// just multiplying a scale.
const ANNOT_HANDLES = [
  { id: 'nw', hx: 0, hy: 0, cur: 'nwse-resize' }, { id: 'n', hx: 0.5, hy: 0, cur: 'ns-resize' },
  { id: 'ne', hx: 1, hy: 0, cur: 'nesw-resize' }, { id: 'e', hx: 1, hy: 0.5, cur: 'ew-resize' },
  { id: 'se', hx: 1, hy: 1, cur: 'nwse-resize' }, { id: 's', hx: 0.5, hy: 1, cur: 'ns-resize' },
  { id: 'sw', hx: 0, hy: 1, cur: 'nesw-resize' }, { id: 'w', hx: 0, hy: 0.5, cur: 'ew-resize' },
];
function _annotXformHandles(x) {
  const map = _annotXformMapper(x);
  const W = x.layer.width, H = x.layer.height;
  const d = { x: x.ox - x.cx, y: x.oy - x.cy };
  return ANNOT_HANDLES.map(h => Object.assign({}, h, {
    pt: map(d.x + h.hx * W, d.y + h.hy * H),
    pD: { x: h.hx * W, y: h.hy * H },            // the handle, in layer pixels
    pA: { x: (1 - h.hx) * W, y: (1 - h.hy) * H },// the point it pivots against
  }));
}
// Which handle is under the pointer, judged in SCREEN pixels so it stays
// grabbable at any zoom.
function _annotXformHandleAt(p) {
  const x = _annot && _annot.xform; if (!x) return null;
  const s = _annotDisplayScale() || 1;
  const q = _annotXformUnoffset(x, p);
  let best = null, bestD = 11 / s;
  _annotXformHandles(x).forEach(h => {
    const d = Math.hypot(q.x - h.pt.x, q.y - h.pt.y);
    if (d <= bestD) { bestD = d; best = h; }
  });
  return best;
}
// A pointer position arrives in CANVAS coordinates; the transform maths lives
// in the frame the object is composed in, which a growing canvas shifts by
// (offX, offY). Everything that compares the two has to go through here.
function _annotXformUnoffset(x, p) { return { x: p.x - (x.offX || 0), y: p.y - (x.offY || 0) }; }
// Is the pointer inside the transform box? (Point-in-quad by winding.) That is
// what makes dragging the middle of the box move the object.
function _annotXformInside(p) {
  const x = _annot && _annot.xform; if (!x) return false;
  const c = _annotXformCorners(x);
  p = _annotXformUnoffset(x, p);
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (!sign) sign = s; else if (s !== sign) return false;
  }
  return true;
}
// Put the pivot back in the middle of the box without moving a single pixel:
// the shift is taken straight back out of the layer's own offset. Run after a
// resize or a move, so a turn afterwards spins about the object's centre.
function _annotXformRecentre(x) {
  const W = x.layer.width, H = x.layer.height;
  const d = { x: x.ox - x.cx, y: x.oy - x.cy };
  const c = _annotXformMapper(x)(d.x + W / 2, d.y + H / 2);
  const shift = _annotXformUnmapVec(x, x.cx - c.x, x.cy - c.y);
  x.cx = c.x; x.cy = c.y;
  x.ox = c.x + d.x + shift.x;
  x.oy = c.y + d.y + shift.y;
}
// Begin a handle drag: everything the move needs is frozen here, so each frame
// is computed from the state at mouse-down and can never drift.
function _annotXformScaleStart(h) {
  const x = _annot.xform;
  const d = { x: x.ox - x.cx, y: x.oy - x.cy };
  const sx = _annotXformSx(x), sy = _annotXformSy(x);
  _annot.xfScale = {
    h, sx0: sx, sy0: sy,
    // The anchor's position in the M-frame — the one point the drag holds still.
    Ua: (d.x + h.pA.x) * sx, Va: (d.y + h.pA.y) * sy,
    spanX: h.pD.x - h.pA.x, spanY: h.pD.y - h.pA.y,
  };
}
function _annotXformScaleDrag(p, shift) {
  const x = _annot && _annot.xform, st = _annot && _annot.xfScale;
  if (!x || !st) return;
  const q = _annotXformUnoffset(x, p);
  const m = _annotXformMFrame(x, q.x, q.y);
  let sx = st.sx0, sy = st.sy0;
  if (Math.abs(st.spanX) > 0.5) sx = (m.x - st.Ua) / st.spanX;
  if (Math.abs(st.spanY) > 0.5) sy = (m.y - st.Va) / st.spanY;
  // Locked (or Shift held): one factor drives both axes, so the object keeps
  // its shape. The bigger of the two moves wins, and each axis keeps its own
  // sign — dragging a handle past the anchor still flips the object.
  const keep = x.lock !== (!!shift);          // Shift is a momentary override
  if (keep) {
    // Only the axes this handle actually drives get a vote: an edge handle
    // leaves its other axis at 1x, and letting that count would out-vote the
    // shrink the drag is asking for.
    const fx = Math.abs(st.spanX) > 0.5 ? sx / (st.sx0 || 1) : null;
    const fy = Math.abs(st.spanY) > 0.5 ? sy / (st.sy0 || 1) : null;
    const f = Math.max(fx === null ? 0 : Math.abs(fx), fy === null ? 0 : Math.abs(fy)) || 1;
    sx = Math.sign(fx === null ? 1 : (fx || 1)) * f * st.sx0;
    sy = Math.sign(fy === null ? 1 : (fy || 1)) * f * st.sy0;
  }
  sx = _annotXformClampScale(x, sx, x.layer.width);
  sy = _annotXformClampScale(x, sy, x.layer.height);
  // Hold the anchor: the layer offset is whatever puts it back where it was.
  x.sx = sx; x.sy = sy;
  x.ox = x.cx + st.Ua / sx - st.h.pA.x;
  x.oy = x.cy + st.Va / sy - st.h.pA.y;
  _annotXformSyncBar();
  _annotXformPreview();
}
// A scale factor has to keep the object visible, keep it under the canvas
// ceiling, and never be zero — a zero would collapse the object with no way
// back, because the offset maths divides by it.
function _annotXformClampScale(x, s, sidePx) {
  const sign = s < 0 ? -1 : 1;
  let mag = Math.abs(s);
  if (!isFinite(mag) || mag < ANNOT_SCALE_MIN) mag = ANNOT_SCALE_MIN;
  const roomy = Math.max(ANNOT_SCALE_MIN, ANNOT_XFORM_MAX_PX / Math.max(1, sidePx));
  mag = Math.min(mag, ANNOT_SCALE_MAX, roomy);
  return sign * mag;
}
// Drag the middle of the box to reposition the object. The pivot travels with
// it, so the object keeps turning about its own centre.
function _annotXformMoveTo(dx, dy) {
  const x = _annot && _annot.xform; if (!x) return;
  x.cx += dx; x.cy += dy; x.ox += dx; x.oy += dy;
  x.moved = true;
  _annotXformPreview();
}
// The % boxes and the flip buttons scale about the pivot, which _after a
// recentre_ is the middle of the box — so the object grows evenly both ways
// instead of creeping off to one side.
function annotXformSetScale(field, val) {
  const x = _annot && _annot.xform; if (!x) return;
  const side = field === 'sx' ? x.layer.width : x.layer.height;
  const was = field === 'sx' ? _annotXformSx(x) : _annotXformSy(x);
  const want = _annotXformClampScale(x, (parseFloat(val) || 0) / 100 * (was < 0 ? -1 : 1), side);
  const f = want / (was || 1);
  x[field] = want;
  if (x.lock) {
    const other = field === 'sx' ? 'sy' : 'sx';
    const oside = field === 'sx' ? x.layer.height : x.layer.width;
    x[other] = _annotXformClampScale(x, (field === 'sx' ? _annotXformSy(x) : _annotXformSx(x)) * f, oside);
  }
  _annotXformSyncBar();
  _annotXformPreview();
}
function annotXformSetLock(on) {
  const x = _annot && _annot.xform; if (!x) return;
  x.lock = !!on;
  _annotXformSyncBar();
}
function annotXformFlip(axis) {
  const x = _annot && _annot.xform; if (!x) return;
  if (axis === 'y') x.sy = -_annotXformSy(x); else x.sx = -_annotXformSx(x);
  _annotXformSyncBar();
  _annotXformPreview();
}
function annotXformScaleNudge(f) {
  const x = _annot && _annot.xform; if (!x) return;
  x.sx = _annotXformClampScale(x, _annotXformSx(x) * f, x.layer.width);
  x.sy = _annotXformClampScale(x, _annotXformSy(x) * f, x.layer.height);
  _annotXformSyncBar();
  _annotXformPreview();
}

// The transformed object becomes the new selection, so it can be turned again,
// nudged with Move, or filled — the mask comes straight from its alpha.
function _annotXformSelFromLayer() {
  const x = _annot.xform, cv = _annot.canvas;
  const sc = document.createElement('canvas');
  sc.width = cv.width; sc.height = cv.height;
  _annotXformDrawInto(sc.getContext('2d'), x, x.offX || 0, x.offY || 0);
  const d = sc.getContext('2d').getImageData(0, 0, sc.width, sc.height).data;
  let x0 = sc.width, y0 = sc.height, x1 = -1, y1 = -1;
  for (let y = 0; y < sc.height; y++) for (let px = 0; px < sc.width; px++) {
    if (d[(y * sc.width + px) * 4 + 3] < 128) continue;
    if (px < x0) x0 = px; if (px > x1) x1 = px;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let px = 0; px < w; px++) {
    mask[y * w + px] = d[((y + y0) * sc.width + (px + x0)) * 4 + 3] >= 128 ? 1 : 0;
  }
  const sel = { x: x0, y: y0, w, h, mask };
  sel.outline = _annotMaskOutline(sel);
  return sel;
}
function _annotXformEnd() {
  if (!_annot) return;
  _annot.xform = null;
  _annot.xfScale = null; _annot.xfMove = false;
  _annotXformSyncBar();
  _annotSelSyncBar();
}
// Burn the transform in. An untouched session just melts away — no history
// step is spent on a turn of 0°.
function annotXformApply(quiet) {
  const x = _annot && _annot.xform; if (!x) return;
  if (_annotXformIsIdentity(x)) { annotXformCancel(true); return; }
  _annotXformPreview();
  // A pasted picture becomes the selection too, so it can be nudged, filled or
  // turned again straight afterwards without hunting for it with the lasso.
  const sel = x.scope === 'image' ? null : _annotXformSelFromLayer();
  const what = x.scope === 'image' ? 'Picture' : x.scope === 'paste' ? 'Pasted picture' : 'Object';
  const bits = [];
  const sx = _annotXformSx(x), sy = _annotXformSy(x);
  const pct = v => Math.round(Math.abs(v) * 1000) / 10 + '%';
  if (Math.abs(sx) !== 1 || Math.abs(sy) !== 1) bits.push('resized to ' + pct(sx) + ' × ' + pct(sy));
  if (sx < 0 && sy < 0) bits.push('flipped both ways');
  else if (sx < 0) bits.push('flipped ↔');
  else if (sy < 0) bits.push('flipped ↕');
  if (x.angle) bits.push('turned ' + (Math.round(x.angle * 10) / 10) + '°');
  if (x.skewX) bits.push('slanted ' + (Math.round(x.skewX * 10) / 10) + '° ↔');
  if (x.skewY) bits.push('slanted ' + (Math.round(x.skewY * 10) / 10) + '° ↕');
  if (x.moved && !bits.length) bits.push('moved');
  else if (x.moved) bits.push('moved');
  if (x.scope === 'paste' && !bits.length) bits.push('placed');
  _annotXformEnd();
  if (sel) { _annot.sel = sel; _annotSelSyncBar(); }
  if (!quiet) showToast(what + ' ' + (bits.join(', ') || 'transformed') + ' ✓ (Undo puts it back)', 'success');
}
// Throw the session away and restore the snapshot taken when it started. The
// selection that was lifted comes back too, so cancelling costs nothing.
function annotXformCancel(quiet) {
  if (!_annot || !_annot.xform) return;
  const prevSel = _annot.xform.prevSel || null;
  const wasPaste = _annot.xform.scope === 'paste';
  _annotXformEnd();
  annotUndo();
  _annot.sel = prevSel;
  _annotSelSyncBar();
  if (!quiet) showToast(wasPaste ? 'Pasted picture removed' : 'Turn cancelled — picture put back', 'info');
}
function annotXformReset() {
  const x = _annot && _annot.xform; if (!x) return;
  x.angle = 0; x.skewX = 0; x.skewY = 0; x.strLine = null;
  x.sx = 1; x.sy = 1;
  _annotXformSyncBar(); _annotXformPreview();
}
function annotXformSet(field, val) {
  const x = _annot && _annot.xform; if (!x) return;
  const lim = field === 'angle' ? 180 : 60;
  x[field] = _annotClampNum(parseFloat(val), -lim, lim);
  _annotXformSyncBar(); _annotXformPreview();
}
function annotXformNudge(deg) {
  const x = _annot && _annot.xform; if (!x) return;
  x.angle = _annotWrapDeg(x.angle + deg);
  _annotXformSyncBar(); _annotXformPreview();
}
function annotXformSetGrow(on) {
  const x = _annot && _annot.xform; if (!x) return;
  x.grow = !!on;
  _annotXformPreview();
}
// Straighten: drag a line along something that ought to be level (a table rule,
// the base of a diagram, a line of print) and the picture turns to make it so.
function annotXformStraightenStart() {
  const x = _annot && _annot.xform; if (!x) return;
  x.straighten = true; x.strLine = null;
  _annotXformSyncBar();
  showToast('📐 Now drag a line along an edge that should be straight', 'info');
}
function _annotXformStraightenFinish() {
  const x = _annot && _annot.xform; if (!x || !x.strLine) return;
  const { from, to } = x.strLine;
  const dx = to.x - from.x, dy = to.y - from.y;
  x.strLine = null;
  // A stray click leaves Straighten armed — you meant to trace, not to click.
  if (Math.hypot(dx, dy) < 20) { showToast('Drag a longer line along the edge you want level', 'info'); _annotXformSyncBar(); return; }
  x.straighten = false;
  let deg = Math.atan2(dy, dx) * 180 / Math.PI;
  if (deg > 90) deg -= 180; else if (deg < -90) deg += 180;
  if (Math.abs(deg) > 45) deg -= Math.sign(deg) * 90;   // they traced a vertical edge
  x.angle = _annotWrapDeg(x.angle - deg);
  _annotXformSyncBar();
  _annotXformPreview();
  showToast('Straightened by ' + (Math.round(-deg * 10) / 10) + '° — fine-tune with the Turn slider', 'success');
}
function _annotXformSyncBar() {
  const bar = document.getElementById('annotXformBar');
  const x = _annot && _annot.xform;
  if (bar) bar.style.display = x ? 'flex' : 'none';
  if (!x) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = v; };
  set('annotXformAngle', x.angle); set('annotXformAngleNum', Math.round(x.angle * 10) / 10);
  set('annotXformSkewX', x.skewX); set('annotXformSkewY', x.skewY);
  const lbl = (id, v, unit) => { const el = document.getElementById(id); if (el) el.textContent = (Math.round(v * 10) / 10) + (unit || '°'); };
  lbl('annotXformSkewXVal', x.skewX); lbl('annotXformSkewYVal', x.skewY);
  // Size is shown as a percentage, and in real pixels beside it, because "how
  // big will this actually be" is the question a resize is asked to answer.
  const sx = _annotXformSx(x), sy = _annotXformSy(x);
  set('annotXformSxNum', Math.round(Math.abs(sx) * 1000) / 10);
  set('annotXformSyNum', Math.round(Math.abs(sy) * 1000) / 10);
  const lock = document.getElementById('annotXformLock');
  if (lock) lock.checked = x.lock !== false;
  const px = document.getElementById('annotXformSizePx');
  if (px) px.textContent = Math.round(Math.abs(sx) * x.layer.width) + ' × ' + Math.round(Math.abs(sy) * x.layer.height) + ' px';
  const scope = document.getElementById('annotXformScope');
  if (scope) scope.textContent = x.scope === 'sel' ? 'the selected object'
    : x.scope === 'paste' ? 'the pasted picture' : 'the whole picture';
  const growWrap = document.getElementById('annotXformGrowWrap');
  if (growWrap) growWrap.style.display = x.scope === 'image' ? 'inline-flex' : 'none';
  const grow = document.getElementById('annotXformGrow');
  if (grow) grow.checked = !!x.grow;
  const str = document.getElementById('annotXformStraightenBtn');
  if (str) str.classList.toggle('active', !!x.straighten);
}

// History brush: paint the ORIGINAL picture back, one dab at a time.
function _annotHistoryDab(x, y) {
  if (!_annot.origSnap) return;
  const ctx = _annot.ctx, r = Math.max(1, Math.round(_annot.size)) / 2;
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.clip();
  ctx.drawImage(_annot.origSnap, 0, 0);
  ctx.restore();
}
function _annotHistoryStroke(from, to) {
  const r = Math.max(1, Math.round(_annot.size)) / 2;
  const dx = to.x - from.x, dy = to.y - from.y, dist = Math.hypot(dx, dy);
  const step = Math.max(1, r / 2), n = Math.max(1, Math.ceil(dist / step));
  for (let i = 1; i <= n; i++) _annotHistoryDab(from.x + dx * (i / n), from.y + dy * (i / n));
}

// Clone stamp: copy a circular patch from the frozen source snapshot, offset so
// the source point tracks the brush as you drag.
function _annotCloneDab(ctx, x, y) {
  if (!_annot.cloneSnap || !_annot.cloneOff) return;
  const r = Math.max(1, Math.round(_annot.size)) / 2;
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.clip();
  ctx.drawImage(_annot.cloneSnap, _annot.cloneOff.x, _annot.cloneOff.y);
  ctx.restore();
}
function _annotCloneStroke(from, to) {
  const ctx = _annot.ctx, r = Math.max(1, Math.round(_annot.size)) / 2;
  const dx = to.x - from.x, dy = to.y - from.y, dist = Math.hypot(dx, dy);
  const step = Math.max(1, r / 2), n = Math.max(1, Math.ceil(dist / step));
  for (let i = 1; i <= n; i++) _annotCloneDab(ctx, from.x + dx * (i / n), from.y + dy * (i / n));
}
function _annotStageBox() {
  const st = document.getElementById('annotStage');
  return st ? st.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
}
// Keep the image from being dragged fully out of the viewport.
function _annotClampPan() {
  if (!_annot) return;
  const box = _annotStageBox(), s = _annotDisplayScale();
  const w = _annot.canvas.width * s, h = _annot.canvas.height * s;
  const margin = 40; // always keep at least this many px of image reachable
  _annot.panX = Math.min(box.width - margin, Math.max(margin - w, _annot.panX));
  _annot.panY = Math.min(box.height - margin, Math.max(margin - h, _annot.panY));
}
function annotZoomFit() {
  if (!_annot) return;
  const box = _annotStageBox();
  _annot.fit = Math.min(box.width / _annot.canvas.width, box.height / _annot.canvas.height) || 1;
  _annot.zoom = 1;
  const s = _annotDisplayScale();
  _annot.panX = (box.width - _annot.canvas.width * s) / 2;
  _annot.panY = (box.height - _annot.canvas.height * s) / 2;
  _annotUpdateTransform();
}
// Zoom about a viewport point (px relative to the stage). Keeps that point fixed.
function _annotZoomAt(factor, vx, vy) {
  if (!_annot) return;
  const box = _annotStageBox();
  if (vx == null) { vx = box.width / 2; vy = box.height / 2; }
  const oldS = _annotDisplayScale();
  const minZoom = 1, maxZoom = ANNOT_MAX_DISPLAY / (_annot.fit || 1);
  const newZoom = Math.min(maxZoom, Math.max(minZoom, _annot.zoom * factor));
  if (newZoom === _annot.zoom) return;
  const newS = _annot.fit * newZoom;
  // canvas-space point under the cursor stays put
  const cx = (vx - _annot.panX) / oldS, cy = (vy - _annot.panY) / oldS;
  _annot.zoom = newZoom;
  _annot.panX = vx - cx * newS;
  _annot.panY = vy - cy * newS;
  _annotClampPan();
  _annotUpdateTransform();
}
function annotZoomStep(factor) {
  const box = _annotStageBox();
  _annotZoomAt(factor, box.width / 2, box.height / 2);
}
function _annotWheel(e) {
  if (!_annot) return;
  e.preventDefault();   // never let the page/browser scroll or zoom
  const box = _annotStageBox();
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  _annotZoomAt(factor, e.clientX - box.left, e.clientY - box.top);
}
function _annotTypingInField(e) {
  const el = (e && e.target) || document.activeElement;
  return !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable));
}
function _annotKeyDown(e) {
  if (!_annot) return;
  if (e.code === 'Space' && !_annotTypingInField(e)) { _annot.space = true; const st = document.getElementById('annotStage'); if (st) st.classList.add('canpan'); _annotUpdateBrushRing(); e.preventDefault(); }
  // Escape backs out of the open transform first, then out of a selection.
  if (e.key === 'Escape' && !_annotTypingInField(e) && _annot.xform) { e.preventDefault(); _annot.drawing = false; annotXformCancel(); return; }
  if (e.key === 'Escape' && !_annotTypingInField(e) && (_annot.sel || _annot.selPts)) { _annot.selPts = null; _annot.drawing = false; annotSelClear(); }
  // Ctrl/Cmd+Z works even from a text label; everything else needs the canvas.
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); annotUndo(); return; }
  if (_annotTypingInField(e) || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  // [ and ] step the brush the way every paint program does. Shift jumps by 5.
  if (k === '[' || k === '{') { e.preventDefault(); _annotStepSize(k === '{' ? -5 : -1); return; }
  if (k === ']' || k === '}') { e.preventDefault(); _annotStepSize(k === '}' ? 5 : 1); return; }
  if (k === '+' || k === '=') { e.preventDefault(); annotZoomStep(1.3); return; }
  if (k === '-' || k === '_') { e.preventDefault(); annotZoomStep(1 / 1.3); return; }
  if (k === '0') { e.preventDefault(); annotZoomFit(); return; }
  // Delete / Backspace cuts the selection away, the way every image editor does.
  if ((k === 'Delete' || k === 'Backspace') && _annot.sel) { e.preventDefault(); annotSelDelete(); return; }
  // Enter commits an open transform (Photoshop's habit); otherwise it saves.
  if (k === 'Enter') { e.preventDefault(); if (_annot.xform) annotXformApply(); else applyAnnotTool(); return; }
  const tool = ANNOT_KEYS[String(k).toLowerCase()];
  if (tool) { e.preventDefault(); _annotSetTool(tool); }
}
function _annotKeyUp(e) { if (_annot && e.code === 'Space') { _annot.space = false; const st = document.getElementById('annotStage'); if (st) st.classList.remove('canpan'); _annotUpdateBrushRing(); } }
function _annotBindZoomListeners() {
  const st = document.getElementById('annotStage');
  if (st && !st._zoomBound) {
    st.addEventListener('wheel', _annotWheel, { passive: false });
    // The pointer can leave the stage (or the window) without another move
    // event ever arriving, which would strand the ring where it was last seen.
    st.addEventListener('pointerleave', () => { if (_annot) { _annot.ptrIn = false; _annotUpdateBrushRing(); } });
    st._zoomBound = true;
  }
  window.addEventListener('keydown', _annotKeyDown);
  window.addEventListener('keyup', _annotKeyUp);
  // Capture, so a picture pasted into the editor never reaches the page-level
  // paste handlers sitting underneath the overlay.
  window.addEventListener('paste', _annotPasteHandler, true);
}
function _annotUnbindZoomListeners() {
  window.removeEventListener('keydown', _annotKeyDown);
  window.removeEventListener('keyup', _annotKeyUp);
  window.removeEventListener('paste', _annotPasteHandler, true);
  const st = document.getElementById('annotStage');
  if (st) st.classList.remove('canpan', 'panning');
}
const ANNOT_CURSORS = { text: 'text', fill: 'cell', wand: 'cell', move: 'move', rotate: 'grab', skew: 'ew-resize', scale: 'move' };
function _annotSetTool(t) {
  _annotResetCompose();      // never strand the canvas in destination-out
  // Leaving Rotate/Skew/Resize settles the open transform: a real change is
  // kept, an untouched one is dropped. Nothing is ever left half-applied.
  if (_annot && _annot.xform && t !== 'rotate' && t !== 'skew' && t !== 'scale') {
    if (_annotXformIsIdentity(_annot.xform)) annotXformCancel(true); else annotXformApply();
  }
  if (_annot) _annot.tool = t;
  document.querySelectorAll('.annot-tool').forEach(b => b.classList.toggle('active', b.getAttribute('data-atool') === t));
  const c = document.getElementById('annotCanvas');
  if (c) c.style.cursor = ANNOT_CURSORS[t] || 'crosshair';
  // With Move active a whole text label is draggable, not just its little handle.
  document.querySelectorAll('#annotStage .annot-textbox').forEach(b => b.classList.toggle('movable', t === 'move'));
  _annotUpdateCloneMarker();   // show the clone-source pin only while the Clone tool is active
  // Picking Rotate, Skew or Resize opens the transform straight away, so the
  // handles and sliders are there to use — you shouldn't have to drag once to
  // discover the panel.
  if (_annot && (t === 'rotate' || t === 'skew' || t === 'scale') && !_annot.xform) _annotXformBegin();
  _annotXformSyncBar();
  // Switching to a brush tool should show its size straight away — you should
  // not have to make a mark to find out how big the mark will be.
  if (_annot && ANNOT_RING_TOOLS[t]) _annotBrushFlash(); else _annotUpdateBrushRing();
}
// Single-key tool switching, Photoshop's letters where they exist.
const ANNOT_KEYS = { e: 'erase', b: 'paint', g: 'fill', s: 'clone', y: 'history', m: 'select', l: 'lasso', w: 'wand', v: 'move', u: 'line', t: 'text', r: 'rotate', k: 'skew', f: 'scale' };
// A history step remembers the canvas SIZE as well as its pixels: rotating the
// whole picture grows the canvas, and undoing that has to shrink it back.
// THE UNDO STACK IS CAPPED BY BYTES, NOT BY A COUNT, and that is what pays for
// the big canvas above. A full-frame snapshot of a 4096px photo is 67 MB, so
// the portal's flat "keep the last ten" would hold two thirds of a gigabyte of
// RGBA on a picture this app is expressly built to open. Ten steps on a small
// picture and fewer on a huge one is the honest trade — and it is why the
// ceiling could be raised at all.
//
// ONE step is always kept, whatever it costs: an undo that silently is not
// there is worse than a slow one.
function _annotPushHistory() {
  if (!_annot) return;
  try {
    const w = _annot.canvas.width, h = _annot.canvas.height;
    _annot.history.push({ img: _annot.ctx.getImageData(0, 0, w, h), w, h, bytes: w * h * 4 });
    let total = _annot.history.reduce((n, s) => n + (s.bytes || 0), 0);
    while (_annot.history.length > ANNOT_HISTORY_MAX ||
           (_annot.history.length > 1 && total > ANNOT_HISTORY_BYTES)) {
      total -= _annot.history.shift().bytes || 0;
    }
  } catch (_) {}
}
// 🧻 Clean paper — the manual twin of the automatic pass in the enhance door,
// for every picture that is ALREADY in the bank. Those were re-rendered before
// the cleaner existed and carry the weave in their stored pixels; nobody is
// going to reopen a thousand of them, but the one being touched up anyway is a
// tap away from clean. One history step, so ↶ Undo puts the texture back if
// the guards let through something they should not have.
function annotCleanPaper() {
  if (!_annot) return;
  const W = _annot.canvas.width, H = _annot.canvas.height;
  let id;
  try { id = _annot.ctx.getImageData(0, 0, W, H); }
  catch (e) { showToast('Could not read the picture to clean it', 'error'); return; }
  const rep = _paperCleanPixels(id.data, W, H);
  if (!rep.ok) {
    // Every refusal is named, because "nothing happened" on a button is the
    // one outcome nobody can act on.
    showToast(rep.reason === 'no-white' ? 'Left alone — this picture has no white paper to clean (it is a photo or dark artwork)'
      : rep.reason === 'not-paper' ? 'Left alone — the bright part is not a page background here'
      : rep.reason === 'no-ink' ? 'Left alone — there is no line work in this picture to protect'
      : 'Nothing to clean', 'info');
    return;
  }
  if (!rep.changed) { showToast('Already clean — the background is pure white ✓', 'info'); return; }
  _annotPushHistory();
  _annot.ctx.putImageData(id, 0, 0);
  showToast(`🧻 Cleaned the background — ${Math.round(rep.changed / (W * H) * 100)}% of the picture snapped to white ✓`, 'success');
}

function annotUndo() {
  if (!_annot) return;
  // While a rotate/skew is open, undo means "abandon this turn" — stepping the
  // canvas back underneath a live session would leave the two out of step.
  // (Cancel clears the session first, so this never recurses.)
  if (_annot.xform) { annotXformCancel(); return; }
  if (!_annot.history.length) return;
  const step = _annot.history.pop();
  if (_annot.canvas.width !== step.w || _annot.canvas.height !== step.h) {
    _annotResizeCanvas(step.w, step.h);
    annotZoomFit();
  }
  _annot.ctx.putImageData(step.img, 0, 0);
}
// Resize the working canvas (and the marching-ants overlay that rides on it).
function _annotResizeCanvas(w, h) {
  if (!_annot) return;
  _annot.canvas.width = w; _annot.canvas.height = h;
  if (_annot.selCanvas) { _annot.selCanvas.width = w; _annot.selCanvas.height = h; }
}
function _annotPt(e) {
  const c = _annot.canvas, r = c.getBoundingClientRect();
  const scale = c.width / r.width;
  return { x: (e.clientX - r.left) * scale, y: (e.clientY - r.top) * (c.height / r.height), dispX: e.clientX - r.left, dispY: e.clientY - r.top, clientX: e.clientX, clientY: e.clientY, scale };
}
// Plot a crisp 1px line between two points (Bresenham) — no anti-aliasing, so a
// 1px brush drags as clean single pixels, like a Photoshop pencil.
function _annotPlotLine(ctx, x0, y0, x1, y1) {
  x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.floor(x1); y1 = Math.floor(y1);
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    ctx.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}
// Snap the end point to the nearest 45° from the start (PowerPoint-style).
function _annotSnap45(s, p) {
  const dx = p.x - s.x, dy = p.y - s.y;
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return { x: s.x + Math.cos(ang) * len, y: s.y + Math.sin(ang) * len };
}
// Lock to the horizontal or vertical axis (whichever is dominant) — the
// Photoshop Shift-drag brush constraint.
function _annotSnapAxis(s, p) {
  const dx = p.x - s.x, dy = p.y - s.y;
  return Math.abs(dx) >= Math.abs(dy) ? { x: p.x, y: s.y } : { x: s.x, y: p.y };
}
// Constrain a rectangle drag to a square (Shift held while rect-selecting).
function _annotSquarePt(s, p) {
  const dx = p.x - s.x, dy = p.y - s.y;
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: s.x + (dx < 0 ? -m : m), y: s.y + (dy < 0 ? -m : m) };
}
// One straight brush stroke between two points with the current tool settings
// (used by the Photoshop click-then-Shift-click line).
function _annotBrushLine(a, b) {
  const ctx = _annot.ctx, lw = Math.max(1, Math.round(_annot.size));
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  _annotPaintCompose(ctx);
  ctx.lineWidth = lw;
  if (lw <= 1) { _annotPlotLine(ctx, a.x, a.y, b.x, b.y); }
  else { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
  _annotResetCompose();
}
// ---- SELECTION (rectangle / lasso) with marching ants, then fill the area
// with a flat colour, the surrounding texture, or AI content-aware fill. ----
function _annotSelPath(pts) {
  const path = new Path2D();
  if (!pts || pts.length < 2) return path;
  path.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
  path.closePath();
  return path;
}
function _annotSelSyncBar() {
  const bar = document.getElementById('annotSelBar');
  if (bar) bar.style.display = (_annot && _annot.sel) ? 'flex' : 'none';
  _aiVisibilitySync();
  _annotAiSyncScope();   // ✨ Regenerate says which of its two scopes it is about to use
}
// The two AI buttons are the only things in this app that need a network, and
// the AI init is deliberately late (and allowed to fail), so BOTH of them are
// hidden rather than left sitting there dead. A button that costs a click and
// answers with an error toast is worse than a button that is not there.
//
// This is called from _annotSelSyncBar (every selection change) and once more
// when the models finally land, so a bar drawn before the SDK arrived is put
// right without the editor being reopened.
function _aiVisibilitySync() {
  const ready = imageAiReady();
  const fill = document.getElementById('annotAiFillBtn');
  if (fill) fill.style.display = ready ? '' : 'none';
  const ai = document.getElementById('annotAiBar');
  if (ai) ai.style.display = (ready && _annot) ? 'flex' : 'none';
}
// The bounding box of a selection, whichever shape it is — a polygon from the
// rectangle / lasso tools, or a masked rect from the magic wand.
function _annotSelBox(sel) {
  if (!sel) return null;
  if (!sel.pts) return { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  sel.pts.forEach(p => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}
function annotSelClear() {
  if (!_annot) return;
  _annot.sel = null; _annot.selPts = null;
  _annotSelSyncBar();
}

// ---- MAGIC WAND -----------------------------------------------------------
// Click a colour and every pixel like it becomes the selection. Contiguous by
// default (the patch you clicked); Alt+click takes that colour across the whole
// picture, which is how you grab, say, every bit of a printed grey watermark in
// one go. "Like it" is the ± slider: squared RGB distance, same yardstick the
// paint bucket uses, so the two tools behave consistently.
//
// The result is a per-pixel MASK, not a polygon — a wand selection can be full
// of holes and islands that no outline could describe. Every selection
// operation below therefore works from a mask, and the polygon tools simply
// rasterise into one.
function _annotMagicWand(sx, sy, global) {
  const cv = _annot.canvas, W = cv.width, H = cv.height;
  sx = Math.floor(sx); sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
  const d = _annot.ctx.getImageData(0, 0, W, H).data;
  const at = (x, y) => (y * W + x) * 4;
  const s0 = at(sx, sy);
  const tr = d[s0], tg = d[s0 + 1], tb = d[s0 + 2];
  const t = Math.max(1, _annot.tol || 32), TOL = t * t * 3;
  const near = i => { const dr = d[i] - tr, dg = d[i + 1] - tg, db = d[i + 2] - tb; return dr * dr + dg * dg + db * db <= TOL; };
  const mask = new Uint8Array(W * H);
  if (global) {
    for (let k = 0; k < mask.length; k++) if (near(k * 4)) mask[k] = 1;
  } else {
    const stack = [sy * W + sx];
    mask[sy * W + sx] = 1;
    while (stack.length) {
      const k = stack.pop(), x = k % W, y = (k / W) | 0;
      if (x > 0 && !mask[k - 1] && near(at(x - 1, y))) { mask[k - 1] = 1; stack.push(k - 1); }
      if (x < W - 1 && !mask[k + 1] && near(at(x + 1, y))) { mask[k + 1] = 1; stack.push(k + 1); }
      if (y > 0 && !mask[k - W] && near(at(x, y - 1))) { mask[k - W] = 1; stack.push(k - W); }
      if (y < H - 1 && !mask[k + W] && near(at(x, y + 1))) { mask[k + W] = 1; stack.push(k + W); }
    }
  }
  // Crop to the pixels actually hit so every later pass works on a small box.
  let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!mask[y * W + x]) continue;
    n++;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (!n) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = mask[(y + y0) * W + (x + x0)];
  return { x: x0, y: y0, w, h, mask: out, count: n };
}

// The outline of a mask, as edge segments between a selected and an unselected
// pixel. Marching ants ride this exactly like they ride a lasso path.
function _annotMaskOutline(m) {
  const path = new Path2D();
  const on = (x, y) => (x < 0 || y < 0 || x >= m.w || y >= m.h) ? 0 : m.mask[y * m.w + x];
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    if (!on(x, y)) continue;
    const px = m.x + x, py = m.y + y;
    if (!on(x, y - 1)) { path.moveTo(px, py); path.lineTo(px + 1, py); }
    if (!on(x, y + 1)) { path.moveTo(px, py + 1); path.lineTo(px + 1, py + 1); }
    if (!on(x - 1, y)) { path.moveTo(px, py); path.lineTo(px, py + 1); }
    if (!on(x + 1, y)) { path.moveTo(px + 1, py); path.lineTo(px + 1, py + 1); }
  }
  return path;
}
// Marching-ants animation: redraw the selection outline on the overlay canvas
// while the tool is open. Dash length is in screen pixels regardless of zoom.
let _annotAntsRunning = false;
function _annotAntsLoop() {
  if (!_annot || !_annot.selCanvas) { _annotAntsRunning = false; return; }
  _annotAntsRunning = true;
  const sc = _annot.selCanvas, sctx = sc.getContext('2d');
  sctx.clearRect(0, 0, sc.width, sc.height);
  const pts = (_annot.drawing && _annot.selPts) ? _annot.selPts : (_annot.sel && _annot.sel.pts ? _annot.sel.pts : null);
  let path = null;
  if (pts && pts.length > 1) path = _annotSelPath(pts);
  else if (_annot.sel && _annot.sel.outline) path = _annot.sel.outline;
  if (path) {
    const s = _annotDisplayScale() || 1;
    const phase = (performance.now() / 90) % 16;
    sctx.lineWidth = Math.max(1 / s, 0.5);
    sctx.setLineDash([6 / s, 6 / s]);
    sctx.strokeStyle = '#ffffff'; sctx.lineDashOffset = -phase / s; sctx.stroke(path);
    sctx.strokeStyle = '#111111'; sctx.lineDashOffset = -(phase + 6) / s; sctx.stroke(path);
  }
  // The transform box rides the same overlay: the object's real outline while
  // it is being turned, slanted or resized, with grab handles on it while the
  // Resize tool is the one in hand.
  const xf = _annot.xform;
  if (xf && xf.layer) {
    const s = _annotDisplayScale() || 1;
    const c = _annotXformCorners(xf);
    const off = { x: xf.offX || 0, y: xf.offY || 0 };
    sctx.setLineDash([]);
    sctx.beginPath();
    c.forEach((p, i) => { const X = p.x + off.x, Y = p.y + off.y; i ? sctx.lineTo(X, Y) : sctx.moveTo(X, Y); });
    sctx.closePath();
    sctx.lineWidth = Math.max(1.4 / s, 0.5);
    sctx.strokeStyle = 'rgba(255,255,255,0.95)'; sctx.stroke();
    sctx.lineWidth = Math.max(0.7 / s, 0.25);
    sctx.strokeStyle = '#b45309'; sctx.stroke();
    if (_annot.tool === 'scale') {
      const r = 5 / s;
      _annotXformHandles(xf).forEach(h => {
        const X = h.pt.x + off.x, Y = h.pt.y + off.y;
        sctx.beginPath(); sctx.rect(X - r, Y - r, r * 2, r * 2);
        sctx.fillStyle = '#ffffff'; sctx.fill();
        sctx.lineWidth = Math.max(1 / s, 0.4);
        sctx.strokeStyle = '#b45309'; sctx.stroke();
      });
    }
  }
  if (xf && xf.strLine) {
    const s = _annotDisplayScale() || 1;
    sctx.setLineDash([]);
    sctx.lineCap = 'round';
    sctx.lineWidth = Math.max(1.5 / s, 0.6);
    sctx.beginPath();
    sctx.moveTo(xf.strLine.from.x, xf.strLine.from.y);
    sctx.lineTo(xf.strLine.to.x, xf.strLine.to.y);
    sctx.strokeStyle = 'rgba(255,255,255,0.9)'; sctx.stroke();
    sctx.lineWidth = Math.max(0.8 / s, 0.3);
    sctx.strokeStyle = '#0b6b4f'; sctx.stroke();
  }
  requestAnimationFrame(_annotAntsLoop);
}
// Rasterise the selection into a bounding box + per-pixel mask (1 = selected).
// A wand selection already IS a mask and is handed straight back.
function _annotSelMask() {
  const sel = _annot && _annot.sel; if (!sel) return null;
  if (sel.mask) return sel;
  const W = _annot.canvas.width, H = _annot.canvas.height;
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  sel.pts.forEach(p => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
  const w = x1 - x0, h = y1 - y0;
  if (w < 1 || h < 1) return null;
  const mc = document.createElement('canvas'); mc.width = w; mc.height = h;
  const mx = mc.getContext('2d');
  mx.translate(-x0, -y0);
  mx.fillStyle = '#fff';
  mx.fill(_annotSelPath(sel.pts));
  const md = mx.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = md[i * 4 + 3] > 127 ? 1 : 0;
  return { x: x0, y: y0, w, h, mask };
}
// Apply a callback clipped to the selection, whichever kind it is: a polygon
// gets a real canvas clip (anti-aliased edges), a wand mask is composited
// pixel-by-pixel. One helper so every selection action supports both.
function _annotWithSelClip(fn) {
  const sel = _annot && _annot.sel; if (!sel) return;
  const ctx = _annot.ctx;
  if (sel.pts) { ctx.save(); ctx.clip(_annotSelPath(sel.pts)); fn(ctx); ctx.restore(); return; }
  const m = sel;
  const scratch = document.createElement('canvas');
  scratch.width = _annot.canvas.width; scratch.height = _annot.canvas.height;
  const sx = scratch.getContext('2d');
  fn(sx);
  const before = ctx.getImageData(m.x, m.y, m.w, m.h);
  const after = sx.getImageData(m.x, m.y, m.w, m.h);
  for (let k = 0; k < m.mask.length; k++) {
    if (!m.mask[k] || after.data[k * 4 + 3] === 0) continue;
    const i = k * 4;
    before.data[i] = after.data[i]; before.data[i + 1] = after.data[i + 1];
    before.data[i + 2] = after.data[i + 2]; before.data[i + 3] = 255;
  }
  ctx.putImageData(before, m.x, m.y);
}
// ---- DELETE: cut the selection away to nothing -----------------------------
// The flow this exists for: pick the 🪄 wand, click the colour that should not
// be there (Alt+click to take it across the WHOLE picture), press Delete. Those
// pixels become transparent — not white, not black, gone — and the PNG that is
// saved keeps the hole.
function annotSelDelete() {
  if (!_annot || !_annot.sel) { showToast('Select an area first — 🪄 wand, ⬚ select or ➰ lasso', 'info'); return; }
  _annotPushHistory();
  const ctx = _annot.ctx, sel = _annot.sel;
  if (sel.pts) {
    // A polygon gets a real clip, so the edge is anti-aliased rather than jagged.
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.fill(_annotSelPath(sel.pts));
    ctx.restore();
  } else {
    const m = sel;
    const d = ctx.getImageData(m.x, m.y, m.w, m.h);
    for (let k = 0; k < m.mask.length; k++) if (m.mask[k]) d.data[k * 4 + 3] = 0;
    ctx.putImageData(d, m.x, m.y);
  }
  showToast('Deleted — that area is transparent now ✓', 'success');
}
function annotSelFillColour() {
  if (!_annot || !_annot.sel) return;
  _annotSyncControls();
  _annotPushHistory();
  const sel = _annot.sel, colour = _annot.color;
  _annotWithSelClip(c => {
    c.fillStyle = colour;
    if (sel.pts) c.fill(_annotSelPath(sel.pts));
    else c.fillRect(sel.x, sel.y, sel.w, sel.h);
  });
  showToast('Selection filled ✓', 'success');
}
// "Fill from surroundings" — onion-peel inpainting: BFS inwards from the
// selection edge, each unknown pixel takes the average of its already-known
// neighbours. Fast, local, great for paper/flat backgrounds.
function annotSelPatchFill() {
  if (!_annot || !_annot.sel) return;
  const m = _annotSelMask(); if (!m) return;
  _annotPushHistory();
  const ctx = _annot.ctx, W = _annot.canvas.width, H = _annot.canvas.height;
  // Work on a box one pixel wider than the selection so the border ring is known.
  const bx = Math.max(0, m.x - 1), by = Math.max(0, m.y - 1);
  const bw = Math.min(W, m.x + m.w + 1) - bx, bh = Math.min(H, m.y + m.h + 1) - by;
  const img = ctx.getImageData(bx, by, bw, bh), d = img.data;
  const unknown = new Uint8Array(bw * bh);
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    if (m.mask[y * m.w + x]) unknown[(y + m.y - by) * bw + (x + m.x - bx)] = 1;
  }
  const queue = [];
  const edge = k => {   // unknown pixel touching at least one known pixel
    const x = k % bw, y = (k / bw) | 0;
    return (x > 0 && !unknown[k - 1]) || (x < bw - 1 && !unknown[k + 1]) || (y > 0 && !unknown[k - bw]) || (y < bh - 1 && !unknown[k + bw]);
  };
  for (let k = 0; k < unknown.length; k++) if (unknown[k] && edge(k)) queue.push(k);
  let qi = 0;
  while (qi < queue.length) {
    const k = queue[qi++];
    if (!unknown[k]) continue;
    const x = k % bw, y = (k / bw) | 0;
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
      const nk = ny * bw + nx;
      if (unknown[nk]) continue;
      const i = nk * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
    if (!n) continue;   // no known neighbour (selection spans the whole image edge) — leave as-is
    const i = k * 4;
    d[i] = r / n; d[i + 1] = g / n; d[i + 2] = b / n; d[i + 3] = 255;
    unknown[k] = 0;
    // enqueue unknown 4-neighbours
    if (x > 0 && unknown[k - 1]) queue.push(k - 1);
    if (x < bw - 1 && unknown[k + 1]) queue.push(k + 1);
    if (y > 0 && unknown[k - bw]) queue.push(k - bw);
    if (y < bh - 1 && unknown[k + bw]) queue.push(k + bw);
  }
  ctx.putImageData(img, bx, by);
  showToast('Filled from the surrounding texture ✓', 'success');
}
// AI content-aware fill: paint the selection solid magenta on a copy, ask the
// Gemini image model to reconstruct that region from its surroundings, then
// composite the result back clipped to the selection — pixels outside the
// selection are never touched.
async function annotSelAiFill() {
  if (!_annot || !_annot.sel) return;
  if (_annot.aiFillBusy) { showToast('AI fill is already running…', 'info'); return; }
  if (!imageAiReady()) { showToast('Image AI is not available — try "Fill from surroundings" instead', 'error'); return; }
  const sel = _annot.sel, canvas = _annot.canvas;
  _annot.aiFillBusy = true;
  showToast('✨ AI content-aware fill…', 'info');
  try {
    const marked = document.createElement('canvas');
    marked.width = canvas.width; marked.height = canvas.height;
    const mx = marked.getContext('2d');
    mx.drawImage(canvas, 0, 0);
    mx.fillStyle = '#ff00ff';
    if (sel.pts) {
      mx.fill(_annotSelPath(sel.pts));
    } else {
      const md = mx.getImageData(sel.x, sel.y, sel.w, sel.h);
      for (let k = 0; k < sel.mask.length; k++) {
        if (!sel.mask[k]) continue;
        const i = k * 4;
        md.data[i] = 255; md.data[i + 1] = 0; md.data[i + 2] = 255; md.data[i + 3] = 255;
      }
      mx.putImageData(md, sel.x, sel.y);
    }
    const dataUrl = marked.toDataURL('image/png');
    // Deliberately NOT SCAN_SOURCE_PROMPT: this patch has to disappear into
    // surroundings that are still scanned, so it must copy the scan's grain
    // and tone rather than clean it up.
    const prompt = 'This image has one region painted solid magenta (#FF00FF). Reproduce the ENTIRE image exactly as it is — same size, same colours, same content — but replace the magenta region with a seamless, content-aware reconstruction of the background and surrounding texture, as if whatever was there had been removed. Continue any lines, shading or patterns that pass through the region naturally. ' +
      'The picture is a scan, photocopy or photo of a printed exam paper, so the area around the region is probably speckled, greyish, unevenly lit, slightly blurred and a little skewed. MATCH that surrounding grain, tone and brightness exactly so the repair is invisible — do NOT clean it up, sharpen it, whiten it or straighten it, and do not let the patch look newer than the paper around it. ' +
      'Do not change ANYTHING outside the magenta region. Do not add labels, watermarks or new objects.';
    // Deliberately NOT `generateCleanEnhancedImage`. This reply is a PATCH that
    // has to disappear into the picture around it — `ANNOT_AI_KEEP` asks the
    // model to match the grain and tone of a scan rather than clean it up — so
    // whitening its background would leave a bright rectangle on a grey page.
    // Cleaning the whole picture is the 🧻 button's job, not this one's.
    const outUrl = await generateEnhancedImageDataUrl(prompt, { mimeType: 'image/png', data: dataUrl.split(',')[1] || '' });
    const img = await _loadImageEl(outUrl);
    if (!_annot || _annot.canvas !== canvas) return;   // tool was closed meanwhile
    _annotPushHistory();
    // Only the selected area may change — clipped for a polygon, masked for a wand.
    _annotWithSelClip(c => c.drawImage(img, 0, 0, canvas.width, canvas.height));
    showToast('AI content-aware fill applied ✓ (Undo if it missed)', 'success');
  } catch (e) {
    console.warn('AI content-aware fill failed', e);
    showToast('AI fill failed: ' + (e && e.message ? e.message : e), 'error');
  } finally { if (_annot) _annot.aiFillBusy = false; }
}

// ---- ✨ REGENERATE: say what you want and the AI redraws it ------------------
// AI content-aware fill answers exactly ONE question — "take this out" — with a
// prompt nobody can change. Everything else an author actually wants of a
// picture ("rub out the pencil marks", "make the arrow red", "redraw this
// beaker cleanly", "put the missing axis label back") had no door at all. This
// is that door: a line to type in, and the same image model behind it.
//
// TWO SCOPES, and the difference between them is the whole safety story:
//   * With an area SELECTED, only that area may change. The model is shown the
//     picture with the area RINGED rather than blanked — "make the arrow red"
//     needs the arrow still visible, which is exactly what content-aware fill's
//     magenta blanking destroys — and the reply is composited back through
//     _annotWithSelClip, so a model that quietly rewrote the whole page cannot
//     touch one pixel outside the selection.
//   * With NOTHING selected the whole picture is redrawn, which is the honest
//     reading of "no area chosen".
// The bar names the scope it is about to use, because those two are very
// different things to press a button on.
//
// It is one history step either way, so ↶ Undo puts the original back — which
// is what makes an experimental prompt cheap enough to actually experiment with.
const ANNOT_AI_KEEP = ' Return the ENTIRE image at the SAME size and aspect ratio. The picture is usually a scan, photocopy or photo of a printed page, so match the grain, tone, brightness and line weight of the surrounding picture exactly — do not clean it up, sharpen it, whiten it, straighten it or restyle it. Do not add labels, watermarks, borders, captions or any object that was not asked for.';
function _annotAiSyncScope() {
  const el = document.getElementById('annotAiScope');
  if (el) el.textContent = (_annot && _annot.sel) ? 'the selected area only' : 'the whole picture';
}
// Opening the editor on a new picture starts the bar empty — last picture's
// instruction sitting in the box is one Enter away from being run on this one —
// and hides it outright where there is no image model to run it.
function _annotAiBarInit() {
  _aiVisibilitySync();
  const input = document.getElementById('annotAiPrompt');
  if (input) input.value = '';
  const btn = document.getElementById('annotAiGoBtn');
  if (btn) { btn.disabled = false; btn.textContent = '✨ Regenerate'; }
  _annotAiSyncScope();
}
async function annotAiRegen() {
  if (!_annot) return;
  const input = document.getElementById('annotAiPrompt');
  const want = ((input && input.value) || '').trim();
  if (!want) { showToast('Type what you want changed first', 'info'); if (input) input.focus(); return; }
  if (_annot.aiFillBusy) { showToast('The AI is already working on this picture…', 'info'); return; }
  if (!imageAiReady()) { showToast('Image AI is not available in this project', 'error'); return; }
  const canvas = _annot.canvas, sel = _annot.sel;
  const btn = document.getElementById('annotAiGoBtn');
  _annot.aiFillBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = '✨ Regenerating…'; }
  showToast('✨ Regenerating ' + (sel ? 'the selected area' : 'the picture') + '…', 'info');
  try {
    const marked = document.createElement('canvas');
    marked.width = canvas.width; marked.height = canvas.height;
    const mx = marked.getContext('2d');
    mx.drawImage(canvas, 0, 0);
    let prompt;
    if (sel) {
      // The marker is drawn just OUTSIDE the selection, so it never covers the
      // content the instruction is about — and anything of it that survives
      // into the reply is outside the clip and therefore cannot be composited.
      const b = _annotSelBox(sel);
      const pad = Math.max(3, Math.round(Math.min(canvas.width, canvas.height) * 0.006));
      mx.save();
      mx.strokeStyle = '#ff00ff';
      mx.lineWidth = pad;
      mx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
      mx.restore();
      prompt = 'Reproduce this ENTIRE image exactly as it is — same size, same colours, same content — and change ONLY what is inside the magenta (#FF00FF) rectangle: ' + want + '. '
        + 'The magenta rectangle is a marker, not part of the picture: do not draw it in your output, and blend your change seamlessly into the picture at its edges. Change NOTHING outside it.' + ANNOT_AI_KEEP;
    } else {
      prompt = 'Redraw this image with the following change: ' + want + '. Keep everything else in the picture exactly as it is.' + ANNOT_AI_KEEP;
    }
    const dataUrl = marked.toDataURL('image/png');
    // Deliberately NOT `generateCleanEnhancedImage`. This reply is a PATCH that
    // has to disappear into the picture around it — `ANNOT_AI_KEEP` asks the
    // model to match the grain and tone of a scan rather than clean it up — so
    // whitening its background would leave a bright rectangle on a grey page.
    // Cleaning the whole picture is the 🧻 button's job, not this one's.
    const outUrl = await generateEnhancedImageDataUrl(prompt, { mimeType: 'image/png', data: dataUrl.split(',')[1] || '' });
    const img = await _loadImageEl(outUrl);
    if (!_annot || _annot.canvas !== canvas) return;   // the editor was closed while the AI was thinking
    _annotPushHistory();
    if (sel) {
      _annotWithSelClip(c => c.drawImage(img, 0, 0, canvas.width, canvas.height));
    } else {
      // clearRect first, never a 'copy' composite: a canvas stranded in a
      // composite mode erases everything drawn afterwards.
      const ctx = _annot.ctx;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }
    showToast('Regenerated ✓ — ↶ Undo puts it back', 'success');
  } catch (e) {
    console.warn('AI regenerate failed', e);
    showToast('Regenerate failed: ' + (e && e.message ? e.message : e), 'error');
  } finally {
    if (_annot) _annot.aiFillBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = '✨ Regenerate'; }
  }
}
function _annotDown(e) {
  if (!_annot) return;
  e.preventDefault();
  _annotSyncControls();
  const p = _annotPt(e), ctx = _annot.ctx;
  if (_annot.tool === 'text') { _annotPlaceText(p); return; }
  if (_annot.tool === 'fill') { _annotPushHistory(); _annotFloodFill(p.x, p.y); return; }
  if (_annot.tool === 'wand') {
    const m = _annotMagicWand(p.x, p.y, e.altKey);
    if (!m) { showToast('Nothing matched there — try a bigger ±', 'info'); return; }
    m.outline = _annotMaskOutline(m);
    _annot.sel = m;
    _annotSelSyncBar();
    showToast(m.count.toLocaleString() + ' pixels selected' + (e.altKey ? ' across the whole picture' : '') +
      ' — fill it, move it, or widen the ± slider', 'info');
    return;
  }
  if (_annot.tool === 'scale') {
    if (!_annot.xform) _annotXformBegin();
    const x = _annot.xform; if (!x) return;
    const h = _annotXformHandleAt(p);
    if (h) { _annotXformScaleStart(h); _annot.start = p; _annot.drawing = true; return; }
    // Not on a handle: dragging the middle of the box slides the object.
    if (_annotXformInside(p)) { _annot.start = p; _annot.xfMove = true; _annot.drawing = true; return; }
    showToast('Drag a corner or edge handle to resize — or inside the box to move it', 'info');
    return;
  }
  if (_annot.tool === 'rotate' || _annot.tool === 'skew') {
    if (!_annot.xform) _annotXformBegin();
    const x = _annot.xform; if (!x) return;
    if (x.straighten) { x.strLine = { from: p, to: p }; _annot.drawing = true; return; }
    _annot.start = p;
    _annot.xfStart = { angle: x.angle, skewX: x.skewX, skewY: x.skewY, ang0: Math.atan2(p.y - x.cy, p.x - x.cx) };
    _annot.drawing = true;
    return;
  }
  if (_annot.tool === 'move') {
    if (!_annot.sel) { showToast('Select an area first (⬚, ➰ or 🪄), then drag it with Move', 'info'); return; }
    _annotPushHistory();
    _annot.float = _annotSelLift(e.altKey);
    if (!_annot.float) return;
    _annot.start = p;
    _annot.drawing = true;
    return;
  }
  if (_annot.tool === 'history') {
    _annotPushHistory();
    _annot.drawing = true;
    _annot.last = p;
    _annotHistoryDab(p.x, p.y);
    return;
  }
  if (_annot.tool === 'select' || _annot.tool === 'lasso') {
    _annot.sel = null; _annotSelSyncBar();
    _annot.selPts = _annot.tool === 'select' ? [p, p, p, p] : [p];
    _annot.start = p;
    _annot.drawing = true;
    return;
  }
  if (_annot.tool === 'clone') {
    // First click (or Alt+click) sets the source; later drags stamp from it.
    if (e.altKey || !_annot.cloneSrc) {
      _annot.cloneSrc = { x: p.x, y: p.y };
      _annotUpdateCloneMarker();
      _annotUpdateBrushRing();   // the ring can start previewing the moment there is a source
      showToast('Clone source set — the ring under your pointer now shows what will be stamped', 'info');
      return;
    }
    _annotPushHistory();
    const snap = document.createElement('canvas');
    snap.width = _annot.canvas.width; snap.height = _annot.canvas.height;
    snap.getContext('2d').drawImage(_annot.canvas, 0, 0);
    _annot.cloneSnap = snap;
    _annot.cloneOff = { x: p.x - _annot.cloneSrc.x, y: p.y - _annot.cloneSrc.y };
    _annot.drawing = true;
    _annot.last = p;
    _annotCloneDab(ctx, p.x, p.y);
    _annotUpdateBrushRing();   // the offset is locked in now — preview from the frozen snapshot
    return;
  }
  _annotPushHistory();
  if (_annot.tool === 'line') {
    _annot.start = p;
    _annot.snap = ctx.getImageData(0, 0, _annot.canvas.width, _annot.canvas.height);
    _annot.drawing = true;
    return;
  }
  // erase / paint brush
  // Photoshop straight-line join: click once, then Shift-click somewhere else —
  // the two points are connected with one straight stroke.
  if (e.shiftKey && _annot.anchor) {
    _annotBrushLine(_annot.anchor, p);
    _annot.drawing = true;
    _annot.last = p;
    _annot.shiftSeg = null;
    ctx.beginPath(); ctx.moveTo(p.x, p.y);
    return;
  }
  _annot.drawing = true;
  _annot.last = p;
  _annot.shiftSeg = null; // Shift-straight segment state (start pt + snapshot)
  // Brush size is measured in IMAGE pixels (Photoshop-style): size 1 = one pixel,
  // independent of the current zoom, so precise edits are possible when zoomed in.
  const lw = Math.max(1, Math.round(_annot.size));
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // The mode is set for the WHOLE stroke — the drag carries on in pointermove
  // against this same context — and _annotUp puts it back.
  _annotPaintCompose(ctx);
  ctx.lineWidth = lw;
  if (lw <= 1) {
    // A 1px brush paints a crisp single pixel (no anti-aliasing) — pixel-perfect.
    ctx.fillRect(Math.floor(p.x), Math.floor(p.y), 1, 1);
  } else {
    ctx.beginPath(); ctx.arc(p.x, p.y, lw / 2, 0, Math.PI * 2); ctx.fill(); // a click paints a dot
  }
  ctx.beginPath(); ctx.moveTo(p.x, p.y);
}
function _annotMove(e) {
  if (!_annot || !_annot.drawing) return;
  e.preventDefault();
  const p = _annotPt(e), ctx = _annot.ctx;
  if (_annot.tool === 'scale') {
    if (_annot.xfScale) { _annotXformScaleDrag(p, e.shiftKey); return; }
    if (_annot.xfMove && _annot.start) {
      let dx = p.x - _annot.start.x, dy = p.y - _annot.start.y;
      if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }   // Shift = straight
      _annotXformMoveTo(dx, dy);
      _annot.start = p;
    }
    return;
  }
  if (_annot.tool === 'rotate' || _annot.tool === 'skew') {
    const x = _annot.xform; if (!x) return;
    if (x.straighten) { if (x.strLine) x.strLine.to = p; return; }   // the guide is drawn by the ants loop
    if (!_annot.xfStart) return;
    if (_annot.tool === 'rotate') {
      const a = Math.atan2(p.y - x.cy, p.x - x.cx);
      let deg = _annot.xfStart.angle + (a - _annot.xfStart.ang0) * 180 / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;   // Shift snaps to 15°, like every transform tool
      x.angle = _annotWrapDeg(deg);
    } else {
      // Drag sideways to slant sideways, up/down to slant up/down. A drag across
      // half the picture is 45° of slant; Shift locks to one axis.
      let dx = p.x - _annot.start.x, dy = p.y - _annot.start.y;
      if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
      const spanX = Math.max(40, _annot.canvas.height / 2), spanY = Math.max(40, _annot.canvas.width / 2);
      x.skewX = _annotClampNum(_annot.xfStart.skewX + dx / spanX * 45, -60, 60);
      x.skewY = _annotClampNum(_annot.xfStart.skewY + dy / spanY * 45, -60, 60);
    }
    _annotXformSyncBar();
    _annotXformPreview();
    return;
  }
  if (_annot.tool === 'move') {
    if (!_annot.float) return;
    let dx = p.x - _annot.start.x, dy = p.y - _annot.start.y;
    if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }   // Shift = straight
    _annot.float.dx = Math.round(dx); _annot.float.dy = Math.round(dy);
    _annotFloatDraw();
    return;
  }
  if (_annot.tool === 'history') { _annotHistoryStroke(_annot.last, p); _annot.last = p; return; }
  if (_annot.tool === 'select' || _annot.tool === 'lasso') {
    if (!_annot.selPts) return;
    if (_annot.tool === 'select') {
      const s = _annot.start, q = e.shiftKey ? _annotSquarePt(s, p) : p;   // Shift = square, like Photoshop
      _annot.selPts = [s, { x: q.x, y: s.y }, q, { x: s.x, y: q.y }];
    } else {
      _annot.selPts.push(p);
    }
    return;
  }
  if (_annot.tool === 'clone') { _annotCloneStroke(_annot.last, p); _annot.last = p; return; }
  if (_annot.tool === 'line') {
    const end = e.shiftKey ? _annotSnap45(_annot.start, p) : p;
    ctx.putImageData(_annot.snap, 0, 0);
    ctx.strokeStyle = _annot.color; ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, Math.round(_annot.size));
    ctx.beginPath(); ctx.moveTo(_annot.start.x, _annot.start.y); ctx.lineTo(end.x, end.y); ctx.stroke();
    return;
  }
  // Hold Shift while erasing/painting: the stroke is locked to the horizontal
  // or vertical axis (whichever is dominant), live-previewed by restoring the
  // snapshot — just like Photoshop's Shift-drag brush.
  if (e.shiftKey) {
    if (!_annot.shiftSeg) {
      _annot.shiftSeg = {
        start: _annot.last,
        snap: ctx.getImageData(0, 0, _annot.canvas.width, _annot.canvas.height)
      };
    }
    const s = _annot.shiftSeg.start;
    const q = _annotSnapAxis(s, p);
    ctx.putImageData(_annot.shiftSeg.snap, 0, 0);
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(q.x, q.y);
    _annot.last = q;
    return;
  }
  if (_annot.shiftSeg) {
    // Shift released mid-stroke — the straight segment stays; carry on
    // freehand from its end.
    _annot.shiftSeg = null;
    ctx.beginPath(); ctx.moveTo(_annot.last.x, _annot.last.y);
  }
  if (Math.max(1, Math.round(_annot.size)) <= 1) {
    // Pixel-perfect 1px drag: plot crisp pixels between samples.
    _annotPlotLine(ctx, _annot.last.x, _annot.last.y, p.x, p.y);
  } else {
    ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p.x, p.y);
  }
  _annot.last = p;
}
function _annotUp() {
  if (!_annot) return;
  if (_annot.xform && _annot.tool === 'scale') {
    // The box has moved or changed size, so the pivot goes back to its middle —
    // otherwise a turn afterwards swings the object round a point off to one side.
    if (_annot.xfScale || _annot.xfMove) _annotXformRecentre(_annot.xform);
    _annot.xfScale = null; _annot.xfMove = false;
    _annot.drawing = false; _annot.start = null;
    _annotXformSyncBar();
    return;
  }
  if (_annot.xform && (_annot.tool === 'rotate' || _annot.tool === 'skew')) {
    if (_annot.xform.straighten && _annot.xform.strLine) _annotXformStraightenFinish();
    _annot.drawing = false; _annot.start = null; _annot.xfStart = null;
    return;
  }
  if (_annot.float) {
    _annotFloatCommit();
    _annot.drawing = false; _annot.start = null; _annot.last = null;
    return;
  }
  if (_annot.drawing && _annot.selPts && (_annot.tool === 'select' || _annot.tool === 'lasso')) {
    // Finalise the selection: keep it only if it has real area.
    const pts = _annot.selPts;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach(q => { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); });
    _annot.sel = (pts.length >= 3 && (x1 - x0) >= 3 && (y1 - y0) >= 3) ? { pts: pts.slice() } : null;
    _annot.selPts = null;
    _annotSelSyncBar();
    if (_annot.sel) showToast('Area selected — pick a fill option above the image', 'info');
  }
  // Remember where the brush stroke ended — a later Shift-click continues from
  // here with a straight line (Photoshop behaviour).
  if ((_annot.tool === 'erase' || _annot.tool === 'paint') && _annot.last) _annot.anchor = _annot.last;
  _annotResetCompose();
  _annot.drawing = false; _annot.start = null; _annot.snap = null; _annot.shiftSeg = null; _annot.last = null; _annot.cloneSnap = null; _annot.cloneOff = null;
  _annotUpdateBrushRing();   // the offset is released — the preview goes back to showing the source itself
}
function _annotPlaceText(p) {
  const stage = document.getElementById('annotStage');
  if (!stage) return;
  const fontNat = Math.max(14, _annot.size * 2.6);
  // A draggable label: a wrapper holding a "move" handle + the text input. The
  // teacher can reposition it freely, and it burns onto the canvas wherever the
  // input ends up (not the original click point).
  const box = document.createElement('div');
  box.className = 'annot-textbox';
  // Position relative to the stage viewport (the canvas is transformed within it).
  const _sr = stage.getBoundingClientRect();
  box.style.left = ((p.clientX != null ? p.clientX - _sr.left : p.dispX)) + 'px';
  box.style.top = ((p.clientY != null ? p.clientY - _sr.top : p.dispY)) + 'px';
  const handle = document.createElement('div');
  handle.className = 'annot-textbox-handle';
  handle.textContent = '✥ drag';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'annot-textbox-input';
  input.style.color = _annot.color;
  input.style.fontSize = Math.max(10, Math.round(fontNat / p.scale)) + 'px';
  box.appendChild(handle);
  box.appendChild(input);
  if (_annot.tool === 'move') box.classList.add('movable');
  stage.appendChild(box);
  setTimeout(() => input.focus(), 0);

  // --- drag to reposition ---
  // The little handle always drags. With the Move tool active the body of the
  // label drags too, so "Move" repositions text as well as pixels.
  let drag = null;
  const startDrag = (ev, el) => {
    ev.preventDefault(); ev.stopPropagation();   // keep input focus; don't draw on the canvas
    drag = { dx: ev.clientX - box.offsetLeft, dy: ev.clientY - box.offsetTop };
    try { el.setPointerCapture(ev.pointerId); } catch (e) {}
  };
  const moveDrag = ev => {
    if (!drag) return;
    const sr = stage.getBoundingClientRect();
    let nx = ev.clientX - drag.dx, ny = ev.clientY - drag.dy;
    nx = Math.max(0, Math.min(sr.width - 10, nx));
    ny = Math.max(19, Math.min(sr.height - 6, ny));   // keep the handle on-screen
    box.style.left = nx + 'px'; box.style.top = ny + 'px';
  };
  const endDrag = (ev, el) => { drag = null; try { el.releasePointerCapture(ev.pointerId); } catch (e) {} input.focus(); };
  handle.addEventListener('pointerdown', ev => startDrag(ev, handle));
  handle.addEventListener('pointermove', moveDrag);
  handle.addEventListener('pointerup', ev => endDrag(ev, handle));
  input.addEventListener('pointerdown', ev => { if (_annot && _annot.tool === 'move') startDrag(ev, input); });
  input.addEventListener('pointermove', moveDrag);
  input.addEventListener('pointerup', ev => { if (drag) endDrag(ev, input); });

  let done = false;
  const commit = () => {
    if (done) return; done = true;
    const val = input.value.trim();
    if (val) {
      _annotPushHistory();
      const c = _annot.canvas, cr = c.getBoundingClientRect(), ir = input.getBoundingClientRect();
      const sx = c.width / cr.width, sy = c.height / cr.height;
      // input's content start = border-box left/top + ~border+padding (1px+4px / 1px+1px)
      const x = (ir.left - cr.left) * sx + 5 * sx;
      const y = (ir.top - cr.top) * sy + 2 * sy;
      const ctx = _annot.ctx;
      ctx.fillStyle = _annot.color;
      ctx.textBaseline = 'top';
      ctx.font = `600 ${Math.round(fontNat)}px 'DM Sans', sans-serif`;
      ctx.fillText(val, x, y);
    }
    if (box.parentNode) box.parentNode.removeChild(box);
  };
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
    else if (ev.key === 'Escape') { done = true; if (box.parentNode) box.parentNode.removeChild(box); }
  });
  input.addEventListener('blur', () => { if (!drag) commit(); });   // don't commit while mid-drag
}
// ⬇️ Save the picture as it stands to a PNG file, without leaving the editor.
// It is on EVERY target, not just the standalone page: an answer-key diagram
// worth keeping outside the app, or a piece of card art wanted as a file, is
// the same one click. PNG end to end — a JPEG step here would flatten the
// alpha of anything that has been cut out to transparent.
function annotDownloadPng() {
  if (!_annot) return;
  if (_annot.xform) annotXformApply(true);
  document.querySelectorAll('#annotStage .annot-textbox-input').forEach(i => i.blur());
  try {
    const a = document.createElement('a');
    a.href = _annot.canvas.toDataURL('image/png');
    a.download = peDownloadName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('⬇️ Saved as a PNG', 'success');
  } catch (e) {
    console.warn('annot download failed', e);
    showToast('Could not save the PNG: ' + (e && e.message ? e.message : e), 'error');
  }
}
// ✓ Done. In the portal this wrote the picture back to whatever it was opened
// from — a question's image block, an answer-key diagram, a card-art slot. Here
// there is nothing behind the editor, so DONE IS THE EXPORT: it opens the
// export panel, which is the only way a picture leaves this app.
//
// Nothing is uploaded and nothing is saved. The picture never leaves the tab.
async function applyAnnotTool() {
  if (!_annot) return;
  // Settle an open resize/rotate/skew so the transform isn't lost on the way out.
  if (_annot.xform) annotXformApply(true);
  // Burn any label that's still being edited so it isn't lost.
  document.querySelectorAll('#annotStage .annot-textbox-input').forEach(i => i.blur());
  exOpen();
}

function closeAnnotTool() {
  const o = document.getElementById('annotOverlay'); if (o) o.classList.remove('show');
  const s = document.getElementById('annotStage'); if (s) s.querySelectorAll('.annot-textbox').forEach(el => el.remove());
  const cm = document.getElementById('annotCloneSrc'); if (cm) cm.remove();
  const br = document.getElementById('annotBrushRing'); if (br) br.remove();
  const bh = document.getElementById('annotBrushHud'); if (bh) bh.remove();
  if (_annot) clearTimeout(_annot.hudTimer);
  const sc = document.getElementById('annotSelCanvas'); if (sc) sc.getContext('2d').clearRect(0, 0, sc.width, sc.height);
  _annotUnbindZoomListeners();
  _annot = null;
  _annotSelSyncBar();
  _annotXformSyncBar();
}
document.addEventListener('click', function (e) {
  const t = e.target.closest && e.target.closest('[data-atool]');
  if (t) { e.preventDefault(); _annotSetTool(t.getAttribute('data-atool')); }
});
// Pan when Space is held or the middle mouse button is used; otherwise draw.
function _annotPanStart(e) {
  _annot.panning = true;
  _annot.panFrom = { x: e.clientX, y: e.clientY, panX: _annot.panX, panY: _annot.panY };
  const st = document.getElementById('annotStage'); if (st) st.classList.add('panning');
  _annotUpdateBrushRing();
  try { e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId); } catch (_) {}
}
function _annotPanMove(e) {
  if (!_annot || !_annot.panning || !_annot.panFrom) return;
  _annot.panX = _annot.panFrom.panX + (e.clientX - _annot.panFrom.x);
  _annot.panY = _annot.panFrom.panY + (e.clientY - _annot.panFrom.y);
  _annotClampPan();
  _annotUpdateTransform();
}
function _annotPanEnd() {
  if (_annot && _annot.panning) { _annot.panning = false; _annot.panFrom = null; const st = document.getElementById('annotStage'); if (st) st.classList.remove('panning'); _annotUpdateBrushRing(); }
}
document.addEventListener('pointerdown', function (e) {
  const c = document.getElementById('annotCanvas');
  if (!_annot || !c || e.target !== c) return;
  _annotTrackPointer(e);   // a tap with no movement before it still gets its ring
  if (_annot.space || e.button === 1) { e.preventDefault(); _annotPanStart(e); return; }
  if (e.button === 0) _annotDown(e);
});
document.addEventListener('pointermove', function (e) {
  if (!_annot) return;
  _annotTrackPointer(e);   // the ring follows the pointer whatever else is going on
  if (_annot.panning) { _annotPanMove(e); return; }
  if (_annot.drawing) { _annotMove(e); return; }
  // Hovering the transform box: the pointer says what each handle will do, so
  // a resize box behaves like one everywhere else does.
  if (_annot.tool === 'scale' && _annot.xform) {
    const c = document.getElementById('annotCanvas');
    if (c && e.target === c) {
      const p = _annotPt(e);
      const h = _annotXformHandleAt(p);
      c.style.cursor = h ? h.cur : (_annotXformInside(p) ? 'move' : 'default');
    }
  }
});
document.addEventListener('pointerup', function () { _annotPanEnd(); _annotUp(); _annotUpdateBrushRing(); });

// =====================================================================
// THE DOOR IN — paste, drop, or pick a file
// =====================================================================
// Three ways to bring a picture in and ONE door out of them, so a picture
// behaves identically however it arrived. Ported from the portal's 🎨 Photo
// Editor page, which exists for the same reason.
const PE_MAX_BYTES = 40 * 1024 * 1024;

function _peStatus(msg, bad) {
  const el = document.getElementById('peStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = bad ? 'var(--accent-red)' : 'var(--text-muted)';
}
// The ONE door. Everything that can bring a picture into this app comes here.
function _peOpen(dataUrl, name) {
  if (!dataUrl) { _peStatus('That did not look like a picture.', true); return; }
  _peName = _peCleanName(name);
  _peStatus('');
  _annotOpenSrc(Promise.resolve(dataUrl), { standalone: true }, '🎨 Photo Editor');
}
// What the exported file is called. The name a picture arrived with, minus its
// extension, so an edited photo.jpg comes back as photo.png rather than as
// something nobody can find again. A pasted screenshot has no name at all, so
// it gets a dated one — twenty files called "image" in a downloads folder is
// its own kind of lost.
let _peName = '';
function _peCleanName(n) {
  return String(n || '').replace(/\.[a-z0-9]+$/i, '').replace(/[^\w. -]+/g, '').trim().slice(0, 60);
}
function _peStamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}
function peDownloadName() {
  return (_peName || 'edited-' + _peStamp()) + '.png';
}
function _peReadFile(file) {
  if (!file) return;
  if (!/^image\//i.test(file.type || '')) { _peStatus('That file is not a picture.', true); return; }
  if (file.size > PE_MAX_BYTES) { _peStatus('That picture is very large (' + Math.round(file.size / 1048576) + ' MB) — try a smaller one.', true); return; }
  _peStatus('Opening ' + (file.name || 'the picture') + '…');
  const r = new FileReader();
  r.onload = () => _peOpen(String(r.result || ''), file.name);
  r.onerror = () => _peStatus('Could not read that file.', true);
  r.readAsDataURL(file);
}
function pePickFiles(input) {
  const f = input && input.files && input.files[0];
  // Cleared BEFORE the read. An <input type=file> still holding last time's
  // file fires no `change` for the same picture picked twice, so the second
  // attempt does nothing at all — a button that looks like it works and does
  // not.
  const file = f;
  if (input) input.value = '';
  _peReadFile(file);
}
function peZoneClick() {
  const i = document.getElementById('peFile');
  if (i) i.click();
}
function peDrop(e) {
  e.preventDefault();
  const zone = document.getElementById('peZone');
  if (zone) zone.classList.remove('dragover');
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) { _peReadFile(f); return; }
  const url = e.dataTransfer && e.dataTransfer.getData('text/uri-list');
  if (url) {
    _peStatus('Fetching that picture…');
    _urlToDataUrlRobust(url).then(d => _peOpen(d, url.split('/').pop()))
      .catch(() => _peStatus('Could not load that picture from the web.', true));
  }
}
// Paste is bound to the PAGE, and it stands down the moment the editor is
// open — in there Ctrl+V means something else and equally wanted: it drops a
// picture ONTO the one being edited, as its own layer. That is the editor's
// own handler (`_annotPasteHandler`), bound in capture, and this must not
// race it.
function _pePaste(e) {
  if (_annot) return;
  if (exIsOpen()) return;
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.kind === 'file' && /^image\//i.test(it.type || '')) {
      const f = it.getAsFile();
      if (f) { e.preventDefault(); _peReadFile(f); return; }
    }
  }
  const files = (e.clipboardData && e.clipboardData.files) || [];
  if (files.length && /^image\//i.test(files[0].type || '')) { e.preventDefault(); _peReadFile(files[0]); }
}
document.addEventListener('paste', _pePaste);
// Dropping a picture anywhere on the landing page, not just on the dashed box.
// Aiming at a target is work; the whole window is the target.
document.addEventListener('dragover', e => {
  if (_annot || exIsOpen()) return;
  e.preventDefault();
  const z = document.getElementById('peZone'); if (z) z.classList.add('dragover');
});
document.addEventListener('dragleave', e => {
  if (e.relatedTarget) return;   // still inside the window — a child swap, not a leave
  const z = document.getElementById('peZone'); if (z) z.classList.remove('dragover');
});
document.addEventListener('drop', e => {
  if (_annot || exIsOpen()) return;
  peDrop(e);
});

// =====================================================================
// THE DOOR OUT — download a file, or copy the picture to the clipboard
// =====================================================================
// In the portal ✓ Apply wrote the picture back to whatever it was opened from
// and there was one export: a plain full-size PNG. Here the export IS the
// product, so it gets a panel: what format, how big, how good, and what it
// will actually weigh — answered before the file is written rather than after
// it is in the downloads folder.
//
//  • THE SIZE SHOWN IS A REAL ENCODE, NEVER AN ESTIMATE. The picture is
//    genuinely re-encoded at the chosen settings and the resulting Blob is
//    measured, so "1.4 MB" is the file you are about to get. A guess from
//    pixel count × a fudge factor is wrong by a factor of ten on a photo
//    versus a diagram, which is exactly the pair of cases this app handles.
//  • …SO IT IS DEBOUNCED, and the panel says it is working. Encoding a 4096px
//    PNG takes real time and the sliders are dragged.
//  • PNG IS THE DEFAULT AND KEEPS TRANSPARENCY. The other two do not: a
//    cut-out saved as a JPEG comes back with a black or white box round it,
//    which is the one export failure that looks fine in the panel and is
//    discovered later. So a picture that HAS transparent pixels says so, in
//    the panel, the moment a lossy format is chosen.
//  • SCALING IS DOWN ONLY. Every percentage over 100 is invented detail; the
//    honest ceiling is the pixels that are actually there, and the panel says
//    what those are.
//  • THE CLIPBOARD IS ALWAYS PNG. image/png is the one type every OS and
//    browser agrees on for a copied picture — a JPEG on the clipboard is
//    silently dropped by most of them — so 📋 Copy encodes a PNG whatever the
//    download format is set to, and says so rather than pretending the
//    quality slider did something.
const EX_FORMATS = {
  png:  { mime: 'image/png',  ext: 'png',  label: 'PNG',  lossy: false, alpha: true,
          note: 'Lossless and keeps transparency. The right default, and the biggest file.' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg',  lossy: true,  alpha: false, label: 'JPEG',
          note: 'Much smaller, for photographs. No transparency — empty areas are filled.' },
  webp: { mime: 'image/webp', ext: 'webp', lossy: true,  alpha: true,  label: 'WebP',
          note: 'Smaller than PNG at the same quality, and keeps transparency. Not every old app opens it.' }
};
const EX_SCALES = [100, 75, 50, 33, 25];
const EX_ENCODE_DEBOUNCE = 260;

let _ex = null;          // the panel's state, null while it is closed
let _exTimer = null;
let _exRun = 0;          // which encode is the current one — a slow one must not overwrite a newer

function exIsOpen() { return !!_ex; }

// The picture, exactly as it stands on the canvas. Taken once when the panel
// opens: the editor is behind a modal from here on, so nothing can change it,
// and re-reading a 4096px canvas on every slider tick would be the slow part.
function exOpen() {
  if (!_annot) return;
  const src = document.createElement('canvas');
  src.width = _annot.canvas.width; src.height = _annot.canvas.height;
  src.getContext('2d').drawImage(_annot.canvas, 0, 0);
  _ex = {
    src, w: src.width, h: src.height,
    format: 'png', quality: 88, scale: 100,
    bg: '#ffffff',
    hasAlpha: _exHasAlpha(src),
    blob: null, busy: false
  };
  const nameBox = document.getElementById('exName');
  if (nameBox) nameBox.value = peDownloadName().replace(/\.[a-z0-9]+$/i, '');
  document.getElementById('exOverlay').classList.add('show');
  exRender();
}
function exClose() {
  _ex = null;
  clearTimeout(_exTimer);
  const o = document.getElementById('exOverlay');
  if (o) o.classList.remove('show');
}
// Does the picture actually have anything transparent in it? Only worth asking
// once, and only worth warning about if the answer is yes — a photograph has
// no alpha and does not need to be told about JPEG.
function _exHasAlpha(cv) {
  try {
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    // Every 4th pixel is plenty to answer a yes/no on a 16-megapixel canvas.
    for (let i = 3; i < d.length; i += 16) if (d[i] < 250) return true;
    return false;
  } catch (_) { return false; }
}
function exSetFormat(f) { if (!_ex || !EX_FORMATS[f]) return; _ex.format = f; exRender(); }
function exSetQuality(v) { if (!_ex) return; _ex.quality = Math.max(20, Math.min(100, parseInt(v, 10) || 88)); exRender(); }
function exSetScale(v) { if (!_ex) return; _ex.scale = Math.max(5, Math.min(100, parseInt(v, 10) || 100)); exRender(); }
function exSetBg(v) { if (!_ex) return; _ex.bg = v || '#ffffff'; exRender(); }
// The longest side, in pixels — the number people actually have a target for
// ("under 1500px for the site"). It is the same knob as the percentage, read
// the other way round, so the two always agree.
function exSetMaxSide(v) {
  if (!_ex) return;
  const want = parseInt(v, 10);
  const longest = Math.max(_ex.w, _ex.h);
  if (!want || want < 1) return;
  _ex.scale = Math.max(5, Math.min(100, Math.round(Math.min(want, longest) / longest * 100)));
  exRender();
}
function exOutSize() {
  if (!_ex) return { w: 0, h: 0 };
  return {
    w: Math.max(1, Math.round(_ex.w * _ex.scale / 100)),
    h: Math.max(1, Math.round(_ex.h * _ex.scale / 100))
  };
}
function _exBytes(n) {
  if (n == null) return '…';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(n < 10485760 ? 2 : 1) + ' MB';
}
// Paint the picture at the export size. A lossy format with no alpha channel
// gets the chosen background painted UNDER it first — otherwise the browser
// fills the transparent parts with black, which is nobody's intention.
function _exCanvas() {
  const { w, h } = exOutSize();
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  if (!EX_FORMATS[_ex.format].alpha) { ctx.fillStyle = _ex.bg; ctx.fillRect(0, 0, w, h); }
  // Downscaling a photo with the browser's own smoothing beats a nearest
  // neighbour pass; at 100% this is a straight blit and costs nothing.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(_ex.src, 0, 0, w, h);
  return cv;
}
function _exEncode(format, quality) {
  const cv = _exCanvas();
  const f = EX_FORMATS[format];
  return new Promise(res => {
    cv.toBlob(b => res(b), f.mime, f.lossy ? quality / 100 : undefined);
  });
}
// Repaint the panel now, and start a (debounced) real encode to fill in the
// weight. `_exRun` is what stops a slow encode of an older setting landing on
// top of a newer one — the panel would then show a size for a file nobody is
// about to download.
function exRender() {
  if (!_ex) return;
  _exPaint();
  clearTimeout(_exTimer);
  _ex.busy = true; _ex.blob = null;
  _exPaintSize();
  const run = ++_exRun;
  _exTimer = setTimeout(async () => {
    const blob = await _exEncode(_ex.format, _ex.quality);
    if (!_ex || run !== _exRun) return;
    _ex.blob = blob; _ex.busy = false;
    _exPaintSize();
  }, EX_ENCODE_DEBOUNCE);
}
function _exPaintSize() {
  const el = document.getElementById('exSize');
  if (!el || !_ex) return;
  el.innerHTML = _ex.busy || !_ex.blob
    ? '<span class="ex-calc">working out the size…</span>'
    : '<b>' + _exBytes(_ex.blob.size) + '</b>';
}
function _exPaint() {
  if (!_ex) return;
  const f = EX_FORMATS[_ex.format];
  const out = exOutSize();
  document.querySelectorAll('#exOverlay [data-exfmt]').forEach(b =>
    b.classList.toggle('active', b.getAttribute('data-exfmt') === _ex.format));
  document.querySelectorAll('#exOverlay [data-exscale]').forEach(b =>
    b.classList.toggle('active', +b.getAttribute('data-exscale') === _ex.scale));
  const q = document.getElementById('exQualityRow');
  if (q) q.style.display = f.lossy ? '' : 'none';
  const qv = document.getElementById('exQualityVal'); if (qv) qv.textContent = _ex.quality + '%';
  const qs = document.getElementById('exQuality'); if (qs && +qs.value !== _ex.quality) qs.value = _ex.quality;
  const ss = document.getElementById('exScale'); if (ss && +ss.value !== _ex.scale) ss.value = _ex.scale;
  const ms = document.getElementById('exMaxSide'); if (ms) ms.value = Math.max(out.w, out.h);
  const dim = document.getElementById('exDims');
  if (dim) dim.innerHTML = '<b>' + out.w + ' × ' + out.h + '</b> px' +
    (_ex.scale < 100 ? ' <span class="ex-was">(from ' + _ex.w + ' × ' + _ex.h + ')</span>' : '');
  const note = document.getElementById('exNote'); if (note) note.textContent = f.note;
  // The one warning worth interrupting for: a cut-out about to be flattened.
  const warn = document.getElementById('exAlphaWarn');
  const showWarn = _ex.hasAlpha && !f.alpha;
  if (warn) warn.style.display = showWarn ? '' : 'none';
  const bgRow = document.getElementById('exBgRow');
  if (bgRow) bgRow.style.display = showWarn ? '' : 'none';
  const ext = document.getElementById('exExt'); if (ext) ext.textContent = '.' + f.ext;
}
function exFileName() {
  const box = document.getElementById('exName');
  const raw = _peCleanName(box ? box.value : '') || 'edited-' + _peStamp();
  return raw + '.' + EX_FORMATS[_ex.format].ext;
}
// The encode the panel already did, if it is still the current one — dragging
// a slider and pressing Download straight away must not save the previous
// settings, so anything not settled is encoded again here.
async function _exCurrentBlob() {
  if (_ex.blob && !_ex.busy) return _ex.blob;
  clearTimeout(_exTimer);
  const run = ++_exRun;
  const blob = await _exEncode(_ex.format, _ex.quality);
  if (_ex && run === _exRun) { _ex.blob = blob; _ex.busy = false; _exPaintSize(); }
  return blob;
}
async function exDownload() {
  if (!_ex) return;
  try {
    const blob = await _exCurrentBlob();
    if (!blob) throw new Error('the picture could not be encoded');
    const name = exFileName();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    // Revoked late: Safari has been known to cancel a download whose object
    // URL went away in the same tick as the click.
    setTimeout(() => URL.revokeObjectURL(url), 20000);
    showToast('⬇️ Saved ' + name + ' — ' + _exBytes(blob.size), 'success');
  } catch (e) {
    console.warn('export download failed', e);
    showToast('Could not save the file: ' + (e && e.message ? e.message : e), 'error');
  }
}
// 📋 Copy. Always a PNG (see the header), and the write has to happen inside
// the gesture that asked for it or Safari refuses it — so the ClipboardItem is
// handed the PROMISE rather than being awaited first.
async function exCopy() {
  if (!_ex) return;
  if (!navigator.clipboard || !window.ClipboardItem) {
    showToast('This browser will not let a page write a picture to the clipboard — use ⬇️ Download instead', 'error');
    return;
  }
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': _exEncode('png', 100).then(b => b || Promise.reject(new Error('encode failed'))) })
    ]);
    const out = exOutSize();
    showToast('📋 Copied — ' + out.w + ' × ' + out.h + ' PNG, ready to paste', 'success');
  } catch (e) {
    console.warn('clipboard copy failed', e);
    showToast('Could not copy to the clipboard: ' + (e && e.message ? e.message : e), 'error');
  }
}
// Esc closes the panel and puts you back in the editor with everything intact —
// the panel only ever READ the canvas.
document.addEventListener('keydown', e => {
  if (!_ex) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); exClose(); }
  else if (e.key === 'Enter' && !/^(INPUT|TEXTAREA)$/.test((e.target.tagName || '')) ) { e.preventDefault(); exDownload(); }
}, true);

// =====================================================================
// THE MODULE'S OWN SCOPE — every name an inline on* handler needs
// =====================================================================
// This file is loaded as <script type="module">, so it has its own scope and
// nothing in it is visible to an `onclick=""` in the markup. Anything the HTML
// calls by name has to be put on `window` here — the portal's rule, and the
// same trap: a handler that was never exported is a button that throws
// "x is not defined" into the console and does nothing on screen.
//
// The list is checked against the markup by tools/handler-tests.mjs, which is
// the only thing that can catch a button added to the HTML and forgotten here.
Object.assign(window, {
  // the door in
  peZoneClick, pePickFiles, peDrop,
  // the editor
  closeAnnotTool, applyAnnotTool, annotDownloadPng, annotUndo,
  annotToggleEraseTo, annotCleanPaper, annotPasteFromClipboard,
  annotZoomStep, annotZoomFit, _annotSyncControls,
  annotSelDelete, annotSelFillColour, annotSelPatchFill, annotSelAiFill, annotSelClear,
  annotAiRegen,
  annotXformSetScale, annotXformSetLock, annotXformFlip, annotXformSet,
  annotXformNudge, annotXformStraightenStart, annotXformSetGrow,
  annotXformReset, annotXformApply, annotXformCancel,
  // the door out
  exClose, exDownload, exCopy,
  exSetFormat, exSetQuality, exSetScale, exSetMaxSide, exSetBg
});

// The AI is the only thing here that touches the network, and it is allowed to
// fail. Kicked off after everything else is wired so the editor is usable the
// instant the page paints, rather than behind an SDK download.
_initImageAi();
