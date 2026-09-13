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
*                     3Com EtherBox test backend: a fake host                          *
*                                                                                      *
*   Exercises the Lisa's receive path without a real network.  The fake host answers   *
*   for every IPv4 address except the Lisa's own:                                      *
*     - ARP requests get a reply naming the fake host's Ethernet address;              *
*     - after the first ARP reply for an address, it sends the Lisa one ICMP echo      *
*       request from that address, and traces the echo reply;                          *
*     - ICMP echo requests from the Lisa are answered;                                 *
*     - TCP segments with SYN are refused with RST+ACK, so a connect fails at once.    *
*   Checksums of what the Lisa sends are verified and traced.                          *
*                                                                                      *
\**************************************************************************************/

#include <vars.h>
#include <etherbox.h>

#define RSP_QUEUE 16
#define RSP_MAXFRAME 1514
#define RSP_KNOWN 16

typedef struct
{
    uint8 frame[RSP_QUEUE][RSP_MAXFRAME];
    int len[RSP_QUEUE];
    int head, count;
    uint8 known[RSP_KNOWN][4]; // addresses already answered by ARP, pinged once
    int nknown;
    uint16 ipid;
    uint16 echoseq;
} Responder;

static const uint8 rsp_mac[6] = {0x02, 0x00, 0x00, 0x00, 0x00, 0x01};

static uint16 get16(const uint8 *p) { return (uint16)((p[0] << 8) | p[1]); }
static void put16(uint8 *p, uint16 v)
{
    p[0] = v >> 8;
    p[1] = v & 0xff;
}

// Internet checksum over len bytes, continuing from sum
static uint32 csum_add(uint32 sum, const uint8 *p, int len)
{
    while (len > 1)
    {
        sum += get16(p);
        p += 2;
        len -= 2;
    }
    if (len)
        sum += p[0] << 8;
    return sum;
}

static uint16 csum_fold(uint32 sum)
{
    while (sum >> 16)
        sum = (sum & 0xffff) + (sum >> 16);
    return (uint16)~sum;
}

// checksum of a TCP or UDP segment with its pseudo header
static uint16 csum_transport(const uint8 *ip, const uint8 *seg, int seglen)
{
    uint8 pseudo[12];

    memcpy(pseudo, ip + 12, 8);
    pseudo[8] = 0;
    pseudo[9] = ip[9];
    put16(pseudo + 10, (uint16)seglen);
    return csum_fold(csum_add(csum_add(0, pseudo, 12), seg, seglen));
}

static void ipstr(char *s, const uint8 *a) { sprintf(s, "%d.%d.%d.%d", a[0], a[1], a[2], a[3]); }

static uint8 *rsp_new_frame(Responder *r, int len)
{
    int slot;

    if (r->count == RSP_QUEUE)
    {
        etherbox_backend_trace("responder: queue full, frame dropped");
        return NULL;
    }
    slot = (r->head + r->count) % RSP_QUEUE;
    r->len[slot] = len;
    r->count++;
    memset(r->frame[slot], 0, RSP_MAXFRAME);
    return r->frame[slot];
}

// Ethernet and IPv4 headers for a frame from the fake host; returns the start of the IP payload
static uint8 *rsp_ip_frame(Responder *r, const uint8 *dstmac, const uint8 *src, const uint8 *dst, uint8 proto, int paylen)
{
    uint8 *f = rsp_new_frame(r, 14 + 20 + paylen);
    uint8 *ip;

    if (!f)
        return NULL;
    memcpy(f, dstmac, 6);
    memcpy(f + 6, rsp_mac, 6);
    put16(f + 12, 0x0800);
    ip = f + 14;
    ip[0] = 0x45;
    put16(ip + 2, (uint16)(20 + paylen));
    put16(ip + 4, r->ipid++);
    ip[8] = 64;
    ip[9] = proto;
    memcpy(ip + 12, src, 4);
    memcpy(ip + 16, dst, 4);
    put16(ip + 10, csum_fold(csum_add(0, ip, 20)));
    return ip + 20;
}

