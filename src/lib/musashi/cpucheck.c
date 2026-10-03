/**************************************************************************************\
*  cpucheck.c -- run one instruction on Musashi, for LISAEM_CPU_CHECK                  *
*                                                                                      *
*  reg68k.c gives this the 68000's state before an instruction; it runs the same       *
*  instruction on Musashi, an independent core, and hands back the state after it and  *
*  the writes it made. The writes are held here, not made: reads see them first, then  *
*  Lisa memory through cc_mem_read(), which reg68k.c provides and which fails for       *
*  anything but RAM, so I/O is never touched. reg68k.c compares the two cores.         *
*                                                                                      *
*  Musashi only ever sees this file: its m68k.h and LisaEm's vars.h are kept apart.    *
\**************************************************************************************/

#include <stddef.h>
#include "m68k.h"
#include "cpucheck.h"

int cc_io;                          /* set when the instruction reached non-RAM */
int cc_nwrites;
cc_write cc_writes[CC_MAXWRITES];

static unsigned overlay(unsigned a, int *hit)
{
  for (int i = cc_nwrites - 1; i >= 0; i--)
    for (int k = 0; k < cc_writes[i].size; k++)
      if (((cc_writes[i].addr + k) & 0xffffff) == a)
      {
        *hit = 1;
        return (cc_writes[i].val >> (8 * (cc_writes[i].size - 1 - k))) & 0xff;
      }
  *hit = 0;
  return 0;
}

static unsigned rd8(unsigned a)
{
  int hit;
  unsigned v = overlay(a & 0xffffff, &hit);
  if (hit)
    return v;
  if (cc_mem_read(a & 0xffffff, &v) != 0)
  {
    cc_io = 1;
    return 0;
  }
  return v & 0xff;
}

unsigned int m68k_read_memory_8(unsigned int a)  { return rd8(a); }
unsigned int m68k_read_memory_16(unsigned int a) { return (rd8(a) << 8) | rd8(a + 1); }
unsigned int m68k_read_memory_32(unsigned int a) { return (rd8(a) << 24) | (rd8(a + 1) << 16) | (rd8(a + 2) << 8) | rd8(a + 3); }
unsigned int m68k_read_disassembler_8(unsigned int a)  { return m68k_read_memory_8(a); }
unsigned int m68k_read_disassembler_16(unsigned int a) { return m68k_read_memory_16(a); }
unsigned int m68k_read_disassembler_32(unsigned int a) { return m68k_read_memory_32(a); }

static void wr(unsigned a, int size, unsigned v)
{
  if (cc_writable(a & 0xffffff, size) != 0)
    cc_io = 1;
  if (cc_nwrites < CC_MAXWRITES)
  {
    cc_writes[cc_nwrites].addr = a & 0xffffff;
    cc_writes[cc_nwrites].size = size;
    cc_writes[cc_nwrites].val = v;
    cc_nwrites++;
  }
  else
    cc_io = 1;                       /* too many to check: treat as unchecked */
}

void m68k_write_memory_8(unsigned int a, unsigned int v)  { wr(a, 1, v & 0xff); }
void m68k_write_memory_16(unsigned int a, unsigned int v) { wr(a, 2, v & 0xffff); }
void m68k_write_memory_32(unsigned int a, unsigned int v) { wr(a, 4, v); }

void cc_init(void)
{
  m68k_init();
  m68k_set_cpu_type(M68K_CPU_TYPE_68000);
  cc_io = 0;
  cc_nwrites = 0;
  m68k_pulse_reset();                /* reads the reset vectors; the registers are set per step */
  m68k_execute(1);                   /* the first call after a reset runs nothing */
}

/* Run the instruction at in->pc. Returns 0 if it was checkable (RAM only). */
int cc_step(const cc_regs *in, cc_regs *out)
{
  cc_io = 0;
  cc_nwrites = 0;
  m68k_set_reg(M68K_REG_SR, in->sr);
  for (int i = 0; i < 8; i++)
  {
    m68k_set_reg(M68K_REG_D0 + i, in->d[i]);
    m68k_set_reg(M68K_REG_A0 + i, in->a[i]);
  }
  m68k_set_reg((in->sr & 0x2000) ? M68K_REG_USP : M68K_REG_ISP, in->osp);
  m68k_set_reg(M68K_REG_PC, in->pc);

  m68k_execute(1);

  for (int i = 0; i < 8; i++)
  {
    out->d[i] = m68k_get_reg(NULL, M68K_REG_D0 + i);
    out->a[i] = m68k_get_reg(NULL, M68K_REG_A0 + i);
  }
  out->sr = m68k_get_reg(NULL, M68K_REG_SR);
  out->pc = m68k_get_reg(NULL, M68K_REG_PC);
  out->osp = m68k_get_reg(NULL, (out->sr & 0x2000) ? M68K_REG_USP : M68K_REG_ISP);
  return cc_io;
}

void cc_disasm(unsigned pc, char *buf)
{
  m68k_disassemble(buf, pc, M68K_CPU_TYPE_68000);
}
