# Environment variables for scripted runs and debugging

These variables let a script run LisaEm with nobody at the window (to test
a guest operating system, for example) and trace the CPU when debugging a
guest. All are off unless set.

## Unattended runs

| Variable | Effect |
|---|---|
| `LISAEM_NO_DIALOGS` | Message boxes are not shown; each is answered with its default button (OK or Yes; No with `wxNO_DEFAULT`; Cancel with `wxCANCEL_DEFAULT`). Set to `0` to turn it off again. Every message box is also logged to stderr as `LisaEm dialog: [title] text`, whether or not this is set. Not covered: `wxMessageDialog` in the Preferences window, and file dialogs. |
| `LISAEM_SCREEN_DUMP=<file.png>` | About once a second, the Lisa display (720x364) is saved to the file, written as `<file>.png.tmp` and renamed. |
| `LISAEM_KEYBOARD_FILE=<file>` | About five times a second, bytes appended to the file are typed on the Lisa keyboard through the Edit/Paste-to-keyboard path. Newline is Return. `^A` followed by a byte B sends B to the COPS as a raw key code (bit 7 set for key down), so a script can hold a key down. If the file shrinks it is read again from the start. |
| `LISAEM_MOUSE_MOVE_AT=<seconds>` | Once, that many seconds after start, does what moving the pointer onto the Lisa screen does. |
| `LISAEM_FLOPPY_AT=<seconds>,<image>` | Once, that many seconds after start, inserts the DC42 image in the floppy drive, as the menu's insert command does. Unlike `-f`, it does not restart from the floppy. |
| `LISAEM_RAM_DUMP=<file>` | When `<file>.req` exists (checked about once a second), logical `$000000`-`$1FFFFF` as seen through MMU context 1 is saved to `<file>` and `<file>.req` is removed, so a script can read memory when it chooses. The PC, D0-D7, A0-A7 and both VIAs' IFR and IER are logged to stderr with it. |
| `LISAEM_ADDRERR_DUMP=<file>` | At the first 68000 address error, the same 2 MB is saved to `<file>` before the guest's error handling runs, and the faulting access, PC, context, registers and SR are logged to stderr. |

Times are host time, counted from when LisaEm starts.

## CPU trace

`cpu_trace()` in `src/lib/libGenerator/generator/reg68k.c` logs each
instruction on the main execution path. When tracing is off, the cost on
that path is one test of a static variable.

| Variable | Meaning |
|---|---|
| `LISAEM_CPU_TRACE=<file>` | turns the trace on |
| `LISAEM_CPU_TRACE_RANGE=<lo>-<hi>` | hex PC range to log (default `0-ffffff`) |
| `LISAEM_CPU_TRACE_MAX=<n>` | line limit (default 2,000,000) |
| `LISAEM_CPU_TRACE_START=<pc>` | hex: log nothing until the PC first reaches `<pc>` (a `START` line marks it) |
| `LISAEM_CPU_TRACE_MODE=stale` | only log instructions whose cached decode is stale |
| `LISAEM_CPU_TRACE_WATCH=<addr>` | hex logical address: log changes of the byte there and of its page translation entry |
| `LISAEM_CPU_TRACE_DUMP=<pc>,<lo>-<hi>` | the first time the PC reaches `<pc>`, write logical `<lo>`-`<hi>` (context 1) to `<file>.ram` |

Each line has the PC, the opcode and operands from the pre-decoded
instruction (IPC), the five words in memory at the PC, SR and all
registers. The instruction is also decoded again from memory, and the line
is marked `STALE` if the cached operands differ (the IPC cache is checked
only against the opcode word). Changes of the MMU context and tables are
logged as `MMU` lines, marked `INCONSISTENT` if the tables do not belong to
the current context. The file is flushed every 1024 lines and on every
`STALE`, `MMU` or `WATCH` line, so it survives the process being killed.

After changing `reg68k.c`, run `./build.sh clean` before `./build.sh
build`, which does not rebuild libGenerator on its own.

## CPU cross-check

`LISAEM_CPU_CHECK=<lo>-<hi>[,<seconds>]` (hex PCs) runs every instruction
whose PC is in that range on a second 68000 core as well, Musashi 4.60
(kstenerud/Musashi 313ebf1, MIT licence, in `src/lib/musashi`), starting
from LisaEm's registers and memory, and logs where the two disagree:
registers, PC, SR and memory writes. With `<seconds>`, checking starts that
many seconds of host time after start.

- Condition codes an instruction sets are compared only where Generator
  computed them (it skips flags that nothing reads).
- Instructions that touch anything but RAM are skipped, as are F-line
  traps (LisaEm's HLE), `STOP` and `RESET`.
- The log goes to `LISAEM_CPU_CHECK_LOG=<file>`, else stderr: the first 60
  disagreements, each with the registers before and after on both cores,
  and a count every 10 seconds.

`cpucheck.c` sits between `reg68k.c` and Musashi. When the check is off,
the cost on the execution path is a few tests of static variables around
each instruction.
