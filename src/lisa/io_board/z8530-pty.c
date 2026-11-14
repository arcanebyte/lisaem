/**************************************************************************************\
*                                                                                      *
*                            The Lisa Emulator Project                                 *
*                             http://lisaem.sunder.net                                 *
*                                                                                      *
*                  Copyright © 2023-2025 by Friends of Ray Arachelian                  *
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
*           Foundation, Inc., 59 Temple Place #330, Boston, MA 02111-1307, USA.      *
*                                                                                      *
*                   or visit: http://www.gnu.org/licenses/gpl.html                     *
*                                                                                      *
*                                                                                      *
*                                                                                      *
*             Z8530 SCC Pseudo TTY (aka PTY) Functions for Lisa serial ports           *
* How it works and what it does:                                                       *
* This feature works only when running LisaEm on Linux or MacOS.                       *
* In the LisaEm File->Preferences window, go to the "ports" tab and set the "Serial B" *
* dropdown  to "PseudoTTY"; Choose a name, e.g. "/tmp/lisaem-port-b". Apply and launch.*
* Behind the scenes, it will create a new pseudo-TTY (a fake, software-based serial    *
* port on the host OS), which is named e.g. "/dev/pts/1"; it will also create          *
* a symbolic link for it named "/tmp/lisaem-port-b", so you can use it without needing *
* to figure out the actual port name.                                                  *
* Example of how to use this:                                                          *
* Boot Lisa Workshop, and from the main menu type T to launch the Terminal app         *
* (there is another T(erminal) app under File Manager, do not use that (confusing?)    *
* Make sure your connection settings are "connector=PortB, baudrate=<any value>,       *
  parity=None, handshake=None, duplex=Full".                                           *
* On the host machine, in a terminal window, type "picocom /tmp/lisaem-port-b"         *
* (you need the "picocom" application installed, e.g. "sudo apt install picocom")      *
* Now you have established a two-way serial communication between Lisa and Linux:      *
* everything you type in the Lisa Terminal window will appear in "picocom", and vice   *
* versa.                                                                               *
* Note: Lisa uses the "Carriage Return" (aka "\r", symbol 0x0D) for new lines, so when *
* you type "Enter" in the Lisa Terminal, on the Linux side you will not see a new line,*
* as that is not a new-line in Linux (is not a "Line Feed" "\n").                      *
*                                                                                      *
* Above is just an example of establishing a connection. You can do more useful stuff, *
* like launching programs on both sides to send and receive files.                     *
*                                                                                      *
* Does the baud rate need to match on both sides? No: it works well regardless of the  *
* baud rate chosen in LisaEm or in "picocom".                                          *
* What about other parameters, like "parity" and "handshake"? You can safely use       *
* parity=None and handshake=None on both sides, and there shouldn't be any data loss.  *
*                                                                                      *
* Note on buffering: if you use a program to send data from the (Linux) host machine   *
* to LisaEm, you will observe that it sends data in chunks of about 20k, then waits for*
* Lisa to fully comsume it, then sends another chunk, etc. This buffer is part of the  *
* Pseudo TTY port implementation, and cannot be changed or disabled.                   *
* Implementation detail: the host->LisaEm communicationpath does polling for data when *
* Lisa is ready to recive another byte, so that the emulator will not freeze if the    *
* host is not sending any data. However, the LisaEm->host communication path does not  *
* support polling, so if the host is not reading data from the Pseudo TTY port, LisaEm *
* may eventually block and freeze. If data loss is acceptable, the code can be modified*
* to do so instead of blocking.                                                        *
\***************************************************************************************/

#ifndef __MSVCRT__

// Somehow prevents compilation warnings.
#define _GNU_SOURCE
#define _XOPEN_SOURCE 600
#define __USE_BSD

// Required on macOS for cfmakeraw and other BSD termios functions
#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#endif

// Claude says O_NDELAY is equivalent to O_NONBLOCK on macOS systems
// Create a compatibility shim
#ifndef O_NDELAY
#define O_NDELAY O_NONBLOCK
#endif

#include <vars.h>
#include <z8530_structs.h>
#include <stdlib.h>

#include <sys/types.h>
#include <signal.h>

#include <sys/socket.h>
#include <arpa/inet.h>
#include <poll.h>
#include <sys/poll.h>
#include <netinet/in.h>

#include <fcntl.h>
#include <errno.h>

#include <termios.h>
#include <sys/select.h>
#include <sys/ioctl.h>
#include <string.h>
#include <unistd.h>

