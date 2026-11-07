/**************************************************************************************\
*  LisaEm web/headless host layer                                                       *
*                                                                                      *
*  Replaces the wxWidgets front end (src/host/wxui) with a small, flat C API that can  *
*  be compiled to WebAssembly (Emscripten) or to a native library.  It reproduces the  *
*  hardware initialisation sequence of initialize_all_subsystems() without any UI.     *
*                                                                                      *
*  Everything is driven by the host: the emulated machine only advances when           *
*  lisa_run() is called, and it advances by an exact number of 68000 cycles.  That     *
*  makes runs fully deterministic, which is what automation and testing want.          *
*                                                                                      *
*  Licensed under the GNU General Public License v3, like the rest of LisaEm.          *
\**************************************************************************************/

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <math.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define LISA_API EMSCRIPTEN_KEEPALIVE
#else
#define LISA_API __attribute__((visibility("default")))
#endif

#include <vars.h>
#include <reg68k.h>
#include <generator.h>
#include <registers.h>
#include <cpu68k.h>
#include <keyscan.h>
#include "cpucheck.h"

/* Functions defined in the core that vars.h does not declare. */
extern int32 reg68k_external_execute(int32 clocks);
extern int romless_boot(int profileboot);
extern void cpu68k_reset(void);
extern void disconnect_serial(int port);
extern int check_running_lisa_os(void);
extern void apple_1(void);
extern void apple_2(void);
extern void apple_3(void);
extern int checkromchksum(void);
extern void fixromchk(void);
extern int has_xl_screenmod(void);
extern DC42ImageType current_upper_floppy_image, current_lower_floppy_image;
extern uint8 is_floppy_image_currently_inserted(DC42ImageType *F);
extern int dc42_sync_to_disk(DC42ImageType *F);
extern void get_next_timer_event(void);
extern void init_Profiles(void);
extern void profile_unmount(void);
extern int profile_mount(char *filename, ProFileType *P);
extern int floppy_insert(char *Image, uint8 insert_in_upper_floppy_drive);

#define LISA_CYCLES_PER_SECOND 5000000

/* ------------------------------------------------------------------------------------ *
 *  Host hooks the core expects (formerly implemented by the wx UI)                     *
 * ------------------------------------------------------------------------------------ */

#define MSG_RING 32
#define MSG_LEN 512
static char msg_ring[MSG_RING][MSG_LEN];
static unsigned msg_head = 0, msg_tail = 0;

static void push_message(const char *kind, const char *title, const char *text)
{
  snprintf(msg_ring[msg_head % MSG_RING], MSG_LEN, "%s: [%s] %s", kind, title ? title : "", text ? text : "");
  msg_head++;
  if (msg_head - msg_tail > MSG_RING)
    msg_tail = msg_head - MSG_RING;
}

static int host_powered_off = 0;
static int host_exit_requested = 0;

void messagebox(char *text, char *title) { push_message("dialog", title, text); }

/* Unattended: every yes/no question is answered "yes" (same as LISAEM_NO_DIALOGS). */
int yesnomessagebox(char *text, char *title)
{
  push_message("question", title, text);
  return 1;
}

/* Even-parity lookup helper (formerly defined in the wx UI). */
uint8 evenparity(uint8 data)
{
  uint32 v = data;
  v ^= v >> 4;
  v &= 0xf;
  return !((0x6996 >> v) & 1);
}


/* ---- Optional features the web host does not provide ---------------------------------- */

/* Musashi CPU cross-check (LISAEM_CPU_CHECK) is not built into the web core. */
int cc_nwrites = 0;
cc_write cc_writes[CC_MAXWRITES];
void cc_init(void) {}
int cc_step(const cc_regs *in, cc_regs *out) { (void)in; (void)out; return -1; }
void cc_disasm(unsigned pc, char *buf) { (void)pc; if (buf) buf[0] = 0; }

/* EtherBox networking is not available in the browser. */
XTIMER etherbox_next_event(EtherBoxType *eb) { (void)eb; return 0; }
void etherbox_timer(EtherBoxType *eb) { (void)eb; }

/* ImageWriter printer output is not captured yet. */
void ImageWriterLoop(int iw, uint8 c) { (void)iw; (void)c; }

/* UI-only notifications. */
void eject_floppy_animation(void) {}
void LisaScreenRefresh(void) { videoramdirty = 32768; }
void contrastchange(void) {}

/* The Lisa's speaker: a square wave whose half-period is set by VIA1 timer 2.  The host
   just records the current state so a front end can play it (Web Audio, etc.). */
static int host_sound_hz = 0;
void sound_play(uint16 freq) { host_sound_hz = freq; }
void sound_off(void) { host_sound_hz = 0; }

void save_pram(void) {}
void rename_rompath(char *rompath) { (void)rompath; } /* wx remembers the merged split ROM; nothing to do here */
void lisa_powered_off(void) { host_powered_off = 1; }
void on_lisa_exit(void) { host_exit_requested = 1; }


/* ------------------------------------------------------------------------------------ *
 *  Serial ports (Zilog 8530).  The host plugs into the core's "terminal" backend:      *
 *  bytes the Lisa transmits are collected for the host, and bytes the host sends are   *
 *  fed to the Lisa's receiver.  Public port numbers: 0 = Serial A, 1 = Serial B.       *
 *  (Internally the SCC calls B channel 0 and A channel 1.)                             *
 * ------------------------------------------------------------------------------------ */

extern FLIFLO_QUEUE_t SCC_READ[2], SCC_WRITE[2];
static uint8 host_serial_mode[2] = {SCC_NOTHING, SCC_NOTHING}; /* indexed by SCC channel */
#define SCC_CH(p) ((p) == 0 ? 1 : 0)

