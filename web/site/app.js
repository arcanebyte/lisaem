// LisaEm Web: browser front end for the LisaEm core (WebAssembly).
import { Lisa, KEYMAP, SCREEN_W, SCREEN_H } from '../js/lisa.js';
import { Display, ASPECTS, PRESETS } from './display.js';
import { idbGet, idbPut, idbDel } from './store.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const display = new Display(canvas);
$('renderer').textContent = display.renderer;

let lisa = null;              // current machine (null until first boot)
let floppy = null;            // { name, bytes }
let profile = null;           // { name, bytes }
let rom = null;               // { name, rom: Uint8Array | {lo, hi} }
let bootFrom = null;          // 'floppy' | 'profile' | 'menu' (the ROM's startup menu): what Power on starts
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
  for (const id of ['btnPause', 'btnShot', 'btnType', 'btnSaveState']) $(id).disabled = !on;
  renderPower();
}

function drawScreen() { display.present(lisa.screen()); }

// ---- display settings (remembered per browser) -------------------------------------------

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('lisaem.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('lisaem.' + k, JSON.stringify(v)); } catch { /* private mode etc. */ } },
};
$('aspect').innerHTML = Object.entries(ASPECTS).map(([k, a]) => `<option value="${k}">${a.label}</option>`).join('');
const sliders = { curve: 'fxCurve', scan: 'fxScan', glow: 'fxGlow', mask: 'fxMask', vignette: 'fxVig', border: 'fxBorder' };
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
  if (!bootFrom) return false;
  // Do all the awaiting before the machine exists: once `lisa` is set the render loop runs it, and an
  // un-booted machine would execute garbage from address 0.
  const profileBytes = profile ? await diskBytes('profile', profile) : null;
  const floppyBytes = floppy ? await diskBytes('floppy', floppy) : null;
  lisa = await Lisa.create({ ramKB: 1024, clock: 'now' });
  if (profile && !lisa.mountProfile(profileBytes)) log('Could not mount the hard disk image.');
  if (floppy && !lisa.insertFloppy(floppyBytes)) { log('That does not look like a valid floppy image.'); lisa = null; return false; }
  baseline.profile = profile ? lisa.diskHash(0) : 0;
  baseline.floppy = floppy ? lisa.diskHash(1) : 0;
  refreshDiskButtons();
  let ok;
  if (rom) {
    try {
      const info = lisa.loadROM(rom.rom);
      log(`ROM ${info.version} (${info.format})${info.checksumOk ? '' : ': checksum differs from a stock ROM, it may misbehave'}`);
      ok = lisa.powerOn({ boot: bootFrom === 'menu' ? 'none' : bootFrom });
    } catch (e) { log(String(e.message || e)); lisa = null; return false; }
  } else {
    ok = bootFrom === 'profile' ? lisa.bootProfile() : lisa.bootFloppy();
  }
  flushMessages();
  if (!ok) { stopped = true; return false; }
  stopped = false;
  const s = lisa.screen(); screenW = s.width; screenH = s.height;
  display.setAspect(screenW === SCREEN_W ? $('aspect').value : screenW / screenH); // XL screens have square-ish pixels
  $('hint').classList.add('gone');
  paused = false; $('btnPause').textContent = 'Pause';
  setEnabled(true);
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

// Sound: the core logs every speaker register write with its emulated timestamp and renders PCM from that
// (Lisa.audioRender); an AudioWorklet plays it back. Only at 1x: at other speeds the audio is rendered and
// discarded (so the log stays bounded) because pitch-shifted PCM would just be noise.
const sound = { ctx: null, node: null, loading: null, forMachine: null, stats: null };

async function ensureSound() {
  if (sound.node) return true;
  sound.loading ??= (async () => {
    try {
      sound.ctx ??= new AudioContext({ latencyHint: 'interactive' });
      await sound.ctx.audioWorklet.addModule(new URL('audio-worklet.js', import.meta.url));
      const node = new AudioWorkletNode(sound.ctx, 'lisa-speaker', { numberOfInputs: 0, outputChannelCount: [1], processorOptions: { startMs: 40, maxMs: 250 } });
      node.port.onmessage = (e) => { sound.stats = e.data; };
      node.connect(sound.ctx.destination);
      sound.node = node;
      return true;
    } catch (e) {
      log('Sound is unavailable: ' + (e.message || e));
      $('sound').checked = false;
      return false;
    } finally { sound.loading = null; }
  })();
  return sound.loading;
}

