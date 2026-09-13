/**************************************************************************************\
*                                                                                      *
*              The Lisa Emulator Project                                               *
*                             http://lisaem.sunder.net                                 *
*                                                                                      *
*           This program is free software; you can redistribute it and/or              *
*           modify it under the terms of the GNU General Public License                *
*           as published by the Free Software Foundation; either version 2             *
*           of the License, or (at your option) any later version.                     *
*                                                                                      *
*           This program is distributed in the hope that it will be useful,            *
*           but WITHOUT ANY WARRANTY; without even the implied warranty of             *
*           MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the              *
*           GNU General Public License for more details.                               *
*                                                                                      *
*                          3Com EtherBox on a parallel port                            *
*                                                                                      *
*   The Ethernet box driven by UniSoft UniPlus+ V.1.5+ (if_eb.c) through one parallel  *
*   port VIA.  Port B carries a command code, port A a register number or data byte,   *
*   one byte per /PSTRB (CA2 pulse).  Behind the port is a 3Com EDLC-style controller  *
*   with a station address, a 2048 byte transmit buffer and two 2048 byte receive      *
*   buffers.  The box interrupts the Lisa by pulsing CA1.                              *
*                                                                                      *
*   Only what if_eb.c uses is modelled.                                                *
*                                                                                      *
\**************************************************************************************/

#define IN_ETHERBOX_C
#include <vars.h>
#include <etherbox.h>
#include <stdarg.h>

extern void set_next_timer_id(uint8 x);

// port B command codes
#define EB_PB_RC 0xa8 // idle / read command
#define EB_PB_WC 0xa0 // write command: the next strobed port A byte selects a register
#define EB_PB_WD 0xb0 // write data to the selected register
#define EB_PB_RD 0xb8 // read data from the selected register

// controller registers
#define EB_ACTADDR0 0 // station address RAM, 0-5
#define EB_RCVCMD 6
#define EB_XCSR 7
#define EB_XBP_HI 8
#define EB_XBP_LO 9
#define EB_BBPCLEAR 10 // write: clear the bus buffer pointer
#define EB_PROM 10     // read: station address PROM
#define EB_AUXCSR 11
#define EB_COLLCNTR 12
#define EB_XMTBUF 13
#define EB_RCVBUFA 14
#define EB_RCVBUFB 15

// XCSR read bits
#define EB_XREADY 0x08

// RCVCMD bits
#define EB_STABROAD 0x80 // station address and broadcast
#define EB_PROMIS 0x40   // everything

// AUXCSR bits
#define EB_EDLCRES 0x80 // W: reset the controller           R: XCVRUP, transceiver on
#define EB_XCVRUP 0x80
#define EB_SYSEI 0x40   // enable interrupts
#define EB_RBBSW 0x20   // receive buffer B belongs to the controller
#define EB_RBASW 0x10   // receive buffer A belongs to the controller
#define EB_XBUFSW 0x08  // transmit buffer belongs to the controller (W: send it)
#define EB_BBASW 0x04   // R: buffer B filled before buffer A

// receive buffer status byte
#define EB_STALE 0x80

#define EB_BUFSIZE 2048
#define EB_PTRMASK (EB_BUFSIZE - 1)
#define EB_MINFRAME 60
// Largest frame handed to the Lisa.  if_eb.c reads a frame into ebrbuf[EBMTU], which is 1500 bytes, so a longer
// frame would overrun it.
#define EB_MAXRXFRAME 1500

#define EB_TX_DELAY THOUSANDTH_OF_A_SECOND       // time on the wire before transmit done
#define EB_IRQ_RETRY TEN_THOUSANDTH_OF_A_SEC     // retry while the CPU masks the slot's interrupt level
#define EB_POLL_INTERVAL (THOUSANDTH_OF_A_SECOND * 10) // backend receive poll

enum eb_rxstate
{
    EB_RX_HOST = 0, // the Lisa owns the buffer and it holds no new frame
    EB_RX_ARMED,    // handed to the controller, waiting for a frame
    EB_RX_FULL      // holds a received frame; the Lisa owns it again
};

struct EtherBoxType
{
    int vianum;

    uint8 portb;  // command code on port B
    uint8 regsel; // selected register
    uint16 bbp;   // bus buffer pointer.  XBP writes load it, buffer and PROM access advance it