/* Called by the core whenever the guest (re)initialises the SCC. */
void connect_serial_devices(void)
{
  serial_b = host_serial_mode[0];
  serial_a = host_serial_mode[1];
}

char read_serial_port_terminal(unsigned int port) { return (char)fliflo_buff_get(&SCC_READ[port]); }
/* The SCC's own FIFOs are only 2 bytes (as on the real chip), so the host talks to them through two
   bigger rings per port: bytes the host sends wait in ser_in until the SCC can take them, and bytes the
   Lisa transmits are collected in ser_out until the host reads them. Nothing is dropped unless a ring
   (64 KB) overflows. Both live in the heap, so snapshots include them. */
#define SER_RING 65536
static uint8_t ser_in[2][SER_RING], ser_out[2][SER_RING];
static unsigned ser_in_h[2], ser_in_t[2], ser_out_h[2], ser_out_t[2];

void write_serial_port_terminal(unsigned int port, char data)
{
  if (port > 1 || ser_out_h[port] - ser_out_t[port] >= SER_RING)
    return;
  ser_out[port][ser_out_h[port]++ % SER_RING] = (uint8_t)data;
}

/* Move waiting host bytes into the SCC receive FIFO as the guest makes room. */
static void serial_pump(void)
{
  int ch;
  for (ch = 0; ch < 2; ch++)
    while (ser_in_t[ch] != ser_in_h[ch] && !fliflo_buff_is_full(&SCC_READ[ch]))
      fliflo_buff_add(&SCC_READ[ch], ser_in[ch][ser_in_t[ch]++ % SER_RING]);
}
static int serial_pending(void) { return ser_in_t[0] != ser_in_h[0] || ser_in_t[1] != ser_in_h[1]; }
void init_terminal_serial_port(int port) { (void)port; }

/* Serial backends that need an OS (pty, tty, shell, telnet) are not available. */
char read_serial_port_shell(unsigned int port) { (void)port; return -1; }
void write_serial_port_shell(unsigned int port, char c) { (void)port; (void)c; }
char read_serial_port_pty(unsigned int port) { (void)port; return -1; }
void write_serial_port_pty(unsigned int port, char c) { (void)port; (void)c; }
void set_dtr_pty(unsigned int port, uint8 value) { (void)port; (void)value; }
char read_serial_port_tty(unsigned int port) { (void)port; return -1; }
void write_serial_port_tty(unsigned int port, char c) { (void)port; (void)c; }
void set_port_baud_tty(int port, uint32 baud) { (void)port; (void)baud; }
char read_serial_port_telnetd(unsigned int port) { (void)port; return -1; }
void write_serial_port_telnetd(unsigned int port, char c) { (void)port; (void)c; }
int poll_telnet_serial_read(int portnum) { (void)portnum; return 0; }
void check_telnet_connection(int portnum) { (void)portnum; }
void init_telnet_serial_port(int port) { (void)port; }
void etherbox_detach(EtherBoxType *eb) { (void)eb; }
int pickprofilesize(char *filename, int allowexisting) { (void)filename; (void)allowexisting; return 0; }
void update_profile_preferences_path(char *newfilename) { (void)newfilename; }

/* Console text the HLE layer prints (ROM-less boot progress, LPW console). Collected
   in a ring that the host can drain. */
#define CONSOLE_SIZE 65536
static uint8_t console_ring[CONSOLE_SIZE];
static unsigned console_head = 0, console_tail = 0;
void lisa_console_output(uint8 c)
{
  console_ring[console_head++ % CONSOLE_SIZE] = c;
  if (console_head - console_tail > CONSOLE_SIZE)
    console_tail = console_head - CONSOLE_SIZE;
}
void lpw_console_output(char *text)
{
  for (; text && *text; text++)
    lisa_console_output((uint8)*text);
}
void lpw_console_output_c(char c) { lisa_console_output((uint8)c); }

/* Connect (enable=1) or disconnect a serial port to the host.  Takes effect when the
   guest next initialises its SCC, so call this before booting. */
LISA_API void lisa_serial_attach(int port, int enable)
{
  host_serial_mode[SCC_CH(port)] = enable ? SCC_TERMINAL : SCC_NOTHING;
  connect_serial_devices();
}

/* Send bytes to the Lisa's serial receiver. They are queued (up to 64 KB) and fed to the SCC as the guest
   reads them, so a long message is fine; run the machine for it to be received. Returns the number queued. */
LISA_API int lisa_serial_write(int port, const uint8_t *data, int len)
{
  int ch = SCC_CH(port), n = 0;
  while (n < len && ser_in_h[ch] - ser_in_t[ch] < SER_RING)
    ser_in[ch][ser_in_h[ch]++ % SER_RING] = data[n++];
  serial_pump();
  return n;
}

/* Fetch bytes the Lisa has transmitted on a serial port. Returns the number copied. */
LISA_API int lisa_serial_read(int port, uint8_t *dst, int max)
{
  int ch = SCC_CH(port), n = 0;
  while (n < max && ser_out_t[ch] != ser_out_h[ch])
    dst[n++] = ser_out[ch][ser_out_t[ch]++ % SER_RING];
  return n;
}

/* Bytes the host has sent that the guest has not yet received, per port (0 = A, 1 = B). */
LISA_API int lisa_serial_backlog(int port)
{
  int ch = SCC_CH(port);
  return (int)(ser_in_h[ch] - ser_in_t[ch]);
}