// Sound defaults to on (remembered after that). Browsers keep audio suspended until the page has had a
// click or key press, so the context is created up front and resumed by the first gesture.
$('sound').checked = store.get('sound', true);
for (const ev of ['pointerdown', 'keydown']) {
  addEventListener(ev, () => { if ($('sound').checked && sound.ctx?.state === 'suspended') sound.ctx.resume(); }, { capture: true });
}

function pumpSound() {
  if (!lisa) return;
  if ($('sound').checked && !sound.node) { ensureSound(); return; }
  if (!$('sound').checked || !sound.node) {
    if (sound.forMachine === lisa) { lisa.audioStop(); sound.forMachine = null; }
    return;
  }
  if (sound.forMachine !== lisa) { lisa.audioStart(sound.ctx.sampleRate); sound.forMachine = lisa; }
  const pcm = lisa.audioRender();
  if (pcm.length && speed === 1 && sound.ctx.state === 'running') sound.node.port.postMessage(pcm, [pcm.buffer]);
}

function frame(ts) {
  const dt = Math.min(ts - (lastTs || ts), 100);
  lastTs = ts;
  if (lisa && !paused && !stopped) {
    handleStatus(lisa.run(dt * speed));
    drawScreen();
    pumpSound();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
setInterval(updateStatus, 250);
setInterval(flushMessages, 1000);

// ---- disks and the power button ---------------------------------------------------------
//
// Loading a disk only fills its slot; Power on (or dropping a file on the screen) starts the machine.

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
const IS_ROM_NAME = /\.(bin|rom|lo|hi)$/i;
const HARD_DISK_BYTES = 2 * 1024 * 1024;       // floppies are under 1 MB, ProFiles are 5 MB and up

/** Which slot a file belongs in, judged by name and size. */
const classify = (name, size) => (IS_ROM_NAME.test(name) ? 'rom' : size > HARD_DISK_BYTES ? 'profile' : 'floppy');

function availableDevices() {
  return [floppy && 'floppy', profile && 'profile', rom && 'menu'].filter(Boolean);
}

/** Keep the boot-from choice valid; `prefer` is the device the user just added. */
function chooseBootFrom(prefer) {
  const have = availableDevices();
  if (prefer && have.includes(prefer)) bootFrom = prefer;
  else if (!have.includes(bootFrom)) bootFrom = have[0] ?? null;
}

function renderPower() {
  const have = availableDevices(), labels = { floppy: 'Floppy disk', profile: 'Hard disk (ProFile)', menu: "The ROM's startup menu" };
  const sel = $('bootFrom');
  sel.innerHTML = have.map((d) => `<option value="${d}">${labels[d]}</option>`).join('');
  sel.disabled = have.length === 0;
  if (bootFrom) sel.value = bootFrom;
  $('btnPower').disabled = !bootFrom;
  $('btnPower').textContent = lisa ? 'Restart' : 'Power on';
  const via = rom ? 'through the boot ROM' : 'directly, with no ROM';
  $('bootHint').textContent = !bootFrom ? 'Add a floppy or a hard disk to begin.'
    : bootFrom === 'menu' ? 'Powers on through the boot ROM and stops at its startup menu.'
    : `${lisa ? 'Restarts' : 'Starts'} the ${bootFrom === 'floppy' ? 'floppy' : 'hard disk'} ${via}.`;
}

function renderSlots() {
  // textContent only: file names come from the user's disk and must never be parsed as HTML
  const set = (nameId, sizeId, m, size) => {
    $(nameId).textContent = m ? m.name : (nameId === 'romName' ? 'none' : 'empty');
    $(nameId).classList.toggle('empty', !m);
    $(nameId).title = m ? m.name : '';
    $(sizeId).textContent = m && size ? size(m) : '';
  };
  set('floppyName', 'floppySize', floppy, (m) => fmtSize(m.bytes.length));
  set('profileName', 'profileSize', profile, (m) => fmtSize(m.bytes.length));
  set('romName', 'romSize', rom, (m) => (m.rom.lo ? `${fmtSize(m.rom.lo.length + m.rom.hi.length)}, lo + hi` : fmtSize(m.rom.length)));
  $('btnEjectFloppy').disabled = !floppy;
  $('btnEjectProfile').disabled = !profile;
  $('btnForgetRom').disabled = !rom;
  $('romState').textContent = rom ? 'loaded' : 'none';
  refreshDiskButtons();
  chooseBootFrom();
  renderPower();
}

/** Show a button as busy while an async job runs, and always put it back. */
async function busy(btn, label, job) {
  const was = btn.textContent;
  btn.disabled = true; btn.textContent = label;
  try { return await job(); } finally { btn.textContent = was; btn.disabled = false; }
}

async function readBytes(file) { return new Uint8Array(await file.arrayBuffer()); }

async function takeFloppy(file) {
  floppy = { name: file.name, bytes: await readBytes(file) };
  chooseBootFrom('floppy'); renderSlots(); log(`Floppy: ${file.name}`);
}
async function takeProfile(file) {
  profile = { name: file.name, bytes: await readBytes(file) };
  chooseBootFrom('profile'); renderSlots(); log(`Hard disk: ${file.name}`);
}

$('btnFloppy').addEventListener('click', () => $('fileFloppy').click());
$('btnProfile').addEventListener('click', () => $('fileProfile').click());
$('fileFloppy').addEventListener('change', (e) => { if (e.target.files[0]) takeFloppy(e.target.files[0]); e.target.value = ''; });
$('fileProfile').addEventListener('change', (e) => { if (e.target.files[0]) takeProfile(e.target.files[0]); e.target.value = ''; });
$('btnEjectFloppy').addEventListener('click', () => { floppy = null; renderSlots(); log('Floppy removed (takes effect at the next power on).'); });
$('btnEjectProfile').addEventListener('click', () => { profile = null; renderSlots(); log('Hard disk removed (takes effect at the next power on).'); });
$('bootFrom').addEventListener('change', (e) => { bootFrom = e.target.value; renderPower(); });
$('btnPower').addEventListener('click', async () => {
  $('btnPower').disabled = true;            // one machine at a time while it is being built
  try { await newMachine(); } finally { renderPower(); }
  canvas.focus();
});

// Drag and drop: onto a slot loads that slot; onto the screen sorts the files out and powers on.
function dropTarget(el, handler) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag'); });
  el.addEventListener('dragleave', () => el.classList.remove('drag'));
  el.addEventListener('drop', async (e) => { e.preventDefault(); el.classList.remove('drag'); await handler([...e.dataTransfer.files]); });
}
dropTarget($('slotFloppy'), async (fs) => fs[0] && takeFloppy(fs[0]));
dropTarget($('slotProfile'), async (fs) => fs[0] && takeProfile(fs[0]));
dropTarget($('slotRom'), async (fs) => takeRom(fs));
dropTarget($('screenWrap'), async (fs) => {
  const roms = fs.filter((f) => classify(f.name, f.size) === 'rom');
  if (roms.length) await takeRom(roms);
  for (const f of fs.filter((x) => !roms.includes(x))) await (classify(f.name, f.size) === 'profile' ? takeProfile(f) : takeFloppy(f));
  await newMachine(); canvas.focus();
});

// Disk images and ROMs served by `serve.mjs --media <dir>` (optional).
(async () => {
  try {
    const r = await fetch('/media/index.json');
    if (!r.ok) return;
    const all = await r.json();
    const roms = all.filter((d) => classify(d.name, d.size) === 'rom'), list = all.filter((d) => classify(d.name, d.size) !== 'rom');
    const fetchFile = async (d) => new File([await (await fetch('/media/' + encodeURIComponent(d.name))).arrayBuffer()], d.name);
    if (roms.length) {
      $('btnFolderRom').hidden = false;
      $('btnFolderRom').addEventListener('click', () => busy($('btnFolderRom'), 'Loading…', async () => takeRom(await Promise.all(roms.map(fetchFile)))));
    }
    if (!list.length) return;
    $('localRow').hidden = false;
    $('localDisks').innerHTML = list.map((d) => `<option value="${d.name}">${d.name} (${fmtSize(d.size)}, ${classify(d.name, d.size) === 'profile' ? 'hard disk' : 'floppy'})</option>`).join('');
    $('btnInsertLocal').addEventListener('click', () => busy($('btnInsertLocal'), 'Loading…', async () => {
      const d = list.find((x) => x.name === $('localDisks').value);
      const f = await fetchFile(d);
      await (classify(d.name, d.size) === 'profile' ? takeProfile(f) : takeFloppy(f));
    }));
  } catch { /* no media server */ }
})();

// ---- keeping disk changes ---------------------------------------------------------------
//
// The guest writes to its disks (the Office System updates its ProFile as it runs). Those changes are
// saved to IndexedDB, keyed by disk name and size, and used instead of the original bytes the next time
// the same disk is loaded.

const baseline = { profile: 0, floppy: 0 };   // fingerprint of each disk when last loaded/saved
const diskKey = (kind, m) => `${kind}:${m.name}:${m.bytes.length}`;

async function diskBytes(kind, m) {
  if ($('keepChanges').checked) {
    const saved = await idbGet(diskKey(kind, m));
    if (saved?.bytes && saved.bytes.byteLength === m.bytes.length) {
      log(`Using your saved changes to ${m.name} (${new Date(saved.savedAt).toLocaleString()})`);
      return new Uint8Array(saved.bytes);
    }
  }
  return m.bytes;
}

function refreshDiskButtons() {
  $('btnDlProfile').disabled = !(lisa && profile);
  $('btnDlFloppy').disabled = !(lisa && floppy);
  $('btnRevert').disabled = !(profile || floppy);
}

let saving = false;
async function saveDisks() {
  if (!lisa || saving || !$('keepChanges').checked) return;
  saving = true;
  try {
    for (const [kind, which, m] of [['profile', 0, profile], ['floppy', 1, floppy]]) {
      if (!m) continue;
      const h = lisa.diskHash(which);
      if (!h || h === baseline[kind]) continue;
      const bytes = kind === 'profile' ? lisa.exportProfile() : lisa.exportFloppy();
      if (bytes && await idbPut(diskKey(kind, m), { name: m.name, bytes: bytes.buffer, savedAt: Date.now() })) {
        baseline[kind] = h;
        $('saveState').textContent = `saved ${new Date().toLocaleTimeString()}`;
      }
    }
  } finally { saving = false; }
}
setInterval(saveDisks, 15000);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveDisks(); });
window.addEventListener('pagehide', saveDisks);
$('keepChanges').addEventListener('change', () => store.set('keep', $('keepChanges').checked));
$('keepChanges').checked = store.get('keep', true);

