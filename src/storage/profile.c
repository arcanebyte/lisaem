/**************************************************************************************\
*                                                                                      *
*              The Lisa Emulator Project  V1.2.7      DEV 2022.04.01                   *
*                             http://lisaem.sunder.net                                 *
*                                                                                      *
*                  Copyright (C) 1998, 2007 Ray A. Arachelian                          *
*                                All Rights Reserved                                   *
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
*           You should have received a copy of the GNU General Public License          *
*           along with this program;  if not, write to the Free Software               *
*           Foundation, Inc., 59 Temple Place #330, Boston, MA 02111-1307, USA.        *
*                                                                                      *
*                   or visit: http://www.gnu.org/licenses/gpl.html                     *
*                                                                                      *
*                                                                                      *
*                         Profile Hard Disk  Routines                                  *
*                                                                                      *
\**************************************************************************************/

#define IN_PROFILE_C

// this also includes libdc42.h
#include <vars.h>

#define PROFILE_WAIT_EXEC_CYCLE 3 // #of ProFile Loops to wait after got 55 before we return results to Lisa

#define PRO_STATUS_CLEAR     \
    {                        \
        P->DataBlock[0] = 0; \
        P->DataBlock[1] = 0; \
        P->DataBlock[2] = 0; \
        P->DataBlock[3] = 0; \
    }
#define PRO_STATUS_GOT55        \
    {                           \
        P->DataBlock[0] |= 128; \
    } // signal that I got 0x55 response
#define PRO_STATUS_NO55         \
    {                           \
        P->DataBlock[0] &= 127; \
    } // signal that I didn't
#define PRO_STATUS_BUFFER_OVERFLOW \
    {                              \
        P->DataBlock[0] |= 64;     \
    } // Lisa sent too much data
#define PRO_STATUS_FAILED     \
    {                         \
        P->DataBlock[0] |= 1; \
    } // operation failed
#define PRO_STATUS_WAS_RESET                  \
    {                                         \
        P->DataBlock[3] |= 128;               \
        P->last_reset_cpuclk = cpu68k_clocks; \
    } // profile was reset
#define PRO_INVALID_BLOCK_NO   \
    {                          \
        P->DataBlock[3] |= 64; \
    } // asked to access invalid block #

char ProFile_Spare_table[536] =
    {

        /*

           * The first 13 bytes show the device name, e.g. "PROFILE     ". Other drives are called "PROFILE 10M  " or "Widget-10   ".
           * The next three bytes hold the device number, which is $000000 for a 5MB ProFile, $000010 for a 10MB ProFile, and $001000 for a Widget 10 drive.
           * The next two bytes indicate  the firmware revision, e.g. $0398 for  3.98.
           * The next three bytes hold the total number of blocks available on the device. This is $002600 for 5MB and $004C00 for 10MB. You see, up to 8GB are possible. IDE reached its first limit at 520MB!
           * The next two bytes indicate the number of bytes per block: $0214 means 532. 532 means 512 byted user data and 20 bytes tag. This is the same format Macintosh MFS volumes and 400k/800k disks use. Send a MFS HD20SC with ST225N mechanism a read capacity command - the response will be 532 bytes per sector!
           * The next byte contains the total number of spare blocks available on the device, which is $20.
           * This is followed by the number of spare blocks currently allocated. A good drive uses less than three spares. When all these 32 blocks are allocated, the host will ask the user to call a qualified Apple Service technician for reformatting.
           * The next byte contains the number of bad blocks currently allocated. A bad block turns into a spared block during the next power-on self test.


        */

        //  0   1   2   3   4   5   6   7   8   9   a   b  c <- 13 bytes
        'P', 'R', 'O', 'F', 'I', 'L', 'E', ' ', ' ', ' ', ' ', ' ', 0, // device name
                                                                       //  d  e  f
        0, 0, 0,                                                       // 0,0,0x10-10MB ProFile                            // device #
                                                                       //  0x10,0x11
        0x03, 0x98,                                                    // ProFile firmware revsion
                                                                       //  0x12, 0x13, 0x14
        0x00, 0x26, 0x00,                                              // # of available blocks to user *play with this*
        /*20, 21 */
        0x02, 0x14,       // bytes/sector  =532
        32,               // number of spares (blocks)  byte 22
        0,                // byte 23
        0,                // byte 24
        0xFF, 0xFF, 0xFF, // byte 25,26,27
        0, 0, 0, 0,       // byte 28,29,30,31  (now we need 500 more bytes full of zeros)

        // 50 0 bytes * 10 lines = 500 bytes... for both spare and error tables. (virtual profiles are perfect!)
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 1
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 2
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 3
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 4
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 5
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 6
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 7
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 8
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 9
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0  // 10
};

/*
 * do the actual reading and writing of the blocks off the profile hard drive image file
 *
 */

void ProfileReset(ProFileType *P);
void ProfileResetOff(ProFileType *P);

// Keep stats here. They do not get reset until the emulator is restarted. 
// The stats are for ALL attached Profile drives, combined (usually there is just one).
uint32 profile_total_num_sectors_read = 0;
uint32 profile_total_num_sectors_written = 0;

#ifdef DEBUG