/* Drain the HLE/LPW console output text. Returns the number of bytes copied. */
LISA_API int lisa_console_read(uint8_t *dst, int max)
{
  int n = 0;
  while (n < max && console_tail != console_head)
    dst[n++] = console_ring[console_tail++ % CONSOLE_SIZE];
  return n;
}

/* ------------------------------------------------------------------------------------ *
 *  State                                                                                *
 * ------------------------------------------------------------------------------------ */

static int initialised = 0;
static uint32_t fb_rgba[720 * 364];

/* Keyboard queue.  Entries are an ASCII byte (typed through the key table), or a raw
   COPS key code with bit 8 set. */
#define KEYQ_SIZE 8192
static uint16_t keyq[KEYQ_SIZE];
static unsigned keyq_head = 0, keyq_tail = 0;
#define KEYQ_RAW 0x100

static int keyq_push(uint16_t v)
{
  if (keyq_head - keyq_tail >= KEYQ_SIZE)
    return 0;
  keyq[keyq_head++ % KEYQ_SIZE] = v;
  return 1;
}

static void keyq_pump(void)
{
  /* Same pacing rule the wx UI uses: only feed the COPS when its queue has room. */
  while (keyq_tail != keyq_head && copsqueuelen >= 0 && copsqueuelen < MAXCOPSQUEUE - 8)
  {
    uint16_t v = keyq[keyq_tail++ % KEYQ_SIZE];
    if (v & KEYQ_RAW)
      send_cops_keycode(v & 0xff);
    else
      keystroke_cops((unsigned char)v);
  }
}

/* ------------------------------------------------------------------------------------ *
 *  API: lifecycle                                                                       *
 * ------------------------------------------------------------------------------------ */

/* The Lisa's real-time clock is seeded from this (UTC seconds since 1970) when it powers on.
   The default is fixed so that a given script always sees the same machine; pass the real
   time to lisa_init() if you want the Lisa to know what day it is. */
static double host_epoch = 443880000.0; /* 1984-01-19 12:00:00 UTC, the Lisa's announcement day */
time_t lisa_host_time(void) { return (time_t)host_epoch; }

/* log_to_stderr: 1 sends the core's ALERT_LOG output to stderr, 0 discards it.
   epoch_seconds: initial clock (UTC seconds since 1970), or 0 for the fixed default. */
LISA_API int lisa_init(int ram_kb, int log_to_stderr, double epoch_seconds)
{
  if (epoch_seconds > 0)
    host_epoch = epoch_seconds;
  uint16 i;

  if (initialised)
    return 0;

  buglog = log_to_stderr ? stderr : fopen("/dev/null", "w");
  if (!buglog)
    buglog = stderr;

  for (i = 0; i < 256; i++)
    eparity[i] = evenparity((uint8)i);

  segment1 = 0;
  segment2 = 0;
  start = 1;

  scc_a_port = NULL;
  scc_b_port = NULL;
  scc_a_IW = -1;
  scc_b_IW = -1;
  serial_a = 0;
  serial_b = 0;

  floppy_iorom = 0xa8;
  init_floppy(floppy_iorom);

  bitdepth = 8;
  memset(serialnum, 0, sizeof(serialnum));
  serialnumshiftcount = 0;
  serialnumshift = 0;

  init_cops();
  init_IRQ();
  init_vias();
  init_Profiles();

  switch (ram_kb)
  {
  case 512:
    maxlisaram = 0x100000;
    minlisaram = 0x080000;
    break;
  case 1024:
    maxlisaram = 0x180000;
    minlisaram = 0x080000;
    break;
  default: /* 1536 and 2048 */
    maxlisaram = 0x200000;
    minlisaram = 0x080000;
    break;
  }

  TWOMEGMLIM = maxlisaram - 1;
  videolatchaddress = maxlisaram - 0x10000;
  videolatch = (maxlisaram >> 15) - 1;
  lastvideolatch = videolatch;
  lastvideolatchaddress = videolatchaddress;

  lisaram = (uint8 *)malloc(2 * 1024 * 1024 + 1024);
  if (!lisaram)
    return 23;
  memset(lisaram, 0xff, 2 * 1024 * 1024 + 511);

  set_keyboard_id(-1);

  /* Default serial number (same default the wx UI uses), checksum-fixed. */
  {
    static const char *s = "ff000000000000ff0000000000000000";
    int j;
    for (j = 0; j < 16; j++)
      serialnum240[j] = (gethex(s[2 * j]) << 4) | gethex(s[2 * j + 1]);
    vidfixromchk(serialnum240);
  }

  disconnect_serial(0);
  disconnect_serial(1);
  initialize_scc(0);

  softmemerror = 0;
  harderror = 0;
  videoirq = 0;
  bustimeout = 0;
  videobit = 0;

  reg68k_sanity_check_bitorder();
  cpu68k_init();
  init_lisa_mmu();
  init_ipct_allocator();

  /* Standard (non-XL) 720x364 display. */
  lisa_vid_size_x = 720;
  lisa_vid_size_y = 364;
  lisa_vid_size_xbytes = 90;
  has_lisa_xl_screenmod = 0;

  disable_vidram();
  videoramdirty = 32768;

  cpu68k_reset();

  host_powered_off = 0;
  initialised = 1;
  return 0;
}

/* Mount a DC42/raw image from the (virtual) filesystem as the floppy. */
LISA_API int lisa_insert_floppy(const char *path) { return floppy_insert((char *)path, 0); }