function download(bytes, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('btnDlProfile').addEventListener('click', () => { const b = lisa?.exportProfile(); if (b) download(b, profile.name); });
$('btnDlFloppy').addEventListener('click', () => { const b = lisa?.exportFloppy(); if (b) download(b, floppy.name); });

let revertArmed = 0;
$('btnRevert').addEventListener('click', async () => {
  if (!revertArmed) { // two clicks, so it cannot happen by accident
    revertArmed = setTimeout(() => { revertArmed = 0; $('btnRevert').textContent = 'Revert disks'; }, 4000);
    $('btnRevert').textContent = 'Click again to confirm'; return;
  }
  clearTimeout(revertArmed); revertArmed = 0; $('btnRevert').textContent = 'Revert disks';
  for (const [kind, m] of [['profile', profile], ['floppy', floppy]]) if (m) await idbDel(diskKey(kind, m));
  $('saveState').textContent = 'reverted'; log('Saved disk changes discarded; starting from the original disks.');
  const was = $('keepChanges').checked; $('keepChanges').checked = false;
  await newMachine(); $('keepChanges').checked = was; canvas.focus();
});

// ---- saving the whole machine ------------------------------------------------------------

$('btnSaveState').addEventListener('click', async () => {
  if (!lisa) return;
  $('btnSaveState').disabled = true;
  try {
    const bytes = await lisa.serialize();
    const ok = await idbPut('state', { bytes: bytes.buffer, savedAt: Date.now(), at: lisa.time });
    log(ok ? `Saved machine state (${(bytes.length / 1048576).toFixed(1)} MB, ${(lisa.time / 1000).toFixed(0)} s into the run).` : 'Could not save state (storage unavailable).');
  } finally { $('btnSaveState').disabled = false; }
});
$('btnLoadState').addEventListener('click', async () => {
  const saved = await idbGet('state');
  if (!saved) { log('No saved state in this browser.'); return; }
  lisa = await Lisa.deserialize(new Uint8Array(saved.bytes));
  stopped = false; paused = false; $('btnPause').textContent = 'Pause';
  const s = lisa.screen(); screenW = s.width; screenH = s.height;
  display.setAspect(screenW === SCREEN_W ? $('aspect').value : screenW / screenH);
  $('hint').classList.add('gone'); setEnabled(true); drawScreen();
  log(`Resumed saved state from ${new Date(saved.savedAt).toLocaleString()}.`);
});

// ---- boot ROM ---------------------------------------------------------------------------

const b64 = {
  enc: (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); },
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};
async function takeRom(files, label) {
  files = [...files];
  if (files.length === 2) { // a lo/hi EPROM pair, told apart by file name
    // lo = odd-addressed bytes (341-0176 / 341-0346 / .lo), hi = even-addressed bytes (341-0175 / 341-0347 / .hi)
    const lo = files.find((f) => /\.lo$|0176|0346|-176-/i.test(f.name)), hi = files.find((f) => /\.hi$|0175|0347|-175-/i.test(f.name));
    if (!lo || !hi) { log('Two ROM files given: I could not tell which is the low and which the high half (expected .lo/.hi or 341-0175/0176 in the names).'); return; }
    rom = { name: label ?? `${lo.name} + ${hi.name}`, rom: { lo: new Uint8Array(await lo.arrayBuffer()), hi: new Uint8Array(await hi.arrayBuffer()) } };
    store.set('rom', { name: rom.name, lo: b64.enc(rom.rom.lo), hi: b64.enc(rom.rom.hi) });
  } else if (files.length === 1) {
    rom = { name: files[0].name, rom: new Uint8Array(await files[0].arrayBuffer()) };
    store.set('rom', { name: rom.name, bin: b64.enc(rom.rom) });
  } else { log('Choose one ROM file, or a .lo and a .hi pair.'); return; }
  chooseBootFrom(); renderSlots(); log(`Boot ROM ${rom.name} chosen`);
}
{
  const saved = store.get('rom', null);
  try {
    if (saved) rom = { name: saved.name, rom: saved.bin ? b64.dec(saved.bin) : { lo: b64.dec(saved.lo), hi: b64.dec(saved.hi) } };
  } catch { rom = null; }
}
$('btnRom').addEventListener('click', () => $('fileRom').click());
$('fileRom').addEventListener('change', (e) => { takeRom(e.target.files); e.target.value = ''; });
$('btnForgetRom').addEventListener('click', () => {
  rom = null; store.set('rom', null);
  $('autoRom').checked = false; store.set('autoRom', false);   // forgetting means "don't bring it back by itself"
  renderSlots(); log('Boot ROM forgotten. Automatic download is off.');
});

