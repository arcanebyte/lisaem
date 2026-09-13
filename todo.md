# TODO

## COPS VIA (VIA1): Timer 1 latch register handled wrong

The parallel-port VIAs were fixed in `aecd54d`. The keyboard/mouse (COPS) VIA, VIA1 at `$FCDD81`, still has the same two bugs in `src/lisa/io_board/via6522.c`.

| | LisaEm today | 6522 datasheet |
|---|---|---|
| Write register 6, T1 low latch (`lisa_wb_Oxdc00_cops_via1`, `case T1LL1`) | Copies the value into the counter (`T1CL`) and **starts Timer 1** (`t1_e = get_via_te_from_timer(...)`, `FIX_CLKSTOP_VIA_T1(1)`) | Loads the latch only. The counter and timer are untouched until register 5 (`T1CH`) is written. |
| Read register 6 (`lisa_rb_Oxdc00_cops_via1`, `case T1LL1`) | Clears the T1 interrupt flag (`VIA_CLEAR_IRQ_T1(1)`) | Returns the latch; the flag is untouched. Only reading register 4 (`T1CL`) clears it. |

**Why it matters:** the boot ROM's `VIA1CHK` (H ROM listing, around `$08B0`) calls the same `VIATST` latch test used for VIA2, writing all 256 values to VIA1's T1 latches. With the bug, each write re-arms Timer 1, so T1 flags on the COPS VIA can be left set, or appear at odd times, after the self-test. VIA1 interrupts at level 2, which carries keyboard and mouse input. On VIA2 the same bug left a stale T1 flag that crashed UniPlus after a Lisa power-off/on within one LisaEm session.

**Why it wasn't fixed with VIA2:** VIA1 carries keyboard, mouse and clock traffic, and its code has its own `_COPS` flag-clearing macros that keep older behaviour. Changing its timer handling needs its own regression pass.

**To do:**
1. Apply the VIA2 change to both `case T1LL1` handlers: on write, load `T1LL` only and return; on read, return `T1LL` without `VIA_CLEAR_IRQ_T1(1)`.
2. Test keyboard and mouse input, the clock, and power-off/on within one session on:
   - LOS 2 and 3.1
   - Workshop
   - MacWorks XL 3.0
   - Xenix
   - UniPlus
   - the boot ROM's service mode
3. While in there, check `case T1LH1` against the datasheet too; LisaEm clears the T1 flag on a register-7 write.