    uint8 actaddr[6];
    uint8 prom[6];
    uint8 rcvcmd;
    uint8 xcsr_enables;
    uint8 sysei;
    uint8 xmit_owned; // XBUFSW: a transmit is in progress
    uint8 tx_done;    // transmit finished, not yet seen through an XCSR read
    uint8 rxstate[2]; // receive buffers A and B
    uint8 rxtaken[2]; // the Lisa has read the status byte of the frame in the buffer
    uint8 b_before_a; // BBASW
    uint8 irq_signalled;

    uint8 xmtbuf[EB_BUFSIZE];
    uint8 rcvbuf[2][EB_BUFSIZE];

    XTIMER tx_done_e;   // 0 when nothing is scheduled
    XTIMER irq_check_e;
    XTIMER poll_e;

    EtherBoxBackend *backend;

    // trace of buffer data moved in one run of strobes
    int run_reg, run_write, run_count;
    uint16 run_ptr;
    uint8 run_bytes[32];

    long tx_frames, rx_frames, rx_dropped;
};

/*********************************************************************************************\
*  Trace: set LISAEM_ETHERBOX_TRACE to a file name (or 1 for ~/lisaem-etherbox-trace.log)     *
\*********************************************************************************************/

static FILE *eb_trace_f = NULL;
static int eb_trace_state = 0; // 0 not checked yet, 1 on, -1 off
static long eb_trace_lines = 0;
#define EB_TRACE_MAX_LINES 500000

static int eb_tracing(void)
{
    if (eb_trace_state == 0)
    {
        const char *e = getenv("LISAEM_ETHERBOX_TRACE");
        char path[1024];

        eb_trace_state = -1;
        if (!e || !*e || !strcmp(e, "0"))
            return 0;
        if (!strcmp(e, "1"))
            snprintf(path, sizeof(path), "%s/lisaem-etherbox-trace.log", getenv("HOME") ? getenv("HOME") : "/tmp");
        else
            snprintf(path, sizeof(path), "%s", e);
        eb_trace_f = fopen(path, "w");
        if (eb_trace_f)
            eb_trace_state = 1;
        else
            ALERT_LOG(0, "EtherBox: could not open trace file %s", path);
    }
    return eb_trace_state > 0 && eb_trace_lines < EB_TRACE_MAX_LINES;
}

static void eb_vtrace(const char *who, const char *fmt, va_list ap)
{
    fprintf(eb_trace_f, "%012llx pc:%08x %s ", (long long)cpu68k_clocks, reg68k_pc, who);
    vfprintf(eb_trace_f, fmt, ap);
    fputc('\n', eb_trace_f);
    fflush(eb_trace_f);
    if (++eb_trace_lines == EB_TRACE_MAX_LINES)
        fprintf(eb_trace_f, "trace limit reached\n");
}

static void eb_trace(EtherBoxType *eb, const char *fmt, ...)
{
    va_list ap;
    char who[16];

    if (!eb_tracing())
        return;
    snprintf(who, sizeof(who), "via%d", eb->vianum);
    va_start(ap, fmt);
    eb_vtrace(who, fmt, ap);
    va_end(ap);
}

void etherbox_backend_trace(const char *fmt, ...)
{
    va_list ap;

    if (!eb_tracing())
        return;
    va_start(ap, fmt);
    eb_vtrace("backend", fmt, ap);
    va_end(ap);
}

/*********************************************************************************************\
*  Packet capture: set LISAEM_ETHERBOX_PCAP to a file name (or 1 for ~/lisaem-etherbox.pcap)  *
*  Frames the Lisa sends and frames the backend delivers, stamped with emulated time.         *
\*********************************************************************************************/

static FILE *eb_pcap_f = NULL;
static int eb_pcap_state = 0; // 0 not checked yet, 1 on, -1 off

// pcap fields are in the writer's byte order; readers tell which from the magic number
static void eb_pcap_put32(uint32 v) { fwrite(&v, 4, 1, eb_pcap_f); }
static void eb_pcap_put16(uint16 v) { fwrite(&v, 2, 1, eb_pcap_f); }