/* Mount a ProFile image on the built-in parallel port (VIA 2). Returns 0 on success. */
LISA_API int lisa_mount_profile(const char *path)
{
  int v = 2, r;
  if (!via[v].ProFile)
    via[v].ProFile = (ProFileType *)calloc(1, sizeof(ProFileType));
  r = profile_mount((char *)path, via[v].ProFile);
  if (r)
  {
    free(via[v].ProFile);
    via[v].ProFile = NULL;
    return r;
  }
  via[v].ProFile->vianum = v;
  return 0;
}

/* ROM-less ("HLE") boot.  from_profile: 0 boots the floppy, 1 boots the ProFile.
   (romless_boot() uses the opposite numbering, so it is translated here.) */
LISA_API int lisa_boot_romless(int from_profile)
{
  host_powered_off = 0;
  host_exit_requested = 0;
  return romless_boot(from_profile ? 0 : 1);
}

/* ------------------------------------------------------------------------------------ *
 *  API: running                                                                         *
 * ------------------------------------------------------------------------------------ */

static int run_slice = 1000; /* CPU cycles per host step; see lisa_set_slice() for why this is small */
static void mouse_pump(void);
static void rom_autoboot_pump(void);
static void serial_pump(void);
static int serial_pending(void);

#define STATUS_POWERED_OFF 1
#define STATUS_REBOOTED 2
#define STATUS_FATAL 4

/* Run the machine for (at least) `cycles` 68000 clock cycles; 5,000 cycles = 1 ms of
   Lisa time.  Returns a bitmask of STATUS_* flags. */
LISA_API int lisa_run(int cycles)
{
  static XTIMER ideal = 0; /* where the clock would be had no call overshot: carries the overshoot over so that
                              the emulated time does not depend on how the host chops it into run() calls */
  XTIMER target;
  static XTIMER next_os_check = 0, slice_end = 0;
  int status = 0;

  if (ideal + LISA_CYCLES_PER_SECOND < cpu68k_clocks || cpu68k_clocks + LISA_CYCLES_PER_SECOND < ideal) /* first call, or the clock was reset */
    ideal = cpu68k_clocks;
  ideal += cycles;
  target = ideal;

  while (cpu68k_clocks < target && !host_powered_off && !host_exit_requested)
  {
    int32 want;

    /* Work happens on a fixed cadence of run_slice cycles that does not care where run() calls begin and
       end, so the guest sees the same thing however the host chops up time (a call may end mid-slice, and
       the next one carries on). */
    if (cpu68k_clocks >= slice_end)
    {
      /* Learn which OS is running: it tells the COPS where that OS keeps its mouse position. */
      if (cpu68k_clocks >= next_os_check)
      {
        check_running_lisa_os();
        next_os_check = cpu68k_clocks + LISA_CYCLES_PER_SECOND / 10;
      }

      rom_autoboot_pump();
      serial_pump();
      keyq_pump();
      mouse_pump();
      seek_mouse_event();
      slice_end = cpu68k_clocks + run_slice;
    }

    /* Always run to the end of the slice, never to the end of the call: where run() calls begin and end
       must not change what the guest sees (the demos' loaders are timing sensitive). A call may therefore
       overshoot by up to a slice; the overshoot is carried over (see `ideal`). */
    want = (int32)(slice_end - cpu68k_clocks);
    reg68k_external_execute(want);

    if (pc24 & 1)
    {
      if (lisa_ram_safe_getlong(context, 12) & 1)
      {
        status |= STATUS_REBOOTED;
        break;
      }
    }
    if (cpu68k_clocks >= slice_end)
    {
      get_next_timer_event();
      seek_mouse_event();
    }
  }

  if (host_powered_off)
    status |= STATUS_POWERED_OFF;
  if (host_exit_requested)
    status |= STATUS_FATAL; /* the core hit an unrecoverable error; see lisa_next_message() */
  return status;
}

LISA_API double lisa_cycles(void) { return (double)cpu68k_clocks; }

/* Mouse button sequencing (see lisa_mouse).
   The COPS mouse is relative: the core feeds the guest motion until its pointer reaches the target. If a
   button event is queued while the pointer is still travelling, the core's "give up" rule can fire the
   press mid-path, and a press and release delivered back to back is too short for the OS to notice. So a
   press is only queued once the pointer has arrived, and held for at least 100 ms of Lisa time. */
#define MOUSE_HOLD_CYCLES (LISA_CYCLES_PER_SECOND / 10)
#define MOUSE_ARRIVE_TIMEOUT (3 * LISA_CYCLES_PER_SECOND)
static struct { int want_down, down_sent, want_up, x, y; XTIMER t_req, t_down; } mb;

static void mouse_pump(void)
{
  int px, py;
  if (!mb.want_down)
    return;
  if (!mb.down_sent)
  {
    px = (int)(lisa_ram_safe_getword(1, lisa_os_mouse_x_ptr) & 0xffff);
    py = (int)(lisa_ram_safe_getword(1, lisa_os_mouse_y_ptr) & 0xffff);
    if ((abs(px - mb.x) <= 3 && abs(py - mb.y) <= 3) || cpu68k_clocks - mb.t_req >= MOUSE_ARRIVE_TIMEOUT)
    {
      add_mouse_event((int16)mb.x, (int16)mb.y, 1);
      mb.down_sent = 1;
      mb.t_down = cpu68k_clocks;
    }
  }
  else if (mb.want_up && cpu68k_clocks - mb.t_down >= MOUSE_HOLD_CYCLES)
  {
    add_mouse_event((int16)mb.x, (int16)mb.y, -1);
    memset(&mb, 0, sizeof mb);
  }
}