static void rsp_send_echo_request(Responder *r, const uint8 *lisamac, const uint8 *from, const uint8 *lisaip)
{
    int i, n = 56;
    uint8 *icmp = rsp_ip_frame(r, lisamac, from, lisaip, 1, 8 + n);
    char a[16], b[16];

    if (!icmp)
        return;
    icmp[0] = 8; // echo request
    put16(icmp + 4, 0x4c49);
    put16(icmp + 6, ++r->echoseq);
    for (i = 0; i < n; i++)
        icmp[8 + i] = (uint8)i;
    put16(icmp + 2, csum_fold(csum_add(0, icmp, 8 + n)));
    ipstr(a, from);
    ipstr(b, lisaip);
    etherbox_backend_trace("responder: ICMP echo request %s -> %s seq %d", a, b, r->echoseq);
}

static void rsp_arp(Responder *r, const uint8 *f, int len)
{
    const uint8 *a = f + 14;
    uint8 *o;
    char s[16], t[16];
    int i, known = 0;

    if (len < 14 + 28 || get16(a) != 1 || get16(a + 2) != 0x0800 || a[4] != 6 || a[5] != 4)
        return;
    ipstr(s, a + 14);
    ipstr(t, a + 24);
    if (get16(a + 6) != 1)
    {
        etherbox_backend_trace("responder: ARP op %d from %s ignored", get16(a + 6), s);
        return;
    }
    if (!memcmp(a + 14, a + 24, 4))
        return; // the Lisa asking about itself

    o = rsp_new_frame(r, 14 + 28);
    if (!o)
        return;
    memcpy(o, a + 8, 6); // to the asker
    memcpy(o + 6, rsp_mac, 6);
    put16(o + 12, 0x0806);
    put16(o + 14, 1);
    put16(o + 16, 0x0800);
    o[18] = 6;
    o[19] = 4;
    put16(o + 20, 2);           // reply
    memcpy(o + 22, rsp_mac, 6); // sender: the fake host
    memcpy(o + 28, a + 24, 4);  //   with the address asked for
    memcpy(o + 32, a + 8, 6);   // target: the asker
    memcpy(o + 38, a + 14, 4);
    etherbox_backend_trace("responder: ARP who-has %s tell %s: replying %02x:%02x:%02x:%02x:%02x:%02x", t, s, rsp_mac[0],
                           rsp_mac[1], rsp_mac[2], rsp_mac[3], rsp_mac[4], rsp_mac[5]);

    for (i = 0; i < r->nknown; i++)
        if (!memcmp(r->known[i], a + 24, 4))
            known = 1;
    if (!known && r->nknown < RSP_KNOWN)
    {
        memcpy(r->known[r->nknown++], a + 24, 4);
        rsp_send_echo_request(r, a + 8, a + 24, a + 14);
    }
}

static void rsp_icmp(Responder *r, const uint8 *f, const uint8 *ip, const uint8 *icmp, int icmplen)
{
    char s[16], d[16];
    int ok = csum_fold(csum_add(0, icmp, icmplen)) == 0;
    uint8 *o;

    ipstr(s, ip + 12);
    ipstr(d, ip + 16);
    if (icmplen < 8)
        return;
    switch (icmp[0])
    {
    case 0:
        etherbox_backend_trace("responder: ICMP echo reply %s -> %s id %04x seq %d, %d bytes, checksum %s", s, d,
                               get16(icmp + 4), get16(icmp + 6), icmplen, ok ? "ok" : "BAD");
        break;
    case 8:
        etherbox_backend_trace("responder: ICMP echo request %s -> %s seq %d, checksum %s: replying", s, d, get16(icmp + 6),
                               ok ? "ok" : "BAD");
        o = rsp_ip_frame(r, f + 6, ip + 16, ip + 12, 1, icmplen);
        if (!o)
            return;
        memcpy(o, icmp, icmplen);
        o[0] = 0;
        put16(o + 2, 0);
        put16(o + 2, csum_fold(csum_add(0, o, icmplen)));
        break;
    default:
        etherbox_backend_trace("responder: ICMP type %d %s -> %s, checksum %s", icmp[0], s, d, ok ? "ok" : "BAD");
    }
}