static void eb_pcap(const uint8 *frame, int len)
{
    if (eb_pcap_state == 0)
    {
        const char *e = getenv("LISAEM_ETHERBOX_PCAP");
        char path[1024];

        eb_pcap_state = -1;
        if (!e || !*e || !strcmp(e, "0"))
            return;
        if (!strcmp(e, "1"))
            snprintf(path, sizeof(path), "%s/lisaem-etherbox.pcap", getenv("HOME") ? getenv("HOME") : "/tmp");
        else
            snprintf(path, sizeof(path), "%s", e);
        eb_pcap_f = fopen(path, "wb");
        if (!eb_pcap_f)
        {
            ALERT_LOG(0, "EtherBox: could not open packet capture file %s", path);
            return;
        }
        eb_pcap_state = 1;
        eb_pcap_put32(0xa1b2c3d4); // magic, microsecond timestamps
        eb_pcap_put16(2);          // version 2.4
        eb_pcap_put16(4);
        eb_pcap_put32(0);          // time zone
        eb_pcap_put32(0);          // timestamp accuracy
        eb_pcap_put32(65535);      // snap length
        eb_pcap_put32(1);          // Ethernet
    }
    if (eb_pcap_state < 0)
        return;

    eb_pcap_put32((uint32)(cpu68k_clocks / ONE_SECOND));
    eb_pcap_put32((uint32)((cpu68k_clocks % ONE_SECOND) * 1000000 / ONE_SECOND));
    eb_pcap_put32((uint32)len);
    eb_pcap_put32((uint32)len);
    fwrite(frame, 1, len, eb_pcap_f);
    fflush(eb_pcap_f);
}

static const char *eb_regname(int r)
{
    static const char *names[16] = {"ACTADDR0", "ACTADDR1", "ACTADDR2", "ACTADDR3", "ACTADDR4", "ACTADDR5",
                                    "RCVCMD", "XCSR", "XBP_HI", "XBP_LO", "BBPCLEAR/PROM", "AUXCSR",
                                    "COLLCNTR", "XMTBUF", "RCVBUFA", "RCVBUFB"};
    return names[r & 15];
}

static int eb_is_buffer_reg(int r, int write)
{
    return r == EB_XMTBUF || r == EB_RCVBUFA || r == EB_RCVBUFB || (r == EB_PROM && !write);
}

static void eb_trace_flush_run(EtherBoxType *eb)
{
    char hex[3 * 32 + 1];
    int i, n;

    if (!eb->run_count)
        return;
    if (eb_tracing())
    {
        n = eb->run_count < 32 ? eb->run_count : 32;
        for (i = 0; i < n; i++)
            snprintf(hex + 3 * i, 4, " %02x", eb->run_bytes[i]);
        hex[3 * n] = 0;
        eb_trace(eb, "%s %s %d bytes from %03x:%s%s", eb->run_write ? "W" : "R", eb_regname(eb->run_reg), eb->run_count,
                 eb->run_ptr, hex, eb->run_count > 32 ? " ..." : "");
    }
    eb->run_count = 0;
}

static void eb_trace_data(EtherBoxType *eb, int reg, int write, uint16 ptr, uint8 data)
{
    if (eb_trace_state < 0)
        return;
    if (eb->run_count && (eb->run_reg != reg || eb->run_write != write))
        eb_trace_flush_run(eb);
    if (!eb->run_count)
    {
        eb->run_reg = reg;
        eb->run_write = write;
        eb->run_ptr = ptr;
    }
    if (eb->run_count < 32)
        eb->run_bytes[eb->run_count] = data;
    eb->run_count++;
}

static void eb_trace_frame(EtherBoxType *eb, const char *what, const uint8 *f, int len)
{
    char hex[3 * 64 + 1];
    int i, n;

    if (!eb_tracing())
        return;
    n = len < 64 ? len : 64;
    for (i = 0; i < n; i++)
        snprintf(hex + 3 * i, 4, " %02x", f[i]);
    hex[3 * n] = 0;
    if (len >= 14)
        eb_trace(eb, "%s %d bytes dst %02x:%02x:%02x:%02x:%02x:%02x src %02x:%02x:%02x:%02x:%02x:%02x type %04x:%s%s", what, len,
                 f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8], f[9], f[10], f[11], (f[12] << 8) | f[13], hex,
                 len > 64 ? " ..." : "");
    else
        eb_trace(eb, "%s %d bytes:%s", what, len, hex);
}