/* ------------------------------------------------------------------------------------ *
 *  Real Boot ROM                                                                        *
 *                                                                                      *
 *  With a ROM the machine boots like the real thing: the ROM runs its self-test, then  *
 *  waits at the boot menu until Apple-1/2/3 chooses a device. lisa_power_on() starts    *
 *  from reset and can press that key for you, using the same timing window as the wx   *
 *  app (3 to 6 seconds into the boot, when the ROM is listening).                      *
 * ------------------------------------------------------------------------------------ */

static int rom_loaded = 0, rom_checksum_bad = 0, rom_autoboot = 0, rom_autoboot_done = 1;

/* Load a boot ROM from the (virtual) filesystem. Accepts, like the wx app: the assembled DTC
   source listing, a lo/hi split pair (pass either file; see read_split_rom), or a plain 16 KB
   image. Returns 1/2/3 for those formats, or a negative number on failure. */
LISA_API int lisa_load_rom(const char *path)
{
  int fmt;
  if (!initialised)
    return -10;
  if (read_dtc_rom((char *)path, lisarom) == 0)
    fmt = 1;
  else if (read_split_rom((char *)path, lisarom) == 0)
    fmt = 2;
  else if (read_rom((char *)path, lisarom) == 0)
    fmt = 3;
  else
    return -1;

  rom_checksum_bad = checkromchksum() != 0; /* tested before the H-ROM patch below, as the wx app does */
  fixromchk();
  romless = 0;
  rom_loaded = 1;

  if (has_xl_screenmod()) /* 3A ROM: the XL screen, 608x431, only for MacWorks */
  {
    lisa_vid_size_x = 608;
    lisa_vid_size_y = 431;
    lisa_vid_size_xbytes = 76;
    has_lisa_xl_screenmod = 1;
  }
  else
  {
    lisa_vid_size_x = 720;
    lisa_vid_size_y = 364;
    lisa_vid_size_xbytes = 90;
    has_lisa_xl_screenmod = 0;
  }
  return fmt;
}

/* ROM version word (e.g. 0x0248 = "2.H" ROM) and 1 if its checksum did not match (the emulator
   may still run it), or 0 if no ROM is loaded. */
LISA_API int lisa_rom_version(void) { return rom_loaded ? (lisarom[0x3ffc] << 8) | lisarom[0x3ffd] : 0; }
LISA_API int lisa_rom_checksum_bad(void) { return rom_checksum_bad; }

/* Power on from reset through the ROM. boot: 0 = stop at the ROM's own menu, 1/2/3 = press
   Apple-1/2/3 for you once the ROM is ready (2 = floppy, 3 = hard disk). */
LISA_API int lisa_power_on(int boot)
{
  if (!rom_loaded)
    return -1;
  romless = 0;
  host_powered_off = 0;
  host_exit_requested = 0;
  disable_vidram();
  videoramdirty = 32768;
  cpu68k_reset();
  rom_autoboot = boot;
  rom_autoboot_done = boot == 0;
  return 0;
}

static void rom_autoboot_pump(void)
{
  if (rom_autoboot_done || cpu68k_clocks < 15000000)
    return;
  if (running_lisa_os == LISA_ROM_RUNNING && cpu68k_clocks < 30000000)
  {
    if (rom_autoboot == 1)
      apple_1();
    else if (rom_autoboot == 2)
      apple_2();
    else if (rom_autoboot == 3)
      apple_3();
    rom_autoboot_done = 1;
  }
  else if (cpu68k_clocks >= 30000000)
    rom_autoboot_done = 1;
}

/* ------------------------------------------------------------------------------------ *
 *  API: input peripherals                                                               *
 * ------------------------------------------------------------------------------------ */

/* Type text on the Lisa keyboard (ASCII; '\n' is Return).  Returns the number of
   characters queued; the rest were dropped because the queue is full. */
LISA_API int lisa_type(const char *text)
{
  int n = 0;
  for (; *text; text++, n++)
    if (!keyq_push((uint8_t)*text))
      break;
  return n;
}

/* Send one raw COPS key code (see keyscan.h).  down=1 key down, 0 key up. */
LISA_API int lisa_key_raw(int keycode, int down)
{
  return keyq_push(KEYQ_RAW | ((keycode & 0x7f) | (down ? KEY_DOWN : KEY_UP)));
}

/* Absolute mouse position in Lisa screen pixels (0..720, 0..364).
   button: 0 = just move, 1 = press, -1 = release.  The emulated COPS then feeds the
   guest relative motion until the guest's own pointer arrives at the target. */
LISA_API void lisa_mouse(int x, int y, int button)
{
  if (button == 1)
  {
    /* Move first; the press is only queued once the guest pointer has arrived (see mouse_pump). */
    add_mouse_event((int16)x, (int16)y, 0);
    mb.want_down = 1;
    mb.down_sent = 0;
    mb.want_up = 0;
    mb.x = x;
    mb.y = y;
    mb.t_req = cpu68k_clocks;
  }
  else if (button == -1 && mb.want_down)
  {
    mb.want_up = 1; /* released after the press has been delivered and held */
    mb.x = x;
    mb.y = y;
  }
  else
  {
    add_mouse_event((int16)x, (int16)y, (int8)button);
    if (mb.want_down)
    {
      mb.x = x;
      mb.y = y;
    }
  }
}

/* ------------------------------------------------------------------------------------ *
 *  API: output peripherals / observation                                                *
 * ------------------------------------------------------------------------------------ */

LISA_API int lisa_screen_width(void) { return lisa_vid_size_x; }
LISA_API int lisa_screen_height(void) { return lisa_vid_size_y; }

/* The raw 1-bit-per-pixel video RAM page the CRT is currently scanning out
   (90 bytes per row, most significant bit leftmost). */
LISA_API const uint8_t *lisa_screen_raw(void) { return lisaram + videolatchaddress; }

