// LisaEm Web: browser front end for the LisaEm core (WebAssembly).
import { Lisa, KEYMAP, SCREEN_W, SCREEN_H } from '../js/lisa.js';
import { Display, ASPECTS, PRESETS } from './display.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const display = new Display(canvas);
$('renderer').textContent = display.renderer;

let lisa = null;              // current machine (null until first boot)
let floppy = null;            // { name, bytes }
let profile = null;           // { name, bytes }
let rom = null;               // { name, rom: Uint8Array | {lo, hi} }
let screenW = SCREEN_W, screenH = SCREEN_H;   // current guest display size (XL ROMs differ)
let paused = false;
let speed = 1;
let stopped = false;          // machine halted (powered off / fatal)
let lastTs = 0;
const held = new Set();       // raw keys currently down

// ---- small helpers ----------------------------------------------------------------------

function log(msg) {
  const el = $('log');
  el.textContent += (el.textContent ? '\n' : '') + msg;
  el.scrollTop = el.scrollHeight;
}

function setEnabled(on) {
  for (const id of ['btnPause', 'btnReset', 'btnShot', 'btnType']) $(id).disabled = !on;
}

function drawScreen() { display.present(lisa.screen()); }

// ---- display settings (remembered per browser) -------------------------------------------

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('lisaem.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('lisaem.' + k, JSON.stringify(v)); } catch { /* private mode etc. */ } },
};
$('aspect').innerHTML = Object.entries(ASPECTS).map(([k, a]) => `<option value="${k}">${a.label}</option>`).join('');
const sliders = { curve: 'fxCurve', scan: 'fxScan', glow: 'fxGlow', mask: 'fxMask', vignette: 'fxVig' };
function syncFxUI(fx) { for (const [k, id] of Object.entries(sliders)) $(id).value = fx[k]; }
function applyFx(preset, fx) {
  $('fxPreset').value = preset; display.setEffects(fx); syncFxUI(display.fx);
  store.set('fx', { preset, fx: display.fx });
}
{
  const saved = store.get('fx', { preset: 'soft', fx: PRESETS.soft });
  const aspect = ASPECTS[store.get('aspect', 'lisa')] ? store.get('aspect', 'lisa') : 'lisa';
  $('aspect').value = aspect; display.setAspect(aspect);
  applyFx(saved.preset, saved.fx);
  if (store.get('panel', true) === false) { $('btnPanel').setAttribute('aria-expanded', 'false'); document.querySelector('.layout').classList.add('nopanel'); }
}
$('aspect').addEventListener('change', (e) => { display.setAspect(e.target.value); store.set('aspect', e.target.value); });
$('fxPreset').addEventListener('change', (e) => { if (e.target.value !== 'custom') applyFx(e.target.value, PRESETS[e.target.value]); else applyFx('custom', display.fx); });
for (const [k, id] of Object.entries(sliders)) $(id).addEventListener('input', (e) => applyFx('custom', { [k]: +e.target.value }));
$('btnPanel').addEventListener('click', () => {
  const lay = document.querySelector('.layout'), hide = !lay.classList.contains('nopanel');
  lay.classList.toggle('nopanel', hide); $('btnPanel').setAttribute('aria-expanded', String(!hide)); store.set('panel', !hide);
});

function updateStatus() {
  const on = !!lisa && !stopped;
  $('chipPower').textContent = !lisa ? 'Off' : stopped ? 'Stopped' : paused ? 'Paused' : 'Running';
  $('chipPower').classList.toggle('on', on && !paused);
  $('chipTime').textContent = lisa ? `${(lisa.time / 1000).toFixed(1)} s` : '0.0 s';
  const osNames = ['ROM', 'Office System', 'Lisa Test', 'MacWorks', 'Monitor', 'Xenix', 'UniPlus', 'UniPlus Sunix'];
  $('chipOS').textContent = lisa ? (osNames[lisa._c('running_os', 'number', [], [])] ?? 'Unknown OS') : '—';
}

// ---- machine lifecycle ------------------------------------------------------------------

