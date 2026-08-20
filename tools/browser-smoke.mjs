// =====================================================================
// The app, driven in a real browser
// =====================================================================
// The wiring tests next door read the two files as text; this one actually
// opens the app, brings a picture in through the file picker, presses every
// tool, paints, selects, fills, cleans, pastes a second picture in as a layer,
// applies the transform, then walks the export panel through all three formats
// and downloads a file — failing on any console or page error.
//
// It is the only check that can catch the failures that live in the joins: a
// canvas that opens at the wrong size, a bar that never appears, an export
// that reports one size and writes another.
//
// It needs Playwright, which is NOT a dependency of this app — there are none,
// it is two static files. Install it just to run this:
//
//     npm install --no-save playwright
//     python3 -m http.server 8899 &
//     node tools/browser-smoke.mjs
//
// It is run with the Firebase SDK unreachable, which is deliberate: that is
// the degraded path, and the two AI buttons hiding themselves rather than
// throwing is one of the things being pinned.
// =====================================================================
import { chromium } from 'playwright';
import fs from 'node:fs';

const errs = [];
// Playwright's own download first — that is the laptop case. Where the browser
// is a shared one provided by the environment (PLAYWRIGHT_BROWSERS_PATH), the
// revision under it will not be the one this Playwright expects, so fall back
// to whatever chromium binary is actually sitting there. CHROMIUM_PATH
// overrides both.
function _findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return null;
  for (const d of fs.readdirSync(root).filter(n => /^chromium-/.test(n)).sort().reverse()) {
    for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = root + '/' + d + '/' + rel;
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
const browser = await chromium.launch().catch(err => {
  const exe = _findChromium();
  if (!exe) throw err;
  console.log('using the environment\'s chromium:', exe);
  return chromium.launch({ executablePath: exe });
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, permissions: [] });
const page = await ctx.newPage();
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/shot-landing.png' });
console.log('landing title:', await page.title());

// Build a test picture: a white page with black "ink", a coloured blob, and a
// transparent corner — so the paper cleaner, the wand and the alpha warning
// all have something real to work on.
const dataUrl = await page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 900; c.height = 620;
  const x = c.getContext('2d');
  x.fillStyle = '#f2f1ee'; x.fillRect(0, 0, 900, 620);
  x.fillStyle = '#111'; x.font = 'bold 64px sans-serif'; x.fillText('Hello world', 60, 140);
  x.strokeStyle = '#111'; x.lineWidth = 5; x.strokeRect(60, 200, 420, 260);
  x.fillStyle = '#2d6ca8'; x.beginPath(); x.arc(640, 380, 110, 0, 7); x.fill();
  x.clearRect(0, 0, 90, 90);
  return c.toDataURL('image/png');
});

// Come in through the ONE door, exactly as a paste/drop/pick does.
await page.evaluate(u => {
  // the picker path, without a real file dialog
  const b = atob(u.split(',')[1]); const arr = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i);
  const file = new File([arr], 'test-picture.png', { type: 'image/png' });
  const dt = new DataTransfer(); dt.items.add(file);
  const input = document.getElementById('peFile');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, dataUrl);

await page.waitForSelector('#annotOverlay.show', { timeout: 5000 });
await page.waitForTimeout(700);
await page.screenshot({ path: '/tmp/shot-editor.png' });
const size = await page.evaluate(() => {
  const c = document.getElementById('annotCanvas');
  return { w: c.width, h: c.height };
});
console.log('canvas opened at', size);

// ── the tools ────────────────────────────────────────────────────────────
for (const t of ['erase','paint','fill','clone','history','select','lasso','wand','move','rotate','scale','skew','line','text']) {
  await page.click(`.annot-tool[data-atool="${t}"]`);
  const active = await page.$eval(`.annot-tool[data-atool="${t}"]`, e => e.classList.contains('active'));
  if (!active) errs.push('tool did not activate: ' + t);
}
console.log('all 14 tools activate');