/*********************************************************************************************\
*  Backend with no network: transmitted frames are dropped, nothing is received.             *
\*********************************************************************************************/

static void eb_null_send(EtherBoxBackend *be, const uint8 *frame, int len)
{
    UNUSED(be);
    UNUSED(frame);
    UNUSED(len);
}

static EtherBoxBackend eb_null_backend = {"none", eb_null_send, NULL, NULL, NULL, NULL};

// LISAEM_ETHERBOX_BACKEND picks the backend: "none" (the default), "responder" or "slirp"
static EtherBoxBackend *eb_open_backend(void)
{
    const char *e = getenv("LISAEM_ETHERBOX_BACKEND");
    EtherBoxBackend *be = NULL;

    if (e && !strcmp(e, "responder"))
        be = etherbox_responder_open();
    else if (e && !strcmp(e, "slirp"))
        be = etherbox_slirp_open();
    else if (e && *e && strcmp(e, "none"))
        ALERT_LOG(0, "EtherBox: unknown backend %s, using none", e);
    return be ? be : &eb_null_backend;
}

/*********************************************************************************************\
*  Timing and interrupts                                                                     *
\*********************************************************************************************/

static void eb_schedule(EtherBoxType *eb, XTIMER *event, XTIMER delay)
{
    *event = cpu68k_clocks + (delay > 0 ? delay : 1);
    if (*event < cpu68k_clocks_stop)
    {
        cpu68k_clocks_stop = *event;
        set_next_timer_id(CYCLE_TIMER_VIAn_CA1(eb->vianum));
    }
}

// the controller's interrupt request, before the pulse on CA1
static int eb_irq_wanted(EtherBoxType *eb)
{
    return eb->sysei && ((eb->rxstate[0] == EB_RX_FULL && !eb->rxtaken[0]) ||
                         (eb->rxstate[1] == EB_RX_FULL && !eb->rxtaken[1]) || eb->tx_done);
}

// Called after anything that changes the interrupt request.  A new request is signalled from the timer, once the CPU
// takes the slot's interrupt level: if_eb.c accesses the box at spl6, and each register 1 access there would clear a
// CA1 flag latched in the meantime.
static void eb_update_irq(EtherBoxType *eb)
{
    if (!eb_irq_wanted(eb))
    {
        eb->irq_signalled = 0;
        eb->irq_check_e = 0;
        return;
    }
    if (!eb->irq_signalled && !eb->irq_check_e)
        eb_schedule(eb, &eb->irq_check_e, 1);
}

static void eb_signal_irq(EtherBoxType *eb)
{
    if (!eb_irq_wanted(eb) || eb->irq_signalled)
        return;
    if (!is_vector_available(via[eb->vianum].irqnum))
    {
        eb_schedule(eb, &eb->irq_check_e, EB_IRQ_RETRY);
        return;
    }
    eb->irq_signalled = 1;
    eb_trace(eb, "IRQ: CA1 pulse (A %d B %d tx_done %d)", eb->rxstate[0], eb->rxstate[1], eb->tx_done);
    VIAEtherBoxIRQ(eb->vianum);
}

/*********************************************************************************************\
*  Transmit and receive                                                                      *
\*********************************************************************************************/

// XBUFSW: send the transmit buffer from the bus buffer pointer to its end
static void eb_transmit(EtherBoxType *eb)
{
    int start = eb->bbp & EB_PTRMASK;
    int len = EB_BUFSIZE - start;

    eb_trace_frame(eb, "TX", eb->xmtbuf + start, len);
    if (len >= 14)
    {
        eb_pcap(eb->xmtbuf + start, len);
        eb->backend->send(eb->backend, eb->xmtbuf + start, len);
        eb->tx_frames++;
    }
    eb->xmit_owned = 1;
    eb->tx_done = 0;
    eb_schedule(eb, &eb->tx_done_e, EB_TX_DELAY);
}

static int eb_accepts(EtherBoxType *eb, const uint8 *f)
{
    static const uint8 broadcast[6] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};

    if (eb->rcvcmd & EB_PROMIS)
        return 1;
    if (eb->rcvcmd & EB_STABROAD)
        return !memcmp(f, eb->actaddr, 6) || !memcmp(f, broadcast, 6);
    return 0;
}