// PTY file descriptors for the two internal serial ports (0 is port B, 1 is port A)
static int fd[2]; // file descriptor
static char pty_symlink_path[2][64];

// Get the PTY slave port name into buf (e.g. "/dev/pts/9")
static void get_pty_slave_port_name(int pty_fd, char *buf, size_t buf_size)
{
  memset(buf, 0, buf_size - 1);
#ifdef __APPLE__
  char *pts = ptsname(pty_fd);
  if (pts)
    strncpy(buf, pts, buf_size - 1);
#else
  ptsname_r(pty_fd, buf, buf_size - 1);
#endif
}

// invoked from lisaem_wx.cpp
void init_pty_serial_port(int port, char *desired_pty_port_symlink_name)
{
  int i, rc;
  char pty_slave_port_name[64]; // e.g. "/dev/pts/9"

  // Clear any previous symlink path
  memset(pty_symlink_path[port], 0, 64);

  // want to always set these for PTY
  scc_r[port].s.rr0.r.tx_buffer_empty = 1;
  scc_r[port].s.rr0.r.dcd = 1;
  scc_r[port].s.rr0.r.cts = 1;

  DEBUG_LOG(0, "openpt");
  fd[port] = posix_openpt(O_RDWR | O_NONBLOCK | O_NDELAY);
  if (fd[port] < 0)
  {
    fprintf(stderr, "Error %d on posix_openpt()\n", errno);
    return;
  }
  DEBUG_LOG(0, "grantpt");
  rc = grantpt(fd[port]);
  if (rc != 0)
  {
    fprintf(stderr, "Error %d on grantpt()\n", errno);
    return;
  }
  DEBUG_LOG(0, "unlockpt");
  rc = unlockpt(fd[port]);
  if (rc != 0)
  {
    fprintf(stderr, "Error %d on unlockpt()\n", errno);
    return;
  }

  // Get the pty slave port name into ptyname, it is e.g. "/dev/pts/9"
  get_pty_slave_port_name(fd[port], pty_slave_port_name, sizeof(pty_slave_port_name));

  // Configure the PTY slave side (the end that the external program connects to)
  // into raw mode so bytes pass through without any transformation or buffering.
  int slave_fd = open(pty_slave_port_name, O_RDWR | O_NOCTTY);
  if (slave_fd >= 0)
  {
    struct termios tty_attr;
    if (tcgetattr(slave_fd, &tty_attr) == 0)
    {
      // Start with raw mode - disables all canonical line buffering
      cfmakeraw(&tty_attr);

      // Explicitly disable features that can cause data loss:
      tty_attr.c_lflag &= ~(ECHO | ECHONL | ICANON | IEXTEN | ISIG);
      tty_attr.c_iflag &= ~(ICRNL | INLCR | IGNCR | IXON | IXOFF);

      // Disable software flow control (XON/XOFF) which can interfere with binary data
#ifdef IXANY
      tty_attr.c_iflag &= ~IXANY;
#endif

      tcsetattr(slave_fd, TCSANOW, &tty_attr);
      fprintf(stdout, "PTY slave port %s configured in raw mode (no canonical buffering)\n", pty_slave_port_name);
    }
    else
    {
      fprintf(stderr, "Warning: tcgetattr failed on slave PTY: %s\n", strerror(errno));
    }

    close(slave_fd);
  }
  else
  {
    fprintf(stderr, "Warning: Could not open PTY slave '%s': %s\n", pty_slave_port_name, strerror(errno));
  }

  // Configure PTY MASTER side into raw mode as well.
  // Raw mode on the master ensures bytes flow through immediately without any
  // canonical buffering, signal processing, or character translation on either direction (RX/TX).
  struct termios master_attr;
  if (tcgetattr(fd[port], &master_attr) == 0)
  {
    cfmakeraw(&master_attr);

    // Explicitly disable all buffering and flow control:
    // Input: no CR->NL mapping, no software flow control (XON/XOFF)
    master_attr.c_iflag &= ~(ICRNL | INLCR | IGNCR | IXON | IXOFF);
#ifdef IXANY
    master_attr.c_iflag &= ~IXANY;
#endif
    // Output: no NL->CR mapping
    master_attr.c_oflag &= ~(OPOST | ONLCR);
    // Local: no canonical mode, no echo, no signals
    master_attr.c_lflag &= ~(ECHO | ECHONL | ICANON | IEXTEN | ISIG);

    tcsetattr(fd[port], TCSANOW, &master_attr);
    fprintf(stdout, "PTY master configured in raw mode (no buffering on RX/TX)\n");
  }
  else
  {
    fprintf(stderr, "Warning: tcgetattr failed on master PTY fd %d: %s\n", fd[port], strerror(errno));
  }
  // Make the master side non-blocking for reads and writes.
  fcntl(fd[port], F_SETFL, O_NONBLOCK | O_NDELAY);

  // Create a symbolic link to the PTY with the user-provided alias
  if (strlen(desired_pty_port_symlink_name) > 0)
  {
    strncpy(pty_symlink_path[port], desired_pty_port_symlink_name, 63);
    // Unlink any old symlink first
    unlink(desired_pty_port_symlink_name);
    // Note: this creates a symbolic link in your Linux file system (same as the "ln -s ..." Linux command).
    // It will remain there, once LisaEm exits.
    if (symlink(pty_slave_port_name, desired_pty_port_symlink_name) == -1)
    {
      fprintf(stdout, "Warning: could not create symlink '%s' -> '%s'. Error: %s\n", desired_pty_port_symlink_name, pty_slave_port_name, strerror(errno));
    }
    else
    {
      fprintf(stdout, "Created symlink: %s -> %s\n", desired_pty_port_symlink_name, pty_slave_port_name);
    }
  }
  else
  {
    fprintf(stdout, "The desired_pty_port_symlink_name is empty. Will not create a symlink for %s.\n", pty_slave_port_name);
  }
}