// This is an appender log, flush+close so that incase there's a crash, no pending data gets lost.

void dump_profile_block(FILE *f, uint8 *RAM, long sectornumber, char *text)
{
    int i, j;
    char c;

    if (!debug_log_enabled)
        return;

    fprintf(f, "%s %ld tags::", text, sectornumber);

    for (i = 0; i < 20; i++)
        fprintf(f, "%02x ", RAM[i]);

    for (i = 0; i < 512; i += 16)
    {
        fprintf(f, "\n%s %ld %04x:: ", text, sectornumber, i);

        for (j = 0; j < 16; j++)
            fprintf(f, "%02x ", RAM[20 + i + j]);

        fputc('|', f);

        for (j = 0; j < 16; j++)
        {
            c = RAM[20 + i + j];
            c &= 0x7f;
            if (c < 32)
                c |= 32;
            if (c > 125)
                c = '.';
            fputc(c, f);
        }
    }
    fputc('\n', f);
}

void dump_profile_block_to_log(uint8 *RAM, long sectornumber, char *text)
{
    FILE *f;
    int i, j;
    char c;

    return;

    f = fopen("./lisaem-output.profile", "a");
    if (!f)
        return;

    fprintf(f, "%s %ld tags::", text, sectornumber);

    for (i = 0; i < 20; i++)
        fprintf(f, "%02x ", RAM[i]);

    for (i = 0; i < 512; i += 16)
    {
        fprintf(f, "\n%s %ld %04x:: ", text, sectornumber, i);

        for (j = 0; j < 16; j++)
            fprintf(f, "%02x ", RAM[20 + i + j]);

        fputc('|', f);

        for (j = 0; j < 16; j++)
        {
            c = RAM[20 + i + j];
            c &= 0x7f;
            if (c < 32)
                c |= 32;
            if (c > 125)
                c = '.';
            fputc(c, f);
        }
    }
    fputc('\n', f);
    fclose(f);
}

void append_profile_log(int level, char *s, ...)
{
    FILE *f;
    // fprintf(buglog,s);

    if (level > DEBUGLEVEL)
        return;

    return;

    f = fopen("./lisaem-output.profile", "a");

    if (f)
    {
        va_list params;

        printlisatime(f);
        fprintf(f, "pc24:%08x ", pc24);

        va_start(params, s);
        vfprintf(f, s, params);
        va_end(params);

        if (debug_log_enabled)
        {
            printlisatime(buglog);
            fprintf(buglog, "pc24:%08x ", pc24);
            va_start(params, s);
            vfprintf(buglog, s, params);
            va_end(params);
            fprintf(buglog, "\n");
        }
        fprintf(f, "\n");
        fflush(f);
        fclose(f);
    }
}

#else

#define dump_profile_block(s...) \
    {                            \
        ;                        \
    }
#define dump_profile_block_to_log(s...) \
    {                                   \
        ;                               \
    }
#define append_profile_log(s...) \
    {                            \
        ;                        \
    }

#endif

long deinterleave5(long sector)
{
    static const int offset[] = {0, 13, 10, 7, 4, 1, 14, 11, 8, 5, 2, 15, 12, 9, 6, 3, 16, 29, 26, 23, 20, 17, 30, 27, 24, 21, 18, 31, 28, 25, 22, 19};
    return offset[sector & 31] + sector - (sector & 31);
}

void get_profile_spare_table(ProFileType *P)
{
    // copy spare table template
    DEBUG_LOG(0, "Profile spare table");
    memset(&P->DataBlock[4], 0, 536);
    memcpy(&P->DataBlock[4], ProFile_Spare_table, 512);

    P->DataBlock[0] = 0;
    P->DataBlock[1] = 0;
    P->DataBlock[2] = 0;
    P->DataBlock[3] = 0;

    // fill in profile size of this profile

    // 0x12, 0x13, 0x14
    if (P->DC42.numblocks == 0)
        P->DC42.numblocks = (P->DC42.datasizetotal / P->DC42.sectorsize);

    char a, b, c;
    switch (P->DC42.numblocks)
    {
    case 19456:
        a = '1';
        b = '0';
        c = 'M';
        break; // 10M
    case 32768:
        a = '1';
        b = '6';
        c = 'M';
        break; // 16M
    case 40960:
        a = '2';
        b = '0';
        c = 'M';
        break; // 20M
    case 65536:
        a = '3';
        b = '2';
        c = 'M';
        break; // 32M
    case 81920:
        a = '4';
        b = '0';
        c = 'M';
        break; // 40M
    case 131072:
        a = '6';
        b = '4';
        c = 'M';
        break; // 64M

    case 262144:
        a = '1';
        b = '2';
        c = '8';
        break; // 128M
    case 524288:
        a = '2';
        b = '5';
        c = '6';
        break; // 256M // 0x080000
    case 1048576:
        a = '5';
        b = '1';
        c = '2';
        break; // 512M // 0x100000
        // case 9728:
    default:
        a = ' ';
        b = ' ';
        c = ' '; // 5M
    }

    P->DataBlock[4 + 0x08] = a;
    P->DataBlock[4 + 0x09] = b;
    P->DataBlock[4 + 0x0a] = c;
    P->DataBlock[4 + 0x0b] = ' ';

    if (P->DC42.numblocks > 9728)
        P->DataBlock[4 + 0x0f] = 0x10;

    //  PROFILE 10M " $000010 or "Widget-10 " $001000

    P->DataBlock[4 + 18] = (((P->DC42.numblocks) >> 16) & 0x0000ff); // msb
    P->DataBlock[4 + 19] = (((P->DC42.numblocks) >> 8) & 0x0000ff);  // middle
    P->DataBlock[4 + 20] = (((P->DC42.numblocks)) & 0x0000ff);       // lsb

    P->indexread = 0; // reset index pointers to status
    P->indexwrite = 4;

    return;
}