/* The screen as 32-bit RGBA pixels (opaque; black = ink, white = paper). */
LISA_API const uint32_t *lisa_screen_rgba(void)
{
  const uint8_t *vid = lisaram + videolatchaddress;
  int w = lisa_vid_size_x, h = lisa_vid_size_y, x, y;
  for (y = 0; y < h; y++)
    for (x = 0; x < w; x++)
    {
      int bit = (vid[y * (w / 8) + (x >> 3)] >> (7 - (x & 7))) & 1;
      fb_rgba[y * w + x] = bit ? 0xff000000u : 0xffffffffu; /* little-endian: A B G R */
    }
  return fb_rgba;
}

LISA_API int lisa_ram_size(void) { return (int)maxlisaram; }
LISA_API const uint8_t *lisa_ram_ptr(void) { return lisaram; }

/* Read memory as the CPU would see it in MMU context `ctx` (0 = ROM/start mode,
   1 = normal OS context, ...).  Returns bytes copied. */
LISA_API int lisa_read_memory(int ctx, uint32_t addr, uint8_t *dst, int len)
{
  int i;
  for (i = 0; i < len; i++)
    dst[i] = (uint8_t)lisa_ram_safe_getbyte(ctx, addr + i);
  return len;
}

/* out[0..7]=D0-D7, out[8..15]=A0-A7, out[16]=PC, out[17]=SR, out[18]=MMU context. */
LISA_API void lisa_registers(uint32_t *out)
{
  int i;
  for (i = 0; i < 16; i++)
    out[i] = reg68k_regs[i];
  out[16] = reg68k_pc;
  out[17] = reg68k_sr.sr_int;
  out[18] = context;
}

/* Pop the next host-visible message (dialogs the guest/core wanted to show, etc.).
   Returns NULL when there are none. */
LISA_API const char *lisa_next_message(void)
{
  static char out[MSG_LEN];
  if (msg_tail == msg_head)
    return NULL;
  strcpy(out, msg_ring[msg_tail++ % MSG_RING]);
  return out;
}

LISA_API int lisa_is_powered_off(void) { return host_powered_off; }


/* ------------------------------------------------------------------------------------ *
 *  Speaker audio                                                                        *
 *                                                                                      *
 *  The Lisa's speaker is driven by VIA1: timer 2's low byte sets the bit rate, the     *
 *  8-bit shift register holds the waveform (it is shifted out continuously, so its     *
 *  pattern is the timbre), and three bits of port B set the volume. A program makes    *
 *  music by rewriting those three, often hundreds of times a second. The core calls    *
 *  host_audio_changed() on every such write; we log the new state with the CPU clock   *
 *  it happened at, and lisa_audio_render() turns the log into PCM sample by sample,    *
 *  so the audio is exact in *emulated* time and independent of how the host chops it   *
 *  into buffers (and so identical on every run).                                        *
 *                                                                                      *
 *  Two regimes, chosen by what the pattern does to the speaker:                        *
 *   - Audible tone (the waveform's fundamental is below ~8 kHz: the ROM's chirp, tone  *
 *     music): the macOS LisaEm patch's model (LisaSpeakerPcm): a +-gain square wave    *
 *     from the pattern, gain eased toward the volume, AC-coupled, one-pole softened.   *
 *   - Ultrasonic carrier (e.g. pattern $AA with T2=4, a ~21 kHz square): the speaker   *
 *     cannot follow the carrier, only its amplitude, so the volume *is* the signal: a  *
 *     3-bit sample, held between writes, AC-coupled and averaged over 5 samples, as in *
 *     the alisando project's own offline renderer. This is how that demo plays PCM     *
 *     music: it writes the volume a few thousand times a second.                       *
 *  Smoothing constants are time constants, so they do not depend on the sample rate.   *
 *                                                                                      *
 *  Nothing is logged until lisa_audio_start(), so headless runs pay nothing.           *
 * ------------------------------------------------------------------------------------ */

typedef struct
{
  int64_t clk;
  uint8_t period, pattern, volume, flags; /* flags: 1 = shift-out enabled, 2 = 625 kHz VIA clock */
} audio_event_t;

#define AUDIO_EVENTS 65536
static audio_event_t aud_ev[AUDIO_EVENTS];
static unsigned aud_h, aud_t;
static int aud_rate = 0; /* 0 = audio off */
#define AUDIO_TRACE_MAX 2000000
static audio_event_t *aud_trace; /* diagnostic: every event ever logged (while tracing) */
static unsigned aud_trace_n, aud_trace_read;
static audio_event_t aud_last;

static struct
{
  double phase, gain, dc, filtered;
  double a_gain, a_dc, a_lpf;
  double box[5]; /* last 5 AC-coupled carrier-mode samples */
  unsigned box_i;
  uint8_t period, pattern, volume, flags;
  int64_t done; /* samples rendered so far */
} aud;

static audio_event_t audio_now(void)
{
  audio_event_t e;
  int shifting = (via[1].via[ACR] & 0x10) != 0;
  e.clk = cpu68k_clocks;
  e.period = via[1].via[T2LL];
  e.pattern = via[1].via[SHIFTREG];
  e.volume = volume & 7;
  e.flags = (uint8_t)((shifting && e.period && e.pattern ? 1 : 0) | ((floppy_iorom & 0x20) ? 0 : 2));
  return e;
}

static void audio_apply(const audio_event_t *e)
{
  aud.period = e->period;
  aud.pattern = e->pattern;
  aud.volume = e->volume;
  aud.flags = e->flags;
}

