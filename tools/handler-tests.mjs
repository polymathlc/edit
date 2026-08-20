// =====================================================================
// The wiring between index.html and editor.js
// =====================================================================
// editor.js is a MODULE, so it has its own scope: a function an inline
// `onclick=""` calls is only reachable if it was put on `window` at the bottom
// of the file. That failure is completely silent from the outside — the button
// draws, the pointer changes, the click throws "x is not defined" into a
// console nobody has open, and the tool simply does nothing.
//
// The same goes the other way. The editor reaches for its controls by id
// (`annotSize`, `annotXformAngle`, `exQuality`…), and an id that was renamed in
// the markup leaves a slider that moves and changes nothing.
//
// Neither failure throws anywhere a person would see it, so both are pinned
// here. Run:  node tools/handler-tests.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const js = readFileSync(join(root, 'editor.js'), 'utf8');

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  ✗ ' + msg); fails++; } };

// ── 1. Every function an inline handler calls is on window ────────────────
const handlerSrc = [...html.matchAll(/\bon[a-z]+="([^"]*)"/g)].map(m => m[1]).join(';');
const called = new Set(
  [...handlerSrc.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)].map(m => m[1])
    .filter(n => !['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof'].includes(n))
);
// Methods called on something (`this.classList.add(…)`, `event.preventDefault()`)
// are not globals; only a bare call at the start of an expression is.
const methodish = new Set(
  [...handlerSrc.matchAll(/\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)].map(m => m[1])
);
// The comments inside the block name what each group is ("the door in"), so
// they have to come out before the names are read — otherwise "in" and "out"
// are read as exports and the test fails on its own commentary.
const assignBlock = (js.match(/Object\.assign\(window,\s*\{([\s\S]*?)\}\);/) || [, ''])[1]
  .replace(/\/\/[^\n]*/g, '');
const exported = new Set(
  [...assignBlock.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,|$)/gm)].map(m => m[1])
);
console.log('Inline handlers → window');
for (const fn of [...called].sort()) {
  if (methodish.has(fn)) continue;
  ok(exported.has(fn), `index.html calls ${fn}() from an inline handler, but editor.js never puts it on window`);
}
ok(exported.size > 20, 'the window export block looks empty — did Object.assign(window, {…}) move?');

// ── 2. Everything exported to window actually exists ──────────────────────
console.log('window exports → real functions');
for (const fn of [...exported].sort()) {
  const defined = new RegExp(`^(?:async\\s+)?function\\s+${fn.replace(/\$/g, '\\$')}\\s*\\(|^(?:const|let|var)\\s+${fn.replace(/\$/g, '\\$')}\\b`, 'm').test(js);
  ok(defined, `editor.js exports ${fn} to window but never defines it`);
}

// ── 3. Every id the editor reaches for exists in the markup ───────────────
// …except the handful it CREATES itself: the brush ring, its HUD, the clone
// pin and the clone preview are made on demand and removed with the editor.
const MADE_AT_RUNTIME = new Set(['annotBrushRing', 'annotBrushHud', 'annotCloneSrc', 'annotClonePeek']);
const wanted = new Set([...js.matchAll(/getElementById\(\s*'([A-Za-z0-9_-]+)'\s*\)/g)].map(m => m[1]));
console.log('getElementById → markup');
for (const id of [...wanted].sort()) {
  if (MADE_AT_RUNTIME.has(id)) continue;
  ok(html.includes(`id="${id}"`), `editor.js looks for #${id}, which is not in index.html`);
}

// ── 4. The portal's rules that came across with the code ──────────────────
console.log('house rules');
ok(!/sk-[A-Za-z0-9]{20}/.test(js) && !/sk-[A-Za-z0-9]{20}/.test(html),
   'an API key shape is in the source — these files are served to every visitor');
ok(/const ANNOT_MAX_PX = \d+/.test(js), 'ANNOT_MAX_PX is gone — the working ceiling has to stay a named constant');
ok(/ANNOT_HISTORY_BYTES/.test(js), 'the byte-capped undo stack is gone — a 4096px canvas would hold 670 MB of RGBA');
// Scaling up is invented detail, and the panel promises it never happens.
ok(/Math\.min\(100,\s*parseInt\(v, 10\) \|\| 100\)/.test(js) || /Math\.min\(100,/.test(js),
   'the export scale is no longer clamped to 100% — every percentage above it is invented detail');
// A JPEG step anywhere in the editor's own save path flattens alpha to black.
ok(!/toDataURL\('image\/jpe?g'/.test(js), "the editor's own canvas is exported as JPEG somewhere — that flattens transparency to black");

if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nAll wiring checks passed.');