// Put a frame from the network into an armed receive buffer.  Returns 0 if no buffer is free to take it.
static int eb_receive(EtherBoxType *eb, const uint8 *frame, int len)
{
    int b, endoff;
    uint8 *buf;

    if (len < 14 || len > EB_MAXRXFRAME || !eb_accepts(eb, frame))
    {
        eb_trace_frame(eb, "RX dropped (length or address filter)", frame, len);
        eb->rx_dropped++;
        return 1;
    }

    if (eb->rxstate[0] == EB_RX_ARMED)
        b = 0;
    else if (eb->rxstate[1] == EB_RX_ARMED)
        b = 1;
    else
        return 0;

    buf = eb->rcvbuf[b];
    if (len < EB_MINFRAME)
    {
        memset(buf + 2, 0, EB_MINFRAME);
        memcpy(buf + 2, frame, len);
        len = EB_MINFRAME;
    }
    else
        memcpy(buf + 2, frame, len);

    // status byte (no errors, high bits of the end offset), then the low byte of the end offset
    endoff = len + 2;
    buf[0] = (endoff >> 8) & 7;
    buf[1] = endoff & 0xff;

    if (b == 1)
        eb->b_before_a = (eb->rxstate[0] != EB_RX_FULL);
    else if (eb->rxstate[1] != EB_RX_FULL)
        eb->b_before_a = 0;
    eb->rxstate[b] = EB_RX_FULL;
    eb->rxtaken[b] = 0;
    eb->rx_frames++;

    eb_trace_frame(eb, b ? "RX into buffer B" : "RX into buffer A", buf + 2, len);
    eb_update_irq(eb);
    return 1;
}

static void eb_poll_backend(EtherBoxType *eb)
{
    uint8 frame[EB_BUFSIZE];
    int len;

    if (!eb->backend->recv)
        return;
    // Take frames only while a buffer is armed and interrupts are on, and only while the CPU would take the box's
    // interrupt.  if_eb.c talks to the box at spl6 or from its interrupt handler, and ebintr reads AUXCSR then writes
    // the switch bits back: a frame landing in between would be thrown away.
    if (!is_vector_available(via[eb->vianum].irqnum))
        return;
    while (eb->sysei && (eb->rxstate[0] == EB_RX_ARMED || eb->rxstate[1] == EB_RX_ARMED))
    {
        len = eb->backend->recv(eb->backend, frame, sizeof(frame));
        if (len <= 0)
            break;
        eb_pcap(frame, len);
        eb_receive(eb, frame, len);
    }
}

/*********************************************************************************************\
*  Register access                                                                           *
\*********************************************************************************************/

// A buffer's switch bit reads 1 while it is armed, and also once the Lisa has read the status byte of the frame in
// it.  The second part is not known hardware behaviour.  ebintr() reads AUXCSR again after handling a frame and starts
// over if anything changed; handling a frame often transmits (an ARP reply, a TCP ack), which changes XBUFSW, and the
// driver only re-arms buffers at the end.  With a plain switch bit the frame would be read and handled again for each
// change.
static uint8 eb_read_aux(EtherBoxType *eb)
{
    int a = eb->rxstate[0] == EB_RX_ARMED || (eb->rxstate[0] == EB_RX_FULL && eb->rxtaken[0]);
    int b = eb->rxstate[1] == EB_RX_ARMED || (eb->rxstate[1] == EB_RX_FULL && eb->rxtaken[1]);

    return EB_XCVRUP | (eb->sysei ? EB_SYSEI : 0) | (b ? EB_RBBSW : 0) | (a ? EB_RBASW : 0) |
           (eb->xmit_owned ? EB_XBUFSW : 0) | (eb->b_before_a ? EB_BBASW : 0);
}