// ---- downloading a boot ROM ---------------------------------------------------------------
//
// The files come from the server this page was loaded from (serve.mjs), which fetches them from the
// catalog's source, checks each against a pinned SHA-256 and caches it. A page served some other way has no
// /rom/ endpoint, and then none of this is shown.

let romCatalog = null;
$('autoRom').checked = store.get('autoRom', true);
$('autoRom').addEventListener('change', () => store.set('autoRom', $('autoRom').checked));

function showRomNote() {
  const r = romCatalog?.roms.find((x) => x.id === $('romChoice').value);
  $('romNote').textContent = r ? r.note : '';
}

async function fetchRom(id) {
  const r = romCatalog.roms.find((x) => x.id === id);
  if (!r) return false;
  log(`Downloading boot ROM ${r.label} from ${new URL(romCatalog.source).host}…`);
  try {
    const get = async (f) => {
      const res = await fetch('/rom/' + encodeURIComponent(f.file));
      if (!res.ok) throw new Error(await res.text());
      return new File([await res.arrayBuffer()], f.file);
    };
    const [lo, hi] = await Promise.all([get(r.lo), get(r.hi)]);
    await takeRom([lo, hi], `${r.label} (bitsavers)`);
    return true;
  } catch (e) {
    log(`Could not download the boot ROM: ${e.message}. Disks will boot without one.`);
    return false;
  }
}