async function newMachine() {
  if (!floppy && !profile && !rom) return false;
  lisa = await Lisa.create({ ramKB: 1024, clock: 'now' });
  if (profile && !lisa.mountProfile(profile.bytes)) log('Could not mount the ProFile image.');
  if (floppy && !lisa.insertFloppy(floppy.bytes)) { log('That does not look like a valid floppy image.'); lisa = null; return false; }
  let ok;
  if (rom) {
    try {
      const info = lisa.loadROM(rom.rom);
      log(`ROM ${info.version} (${info.format})${info.checksumOk ? '' : ': checksum differs from a stock ROM, it may misbehave'}`);
      const want = $('romBoot').value;
      ok = lisa.powerOn({ boot: want === 'floppy' && !floppy ? 'none' : want === 'profile' && !profile ? 'none' : want });
    } catch (e) { log(String(e.message || e)); lisa = null; return false; }
  } else {
    ok = floppy ? lisa.bootFloppy() : lisa.bootProfile();
  }
  flushMessages();
  if (!ok) { stopped = true; return false; }
  stopped = false;
  const s = lisa.screen(); screenW = s.width; screenH = s.height;
  display.setAspect(screenW === SCREEN_W ? $('aspect').value : screenW / screenH); // XL screens have square-ish pixels
  $('hint').classList.add('gone');
  setEnabled(true);
  $('btnPause').textContent = 'Pause';
  paused = false;
  return true;
}

function flushMessages() {
  if (!lisa) return;
  for (const m of lisa.messages()) log(m.replace(/^dialog: /, ''));
  const c = lisa.consoleRead();
  if (c) log('console: ' + c.trim());
}

function handleStatus(st) {
  if (st.fatal || st.poweredOff || st.rebooted) {
    stopped = true;
    flushMessages();
    log(st.fatal ? 'The emulated machine stopped (fatal error).' : st.rebooted ? 'The Lisa restarted.' : 'The Lisa powered off.');
  }
}

// ---- main loop --------------------------------------------------------------------------

let audio = null, osc = null;
function updateSound() {
  if (!$('sound').checked || !lisa || paused || stopped) { if (osc) osc.frequency.value = 0; if (audio && osc) osc.disconnect(); osc = null; return; }
  const v = lisa.sound;
  if (!v) { if (osc) { osc.disconnect(); osc = null; } return; }
  audio ??= new AudioContext();
  if (!osc) {
    osc = audio.createOscillator(); osc.type = 'square';
    const g = audio.createGain(); g.gain.value = 0.04;
    osc.connect(g).connect(audio.destination); osc.start();
  }
  osc.frequency.value = Math.min(20000, 250000 / (v + 2)); // VIA timer half-period at 500 kHz
}

function frame(ts) {
  const dt = Math.min(ts - (lastTs || ts), 100);
  lastTs = ts;
  if (lisa && !paused && !stopped) {
    handleStatus(lisa.run(dt * speed));
    drawScreen();
    updateSound();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
setInterval(updateStatus, 250);
setInterval(flushMessages, 1000);

// ---- disk loading -----------------------------------------------------------------------

async function takeFloppy(file) {
  floppy = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
  $('floppyName').textContent = `${file.name} (${(floppy.bytes.length / 1024).toFixed(0)} KB)`;
  showRom();
  log(`Loaded floppy ${file.name}`);
}

$('fileFloppy').addEventListener('change', (e) => e.target.files[0] && takeFloppy(e.target.files[0]));
$('btnBootFloppy').addEventListener('click', async () => { await newMachine(); canvas.focus(); });
$('btnProfile').addEventListener('click', () => $('fileProfile').click());
$('fileProfile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  profile = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
  $('profileName').textContent = `ProFile: ${f.name} — mounted at the next boot`; showRom();
});

for (const [el, cls] of [[$('screenWrap'), 'drag'], [$('dropFloppy'), 'drag']]) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add(cls); });
  el.addEventListener('dragleave', () => el.classList.remove(cls));
  el.addEventListener('drop', async (e) => {
    e.preventDefault(); el.classList.remove(cls);
    const f = e.dataTransfer.files[0];
    if (f) { await takeFloppy(f); await newMachine(); canvas.focus(); }
  });
}

