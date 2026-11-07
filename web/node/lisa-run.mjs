#!/usr/bin/env node
// Headless Lisa runner.
//
//   node node/lisa-run.mjs --floppy disk.dc42 --seconds 20 --shot out.png [--ascii] [--type "text\n"] [--log]
//
// Boots the floppy with the ROM-less loader, runs for N seconds of *emulated* time, and
// writes a screenshot. Options:
//   --floppy <file>     DiskCopy 4.2 floppy image to boot
//   --profile <file>    ProFile image to mount (boot it with --boot profile)
//   --boot floppy|profile
//   --rom <file>        boot through a real Lisa boot ROM (16 KB image, or <name>.lo,<name>.hi pair as
//                       'name.lo,name.hi'); the ROM presses Apple-2 (floppy) / Apple-3 (profile) for you
//   --seconds <n>       emulated seconds to run (default 10)
//   --type <text>       text to type after --type-at seconds (\n and \t escapes honoured)
//   --type-at <n>       when to start typing (default: after boot, 5)
//   --shot <file.png>   save a PNG of the final screen
//   --ascii             print the final screen as text
//   --ram <kb>          512, 1024 (default) or 2048
//   --log               show the emulator core's debug log on stderr
import { readFileSync, writeFileSync } from 'node:fs';
import { Lisa } from '../js/lisa.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i < 0 ? def : (args[i + 1] ?? true); };
const flag = (name) => args.includes('--' + name);

const floppy = opt('floppy'), profile = opt('profile');
if (!floppy && !profile) {
  console.error('usage: lisa-run.mjs --floppy disk.dc42 [--seconds 10] [--shot out.png] [--ascii] [--type "text"]');
  process.exit(2);
}

const lisa = await Lisa.create({ ramKB: +opt('ram', 1024), log: flag('log') });
if (profile && !lisa.mountProfile(readFileSync(profile))) { console.error('could not mount ProFile'); process.exit(1); }
if (floppy && !lisa.insertFloppy(readFileSync(floppy))) { console.error('could not insert floppy'); process.exit(1); }
const bootFrom = opt('boot', floppy ? 'floppy' : 'profile');
if (opt('rom')) {
  const parts = String(opt('rom')).split(',');
  const info = lisa.loadROM(parts.length === 2 ? { lo: readFileSync(parts[0]), hi: readFileSync(parts[1]) } : readFileSync(parts[0]));
  console.error(`ROM ${info.version} (${info.format})${info.checksumOk ? '' : ' - checksum does not match, may misbehave'}${info.xl ? ' - 3A/XL ROM' : ''}`);
  lisa.powerOn({ boot: bootFrom });
} else {
  const ok = bootFrom === 'profile' ? lisa.bootProfile() : lisa.bootFloppy();
  if (!ok) { console.error('boot failed:', lisa.messages()); process.exit(1); }
}

const seconds = +opt('seconds', 10);
const text = opt('type') && String(opt('type')).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
const typeAt = +opt('type-at', Math.min(5, seconds));
const t0 = Date.now();
let typed = !text;
for (let s = 0; s < seconds * 10; s++) {
  if (!typed && lisa.time >= typeAt * 1000) { lisa.type(text); typed = true; }
  const st = lisa.run(100);
  if (st.poweredOff || st.rebooted || st.fatal) { console.error(`machine stopped (${JSON.stringify(st)}) at ${lisa.time} ms`); break; }
}
const wall = ((Date.now() - t0) / 1000).toFixed(2);
console.error(`ran ${(lisa.time / 1000).toFixed(1)} s of Lisa time in ${wall} s of wall time`);
for (const m of lisa.messages()) console.error('message:', m);
const con = lisa.consoleRead(); if (con) console.error('console:', JSON.stringify(con));

const screen = lisa.screen();
console.error(`screen: ${screen.width}x${screen.height}, ${screen.inkCount()} black pixels, hash ${screen.hash().toString(16)}`);
if (opt('shot')) { writeFileSync(opt('shot'), screen.toPNG()); console.error('wrote', opt('shot')); }
if (flag('ascii')) console.log(screen.toAscii());