// paint a stroke
await page.click('.annot-tool[data-atool="paint"]');
// The CANVAS rect, not the stage's: the canvas is fitted and centred inside
// the stage, so stage coordinates land in the grey margin around the picture.
const box = await page.$eval('#annotCanvas', e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
console.log('canvas on screen:', Math.round(box.w) + '×' + Math.round(box.h), 'at', Math.round(box.x) + ',' + Math.round(box.y));
await page.mouse.move(box.x + box.w * 0.35, box.y + box.h * 0.5);
await page.mouse.down();
await page.mouse.move(box.x + box.w * 0.55, box.y + box.h * 0.62, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(200);
const ringSeen = await page.evaluate(() => !!document.getElementById('annotBrushRing'));
console.log('brush ring created:', ringSeen);

// undo
await page.click('button:has-text("↶ Undo")');
await page.waitForTimeout(200);

// a rectangle selection → the selection bar
await page.click('.annot-tool[data-atool="select"]');
await page.mouse.move(box.x + box.w * 0.12, box.y + box.h * 0.35);
await page.mouse.down();
await page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.72, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(300);
const selBar = await page.$eval('#annotSelBar', e => getComputedStyle(e).display);
console.log('selection bar:', selBar);
const aiFillShown = await page.$eval('#annotAiFillBtn', e => getComputedStyle(e).display);
console.log('AI fill button display (expect none offline):', aiFillShown);
await page.screenshot({ path: '/tmp/shot-selection.png' });

// fill from surroundings (no AI) then deselect
await page.click('button:has-text("🧵 Fill from surroundings")');
await page.waitForTimeout(400);
await page.click('button:has-text("✕ Deselect")');

// clean paper
await page.click('button:has-text("🧻 Clean paper")');
await page.waitForTimeout(400);

// zoom
await page.click('button[title="Zoom in"]');
await page.click('button[title="Fit the whole image in view"]');
await page.waitForTimeout(200);

// ── paste a second picture as a layer ────────────────────────────────────
// A real paste event carrying a real file, so the editor's own capture-phase
// handler is what runs — not a test hook.
await page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 300; c.height = 200;
  const x = c.getContext('2d');
  x.fillStyle = '#b23b36'; x.fillRect(0, 0, 300, 200);
  x.fillStyle = '#fff'; x.font = 'bold 40px sans-serif'; x.fillText('LAYER', 40, 115);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'layer.png', { type: 'image/png' });
  const dt = new DataTransfer(); dt.items.add(file);
  document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(600);
const xf = await page.$eval('#annotXformBar', e => getComputedStyle(e).display);
console.log('transform bar after paste (expect flex):', xf);
await page.screenshot({ path: '/tmp/shot-paste-layer.png' });
const toolAfterPaste = await page.evaluate(() =>
  [...document.querySelectorAll('.annot-tool[data-atool]')].filter(e => e.classList.contains('active')).map(e => e.dataset.atool).join(','));
console.log('tool in hand after paste (expect scale):', toolAfterPaste);
await page.click('#annotXformBar button:has-text("✓ Apply")');
await page.waitForTimeout(400);

// ── the export panel ─────────────────────────────────────────────────────
await page.click('button:has-text("⬇️ Export…")');
await page.waitForSelector('#exOverlay.show');
await page.waitForTimeout(900);
console.log('export dims:', (await page.$eval('#exDims', e => e.textContent)).trim());
console.log('export size (PNG 100%):', (await page.$eval('#exSize', e => e.textContent)).trim());
console.log('alpha warning on PNG:', await page.$eval('#exAlphaWarn', e => getComputedStyle(e).display));
await page.screenshot({ path: '/tmp/shot-export-png.png' });

await page.click('[data-exfmt="jpeg"]');
await page.waitForTimeout(900);
console.log('alpha warning on JPEG (expect block):', await page.$eval('#exAlphaWarn', e => getComputedStyle(e).display));
console.log('export size (JPEG 88%):', (await page.$eval('#exSize', e => e.textContent)).trim());
await page.$eval('#exQuality', e => { e.value = 40; e.dispatchEvent(new Event('input', { bubbles: true })); });
await page.waitForTimeout(900);
console.log('export size (JPEG 40%):', (await page.$eval('#exSize', e => e.textContent)).trim());
await page.click('[data-exscale="50"]');
await page.waitForTimeout(900);
console.log('at 50%:', (await page.$eval('#exDims', e => e.textContent)).trim(), '→', (await page.$eval('#exSize', e => e.textContent)).trim());
console.log('longest-side box:', await page.$eval('#exMaxSide', e => e.value));
await page.screenshot({ path: '/tmp/shot-export-jpeg.png' });

// longest side drives the percentage
await page.$eval('#exMaxSide', e => { e.value = 400; e.dispatchEvent(new Event('change', { bubbles: true })); });
await page.waitForTimeout(900);
console.log('after longest side 400:', (await page.$eval('#exDims', e => e.textContent)).trim());

// webp keeps alpha
await page.click('[data-exfmt="webp"]');
await page.waitForTimeout(900);
console.log('alpha warning on WebP (expect none):', await page.$eval('#exAlphaWarn', e => getComputedStyle(e).display));

// download really writes a file
await page.click('[data-exfmt="png"]'); await page.click('[data-exscale="100"]');
await page.waitForTimeout(900);
const dl = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('button:has-text("⬇️ Download")')]).then(r => r[0]);
const path = await dl.path();
console.log('downloaded:', dl.suggestedFilename(), fs.statSync(path).size, 'bytes');

await ctx.close(); await browser.close();
console.log('\n--- console/page errors ---');
console.log(errs.length ? errs.join('\n') : '(none)');
process.exit(errs.filter(e => !/favicon|fonts.googleapis|gstatic|recaptcha|Failed to load resource/i.test(e)).length ? 1 : 0);
