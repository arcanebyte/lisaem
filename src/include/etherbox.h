/**************************************************************************************\
*                                                                                      *
*                     3Com EtherBox: interface to network backends                     *
*                                                                                      *
\**************************************************************************************/

#ifndef ETHERBOX_H
#define ETHERBOX_H

// The host side of an EtherBox.  send takes one Ethernet frame (no CRC) transmitted by the Lisa; recv copies the next
// frame waiting for the Lisa into frame and returns its length, or 0 when there is none.  recv may be NULL.
typedef struct EtherBoxBackend
{
    const char *name;
    void (*send)(struct EtherBoxBackend *be, const uint8 *frame, int len);
    int (*recv)(struct EtherBoxBackend *be, uint8 *frame, int maxlen);
    void (*close)(struct EtherBoxBackend *be);
    void *ctx;
} EtherBoxBackend;

// test backend: a fake host that answers ARP, ICMP echo and TCP connection attempts
extern EtherBoxBackend *etherbox_responder_open(void);

// trace line from a backend, written to the EtherBox trace when it is on
extern void etherbox_backend_trace(const char *fmt, ...);

#endif
