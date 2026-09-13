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
*                     3Com EtherBox backend: libslirp user-mode NAT                    *
*                                                                                      *
*   Gives the Lisa a private network inside LisaEm, the way QEMU's user networking    *
*   does: no root, no host interface.  The Lisa's TCP and UDP leave as ordinary host   *
*   sockets, and port forwards let host programs connect to the Lisa.                  *
*                                                                                      *
*   Settings, from the environment for now:                                            *
*     LISAEM_ETHERBOX_SLIRP_NET  network, /24 (default 10.0.2.0).  The host (the Mac)  *
*                                is .2, DNS .3.                                        *
*     LISAEM_ETHERBOX_GUEST      the Lisa's address, for port forwards (default .15)   *
*     LISAEM_ETHERBOX_HOSTFWD    port forwards from the host's loopback address to     *
*                                the Lisa, comma separated: tcp:5000:5000,udp:7:7      *
*                                                                                      *
\**************************************************************************************/

#include <vars.h>
#include <etherbox.h>

#ifndef HAVE_LIBSLIRP

EtherBoxBackend *etherbox_slirp_open(void)
{
    ALERT_LOG(0, "EtherBox: this LisaEm was built without libslirp (build.sh --with-slirp)");
    etherbox_backend_trace("slirp: not built in (build.sh --with-slirp)");
    return NULL;
}

#else

#include <libslirp.h>
#include <poll.h>
#include <time.h>
#include <arpa/inet.h>

#define SL_QUEUE 128
#define SL_MAXFRAME 1514
#define SL_MAXFDS 256
#define SL_MAXTIMERS 8
// Frames longer than 1500 bytes would be dropped on the way into the Lisa (if_eb.c's receive buffer), so keep
// slirp's packets to the Lisa below that.
#define SL_GUEST_MTU 1486

typedef struct
{
    SlirpTimerCb cb;
    void *cb_opaque;
    int64_t expire_ms; // -1 when not armed
    int used;
} SlirpTimer;

typedef struct
{
    Slirp *slirp;

    uint8 frame[SL_QUEUE][SL_MAXFRAME];
    int len[SL_QUEUE];
    int head, count;
    long dropped;

    struct pollfd fds[SL_MAXFDS];
    int nfds;

    SlirpTimer timers[SL_MAXTIMERS];
} SlirpBackend;