// Disk images served by `serve.mjs --media <dir>` (optional).
(async () => {
  try {
    const r = await fetch('/media/index.json');
    if (!r.ok) return;
    const all = await r.json();
    const isRom = (d) => /\.(bin|rom|lo|hi)$/i.test(d.name);
    const roms = all.filter(isRom), list = all.filter((d) => !isRom(d));
    if (roms.length) {
      $('btnFolderRom').hidden = false;
      $('btnFolderRom').addEventListener('click', async () => {
        const get = async (d) => new File([await (await fetch('/media/' + encodeURIComponent(d.name))).arrayBuffer()], d.name);
        await takeRom(await Promise.all(roms.map(get)));
      });
    }
    if (!list.length) return;
    $('localRow').hidden = false;
    $('localDisks').innerHTML = list.map((d) => `<option value="${d.name}">${d.name}</option>`).join('');
    $('btnLocalProfile').addEventListener('click', async () => {
      const name = $('localDisks').value;
      const bytes = new Uint8Array(await (await fetch('/media/' + encodeURIComponent(name))).arrayBuffer());
      profile = { name, bytes }; floppy = null;
      $('profileName').textContent = `ProFile: ${name} (${(bytes.length / 1048576).toFixed(1)} MB)`;
      $('floppyName').textContent = 'Choose or drop a DiskCopy 4.2 image…';
      $('romBoot').value = 'profile';
      showRom(); log(`Mounted ProFile ${name}`);
      await newMachine(); canvas.focus();
    });
    $('btnLocal').addEventListener('click', async () => {
      const name = $('localDisks').value;
      const bytes = new Uint8Array(await (await fetch('/media/' + encodeURIComponent(name))).arrayBuffer());
      await takeFloppy(new File([bytes], name));
      await newMachine(); canvas.focus();
    });
  } catch { /* no media server */ }
})();

// ---- boot ROM ---------------------------------------------------------------------------

const b64 = {
  enc: (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); },
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};
function showRom() {
  $('romState').textContent = rom ? 'loaded' : 'none';
  $('romName').textContent = rom ? rom.name : 'Optional: your Lisa boot ROM (16 KB, or .lo + .hi)…';
  $('btnForgetRom').hidden = !rom;
  $('btnBootFloppy').textContent = rom ? 'Power on' : 'Boot floppy';
  $('btnBootFloppy').disabled = !(floppy || rom || profile);
}
async function takeRom(files) {
  files = [...files];
  if (files.length === 2) { // a lo/hi EPROM pair, told apart by file name
    // lo = odd-addressed bytes (341-0176 / 341-0346 / .lo), hi = even-addressed bytes (341-0175 / 341-0347 / .hi)
    const lo = files.find((f) => /\.lo$|0176|0346|-176-/i.test(f.name)), hi = files.find((f) => /\.hi$|0175|0347|-175-/i.test(f.name));
    if (!lo || !hi) { log('Two ROM files given: I could not tell which is the low and which the high half (expected .lo/.hi or 341-0175/0176 in the names).'); return; }
    rom = { name: `${lo.name} + ${hi.name}`, rom: { lo: new Uint8Array(await lo.arrayBuffer()), hi: new Uint8Array(await hi.arrayBuffer()) } };
    store.set('rom', { name: rom.name, lo: b64.enc(rom.rom.lo), hi: b64.enc(rom.rom.hi) });
  } else if (files.length === 1) {
    rom = { name: files[0].name, rom: new Uint8Array(await files[0].arrayBuffer()) };
    store.set('rom', { name: rom.name, bin: b64.enc(rom.rom) });
  } else { log('Choose one ROM file, or a .lo and a .hi pair.'); return; }
  showRom(); log(`Boot ROM ${rom.name} chosen`);
}
{
  const saved = store.get('rom', null);
  try {
    if (saved) rom = { name: saved.name, rom: saved.bin ? b64.dec(saved.bin) : { lo: b64.dec(saved.lo), hi: b64.dec(saved.hi) } };
  } catch { rom = null; }
  showRom();
}
$('fileRom').addEventListener('change', (e) => takeRom(e.target.files));
$('btnForgetRom').addEventListener('click', () => { rom = null; store.set('rom', null); showRom(); log('Boot ROM forgotten.'); });
$('dropRom').addEventListener('dragover', (e) => { e.preventDefault(); $('dropRom').classList.add('drag'); });
$('dropRom').addEventListener('dragleave', () => $('dropRom').classList.remove('drag'));
$('dropRom').addEventListener('drop', (e) => { e.preventDefault(); $('dropRom').classList.remove('drag'); takeRom(e.dataTransfer.files); });

// ---- machine controls -------------------------------------------------------------------