void do_profile_read(ProFileType *P, uint32 block)
{
    // uint16 i,j;
    uint8 *blk;
    // #ifdef DEBUG
    uint32 oblock = block;
    // #endif

    if (!P)
    {
        ALERT_LOG(0, "ProfileType P is null!");
        return;
    } // no image is opened!
    if (!P->DC42.sectorsize)
    {
        ALERT_LOG(0, "Profile sector size is 0!");
        return;
    }

    //    if (block==0x00ffffff || block<30)
    //      ALERT_LOG(0,"Slot 1 ID:%04x, Slot 2 ID:%04x, Slot 3 ID:%04x, via:%d blk:%d",
    //             lisa_ram_safe_getword(1,0x298), lisa_ram_safe_getword(1,0x29a), lisa_ram_safe_getword(1,0x29c),P->vianum,block )

    // convert unbootable fake dual parallel card to have the proper ID.
    if (block == 0x00ffffff && (pc24 & 0x00ff0000) == 0x00fe0000 && !romless && dualparallelrom[0x30] == 0xff && dualparallelrom[0x31] == 0xff)
    {
        if (lisa_ram_safe_getbyte(1, 0x299) == 0x02)
            lisa_ram_safe_setbyte(1, 0x298, 0xe0);
        if (lisa_ram_safe_getbyte(1, 0x29b) == 0x02)
            lisa_ram_safe_setbyte(1, 0x29a, 0xe0);
        if (lisa_ram_safe_getbyte(1, 0x29d) == 0x02)
            lisa_ram_safe_setbyte(1, 0x29c, 0xe0);
    }

    if (block < 0x00f00000)
        block = deinterleave5(block);

    if (block == 0x00fffffe) // return ProfileRAM buffer contents
    {
        P->indexread = 0; // reset index pointers to status
        P->indexwrite = 4;

        dump_profile_block(buglog, &(P->DataBlock[4]), block, "read");
        dump_profile_block_to_log(&(P->DataBlock[4]), block, "read");
        return;
    }

    if (block == 0x00ffffff)
    {
        get_profile_spare_table(P);
        return;
    } // return Profile spare table

    if (P->DC42.numblocks == 0 && P->DC42.sectorsize)
        P->DC42.numblocks = (P->DC42.datasizetotal / P->DC42.sectorsize);
    if (block >= P->DC42.numblocks) // wrong block #
    {
        P->DataBlock[3] |= 64; // set status byte to block number is invalid
        P->indexread = 0;      // reset index pointers to status
        P->indexwrite = 4;
        return;
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    errno = 0;
    blk = (P->DC42).read_sector_data(&(P->DC42), block);
    profile_total_num_sectors_read++;

    if (P->DC42.retval || blk == NULL)
    {
        ALERT_LOG(0, "Read sector from blk#%d failed with error:%d %s", block, P->DC42.retval, P->DC42.errormsg);
    }

    if (blk != NULL)
        memcpy(&(P->DataBlock[4 + P->DC42.tagsize]), blk, P->DC42.datasize); // 4

    if (block == 0)
    {
        bootblockchecksum = 0;
        for (uint32 i = 0; i < P->DC42.datasize; i++)
            bootblockchecksum = ((bootblockchecksum << 1) | ((bootblockchecksum & 0x80000000) ? 1 : 0)) ^ blk[i] ^ i;
    }

    blk = (P->DC42).read_sector_tags(&(P->DC42), block);

    if (block == 0)
    {
        for (uint32 i = 0; i < P->DC42.tagsize; i++)
            bootblockchecksum = ((bootblockchecksum << 1) | ((bootblockchecksum & 0x80000000) ? 1 : 0)) ^ blk[i] ^ i;
        ALERT_LOG(0, "Bootblock checksum:%08x for %s", bootblockchecksum, P->DC42.fname);
    }

    if (P->DC42.retval || blk == NULL)
    {
        ALERT_LOG(0, "Read tags from blk#%d failed with error:%d %s", block, P->DC42.retval, P->DC42.errormsg);
    }

    if (blk != NULL)
        memcpy(&(P->DataBlock[4]), blk, P->DC42.tagsize); // 4+512

#ifdef DEBUG
    dump_profile_block(buglog, &(P->DataBlock[4]), block, "read");
#endif

    if (errno)
    {
        ALERT_LOG(0, "Error reading ProFile Image! errno: %d, State:%d,IndexWrite:%d,ProfileCommand:%d,BSY:%d,Data:%d,CMDL:%d,buffer:%2x:%2x:%2x:%2x:%2x:%2x\n",
                  errno,
                  P->indexwrite,
                  P->StateMachineStep, P->Command, P->BSYLine, P->VIA_PA, P->CMDLine,
                  P->DataBlock[4], P->DataBlock[5], P->DataBlock[6], P->DataBlock[7],
                  P->DataBlock[8], P->DataBlock[9]);
    }

    P->indexread = 0; // reset index pointers to status
    P->indexwrite = 4;
}

void do_profile_write(ProFileType *P, uint32 block)
{
    uint16 i;
#ifdef DEBUG
    uint8 *blk;
    uint32 oblock = block;
#endif

    if (!P)
    {
        ALERT_LOG(0, "Request for null profile blk=%d!", block);
        return;
    } // no image is opened!
    if (!P->DC42.sectorsize)
    {
        ALERT_LOG(0, "Profile sector size is 0!");
        return;
    }

    if (block < 0x00f00000)
        block = deinterleave5(block);

    DEBUG_LOG(0, "ProFile write request block #%ld 0x%08x deinterleaved:%ld 0x%08x\n", block, block, oblock, oblock);

    if (block == 0x00fffffe) // write ProfileRAM buffer contents
    {
        P->indexread = 0; // reset index pointers to status
        P->indexwrite = 4;
        return;
    }

    if (block == 0x00ffffff) // pretend to write ProfileRAM buffer contents
    {
        // copy spare table template

        for (i = 0; i < 532; i++)
        {
            P->DataBlock[4 + i] = ProFile_Spare_table[i];
        }

        // fill in profile size of this profile

        P->DataBlock[18] = ((P->DC42.numblocks >> 16) & 0x0000ff); // msb
        P->DataBlock[19] = ((P->DC42.numblocks >> 8) & 0x0000ff);  // middle
        P->DataBlock[20] = ((P->DC42.numblocks) & 0x0000ff);       // lsb
        P->Command = -2;                                           // is now idle
        P->indexread = 0;                                          // reset index pointers to status
        P->indexwrite = 4;

        return;
    }

    if (P->DC42.fd < 2 && !P->DC42.fh)
    {
        P->Command = -1;
        return;
    } // if the handle isn't open, disable profile.

    if (P->DC42.numblocks == 0)
        P->DC42.numblocks = (P->DC42.datasizetotal / P->DC42.sectorsize);
    if (block >= P->DC42.numblocks) // wrong block #
    {
        P->DataBlock[3] |= 64; // set status byte to block number is invalid
        P->indexread = 0;      // reset index pointers to status
        P->indexwrite = 4;
        return;
    }

    // 2007.01.25
    // P->DC42.synconwrite=1;              // Ensure data is immediately written to the disk.

    errno = 0;

    // fprintf(stderr,"ProFile write to %ld %d bytes\n",block,P->DC42.datasize);
    (P->DC42).write_sector_data(&P->DC42, block, &(P->DataBlock[4 + 6 + P->DC42.tagsize]));
    profile_total_num_sectors_written++;
    if (P->DC42.retval)
    {
        DEBUG_LOG(0, "Write sector from blk#%d failed with error:%d %s", block, P->DC42.retval, P->DC42.errormsg);
    }

    (P->DC42).write_sector_tags(&P->DC42, block, &(P->DataBlock[4 + 6]));
    if (P->DC42.retval)
    {
        DEBUG_LOG(0, "Write tags from blk#%d failed with error:%d %s", block, P->DC42.retval, P->DC42.errormsg);
    }

    // 20061223 - gprof catches the calculate checksums call that this calls to be very expensive
    // dc42_sync_to_disk(&P->DC42);

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    if (errno)
    {

        EXIT(0, 0, "Error reading ProFile Image! errno: %d, State:%d,IndexWrite:%d,ProfileCommand:%d,BSY:%d,Data:%d,CMDL:%d,buffer:%2x:%2x:%2x:%2x:%2x:%2x\n",
             errno,
             P->indexwrite,
             P->StateMachineStep, P->Command, P->BSYLine, P->VIA_PA, P->CMDLine,
             P->DataBlock[4], P->DataBlock[5], P->DataBlock[6], P->DataBlock[7],
             P->DataBlock[8], P->DataBlock[9]);
    }

    P->Command = -2;  // is now idle
    P->indexread = 0; // reset index pointers to status
    P->indexwrite = 4;
}

/******************************************************************************\
*  Reset the Profile PB7 on VIA  because we got a signal to do so or because   *
*  we just booted up.                                                          *
*                                                                              *
\******************************************************************************/

void init_Profiles(void)
{
    // ProfileReset(via[0].ProFile);         // this can be ignored since no profile lives here.
    //
    ProfileReset(via[1].ProFile);

    ProfileReset(via[2].ProFile);
    ProfileReset(via[3].ProFile);
    ProfileReset(via[4].ProFile);
    ProfileReset(via[5].ProFile);
    ProfileReset(via[6].ProFile);

    // ProFileType profiles[7]; -- no need these are attached to the VIA's, so it's via[x]->Profile. *Burp*

    profile_total_num_sectors_read = 0;
    profile_total_num_sectors_written = 0;
}

extern void update_profile_preferences_path(char *newfilename);

void profile_unmount(void)
{
    int i;

    for (i = 2; i < 9; i++)
    {
        if (via[i].ProFile)
        {
            ALERT_LOG(0, "Shutting down profile at via #%d for shutdown/reboot. dc42:%p", i, via[i].ProFile->DC42);
            if ((&via[i].ProFile->DC42)->close_image) // ensure function pointer is valid before calling it
                (&via[i].ProFile->DC42)->close_image(&via[i].ProFile->DC42);
        }
    }
}

int profile_mount(char *filename, ProFileType *P)
{
    int i;
    int file_name_len = strlen(filename);

    // Open the profile - if it doesn't exist, create it.
    // 9728+1 - 5mb profile + space for spare table at -1.

    ALERT_LOG(0, "Attempting to open profile file name:%s", filename);
#ifndef __MSVCRT__
    i = dc42_open(&P->DC42, filename, "wb"); // On non-windows platforms: w=open in read/write mode, b=make best choice for mmapped I/O or RAM
#else
    i = dc42_open(&P->DC42, filename, "wn"); // On win32 platforms: w=open in read/write mode, n=never use mmapped I/O, nor RAM (actually it uses just 532 bytes of F->RAM, to read 1 sector at a time).
#endif
    
    if (i == -6)
    {
        // could not open, likely file does not exist. Prompt user to create a new profile image and ask what size .
        int sz;
        int blocks[] = {9728, 19456, 32768, 40960, 65536, 81920, 131072};
        //               0     1     2     3     4     5     6
        //              5M   10M   16M   20M   32M   40M    64M

        ALERT_LOG(0, "Call to dc42_open open returned error -6 (most likely the file was not found); the error message is:%s . Now asking user what size new file to create ...", P->DC42.errormsg);
        sz = pickprofilesize(filename, 1);
        if (sz < -1 || sz > 6)
            return -1;

        if (sz == -1)
        {
            ALERT_LOG(0, "User chose to select an existing profile instead");
            update_profile_preferences_path(filename);
            i = dc42_open(&P->DC42, filename, "wm");
            if (i)
            {
                ALERT_LOG(0, "Failed to open existing ProFile drive after user selected it!");
                messagebox(P->DC42.errormsg, "File Error");
            }
            return (i ? -1 : 0);
        }

        // Create the new empty profile image file:
        i = dc42_create(filename, "-lisaem.sunder.net hd-", blocks[sz] * 512, blocks[sz] * 20);
        i = dc42_open(&P->DC42, filename, "wm");
        if (i)
        {
            ALERT_LOG(0, "Failed to open newly created ProFile drive!");
            messagebox("Could not open the new ProFile image file!", "File Error");
            return -1;
        }
    } 
    else if (i)
    {
        // We got an error, most-likely error 88, which means that the file is not in valid dc42 format.
        // Now open it as a raw profile image file.
        // Note: there is no way to validate here if the file is a valid raw profile image file. It if boots up, then it is.
        // No popup here: profile_mount() runs at every startup and on every prefs Apply, so warning
        // here would nag on each one. The user is told once, when they pick the image, by
        // LisaConfigFrame::set_profile_path_checked(). A real failure below still reports itself.
        ALERT_LOG(0, "dc42_open() of file name %s returned error %d, the error message is:%s. Now will open the file in raw profile format ...", filename, i, P->DC42.errormsg);
        (void)file_name_len;

#ifndef __MSVCRT__
        i = raw_profile_image_open(&P->DC42, filename, "wb");
#else
        i = raw_profile_image_open(&P->DC42, filename, "wn"); // win32        
#endif 
        if (i) {
            messagebox(P->DC42.errormsg, "File Error");
            return -1;
        }
    }
    ALERT_LOG(0, "Profile image %s opened successfully. Returning 0.", filename);
    return 0;
}

void ProfileResetOff(ProFileType *P)
{
    P->last_reset_cpuclk = -1;
}

void ProfileReset(ProFileType *P)
{
    if (!P)
        return;

    P->DataBlock[0] = 0;
    P->DataBlock[1] = 0;
    PRO_STATUS_WAS_RESET;
    P->DataBlock[3] = 0;

    // reset state machine

    P->Command = -2;         // is now idle
    P->StateMachineStep = 0; // no step, just idle
    P->CMDLine = 0;
    P->BSYLine = 0; // not busy
    P->DENLine = 1;
    P->RRWLine = 0;
    P->VIA_PA = 1; // must always be 1 when ProFile is ready.
    P->clock_e = 0;
    P->last_cmd = 1;
    P->reply = 0;
    // DEBUG_LOG(0,"PROFILE RESET - ACK  01   tag:via2_ora");
    // append_profile_log(0,"PROFILE RESET - ACK  01   tag:via2_ora");

    // if (cpu68k_clocks>1000 && !debug_log_enabled)  { debug_on("profile-reset"); debug_log_enabled=1; }

    // reset buffer pointers

    P->indexread = 0; // reset index pointers to data
    P->indexwrite = 4;

    P->blocktowrite = 0;

    P->last_a_accs = 0;
    P->last_reset_cpuclk = 0;

    memset(P->DataBlock, 0, 542);
}

/*
 *
 * this gets called by the VIA code.  Via code passes pointer to profile structure AND
 * sets the event (see PROLOOP_EV_* below).
//      uint8   CMDLine;                // set by Lisa    1 = /CMD asserted (low)
//      uint8   BSYLine;                // set by ProFile 1 = /BSY asserted (low, drive busy)
//      uint8   DENLine;                // set by Lisa (drive enabled)
//      uint8   RRWLine;                // set by Lisa (read or write)
//
//      uint8   VIA_PA;                 // data to from VIA PortA (copied to/from V->via[0])
 *
 * The drive follows the ProFile protocol (Apple "ProFile HD Communications Protocol", and the
 * ESProFile and Cameo/Aphid drive implementations):
 *
 *   Lisa lowers /CMD                     drive puts a reply byte on the bus and lowers /BSY
 *   Lisa writes $55 and raises /CMD      drive samples the bus when /CMD rises; if it is $55 the
 *                                        drive stays busy for a while, then raises /BSY once
 *
 * The reply byte says what happens after the busy period: $01 = accept the 6 byte command
 * block, $02 = send status+tags+data of the block read, $03/$04 = accept tags+data to write,
 * $06 = do the write and send status.  While waiting for the Lisa the drive keeps /BSY high,
 * and it has no timeouts: it waits for /CMD for as long as it takes.  Bytes move one per
 * /PSTRB pulse.  The rising edge of /BSY is what a Lisa driver sees as the CA1 interrupt.
 *
 * VIAProfileLoop() in via6522.c turns /BSY edges into CA1 flags, and irq.c calls this with a
 * null event when clock_e (the end of a busy period) comes due.
 */

// Macros to make the code a lot more readable/maintainable

// these are why the profile loop was called
#define PROLOOP_EV_IRB 0 // event=0 <- Read from IRB
#define PROLOOP_EV_IRA 1 // event=1 <- Read from IRA
#define PROLOOP_EV_ORA 2 // event=2 <- write to ORA
#define PROLOOP_EV_ORB 3 // event=3 <- write to ORB
#define PROLOOP_EV_NUL 4 // event=4 <- null event - called occasionally by event handling to allow timeouts

#define EVENT_READ_IRB (event == PROLOOP_EV_IRB)
#define EVENT_READ_IRA (event == PROLOOP_EV_IRA)
#define EVENT_WRITE_ORA (event == PROLOOP_EV_ORA)
#define EVENT_WRITE_ORB (event == PROLOOP_EV_ORB)
#define EVENT_WRITE_NUL (event == PROLOOP_EV_NUL)
#define EVENT_STROBE (event == PROLOOP_EV_STROBE)
#define EVENT_NOSTROBE (event == PROLOOP_EV_IRA_NOSTROBE || event == PROLOOP_EV_ORA_NOSTROBE)

char *profile_event_names[8] =
    {
        "read IRB",
        "read IRA",
        "write ORA",
        "write ORB",
        "write NUL",
        "read IRA no strobe",
        "write ORA no strobe",
        "PCR strobe"};

// How long the drive stays busy.  A real ProFile takes milliseconds to seek and read or write;
// these only need to outlast the few instructions a Lisa driver runs after raising /CMD, so that
// the /BSY rising edge (CA1 interrupt) comes after it has returned.
#define PROFILE_HANDSHAKE_DELAY TEN_THOUSANDTH_OF_A_SEC // before accepting the command block or write data
#define PROFILE_RW_DELAY THOUSANDTH_OF_A_SECOND         // to read or write a block

#define PROFILE_LAST_BYTE 541 // highest DataBlock index a transfer may use (4 status + 6 cmd + 532)

// steps of ProFile state machine

#define IDLE_STATE 0                  // /BSY high, wait for Lisa to lower /CMD
#define HANDSHAKE_STATE 2             // reply byte on bus, /BSY low, wait for /CMD to rise with $55 on the bus
#define GET_CMDBLK_STATE 4            // /BSY high, accept the 6 byte command block until /CMD goes low
#define BUSY_STATE 6                  // /BSY low until clock_e, then act on P->reply
#define ACCEPT_DATA_FOR_WRITE_STATE 7 // /BSY high, accept tags+data until /CMD goes low
#define SEND_DATA_AND_TAGS_STATE 10   // /BSY high, Lisa reads status+tags+data (state # used by hle.c)
#define SEND_STATUS_BYTES_STATE 12    // /BSY high, Lisa reads status after a write (state # used by hle.c)

char *profile_state_names[] = {
    /*  0 */ "Idle",
    /*  1 */ "N/A",
    /*  2 */ "HANDSHAKE_STATE",
    /*  3 */ "N/A",
    /*  4 */ "GET_CMDBLK_STATE",
    /*  5 */ "N/A",
    /*  6 */ "BUSY_STATE",
    /*  7 */ "ACCEPT_DATA_FOR_WRITE_STATE",
    /*  8 */ "N/A",
    /*  9 */ "N/A",
    /* 10 */ "SEND_DATA_AND_TAGS_STATE",
    /* 11 */ "N/A",
    /* 12 */ "SEND_STATUS_BYTES_STATE"};

extern void apply_los31_hacks(void);
extern void set_next_timer_id(uint8 x);

// Start a busy period that ends delay clocks from now; irq.c picks up clock_e as a timer event.
void profile_schedule_event(ProFileType *P, XTIMER delay)
{
    P->clock_e = cpu68k_clocks + delay;
    if (P->clock_e < cpu68k_clocks_stop)
    {
        cpu68k_clocks_stop = P->clock_e;
        set_next_timer_id(CYCLE_TIMER_VIAn_CA1(P->vianum));
    }
}

// Lisa lowered /CMD: put the reply on the bus and assert /BSY.
static void profile_reply(ProFileType *P, uint8 reply)
{
    P->reply = reply;
    P->VIA_PA = reply;
    P->BSYLine = 1;
    P->clock_e = 0;
    P->StateMachineStep = HANDSHAKE_STATE;
    DEBUG_LOG(0, "VIA:%d /CMD low - replying %02x, /BSY low", P->vianum, reply);
}

// Busy period over: do what the accepted reply called for, then raise /BSY.
static void profile_busy_done(ProFileType *P)
{
    uint32 blocknumber = (P->DataBlock[5] << 16) | (P->DataBlock[6] << 8) | (P->DataBlock[7]);

    P->clock_e = 0;

    switch (P->reply)
    {
    case 0x01: // ready for the command block
        P->indexwrite = 4;
        P->StateMachineStep = GET_CMDBLK_STATE;
        break;

    case 0x02: // read
        PRO_STATUS_CLEAR;
        DEBUG_LOG(0, "VIA:%d reading block#%d", P->vianum, blocknumber);
        do_profile_read(P, blocknumber);
        P->indexread = 0;
        P->StateMachineStep = SEND_DATA_AND_TAGS_STATE;
        break;

    case 0x03: // write, write/verify - ready for tags+data
    case 0x04:
        P->indexwrite = 10;
        P->StateMachineStep = ACCEPT_DATA_FOR_WRITE_STATE;
        break;

    case 0x06: // write the block
        DEBUG_LOG(0, "VIA:%d writing block#%d", P->vianum, blocknumber);
        do_profile_write(P, blocknumber);
        PRO_STATUS_CLEAR;
        P->indexread = 0;
        P->StateMachineStep = SEND_STATUS_BYTES_STATE;
        break;

    default: // unknown command: let the Lisa read the status
        PRO_STATUS_CLEAR;
        P->indexread = 0;
        P->StateMachineStep = SEND_STATUS_BYTES_STATE;
        break;
    }

    P->VIA_PA = P->DataBlock[P->indexread];
    P->BSYLine = 0;
    DEBUG_LOG(0, "VIA:%d busy done after reply %02x - /BSY high, state:%s", P->vianum, P->reply, profile_state_names[P->StateMachineStep]);
}

void ProfileLoop(ProFileType *P, int event)
{
    static int nostrobe_warned = 0;

    if (!(profile_power & (1 << (P->vianum - 2))))
        return;

    if (!P->DENLine)
    {
        DEBUG_LOG(0, "DEN is disabled on via#%d- ignoring ProFile commands", P->vianum);
        return;
    } // Drive Enabled is off (active low 0=enabled, 1=disable profile)

#ifdef DEBUG
    if (!EVENT_WRITE_NUL)
        DEBUG_LOG(0, "ProFile access at PC:%d/%08x event:%d %s state:%d %s idxr,idxw: %d,%d bsy:%d cmd:%d rrw:%d", context, reg68k_pc, event, profile_event_names[event],
                  P->StateMachineStep, profile_state_names[P->StateMachineStep], P->indexread, P->indexwrite,
                  P->BSYLine, P->CMDLine, P->RRWLine);
#endif

    // Patch the UniPlus loader's serial number check, in case it's from a BLU image.
    if (uniplus_loader_patch)
    {
        if (running_lisa_os == 0 && ((reg68k_pc & 0xffffff00) == 0x060000) && context == 1)
        {
            if (lisa_rl_ram(0x00060090) == 0x2f3c0006 && lisa_rl_ram(0x00060094) == 0x56c04eb9 && lisa_rl_ram(0x00060098) == 0x00060438)
            {
                lisa_wl_ram(0x00060090, 0x42804287);
                lisa_wl_ram(0x00060094, 0x4E714E71);
                lisa_wl_ram(0x00060098, 0x4E714E71);
                ALERT_LOG(0, "*** UniPlus Loader serial patched ****");
            }
            // uniplus serno check: sec 1 floppy or 13 profile/widget: 2f 3c 00 06 56 c0 4e b9 00 06 04 38 - JSR to SN check + push/pop
            //                                                         42 80 42 87 4E 71 4E 71 4E 71 4E 71 (CLRL D0; CLRL D7; NOP 4x)
            uniplus_loader_patch = 0; // disable check now that we've applied the patch
        }
    }
    else if (running_lisa_os != 0)
        uniplus_loader_patch = 0; // if another OS is running disable this check

    // a busy period that came due is finished before anything else is looked at
    if (P->StateMachineStep == BUSY_STATE && P->clock_e && P->clock_e <= cpu68k_clocks)
        profile_busy_done(P);

    // Writing a data byte without a strobe never reaches a real drive; if an OS does this, say so once.
    if (event == PROLOOP_EV_ORA_NOSTROBE && !nostrobe_warned &&
        (P->StateMachineStep == GET_CMDBLK_STATE || P->StateMachineStep == ACCEPT_DATA_FOR_WRITE_STATE))
    {
        ALERT_LOG(0, "VIA:%d ProFile data write without /PSTRB in state %s (register 15, or CA2 not pulse/handshake) PC:%08x - a real drive would not see this byte",
                  P->vianum, profile_state_names[P->StateMachineStep], reg68k_pc);
        nostrobe_warned = 1;
    }

    switch (P->StateMachineStep)
    {

    case IDLE_STATE: // /BSY high, wait for the Lisa to lower /CMD
        P->BSYLine = 0;
        if (P->CMDLine)
        {
            apply_los31_hacks();
            // We no-longer do MacWorksXL3.0 hacks. See more at https://github.com/arcanebyte/lisaem/issues/40
            // apply_mw30_hacks_unused(); # This code was in hle.c
            profile_reply(P, 0x01);
        }
        return;

    case HANDSHAKE_STATE: // /BSY low, the drive samples the bus when /CMD rises
        P->BSYLine = 1;
        if (P->CMDLine)
            return;

        if (P->VIA_PA != 0x55)
        {
            DEBUG_LOG(0, "VIA:%d /CMD rose with %02x on the bus instead of 55 after reply %02x - back to idle", P->vianum, P->VIA_PA, P->reply);
            PRO_STATUS_NO55;
            P->StateMachineStep = IDLE_STATE;
            P->BSYLine = 0;
            return;
        }

        PRO_STATUS_GOT55;
        P->StateMachineStep = BUSY_STATE;
        profile_schedule_event(P, (P->reply == 0x02 || P->reply == 0x06) ? PROFILE_RW_DELAY : PROFILE_HANDSHAKE_DELAY);
        DEBUG_LOG(0, "VIA:%d got 55 for reply %02x - busy until %016llx", P->vianum, P->reply, P->clock_e);
        return;

    case BUSY_STATE: // /BSY low until clock_e
        P->BSYLine = 1;
        return;

    case GET_CMDBLK_STATE:            // /BSY high, command bytes arrive one per strobe
    case ACCEPT_DATA_FOR_WRITE_STATE: // /BSY high, tags+data arrive one per strobe
        P->BSYLine = 0;
        if (P->CMDLine)
        {
            if (P->StateMachineStep == ACCEPT_DATA_FOR_WRITE_STATE)
            {
                DEBUG_LOG(0, "VIA:%d got %d bytes to write", P->vianum, P->indexwrite - 10);
                profile_reply(P, 0x06);
            }
            else
            {
                P->blocktowrite = (P->DataBlock[5] << 16) | (P->DataBlock[6] << 8) | (P->DataBlock[7]);
                DEBUG_LOG(0, "VIA:%d command %02x block#%d", P->vianum, P->DataBlock[4], P->blocktowrite);
                profile_reply(P, P->DataBlock[4] + 2);
            }
            return;
        }

        if (EVENT_WRITE_ORA || EVENT_STROBE)
        {
            if (P->indexwrite > PROFILE_LAST_BYTE)
            {
                PRO_STATUS_BUFFER_OVERFLOW;
                DEBUG_LOG(0, "VIA:%d ProFile buffer overrun, dropping %02x", P->vianum, P->VIA_PA);
                return;
            }
            DEBUG_LOG(0, "VIA:%d stored %02x at index:%d", P->vianum, P->VIA_PA, P->indexwrite);
            P->DataBlock[P->indexwrite++] = P->VIA_PA;
        }
        return;

    case SEND_DATA_AND_TAGS_STATE: // /BSY high, Lisa reads bytes one per strobe
    case SEND_STATUS_BYTES_STATE:
        P->BSYLine = 0;
        if (P->CMDLine) // next command
        {
            profile_reply(P, 0x01);
            return;
        }

        if (P->StateMachineStep == SEND_STATUS_BYTES_STATE && P->indexread > 3)
            P->indexread = 0;
        if (P->indexread > PROFILE_LAST_BYTE)
            P->indexread = 0;

        if (EVENT_READ_IRA) // byte on the bus goes to the Lisa, strobe moves to the next one
        {
            P->VIA_PA = P->DataBlock[P->indexread++];
            DEBUG_LOG(0, "VIA:%d returning %02x from index:%d", P->vianum, P->VIA_PA, P->indexread - 1);
        }
        else if (EVENT_STROBE)
        {
            P->indexread++;
            P->VIA_PA = P->DataBlock[P->indexread];
        }
        else if (event == PROLOOP_EV_IRA_NOSTROBE)
            P->VIA_PA = P->DataBlock[P->indexread];
        return;

    default:
        DEBUG_LOG(0, "Unknown ProFile state %d, returning to idle.", P->StateMachineStep);
        P->StateMachineStep = IDLE_STATE;
        P->BSYLine = 0;
        return;
    }
}

// I gotta get home, dirty,
// I haveta code.
// we gotta code all day all night
// You know it sounds right         - mc++
