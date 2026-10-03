/* cpucheck.h -- the interface between reg68k.c and cpucheck.c (LISAEM_CPU_CHECK) */
#ifndef CPUCHECK_H
#define CPUCHECK_H

typedef struct
{
  unsigned int d[8], a[8]; /* a[7] is the active stack pointer */
  unsigned int pc, sr;
  unsigned int osp;        /* the other stack pointer: USP in supervisor mode, SSP in user */
} cc_regs;

typedef struct
{
  unsigned int addr;
  int size;
  unsigned int val;
} cc_write;

#define CC_MAXWRITES 64

extern int cc_io;
extern int cc_nwrites;
extern cc_write cc_writes[CC_MAXWRITES];

void cc_init(void);
int cc_step(const cc_regs *in, cc_regs *out);
void cc_disasm(unsigned pc, char *buf);

/* provided by reg68k.c: logical address in the current MMU context */
int cc_mem_read(unsigned addr, unsigned *val);  /* 0 and *val for RAM, else -1 */
int cc_writable(unsigned addr, int size);       /* 0 if all bytes are RAM, else -1 */

#endif
