# ProFile emulation: testing status and what's left

This file tracks testing of the ProFile and VIA emulation changes (PR #55, merged 13 September 2026). The branch replaces LisaEm's ProFile drive state machine and the parallel-port 6522 flag handling with protocol- and datasheet-accurate behaviour, and removes the UniPlus-specific handshake patches.

## What changed

- **`src/storage/profile.c` — the drive.** `ProfileLoop()` follows the ProFile protocol, as ESProFile and Cameo/Aphid implement it:
  - Lisa lowers /CMD: the drive puts its reply ($01, $02–$04, $06) on the bus and lowers /BSY.
  - The drive samples the bus when /CMD rises. On $55 it stays busy for a short scheduled time, then raises /BSY once. On anything else it returns to idle.
  - /BSY stays high while the drive waits for the Lisa. The drive has no timeouts.
  - Bytes move one per /PSTRB strobe.
- **`src/lisa/cpu_board/irq.c` — timing.** The drive's busy period (`clock_e`) is a timer event (`CYCLE_TIMER_VIAn_CA1`), so the /BSY edge happens on time.
- **`src/lisa/io_board/via6522.c` — parallel VIAs** (motherboard port and dual parallel card):
  - CA1 is set only by a /BSY edge matching PCR bit 0, whatever IER holds. Reading IFR, writing PCR or writing IER no longer sets or clears it.
  - Register 1 always clears CA1, and clears CA2 unless CA2 is an independent input. It strobes the drive only when CA2 is in handshake or pulse mode.
  - Register 15 and DDRA writes neither clear flags nor strobe.
  - A CA2 manual-output low-to-high PCR write counts as a strobe.
  - When IFR & IER becomes non-zero, the CPU loop stops after the current instruction, so the interrupt is taken immediately.
  - The COPS VIA keeps its previous port A flag clearing.
- **`src/storage/hle.c`:**
  - Removed from `apply_uniplus_hacks()`: the UniPlus 1.4 (`0x20f9c`, `0x210b0`) and sunix 1.1 (`0x1fe24`, `0x1ff38`) BSY-assert and timeout RAM patches.
  - Kept: the `0xc188` idle speed-up and the console-terminal hooks.
- **ProFile HLE speed-ups removed** (`hle.c`, `profile.c`, `rom.c`, preferences):
  - the LOS 3.1 read/write loops, which were installed regardless of the setting;
  - the UniPlus 1.4 read-status/tags/data and write intercepts;
  - the boot ROM `PROREAD` patch;
  - the "Hard drive acceleration" checkbox, which only controlled these.
  With the drive emulated faithfully and the CPU throttled to Lisa speed, the OS's own byte loops cost nothing that matters.
- **Timer 1 latch** (parallel VIAs): writing register 6 only loads the low latch, and reading it doesn't clear the T1 flag, as on the 6522. LisaEm used to start Timer 1 on every register-6 write, so the boot ROM's VIA latch test (`VIA2CHK`/`VIATST`) armed the timer repeatedly. After a Lisa power-off/on within one LisaEm session, a leftover T1 flag reached UniPlus. The kernel's level-1 handler then took it for a parallel-port interrupt and scanned slot 1, panicking with "kernel memory management error" when slot 1 was empty. Master hid it because IER writes cleared flags. The COPS VIA still has the old register-6 behaviour.
- **IFR bit 7** (parallel VIAs): set only while a flag is both set and enabled (`IFR & IER`), as on the 6522. Previously any flag set it; that was hidden while IER writes cleared masked flags.

## Tested so far

"Hard drive acceleration" (HLE) was unchecked for all of these, or had already been removed.

| OS / kernel | Port | Result |
|---|---|---|
| UniPlus V.1.5+ rebuilt `unix.nonet` | built-in | Boots. `find / -print`, `sum`, and `cp`/`cmp`/`rm` round trips pass. |
| UniPlus V.1.5+ rebuilt `unix.net` | built-in | Boots. Mounts the second filesystem on a 20 MB drive (`/dev/p0e`, blocks 19456–38911). Loopback TCP answers (`connect` gets "Connection refused"). |
| UniPlus 1.4 stock `/unix`, without the removed RAM patches | built-in | Boots |
| Lisa Office System 2 | built-in | Boots |
| Lisa Office System 3.1 | built-in | Boots with I/O ROM 88, on this branch (HLE removed) and on `master` alike. With another I/O ROM it stops with system error 10738 on both builds. |
| Xenix (10 MB ProFile) | built-in | Works with I/O ROM A8 (Xenix no longer gets its fake BSY/CA1 interrupt flags). Does not boot with I/O ROM 88; not yet checked on `master`, reinstall pending. |
| MacWorks XL 3.0 | built-in | Boots from the ProFile after a clean install. The earlier hangs and sad Mac `0F0064` ("couldn't read System file") came from an install without the System Folder, and failed the same way on `master` and on the December 2025 build `eb9c325`. |
| MacWorks 1.1h (boot floppy, no parallel devices) | — | Hangs at "Loading......." on `master` and on this branch; one boot on the branch instead stopped LisaEm with a CPU-core or MMU abort. The December 2025 build `eb9c325` also aborts (bus error with the vector table overwritten by `$39393939`), so it predates this branch. Not investigated further. |

A "read error" on `/dev/p0e` along the way turned out to be the kernel's own partition table (entry e was `{0, 0}` in `pro.c`), not the emulation. The disk image checked out clean block by block.

**Error 10738** is "Can't find a required driver for the boot device" (Lisa Pascal 3.0 docs). An LOS image carries boot-device information in PRAM that must match the Lisa model's I/O ROM: an image made on a 2/10 (I/O ROM 88) fails on other ROMs. Fix: set the I/O ROM to match, or invalidate PRAM from LisaBug (`sm fcc180 00ff 0055 00aa`). See [LisaList2](https://lisalist2.com/index.php?topic=656.0). Parallel-port traces of that failure showed every disk read completing normally.

Before this branch, the rebuilt UniPlus kernels failed every boot. They hit `ASSERTION BSY`, then "EXCESSIVE DISK DELAY", then `panic: iinit`, or intermittent "failed to issue cmd to disk".

## Still to test

These changes are merged (PR #55). The rest of the test plan, in priority order:

1. **Dual parallel card ProFile.** Nothing has been run against a ProFile on a slot card since the change. Slot-card ProFile I/O used to hang.
   - Put a ProFile image on a dual parallel card port and, from UniPlus, mount it and read/write:
     ```
     fsck /dev/rp2h
     mount /dev/p2h /mnt; find /mnt -print > /dev/null
     cp /unix /mnt/u && cmp /unix /mnt/u && rm /mnt/u; umount /mnt
     ```
     Use the device node for the port it's on (LisaEm slot 1 high answered as `/dev/p2h`, low as `/dev/p1h`).
   - Then boot from a slot-card ProFile, from the boot ROM's startup menu.
   - Run it with a second ProFile on the built-in port at the same time, so interrupts from both are exercised.
2. **Fresh LOS installs, both I/O ROMs.** Install LOS 2 and LOS 3.1 from floppies onto blank ProFile images with I/O ROM A8 and with 88. After each install, boot, then open, edit and save a document. The install and the save exercise writes.
3. **Pascal Workshop.** A Workshop image stopped with system error 10100 on this branch, with both A8 and 88. The trace showed all 693 reads and 20 writes completing normally, with no disk errors.
   - Boot the same image on a build from before PR #55 (for example LisaEm 2.0.0).
   - If it fails the same way, reinstall Workshop on the ROM you use and retest.
   - If it boots there, it's a regression. Trace IFR/IER access on the parallel VIA after the last write: Workshop's ProFile driver is fully interrupt-driven and flips CA1 polarity (PCR `$6A`/`$6B`) around each handshake.
4. **Xenix with I/O ROM 88.** Works with A8. With 88 (10 MB ProFile) it doesn't boot. Check the same image on a pre-#55 build, then reinstall with 88.
5. **Regression checks for the Timer 1 latch fix.**
   - Card in slot 1, boot UniPlus `unix.net`, shut the Lisa down with LisaEm still open.
   - Remove the card, power on and boot. It must not panic with "kernel memory management error" at `vaddr = 0xFC2069`.
   - Also power-cycle several times within one session with LOS and Xenix.
6. **Other software:**
   - Lisa Office System 1.x
   - MacWorks XL 3.0: install on the current build and boot it (so far the boot used a disk installed on an older build)
   - MacWorks Plus
   - UniPlus sunix 1.1: the installer kernel, which also lost its handshake patches
   - LisaTest's ProFile tests
7. **Boot ROM variants.** Boot from ProFile with other ROM revisions than H. Check that the spare-table read (block `$FFFFFF`) during slot scanning still identifies drives on slot cards.
8. **COPS VIA Timer 1 latch.** Not yet fixed, see `todo.md`. When it is, retest keyboard, mouse and clock on the OSes above.

**Known issues not caused by PR #55** (they also fail on pre-#55 builds). Worth separate issues:
- **MacWorks 1.1h** hangs at "Loading......." or aborts LisaEm, also on `eb9c325` (December 2025).
- **Mac-side crash after an abort:** moving the mouse over the window while the "Emulation aborted!" alert is up can crash LisaEm itself (a null-pointer dereference in the window event handling).
- **Slot interrupt check never unset:** once a slot card has been connected during a session, the slot's interrupt check (`get_exs0/1/2_pending_irq`) is never switched back to "empty" when the card is removed.
- **Build:** `build.sh` adds every `include` directory under the tree, so a git worktree nested inside the checkout breaks the build. It also doesn't rebuild C files after a header changes.

## What to look for

- Hangs at boot or during disk access, and OS disk errors: UniPlus "EXCESSIVE DISK DELAY", "failed to issue cmd to disk" or "bad status"; LOS/Workshop error codes.
- In LisaEm's log, the one-time alert `ProFile data write without /PSTRB`. It means an OS moved a data byte in a way a real drive would not latch, via register 15 or a CA2 mode without a strobe. Note the OS and the PC in the message.
- With a `DEBUG` build, ProfileLoop logs each state change and the reply byte. VIAProfileLoop logs every CA1 latch.

## Building a test binary

`build.sh` adds every `include` directory under the tree to the include path (`bashbuild/src.build`, `find ${XTLD} -type d -name include`). A git worktree nested inside the checkout, such as `.claude/worktrees/...`, can shadow `src/include/vars.h` and break the build. If that happens, build from a copy that excludes it:

```
rsync -a --exclude .claude --exclude .git --exclude 'wxWidgets-*' ./ /tmp/lisaem-build/
ln -s "$PWD/wxWidgets-3.2.11" /tmp/lisaem-build/wxWidgets-3.2.11
cd /tmp/lisaem-build && ./build.sh build
```

## If something regresses

- The changes are split into commits: drive and timer, VIA flags, hle.c patch removal.
- If only UniPlus 1.4 or sunix regresses, revert the `hle.c` commit first.
- If an OS other than UniPlus regresses, compare against a `master` build. The VIA flag commit is the most likely cause.