static void eb_write_aux(EtherBoxType *eb, uint8 data)
{
    if (data & EB_EDLCRES)
        eb_trace(eb, "controller reset");

    eb->sysei = !!(data & EB_SYSEI);

    // a 1 hands a buffer to the controller, a 0 leaves it alone.  Until a frame lands, the buffer's status byte
    // says stale.
    for (int b = 0; b < 2; b++)
    {
        if (!(data & (b ? EB_RBBSW : EB_RBASW)))
            continue;
        if (eb->rxstate[b] == EB_RX_FULL && !eb->rxtaken[b])
        {
            eb_trace(eb, "frame in buffer %c discarded: re-armed before it was read", b ? 'B' : 'A');
            eb->rx_dropped++;
        }
        eb->rxstate[b] = EB_RX_ARMED;
        eb->rcvbuf[b][0] = EB_STALE;
    }
    if ((data & EB_XBUFSW) && !eb->xmit_owned)
        eb_transmit(eb);

    eb_update_irq(eb);
}

static uint8 eb_register_read(EtherBoxType *eb, int advance)
{
    int r = eb->regsel;
    uint8 v;
    uint16 ptr = eb->bbp;

    switch (r)
    {
    case EB_RCVCMD:
        v = eb->rcvcmd;
        break;
    case EB_XCSR:
        v = eb->xmit_owned ? 0 : EB_XREADY; // never collisions or underflow
        if (advance && eb->tx_done)
        {
            eb->tx_done = 0;
            eb_update_irq(eb);
        }
        break;
    case EB_XBP_HI:
        v = (eb->bbp >> 8) & 7;
        break;
    case EB_XBP_LO:
        v = eb->bbp & 0xff;
        break;
    case EB_PROM:
        v = (eb->bbp < 6) ? eb->prom[eb->bbp] : 0;
        break;
    case EB_AUXCSR:
        v = eb_read_aux(eb);
        break;
    case EB_COLLCNTR:
        v = 0;
        break;
    case EB_XMTBUF:
        v = eb->xmtbuf[eb->bbp];
        break;
    case EB_RCVBUFA:
    case EB_RCVBUFB:
        v = eb->rcvbuf[r - EB_RCVBUFA][eb->bbp];
        if (advance && eb->bbp == 0 && eb->rxstate[r - EB_RCVBUFA] == EB_RX_FULL)
        {
            eb->rxtaken[r - EB_RCVBUFA] = 1;
            eb_update_irq(eb);
        }
        break;
    default: // ACTADDR0-5
        v = eb->actaddr[r];
        break;
    }

    if (advance)
    {
        if (eb_is_buffer_reg(r, 0))
        {
            eb->bbp = (eb->bbp + 1) & EB_PTRMASK;
            eb_trace_data(eb, r, 0, ptr, v);
        }
        else
        {
            eb_trace_flush_run(eb);
            eb_trace(eb, "R %s = %02x", eb_regname(r), v);
        }
    }
    return v;
}

static void eb_register_write(EtherBoxType *eb, uint8 data)
{
    int r = eb->regsel;
    uint16 ptr = eb->bbp;

    if (eb_is_buffer_reg(r, 1))
    {
        if (r == EB_XMTBUF)
            eb->xmtbuf[eb->bbp] = data;
        else
            eb->rcvbuf[r - EB_RCVBUFA][eb->bbp] = data;
        eb->bbp = (eb->bbp + 1) & EB_PTRMASK;
        eb_trace_data(eb, r, 1, ptr, data);
        return;
    }

    eb_trace_flush_run(eb);
    eb_trace(eb, "W %s = %02x", eb_regname(r), data);

    switch (r)
    {
    case EB_RCVCMD:
        eb->rcvcmd = data;
        if (eb->backend->recv && !eb->poll_e)
            eb_schedule(eb, &eb->poll_e, EB_POLL_INTERVAL);
        break;
    case EB_XCSR:
        eb->xcsr_enables = data;
        break;
    case EB_XBP_HI:
        eb->bbp = (eb->bbp & 0xff) | ((data & 7) << 8);
        break;
    case EB_XBP_LO:
        eb->bbp = (eb->bbp & 0x700) | data;
        break;
    case EB_BBPCLEAR:
        eb->bbp = 0;
        break;
    case EB_AUXCSR:
        eb_write_aux(eb, data);
        break;
    case EB_COLLCNTR:
        break;
    default: // ACTADDR0-5
        eb->actaddr[r] = data;
        break;
    }
}

/*********************************************************************************************\
*  VIA side                                                                                  *
\*********************************************************************************************/