/* How many bits it takes for the shifted-out pattern to repeat: 1 (constant), 2, 4 or 8. */
static int audio_pattern_bits(uint8_t p)
{
  int per;
  for (per = 1; per < 8; per *= 2)
    if ((uint8_t)((p << per) | (p >> (8 - per))) == p)
      return per;
  return 8;
}

/* Called by the core (via6522.c, under LISA_HOST_AUDIO) whenever a sound register changes. */
void host_audio_changed(void)
{
  audio_event_t e;
  if (!aud_rate)
    return;
  e = audio_now();
  if (e.period == aud_last.period && e.pattern == aud_last.pattern && e.volume == aud_last.volume && e.flags == aud_last.flags)
    return;
  aud_last = e;
  if (aud_trace && aud_trace_n < AUDIO_TRACE_MAX)
    aud_trace[aud_trace_n++] = e;
  if (aud_h - aud_t >= AUDIO_EVENTS) /* log full: fold the oldest event into the state so nothing is lost */
    audio_apply(&aud_ev[aud_t++ % AUDIO_EVENTS]);
  aud_ev[aud_h++ % AUDIO_EVENTS] = e;
}

/* A one-pole smoothing coefficient for time constant `tau` seconds at the output rate. */
static double audio_alpha(double tau) { return 1.0 - exp(-1.0 / (tau * aud_rate)); }

/* Start (or restart) audio at the given output sample rate, from the current emulated time. */
LISA_API void lisa_audio_start(int rate)
{
  audio_event_t e;
  if (rate < 8000 || rate > 192000)
    rate = 44100;
  aud_rate = rate;
  memset(&aud, 0, sizeof aud);
  /* Time constants chosen to reproduce the macOS patch's per-sample constants at 44.1 kHz. */
  aud.a_gain = audio_alpha(1.0 / (44100.0 * -log(1.0 - 0.025)));
  aud.a_dc = audio_alpha(1.0 / (44100.0 * -log(1.0 - 0.003)));
  aud.a_lpf = audio_alpha(1.0 / (44100.0 * -log(1.0 - 0.32)));
  aud_h = aud_t = 0;
  e = audio_now();
  aud_last = e;
  audio_apply(&e);
  aud.done = (int64_t)((double)cpu68k_clocks * rate / LISA_CYCLES_PER_SECOND); /* no burst of catch-up audio */
}

LISA_API void lisa_audio_stop(void) { aud_rate = 0; }

/* Render the audio for the emulated time that has passed since the last call, up to `max` samples
   (mono, float, about +-0.3 at full volume). Returns the number of samples written; call again if it
   returned `max` and you want the rest. */
LISA_API int lisa_audio_render(float *out, int max)
{
  int64_t available;
  int n = 0;
  if (!aud_rate)
    return 0;
  available = (int64_t)((double)cpu68k_clocks * aud_rate / LISA_CYCLES_PER_SECOND);
  while (aud.done < available && n < max)
  {
    double clk = (double)aud.done * LISA_CYCLES_PER_SECOND / aud_rate, target, hz, bit_rate, f0, signal;
    int enabled;
    while (aud_t != aud_h && (double)aud_ev[aud_t % AUDIO_EVENTS].clk <= clk)
      audio_apply(&aud_ev[aud_t++ % AUDIO_EVENTS]);
    enabled = (aud.flags & 1) && aud.pattern && aud.pattern != 255;
    hz = (aud.flags & 2) ? 625000.0 : 500000.0;
    bit_rate = hz / (2.0 * (aud.period + 2));
    f0 = bit_rate / audio_pattern_bits(aud.pattern); /* the waveform's fundamental */
    if (enabled && f0 >= 8000.0)
    {
      /* Ultrasonic carrier: the volume is a 3-bit sample (centred, as the project's own renderer does). */
      signal = (aud.volume - 3.5) * (0.50 / 3.5);
      aud.gain = aud.volume * (0.45 / 7.0); /* keep the tone regime's gain continuous if we switch back */
      aud.dc += aud.a_dc * (signal - aud.dc);
      aud.box[aud.box_i++ % 5] = signal - aud.dc;
      aud.filtered = (aud.box[0] + aud.box[1] + aud.box[2] + aud.box[3] + aud.box[4]) / 5.0;
    }
    else
    {
      target = enabled ? aud.volume * (0.45 / 7.0) : 0.0;
      aud.gain += aud.a_gain * (target - aud.gain);
      aud.phase += bit_rate / aud_rate;
      while (aud.phase >= 8.0)
        aud.phase -= 8.0;
      signal = (aud.pattern & (128u >> (unsigned)aud.phase)) ? aud.gain : -aud.gain;
      aud.dc += aud.a_dc * (signal - aud.dc);
      aud.filtered += aud.a_lpf * (signal - aud.dc - aud.filtered);
      aud.box[aud.box_i++ % 5] = 0.0; /* so a later switch to carrier mode starts from silence */
    }
    out[n++] = (float)aud.filtered;
    aud.done++;
  }
  return n;
}

/* Diagnostic: the speaker registers as the renderer currently has them. out[0..3] = timer-2 low (period),
   shift-register pattern, volume 0-7, flags (1 = shift-out enabled). Call lisa_audio_render() first. */
LISA_API void lisa_audio_state(uint8_t *out)
{
  out[0] = aud.period;
  out[1] = aud.pattern;
  out[2] = aud.volume;
  out[3] = aud.flags;
}

/* Raw value the guest wrote to the speaker timer (0 = silent). */
LISA_API int lisa_sound(void) { return host_sound_hz; }

/* Screen contrast latch (0 = full brightness .. 0xff = off). */
LISA_API int lisa_contrast(void) { return contrast; }