$('btnFetchRom').addEventListener('click', () => busy($('btnFetchRom'), 'Downloading…', () => fetchRom($('romChoice').value)));
$('romChoice').addEventListener('change', showRomNote);

const romReady = (async () => {
  try {
    const r = await fetch('/rom/index.json');
    if (!r.ok) return;
    romCatalog = await r.json();
    $('romChoice').innerHTML = romCatalog.roms.map((x) => `<option value="${x.id}">${x.label}</option>`).join('');
    $('romChoice').value = romCatalog.default;
    $('romHost').textContent = new URL(romCatalog.source).host;
    $('romDefault').hidden = false;
    $('btnFetchRom').disabled = !romCatalog.fetchAllowed;
    showRomNote();
    if (!rom && $('autoRom').checked && romCatalog.fetchAllowed) await fetchRom(romCatalog.default);
  } catch { /* no ROM endpoint: a statically hosted page */ }
})();

// ---- collapsible cards, remembered per browser ------------------------------------------------

{
  const open = store.get('cards', {});
  for (const d of document.querySelectorAll('details[data-card]')) {
    if (open[d.dataset.card] !== undefined) d.open = open[d.dataset.card];
    d.addEventListener('toggle', () => { const s = store.get('cards', {}); s[d.dataset.card] = d.open; store.set('cards', s); });
  }
}
renderSlots();