$('btnPause').addEventListener('click', () => { paused = !paused; $('btnPause').textContent = paused ? 'Resume' : 'Pause'; });
$('btnReset').addEventListener('click', async () => { await newMachine(); canvas.focus(); });
$('speed').addEventListener('change', (e) => { speed = +e.target.value; });
$('sound').addEventListener('change', () => { audio?.resume(); updateSound(); });
$('btnType').addEventListener('click', () => { lisa?.type($('pasteText').value); canvas.focus(); });
$('btnShot').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lisa.screenshotPNG()], { type: 'image/png' }));
  a.download = `lisa-${Date.now()}.png`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---- keyboard & mouse -------------------------------------------------------------------

canvas.addEventListener('keydown', (e) => {
  const code = KEYMAP[e.code];
  if (code === undefined || !lisa) return;
  e.preventDefault();
  if (e.repeat || held.has(code)) return;
  held.add(code); lisa.key(code, true);
});
canvas.addEventListener('keyup', (e) => {
  const code = KEYMAP[e.code];
  if (code === undefined || !lisa) return;
  e.preventDefault();
  if (held.delete(code)) lisa.key(code, false);
});
canvas.addEventListener('blur', () => { for (const c of held) lisa?.key(c, false); held.clear(); });

function lisaXY(e) {
  // Through the display so aspect, scaling and CRT curvature are all accounted for.
  return display.toSource(e.clientX, e.clientY, screenW, screenH);
}
canvas.addEventListener('pointermove', (e) => { const p = lisa && lisaXY(e); if (p) lisa.mouseMove(...p); });
canvas.addEventListener('pointerdown', (e) => {
  canvas.focus(); canvas.setPointerCapture(e.pointerId);
  const p = lisa && lisaXY(e); if (p) lisa.mouseDown(...p);
  e.preventDefault();
});
canvas.addEventListener('pointerup', (e) => { const p = lisa && lisaXY(e); if (p) lisa.mouseUp(...p); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- scripting API for the console / browser automation ---------------------------------
//
// While the page is running in real time, scripted calls and the live loop would fight over the
// machine's clock, so lisaAuto.pause() first. run(ms) then advances Lisa time exactly.

window.lisaAuto = {
  get lisa() { return lisa; },
  display,                              // .setAspect('lisa'|'square'|'fourThree'), .setEffects({curve, scan, glow, mask, vignette})
  /** Load a disk image from a URL or bytes, and boot it. */
  async boot(src, name = 'disk.dc42') {
    const bytes = typeof src === 'string' ? new Uint8Array(await (await fetch(src)).arrayBuffer()) : src;
    floppy = { name: typeof src === 'string' ? src.split('/').pop() : name, bytes };
    $('floppyName').textContent = floppy.name; showRom();
    return newMachine();
  },
  /** Mount a ProFile image (URL or bytes) and boot from it (through the ROM if one is set). */
  async bootProfile(src, name = 'profile.image') {
    const bytes = typeof src === 'string' ? new Uint8Array(await (await fetch(src)).arrayBuffer()) : src;
    profile = { name: typeof src === 'string' ? src.split('/').pop() : name, bytes }; floppy = null;
    $('romBoot').value = 'profile'; showRom();
    return newMachine();
  },
  /** Choose a boot ROM (16 KB Uint8Array, or {lo, hi}); the next boot() powers on through it. */
  setROM(r, name = 'rom') { rom = { name, rom: r }; showRom(); },
  pause() { paused = true; $('btnPause').textContent = 'Resume'; },
  resume() { paused = false; $('btnPause').textContent = 'Pause'; },
  /** Advance emulated time by exactly `ms` and redraw. */
  async run(ms) { const st = lisa.run(ms); handleStatus(st); drawScreen(); updateStatus(); return st; },
  type: (t) => lisa.type(t),
  key: (code, down) => lisa.key(code, down),
  move: (x, y) => lisa.mouseMove(x, y),
  async click(x, y, o) { const r = lisa.click(x, y, o); drawScreen(); return r; },
  async mouseTo(x, y, o) { const r = lisa.mouseTo(x, y, o); drawScreen(); return r; },
  pointer: () => lisa.pointer(),
  screen: () => lisa.screen(),
  ascii: (o) => lisa.screen().toAscii(o),
  screenshot() {
    const bytes = lisa.screenshotPNG();
    let s = ''; for (const b of bytes) s += String.fromCharCode(b);
    return 'data:image/png;base64,' + btoa(s);
  },
  waitForScreen: (...a) => lisa.waitForScreen(...a),
  registers: () => lisa.registers(),
  messages: () => lisa.messages(),
};