void etherbox_orb(EtherBoxType *eb, uint8 data)
{
    if (data == eb->portb)
        return;
    eb->portb = data;
    if (data != EB_PB_RC && data != EB_PB_WC && data != EB_PB_WD && data != EB_PB_RD)
    {
        eb_trace_flush_run(eb);
        eb_trace(eb, "port B %02x (not a command code)", data);
    }
}

void etherbox_ora(EtherBoxType *eb, uint8 data, int strobe)
{
    if (!strobe)
    {
        eb_trace_flush_run(eb);
        eb_trace(eb, "port A write %02x without a strobe, ignored", data);
        return;
    }

    switch (eb->portb)
    {
    case EB_PB_WC:
        eb_trace_flush_run(eb);
        eb->regsel = data & 15;
        break;
    case EB_PB_WD:
        eb_register_write(eb, data);
        break;
    default:
        eb_trace_flush_run(eb);
        eb_trace(eb, "port A write %02x with port B %02x, ignored", data, eb->portb);
        break;
    }
}

uint8 etherbox_ira(EtherBoxType *eb, int strobe)
{
    if (eb->portb != EB_PB_RD)
    {
        if (strobe)
        {
            eb_trace_flush_run(eb);
            eb_trace(eb, "port A read with port B %02x", eb->portb);
        }
        return 0xff;
    }
    return eb_register_read(eb, strobe);
}

XTIMER etherbox_next_event(EtherBoxType *eb)
{
    XTIMER e = 0;

    if (eb->tx_done_e && (!e || eb->tx_done_e < e))
        e = eb->tx_done_e;
    if (eb->irq_check_e && (!e || eb->irq_check_e < e))
        e = eb->irq_check_e;
    if (eb->poll_e && (!e || eb->poll_e < e))
        e = eb->poll_e;
    return e;
}

// run whatever is due
void etherbox_timer(EtherBoxType *eb)
{
    if (eb->tx_done_e && eb->tx_done_e <= cpu68k_clocks)
    {
        eb->tx_done_e = 0;
        eb->xmit_owned = 0;
        eb->tx_done = 1;
        eb_trace(eb, "transmit done");
        eb_update_irq(eb);
    }

    if (eb->poll_e && eb->poll_e <= cpu68k_clocks)
    {
        eb->poll_e = 0;
        if (eb->backend->poll)
            eb->backend->poll(eb->backend);
        eb_poll_backend(eb);
        eb_schedule(eb, &eb->poll_e, EB_POLL_INTERVAL);
    }

    if (eb->irq_check_e && eb->irq_check_e <= cpu68k_clocks)
    {
        eb->irq_check_e = 0;
        eb_signal_irq(eb);
    }
}

EtherBoxType *etherbox_attach(int vianum)
{
    EtherBoxType *eb = (EtherBoxType *)calloc(1, sizeof(EtherBoxType));
    static const uint8 mac[6] = {0x02, 0x60, 0x8c, 0x4c, 0x49, 0x00}; // 3Com's 02-60-8C, then "LI" and the VIA number

    if (!eb)
        return NULL;
    eb->vianum = vianum;
    memcpy(eb->prom, mac, 6);
    eb->prom[5] = (uint8)vianum;
    eb->portb = EB_PB_RC;
    eb->rcvbuf[0][0] = eb->rcvbuf[1][0] = EB_STALE;
    eb->backend = eb_open_backend();
    ALERT_LOG(0, "EtherBox attached to VIA#%d, address %02x:%02x:%02x:%02x:%02x:%02x, backend %s", vianum, eb->prom[0],
              eb->prom[1], eb->prom[2], eb->prom[3], eb->prom[4], eb->prom[5], eb->backend->name);
    eb_trace(eb, "attached, address %02x:%02x:%02x:%02x:%02x:%02x, backend %s", eb->prom[0], eb->prom[1], eb->prom[2],
             eb->prom[3], eb->prom[4], eb->prom[5], eb->backend->name);
    return eb;
}

void etherbox_detach(EtherBoxType *eb)
{
    if (!eb)
        return;
    eb_trace_flush_run(eb);
    eb_trace(eb, "detached: %ld frames sent, %ld received, %ld dropped", eb->tx_frames, eb->rx_frames, eb->rx_dropped);
    if (eb->backend->close)
        eb->backend->close(eb->backend);
    free(eb);
}