static void rsp_tcp(Responder *r, const uint8 *f, const uint8 *ip, const uint8 *tcp, int seglen)
{
    char s[16], d[16];
    int ok, hlen, datalen;
    uint8 flags;
    uint32 seq;
    uint8 *o;

    if (seglen < 20)
        return;
    ok = csum_transport(ip, tcp, seglen) == 0;
    hlen = (tcp[12] >> 4) * 4;
    datalen = seglen - hlen;
    flags = tcp[13];
    seq = ((uint32)tcp[4] << 24) | (tcp[5] << 16) | (tcp[6] << 8) | tcp[7];
    ipstr(s, ip + 12);
    ipstr(d, ip + 16);
    etherbox_backend_trace("responder: TCP %s:%d -> %s:%d flags %02x seq %08x, %d data bytes, checksum %s", s, get16(tcp),
                           d, get16(tcp + 2), flags, seq, datalen, ok ? "ok" : "BAD");

    if ((flags & 0x04) || !(flags & 0x02)) // only answer SYN, never a RST
        return;

    seq += 1 + datalen;
    o = rsp_ip_frame(r, f + 6, ip + 16, ip + 12, 6, 20);
    if (!o)
        return;
    put16(o, get16(tcp + 2));
    put16(o + 2, get16(tcp));
    o[8] = seq >> 24; // ack
    o[9] = seq >> 16;
    o[10] = seq >> 8;
    o[11] = seq;
    o[12] = 5 << 4;
    o[13] = 0x14; // RST, ACK
    put16(o + 16, csum_transport(o - 20, o, 20));
    etherbox_backend_trace("responder: refusing the connection with RST+ACK");
}

static void rsp_send(EtherBoxBackend *be, const uint8 *f, int len)
{
    Responder *r = (Responder *)be->ctx;
    const uint8 *ip;
    int iplen, hlen;
    char s[16], d[16];

    if (len < 14)
        return;
    switch (get16(f + 12))
    {
    case 0x0806:
        rsp_arp(r, f, len);
        return;
    case 0x0800:
        break;
    default:
        etherbox_backend_trace("responder: ether type %04x ignored", get16(f + 12));
        return;
    }

    ip = f + 14;
    if (len < 14 + 20 || (ip[0] >> 4) != 4)
        return;
    hlen = (ip[0] & 15) * 4;
    iplen = get16(ip + 2); // frames from the Lisa are padded, the IP length says how much is real
    ipstr(s, ip + 12);
    ipstr(d, ip + 16);
    if (hlen < 20 || iplen < hlen || 14 + iplen > len)
    {
        etherbox_backend_trace("responder: malformed IP packet %s -> %s", s, d);
        return;
    }
    if (csum_fold(csum_add(0, ip, hlen)) != 0)
        etherbox_backend_trace("responder: IP header checksum BAD %s -> %s", s, d);
    if (memcmp(f, rsp_mac, 6))
        return; // not for the fake host (broadcast IP and the like)

    switch (ip[9])
    {
    case 1:
        rsp_icmp(r, f, ip, ip + hlen, iplen - hlen);
        break;
    case 6:
        rsp_tcp(r, f, ip, ip + hlen, iplen - hlen);
        break;
    default:
        etherbox_backend_trace("responder: IP protocol %d %s -> %s, %d bytes", ip[9], s, d, iplen);
    }
}

static int rsp_recv(EtherBoxBackend *be, uint8 *frame, int maxlen)
{
    Responder *r = (Responder *)be->ctx;
    int len;

    if (!r->count)
        return 0;
    len = r->len[r->head];
    if (len > maxlen)
        len = maxlen;
    memcpy(frame, r->frame[r->head], len);
    r->head = (r->head + 1) % RSP_QUEUE;
    r->count--;
    return len;
}

static void rsp_close(EtherBoxBackend *be)
{
    free(be->ctx);
    free(be);
}

EtherBoxBackend *etherbox_responder_open(void)
{
    EtherBoxBackend *be = (EtherBoxBackend *)calloc(1, sizeof(EtherBoxBackend));
    Responder *r = (Responder *)calloc(1, sizeof(Responder));

    if (!be || !r)
    {
        free(be);
        free(r);
        return NULL;
    }
    be->name = "responder";
    be->send = rsp_send;
    be->recv = rsp_recv;
    be->poll = NULL;
    be->close = rsp_close;
    be->ctx = r;
    return be;
}