static int64_t sl_clock_ns(void *opaque)
{
    struct timespec ts;

    UNUSED(opaque);
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

// slirp has a frame for the Lisa
static slirp_ssize_t sl_send_packet(const void *buf, size_t len, void *opaque)
{
    SlirpBackend *s = (SlirpBackend *)opaque;
    int slot;

    if (len > SL_MAXFRAME || s->count == SL_QUEUE)
    {
        if (!(s->dropped++ % 100))
            etherbox_backend_trace("slirp: frame for the Lisa dropped (%d bytes, %d queued, %ld dropped so far)", (int)len,
                                   s->count, s->dropped);
        return (slirp_ssize_t)len; // as a busy wire would; TCP retransmits
    }
    slot = (s->head + s->count) % SL_QUEUE;
    memcpy(s->frame[slot], buf, len);
    s->len[slot] = (int)len;
    s->count++;
    return (slirp_ssize_t)len;
}

static void sl_guest_error(const char *msg, void *opaque)
{
    UNUSED(opaque);
    etherbox_backend_trace("slirp: guest error: %s", msg);
}

static void *sl_timer_new(SlirpTimerCb cb, void *cb_opaque, void *opaque)
{
    SlirpBackend *s = (SlirpBackend *)opaque;
    int i;

    for (i = 0; i < SL_MAXTIMERS; i++)
        if (!s->timers[i].used)
        {
            s->timers[i].used = 1;
            s->timers[i].cb = cb;
            s->timers[i].cb_opaque = cb_opaque;
            s->timers[i].expire_ms = -1;
            return &s->timers[i];
        }
    etherbox_backend_trace("slirp: out of timers");
    return NULL;
}

static void sl_timer_free(void *timer, void *opaque)
{
    UNUSED(opaque);
    if (timer)
        ((SlirpTimer *)timer)->used = 0;
}

static void sl_timer_mod(void *timer, int64_t expire_time, void *opaque)
{
    UNUSED(opaque);
    if (timer)
        ((SlirpTimer *)timer)->expire_ms = expire_time;
}

// sockets are collected afresh on every poll, so there is nothing to keep track of
static void sl_register_poll_socket(slirp_os_socket fd, void *opaque)
{
    UNUSED(fd);
    UNUSED(opaque);
}

static void sl_notify(void *opaque) { UNUSED(opaque); }

static const SlirpCb sl_callbacks = {
    .send_packet = sl_send_packet,
    .guest_error = sl_guest_error,
    .clock_get_ns = sl_clock_ns,
    .timer_new = sl_timer_new,
    .timer_free = sl_timer_free,
    .timer_mod = sl_timer_mod,
    .notify = sl_notify,
    .register_poll_socket = sl_register_poll_socket,
    .unregister_poll_socket = sl_register_poll_socket,
};

static int sl_add_poll(slirp_os_socket fd, int events, void *opaque)
{
    SlirpBackend *s = (SlirpBackend *)opaque;
    struct pollfd *p;

    if (s->nfds == SL_MAXFDS)
        return -1;
    p = &s->fds[s->nfds];
    p->fd = fd;
    p->events = ((events & SLIRP_POLL_IN) ? POLLIN : 0) | ((events & SLIRP_POLL_OUT) ? POLLOUT : 0) |
                ((events & SLIRP_POLL_PRI) ? POLLPRI : 0);
    p->revents = 0;
    return s->nfds++;
}

static int sl_get_revents(int idx, void *opaque)
{
    SlirpBackend *s = (SlirpBackend *)opaque;
    short r;

    if (idx < 0 || idx >= s->nfds)
        return 0;
    r = s->fds[idx].revents;
    return ((r & POLLIN) ? SLIRP_POLL_IN : 0) | ((r & POLLOUT) ? SLIRP_POLL_OUT : 0) |
           ((r & POLLPRI) ? SLIRP_POLL_PRI : 0) | ((r & POLLERR) ? SLIRP_POLL_ERR : 0) |
           ((r & POLLHUP) ? SLIRP_POLL_HUP : 0);
}

// host sockets and timers, without blocking
static void sl_poll(EtherBoxBackend *be)
{
    SlirpBackend *s = (SlirpBackend *)be->ctx;
    uint32_t timeout = 0;
    int64_t now_ms;
    int i, n;

    s->nfds = 0;
    slirp_pollfds_fill_socket(s->slirp, &timeout, sl_add_poll, s);
    n = s->nfds ? poll(s->fds, s->nfds, 0) : 0;
    slirp_pollfds_poll(s->slirp, n < 0, sl_get_revents, s);

    now_ms = sl_clock_ns(NULL) / 1000000;
    for (i = 0; i < SL_MAXTIMERS; i++)
        if (s->timers[i].used && s->timers[i].expire_ms >= 0 && s->timers[i].expire_ms <= now_ms)
        {
            s->timers[i].expire_ms = -1;
            s->timers[i].cb(s->timers[i].cb_opaque);
        }
}

static void sl_send(EtherBoxBackend *be, const uint8 *frame, int len)
{
    SlirpBackend *s = (SlirpBackend *)be->ctx;

    slirp_input(s->slirp, frame, len);
}

static int sl_recv(EtherBoxBackend *be, uint8 *frame, int maxlen)
{
    SlirpBackend *s = (SlirpBackend *)be->ctx;
    int len;

    if (!s->count)
        return 0;
    len = s->len[s->head];
    if (len > maxlen)
        len = maxlen;
    memcpy(frame, s->frame[s->head], len);
    s->head = (s->head + 1) % SL_QUEUE;
    s->count--;
    return len;
}

static void sl_close(EtherBoxBackend *be)
{
    SlirpBackend *s = (SlirpBackend *)be->ctx;

    slirp_cleanup(s->slirp);
    free(s);
    free(be);
}

// "tcp:5000:5000,udp:7:7" -> port forwards from 127.0.0.1 on the host to the Lisa
static void sl_add_forwards(SlirpBackend *s, const char *spec, struct in_addr guest)
{
    char buf[1024], proto[8];
    char *item, *save = NULL;
    int hostport, guestport;
    struct in_addr loopback;
    char g[INET_ADDRSTRLEN];

    loopback.s_addr = htonl(INADDR_LOOPBACK);
    inet_ntop(AF_INET, &guest, g, sizeof(g));
    snprintf(buf, sizeof(buf), "%s", spec);
    for (item = strtok_r(buf, ", ", &save); item; item = strtok_r(NULL, ", ", &save))
    {
        if (sscanf(item, "%7[a-z]:%d:%d", proto, &hostport, &guestport) != 3 || (strcmp(proto, "tcp") && strcmp(proto, "udp")))
        {
            ALERT_LOG(0, "EtherBox: bad port forward '%s', want tcp:hostport:lisaport", item);
            continue;
        }
        if (slirp_add_hostfwd(s->slirp, !strcmp(proto, "udp"), loopback, hostport, guest, guestport) < 0)
        {
            ALERT_LOG(0, "EtherBox: could not forward %s port %d (in use?)", proto, hostport);
            etherbox_backend_trace("slirp: could not forward %s localhost:%d -> %s:%d", proto, hostport, g, guestport);
        }
        else
            etherbox_backend_trace("slirp: forwarding %s localhost:%d -> %s:%d", proto, hostport, g, guestport);
    }
}

static int sl_env_addr(const char *name, struct in_addr *a)
{
    const char *e = getenv(name);

    if (!e || !*e)
        return 0;
    if (inet_pton(AF_INET, e, a) != 1)
    {
        ALERT_LOG(0, "EtherBox: %s=%s is not an IPv4 address", name, e);
        return 0;
    }
    return 1;
}

EtherBoxBackend *etherbox_slirp_open(void)
{
    SlirpConfig cfg;
    EtherBoxBackend *be;
    SlirpBackend *s;
    uint32_t net;
    struct in_addr guest;
    char n[INET_ADDRSTRLEN], g[INET_ADDRSTRLEN];

    memset(&cfg, 0, sizeof(cfg));
    cfg.version = 6; // for register_poll_socket
    cfg.in_enabled = true;
    cfg.vnetwork.s_addr = htonl(0x0a000200); // 10.0.2.0
    sl_env_addr("LISAEM_ETHERBOX_SLIRP_NET", &cfg.vnetwork);
    net = ntohl(cfg.vnetwork.s_addr) & 0xffffff00;
    cfg.vnetwork.s_addr = htonl(net);
    cfg.vnetmask.s_addr = htonl(0xffffff00);
    cfg.vhost.s_addr = htonl(net | 2);
    cfg.vnameserver.s_addr = htonl(net | 3);
    cfg.vdhcp_start.s_addr = htonl(net | 15);
    cfg.vhostname = "lisaem";
    cfg.if_mtu = SL_GUEST_MTU;
    cfg.if_mru = 1500;

    guest.s_addr = htonl(net | 15);
    sl_env_addr("LISAEM_ETHERBOX_GUEST", &guest);

    be = (EtherBoxBackend *)calloc(1, sizeof(EtherBoxBackend));
    s = (SlirpBackend *)calloc(1, sizeof(SlirpBackend));
    if (!be || !s)
    {
        free(be);
        free(s);
        return NULL;
    }
    s->slirp = slirp_new(&cfg, &sl_callbacks, s);
    if (!s->slirp)
    {
        ALERT_LOG(0, "EtherBox: slirp_new failed");
        free(be);
        free(s);
        return NULL;
    }

    be->name = "slirp";
    be->send = sl_send;
    be->recv = sl_recv;
    be->poll = sl_poll;
    be->close = sl_close;
    be->ctx = s;

    inet_ntop(AF_INET, &cfg.vnetwork, n, sizeof(n));
    inet_ntop(AF_INET, &guest, g, sizeof(g));
    etherbox_backend_trace("slirp %s: network %s/24, host .2, DNS .3, Lisa %s", slirp_version_string(), n, g);
    ALERT_LOG(0, "EtherBox: slirp %s, network %s/24, Lisa %s", slirp_version_string(), n, g);

    if (getenv("LISAEM_ETHERBOX_HOSTFWD"))
        sl_add_forwards(s, getenv("LISAEM_ETHERBOX_HOSTFWD"), guest);
    return be;
}

#endif