int poll_pty_serial_read(int port)
{
  int rc;
  fd_set fd_in;

  FD_ZERO(&fd_in);
  FD_SET(fd[port], &fd_in);
  struct timeval tmo;
  tmo.tv_sec = 0;
  tmo.tv_usec = 1;
  // tmo.tv_nsec=1;
  rc = select(fd[port] + 1, &fd_in, NULL, NULL, &tmo);
  if (rc < 0)
  {
    DEBUG_LOG(0, "got rc %d error from poll on port %d", rc, port); //[cite: 1]
    return 0;
  }

  // Ensure we only return true if the specific PTY fd is ready
  return FD_ISSET(fd[port], &fd_in);
}

// Invoked from z8530.c. Returns 0..255 or -1 (no data available).
int read_serial_port_pty(int port)
{
  // Without this poll() check, the read() call below can block if no data is available, which would freeze LisaEm.
  if (poll_pty_serial_read(port) > 0)
  {
    unsigned char data;
    int num_bytes_read = read(fd[port], &data, 1);
    if (num_bytes_read == 1)
    {
      DEBUG_LOG(0, "Received %c (%d) on serial port %d", data, data, port);
      return data;
    }
    else if (num_bytes_read == 0)
    {
      DEBUG_LOG(0, "Received EOF on serial port %d", port);
      return -1;
    }
    else
    {
      DEBUG_LOG(0, "Got %d error reading from serial port %d", num_bytes_read, port);
      return -1;
    }
  }

  return -1;
}

// Invoked from z8530.c
int write_serial_port_pty(int port, uint8 data)
{
  DEBUG_LOG(0, "Sending out %c (%d) to serial port %d", data, data, port);

  // The master fd is O_NONBLOCK, and a PTY's kernel-side buffer is small.
  // If the reader on the other end (e.g. "picocom") isn't draining fast
  // enough, write() returns -1/EAGAIN. Rather than dropping the byte
  // or queueing it in software, we just wait here until the
  // kernel says the fd is writable again, then write. This stalls the
  // emulator loop while the host side catches up, but guarantees nothing
  // written by the Lisa is ever lost.
  for (;;)
  {
    ssize_t n = write(fd[port], &data, 1);
    if (n == 1)
    {
      return 1;
    }

    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR))
    {
      fd_set fd_out;
      FD_ZERO(&fd_out);
      FD_SET(fd[port], &fd_out);
      // No timeout: block here until the host side has drained enough
      // room for another byte.
      select(fd[port] + 1, NULL, &fd_out, NULL, NULL);
      continue;
    }

    // A real error (not just "try again later").
    fprintf(stdout, "Got %zd error writing to serial port %d (errno %d)\n", n, port, errno);
    return n;
  }
}

// Invoked from z8530.c
void set_dtr_pty(unsigned int port, uint8 value)
{
  DEBUG_LOG(0, "Set PTY DTR on port %d to %d, looping back to DCD", port, value);
  scc_r[port].s.rr0.r.dcd = value;
}

#endif