// ---- machine controls -------------------------------------------------------------------

$('btnPause').addEventListener('click', () => { paused = !paused; $('btnPause').textContent = paused ? 'Resume' : 'Pause'; });
$('speed').addEventListener('change', (e) => { speed = +e.target.value; sound.node?.port.postMessage('flush'); });
$('sound').addEventListener('change', async (e) => {
  store.set('sound', e.target.checked);
  if (e.target.checked && await ensureSound()) { await sound.ctx.resume(); sound.node.port.postMessage('flush'); sound.forMachine = null; }
  else if (sound.ctx) sound.node?.port.postMessage('flush');
});
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
  ready: romReady,                      // resolves when the startup boot-ROM download (if any) has finished
  display,                              // .setAspect('lisa'|'square'|'fourThree'), .setEffects({curve, scan, glow, mask, vignette})
  /** Load a disk image from a URL or bytes, and boot it. */
  async boot(src, name = 'disk.dc42') {
    const bytes = typeof src === 'string' ? new Uint8Array(await (await fetch(src)).arrayBuffer()) : src;
    floppy = { name: typeof src === 'string' ? decodeURIComponent(src.split('/').pop()) : name, bytes };
    chooseBootFrom('floppy'); renderSlots();
    return newMachine();
  },
  /** Mount a ProFile image (URL or bytes) and boot from it (through the ROM if one is set). */
  async bootProfile(src, name = 'profile.image') {
    const bytes = typeof src === 'string' ? new Uint8Array(await (await fetch(src)).arrayBuffer()) : src;
    profile = { name: typeof src === 'string' ? decodeURIComponent(src.split('/').pop()) : name, bytes }; floppy = null;
    chooseBootFrom('profile'); renderSlots();
    return newMachine();
  },
  /** Choose a boot ROM (16 KB Uint8Array, or {lo, hi}); the next boot() powers on through it. */
  setROM(r, name = 'rom') { rom = { name, rom: r }; renderSlots(); },
  /** Persist guest disk changes now; returns the ProFile as the guest left it. */
  async saveDisks() { await saveDisks(); return lisa?.exportProfile() ?? null; },
  /** Turn the speaker on/off (the Sound checkbox). Resolves true once audio is playing. */
  async sound(on = true) { $('sound').checked = on; $('sound').dispatchEvent(new Event('change')); await sound.loading; return on ? !!sound.node && sound.ctx.state === 'running' : true; },
  /** Playback health: { queued, underruns, dropped, peak, rms } (samples / 0..1), null until the speaker has played. */
  audioStats: () => (sound.stats ? { ...sound.stats, state: sound.ctx.state, rate: sound.ctx.sampleRate } : null),
  snapshot: () => lisa.snapshot(),
  restore: (s) => lisa.restore(s),
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
