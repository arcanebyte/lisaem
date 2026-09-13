# ProFile emulation: testing status and what's left

This file tracks testing of the `profile-emulation` branch. The branch replaces LisaEm's ProFile drive state machine and the parallel-port 6522 flag handling with protocol- and datasheet-accurate behaviour, and removes the UniPlus-specific handshake patches.

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
  - Kept: the `0xc188` idle speed-up and the optional HLE intercepts.

## Tested so far

"Hard drive acceleration" (HLE) was unchecked for all of these.

| OS / kernel | Port | Result |
|---|---|---|
| UniPlus V.1.5+ rebuilt `unix.nonet` | built-in | Boots. `find / -print`, `sum`, and `cp`/`cmp`/`rm` round trips pass. |
| UniPlus V.1.5+ rebuilt `unix.net` | built-in | Boots |
| UniPlus 1.4 stock `/unix`, without the removed RAM patches | built-in | Boots |
| Lisa Office System 3.1 | built-in | Opens OK. The LOS 3.1 HLE patches were still active (see below). |

Before this branch, the rebuilt UniPlus kernels failed every boot. They hit `ASSERTION BSY`, then "EXCESSIVE DISK DELAY", then `panic: iinit`, or intermittent "failed to issue cmd to disk".

## Still to test

1. **Dual parallel card.** Mount and read/write a ProFile on a slot-card port, for example from UniPlus:
   ```
   mount /dev/p2h /mnt; find /mnt -print > /dev/null
   cp /unix /mnt/u && cmp /unix /mnt/u && rm /mnt/u; umount /mnt
   ```
   Slot-card ProFile I/O used to hang. Then try booting from a slot-card ProFile.
2. **LOS 3.1 on the full emulation path.** `apply_los31_hacks()` (`src/storage/hle.c`) only checks `los31_hle`, which always starts at 1. It ignores the "Hard drive acceleration" checkbox, so LOS 3.1 always uses its HLE read/write loops and bypasses per-byte strobes.
   - To test without them, gate it on `hle` as well: `if (!los31_hle || !hle) return;`. That is a separate fix, not yet made.
   - Then rebuild, boot LOS with acceleration unchecked, and open, edit and save a document.
3. **Other OSes, on the built-in port and on a slot card where supported:**
   - Lisa Office System 1.x/2.x, including installing from floppies
   - Pascal Workshop
   - MacWorks XL / MacWorks Plus
   - Xenix. Its UniPlus/Xenix CA1 fakes were removed, and Xenix relies on T2 one-shot behaviour.
   - UniPlus sunix 1.1
   - LisaTest's ProFile tests
4. **Boot ROM paths.** Booting from ProFile with the H ROM and with other ROM revisions. The spare-table read (block $FFFFFF) during slot scanning.
5. **UniPlus 1.4 with "Hard drive acceleration" checked.** Its HLE intercepts set `StateMachineStep = 12` and read `DataBlock` directly. The state numbers and buffer layout were kept for this, but it hasn't been run.

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