/* Which OS the core thinks is running (see glue.c): 0 unknown, 1 ROM/boot, 2 Lisa Office
   System, etc. -- the values of the *_RUNNING constants in vars.h. */
LISA_API int lisa_running_os(void) { return running_lisa_os; }

/* Where the guest OS currently thinks its mouse pointer is, packed as x | (y << 16).
   Automation uses this to know when a lisa_mouse() target has been reached. */
LISA_API uint32_t lisa_pointer(void)
{
  uint16_t x = (uint16_t)lisa_ram_safe_getword(1, lisa_os_mouse_x_ptr);
  uint16_t y = (uint16_t)lisa_ram_safe_getword(1, lisa_os_mouse_y_ptr);
  return (uint32_t)x | ((uint32_t)y << 16);
}

/* Diagnostics: bytes waiting in the keyboard/COPS queue (drains as the guest reads them),
   and keys still waiting in the host-side typing queue. */
LISA_API int lisa_cops_pending(void) { return copsqueuelen; }
LISA_API int lisa_typing_pending(void) { return (int)(keyq_head - keyq_tail); }

/* ------------------------------------------------------------------------------------ *
 *  Disk images                                                                          *
 * ------------------------------------------------------------------------------------ */

/* Write any disk changes held in memory back to the image files in the virtual filesystem, so
   that reading those files gives the disks as the guest has left them. Returns the number of
   images flushed. */
LISA_API int lisa_flush_disks(void)
{
  int n = 0, v;
  if (!initialised)
    return 0;
  if (is_floppy_image_currently_inserted(&current_upper_floppy_image))
    n += dc42_sync_to_disk(&current_upper_floppy_image) == 0;
  if (is_floppy_image_currently_inserted(&current_lower_floppy_image))
    n += dc42_sync_to_disk(&current_lower_floppy_image) == 0;
  for (v = 2; v < 9; v++)
    if (via[v].ProFile)
      n += dc42_sync_to_disk(&via[v].ProFile->DC42) == 0;
  return n;
}

/* Diagnostic: how the image I/O layer is handling a disk. which: 0 = ProFile on the built-in
   parallel port, 1 = upper floppy. Returns 0 per-sector file I/O, 1 memory-mapped, 2 whole image in
   RAM written back on flush/close, or -1 if there is no such disk. */
LISA_API int lisa_disk_mode(int which)
{
  if (which == 0)
    return (initialised && via[2].ProFile) ? via[2].ProFile->DC42.mmappedio : -1;
  if (which == 1)
    return (initialised && is_floppy_image_currently_inserted(&current_upper_floppy_image)) ? current_upper_floppy_image.mmappedio : -1;
  return -1;
}

/* Diagnostic/export: pointer to, and size of, the in-memory copy of a disk image (which as in
   lisa_disk_mode). In memory-mapped and in-RAM modes this is the live image, including guest writes. */
LISA_API const uint8_t *lisa_disk_ptr(int which, uint32_t *size)
{
  DC42ImageType *F = NULL;
  if (!initialised)
    return NULL;
  if (which == 0 && via[2].ProFile)
    F = &via[2].ProFile->DC42;
  else if (which == 1 && is_floppy_image_currently_inserted(&current_upper_floppy_image))
    F = &current_upper_floppy_image;
  if (!F)
    return NULL;
  if (size)
    *size = (uint32_t)F->size;
  return F->RAM;
}

/* A fast fingerprint (FNV-1a, 32-bit) of the live in-memory disk image, so a front end can cheaply
   tell whether the guest has changed a disk since it last saved it. Returns 0 if there is no such disk. */
LISA_API uint32_t lisa_disk_hash(int which)
{
  uint32_t size = 0, i, h = 2166136261u;
  const uint8_t *p = lisa_disk_ptr(which, &size);
  if (!p)
    return 0;
  for (i = 0; i < size; i++)
    h = (h ^ p[i]) * 16777619u;
  return h ? h : 1;
}

/* Diagnostic: record every audio event (before it is rendered) so a test can compare the register writes the
   guest made with a reference model. Costs 16 bytes per event, up to 2 million. */
LISA_API void lisa_audio_trace(int on)
{
  if (on && !aud_trace)
    aud_trace = (audio_event_t *)calloc(AUDIO_TRACE_MAX, sizeof(audio_event_t));
  aud_trace_n = aud_trace_read = 0;
  if (!on && aud_trace)
  {
    free(aud_trace);
    aud_trace = NULL;
  }
}

/* Copy up to `max` traced events not yet read into dst, 16 bytes each: int64 clk, then period, pattern, volume,
   flags, and 4 bytes padding. Returns how many were copied. */
LISA_API int lisa_audio_trace_take(audio_event_t *dst, int max)
{
  int n = 0;
  while (aud_trace && n < max && aud_trace_read < aud_trace_n)
    dst[n++] = aud_trace[aud_trace_read++];
  return n;
}

/* How many CPU cycles lisa_run() executes between servicing input and the parts of the core whose timing is
   counted in *host calls* rather than CPU cycles. The main one is the floppy controller's busy counter, which
   seek_mouse_event() decrements once per call, so the slice length sets how long an emulated floppy operation
   takes. With the old 25,000-cycle slice (5 ms) a floppy load held the CPU's interrupts off long enough that
   the alisando demo's music stalled, stretching its first scene from 25 s to 31 s; at 1,000 cycles (200 us)
   the music runs on its own clock, matching the demo's reference mixer to within 1%. 1000 costs no
   measurable speed. Default 1000. */
LISA_API void lisa_set_slice(int cycles) { run_slice = cycles < 100 ? 100 : cycles; }
