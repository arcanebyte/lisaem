/**************************************************************************************\
*                                                                                      *
*              The Lisa Emulator Project  V1.2.7      DEV 2020.12.12                   *
*                             http://lisaem.sunder.net                                 *
*                                                                                      *
*                  Copyright (C) 1998, 2020 Ray A. Arachelian                          *
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
*                                                                                      *
*                          Z8530 SCC telnetd Functions for                             *
*                            Lisa serial ports                                         *
\**************************************************************************************/

#ifdef __MSVCRT__
// Windows: Winsock has to come before anything that might include <windows.h>.
#include <winsock2.h>
#endif

#include <vars.h>
#include <z8530_structs.h>

#ifndef __MSVCRT__
#include <sys/socket.h>
#include <arpa/inet.h>
#include <poll.h>
#include <sys/poll.h>
#include <netinet/in.h>

#ifndef sun
#include <err.h>
#endif

#endif

#include <unistd.h>

// The few places where Winsock differs from BSD sockets.  The wsock32 library
// that the Windows build already links provides everything used here.
#ifdef __MSVCRT__
typedef int telnet_socklen_t;
#define TELNET_CLOSE(s) closesocket(s)
#define TELNET_ERRNO ((int)WSAGetLastError())
#else
typedef socklen_t telnet_socklen_t;
#define TELNET_CLOSE(s) close(s)
#define TELNET_ERRNO errno
#endif

////////////////////////////// Telnet Server hookups  ////////////////////////////

#define MAX_SERIAL_PORTS 2
#define MAXPENDING 1 /*Max connection requests*/
#define BUFFSIZE 3   /* Telnet protocol has a max of 3 chars per block ff xx xx  */

#define MAX_SERIAL_PORTS 2 // 2 is maximum as 4 port serial port cards don't use z8530s

int port_state[MAX_SERIAL_PORTS]; // 0=waiting for connection, 1=connected, -1=telnetd not used.

///// telnetd code - unix and windows //////////////////////////////////////////////////////////////////////////////////////////

// Is there something to read on socket s: a waiting connection on a listening
// socket, or data (or the far end closing) on a connected one?  Never waits.
// Returns 1 for yes, 0 for no, -1 on error.  Windows has no poll() in wsock32,
// so it uses select() with a zero timeout, which amounts to the same thing.
static int telnet_readable(int s)
{
#ifdef __MSVCRT__
  fd_set rd;
  struct timeval tv = {0, 0};
  FD_ZERO(&rd);
  FD_SET((SOCKET)s, &rd);
  int r = select(0, &rd, NULL, NULL, &tv); // the first argument is ignored on Windows
  if (r == SOCKET_ERROR)
    return -1;
  return (r > 0) ? 1 : 0;
#else
  struct pollfd pfd;
  pfd.fd = s;
  pfd.events = (POLLIN | POLLPRI);
  pfd.revents = 0;
  int r = poll(&pfd, 1, 0);
  if (r < 0)
    return -1;
  return (r > 0 && (pfd.revents & (POLLIN | POLLPRI | POLLHUP | POLLERR))) ? 1 : 0;
#endif
}

unsigned telnet_buffer[MAX_SERIAL_PORTS][BUFFSIZE];

struct sockaddr_in telnetserver[MAX_SERIAL_PORTS],
    telnetclient[MAX_SERIAL_PORTS];

int serversock[MAX_SERIAL_PORTS],
    clientsock[MAX_SERIAL_PORTS];

// stuff to send to telnet client.
char telnethax[] = {0xff, 0xfb, 0x01, 0xff, 0xfb, 0x03, 0xff, 0xfd, 0x0f3};

int poll_telnet_serial_read(int portnum);

char read_serial_port_telnetd(unsigned int port)
{
  int c = poll_telnet_serial_read(port);
  return (c > -1) ? (char)c : 0;
}

void write_serial_port_telnetd(unsigned int port, char c)
{
  char buffer[2];
  buffer[0] = c;
  ALERT_LOG(0, "Write char %02x %c to port %d", c, (c > 31 ? c : '.'), port);
  if (port >= MAX_SERIAL_PORTS || port_state[port] != 1)
    return; // nobody connected yet: there is no client socket to send to
  send(clientsock[(unsigned)port], buffer, 1, 0); // should this be telnetserver?
}

void init_telnet_serial_port(int portnum)
{
  // this sets up the listener

  ALERT_LOG(0, "Initializing telnetd for serial port #%d", portnum);

#ifdef __MSVCRT__
  static int winsock_started = 0;
  if (!winsock_started)
  {
    WSADATA wsadata;
    if (WSAStartup(MAKEWORD(2, 2), &wsadata) != 0)
    {
      ALERT_LOG(0, "WSAStartup failed for serial port #%d - port now disabled because:%d", portnum, TELNET_ERRNO);
      port_state[portnum] = -1;
      return;
    }
    winsock_started = 1;
  }
#endif

  /*Create the TCP socket*/
  if ((serversock[portnum] = (int)socket(PF_INET, SOCK_STREAM, IPPROTO_TCP | SO_REUSEADDR)) < 0)
  {
    ALERT_LOG(0, "could not create the socket for serial port #%d - port now disabled because:%d %s", portnum, TELNET_ERRNO, strerror(TELNET_ERRNO));
    port_state[portnum] = -1;
    return;
  }

  /*Construct the server sock addr_instructure*/

  memset(&telnetserver[portnum].sin_zero, 0, 8); /*Clearstruct*/

  telnetserver[portnum].sin_family = AF_INET; /*Internet/IP*/
  // telnetserver[portnum].sin_addr.s_addr=htonl(INADDR_ANY); /*address to listen on - want 127.0.0.1 instead!!!! */
  telnetserver[portnum].sin_addr.s_addr = htonl(INADDR_LOOPBACK); // htonl(INADDR_ANY); //INADDR_LOOPBACK); /*address to listen on - want 127.0.0.1 instead!!!! */

  if (portnum)
    telnetserver[portnum].sin_port = htons(scc_a_telnet_port); /*serverport*/
  else
    telnetserver[portnum].sin_port = htons(scc_b_telnet_port); /*serverport*/

  ALERT_LOG(0, "SCC-telnetd Listening on port #%04x at address:%08x (porta:%d,portb:%d :: %04x,%04x)",
            telnetserver[portnum].sin_port,
            telnetserver[portnum].sin_addr.s_addr,
            scc_a_telnet_port, scc_b_telnet_port,
            htons(scc_a_telnet_port), htons(scc_b_telnet_port));

  /*Bind the server socket*/
  if (bind(serversock[portnum], (struct sockaddr *)&telnetserver[portnum], sizeof(telnetserver[portnum])) < 0) // could not bind to the server port, so, bye bye
  {
    ALERT_LOG(0, "Cannot bind for serial port #%d - port now disabled because:%d %s", portnum, TELNET_ERRNO, strerror(TELNET_ERRNO));
    port_state[portnum] = -1;
    return;
  }

  /*Listenonthetelnetserveret*/

  if (listen(serversock[portnum], MAXPENDING) < 0)
  {
    ALERT_LOG(0, "Cannot Listen for serial port #%d - port now disabled", portnum);
    port_state[portnum] = -1;
    return;
  }

  // if we got here, we're all set!
  ALERT_LOG(0, "Serial port socket %d now initialized and waiting for a connection\n", portnum);
  port_state[portnum] = 0;
  return;
}

// While the Lisa has yet to take the last byte, poll_telnet_serial_read() is
// not called, so a client that disconnected then went unnoticed and the port
// never took another connection.  This handles both without reading any data:
// a waiting connection is accepted, and a connected socket is peeked and
// closed only on end-of-file (or an error).  Bytes the client sent before
// closing are left for the Lisa to read.
void check_telnet_connection(int portnum)
{
  char c;
  int received;

  if (portnum < 0 || portnum >= MAX_SERIAL_PORTS)
    return;
  if (port_state[portnum] == 0)
  {
    poll_telnet_serial_read(portnum); // while listening it only accepts, it never returns data
    return;
  }
  if (port_state[portnum] != 1)
    return;
  if (telnet_readable(clientsock[portnum]) <= 0)
    return;
  if ((received = recv(clientsock[portnum], &c, 1, MSG_PEEK)) > 0)
    return; // data waiting: leave it for the Lisa

  ALERT_LOG(0, "Serial port #%d client %s while the Lisa was busy, closing client connection.  Bye bye.", portnum,
            (received == 0 ? "disconnected" : "receive failed"));
  port_state[portnum] = 0;
  TELNET_CLOSE(clientsock[portnum]);
}

// returns -1 if no data (or not connected), -2 if break detected, otherwise the data itself.
int poll_telnet_serial_read(int portnum)
{
  int pollret = 0, received = 0;
  unsigned char buffer[MAX_SERIAL_PORTS][3];

  if (portnum < 0 || portnum >= MAX_SERIAL_PORTS)
    return -1; // non existant port
  if (port_state[portnum] == -1)
    return -1; // port disabled

  if (port_state[portnum] == 0) // we're waiting for a telnet connection (LISTEN_STATE)
  {
    telnet_socklen_t clientlen = sizeof(telnetclient[portnum]);

    pollret = telnet_readable(serversock[portnum]); // we can change this to poll all ports at once, but some may already be connected.
    if (pollret == 0)
      return -1; // timeout
    if (pollret == -1)
      return -1; // error on poll

    if (pollret > 0)
    {
      /*Wait for client connection*/
      if ((clientsock[portnum] = (int)accept(serversock[portnum], (struct sockaddr *)&telnetclient[portnum], &clientlen)) < 0)
        return -1; // shit happens, rama, rama.

      ALERT_LOG(0, "Serial Port #%d Client connected:%s\n", portnum, inet_ntoa(telnetclient[portnum].sin_addr));
      port_state[portnum] = 1; // change to connected state

      // on accept, send the telnet configuration string.
      send(clientsock[portnum], telnethax, 9, 0);
      return -1; // we don't yet have any useful data from the client, so return nothing.
    }
  }

  // we're already connected, so poll for data.

  pollret = telnet_readable(clientsock[portnum]);
  if (pollret == 0)
    return -1; // timeout
  if (pollret < 0)
    return -1; // perror("got poll error doh!");

  if (pollret > 0) // we got data, or the client went away
    {

      /*Receiv emessage*/

      // One byte at a time: taking up to BUFFSIZE here and returning only the
      // first dropped the rest whenever bytes arrived together. A telnet
      // command (0xff) reads the rest of itself: its command byte, and for
      // WILL, WONT, DO and DONT (0xfb-0xfe) the option byte, which a telnet
      // client sends together, so that none of it reaches the Lisa as data.
      if ((received = recv(clientsock[portnum], (char *)buffer[portnum], 1, 0)) > 0 && buffer[portnum][0] == 0xff)
      {
        recv(clientsock[portnum], (char *)&buffer[portnum][1], 1, 0);
        if (buffer[portnum][1] >= 0xfb && buffer[portnum][1] <= 0xfe)
          recv(clientsock[portnum], (char *)&buffer[portnum][2], 1, 0);
      }
      if (received <= 0) // 0: the client closed the connection; <0: an error. Either way, disconnect.
      {
        // close this socket and go back to waiting for the next connection
        ALERT_LOG(0, "Serial port #%d client %s, closing client connection.  Bye bye.", portnum,
                  (received == 0 ? "disconnected" : "receive failed"));
        port_state[portnum] = 0;
        TELNET_CLOSE(clientsock[portnum]);
        return -1;
      }

      if (received > 0)
      {
        if (buffer[portnum][0] == 0xff) // special telnet sequence?
        {
          switch (buffer[portnum][1]) // 3=^C, 8=^H
          {
          case 0xf3:
            return -2; // printf("break\n");         break;
          case 0xf1:
            return -1; // printf("nop\n");           break;
          case 0xef:
            return -1; // printf("eor\n");           break;
          case 0xee:
            return 3; // printf("abort\n");         break;
          case 0xf4:
            return 3; // printf("interrupt process\n");     break;
          case 0xf9:
            return -1; // printf("Go ahead\n");      break;
          case 0xf8:
            return -1; // printf("Erase Line\n");        break;
          case 0xf7:
            return 8; // printf("Erase character\n");   break;
          case 0xf6:
            return -1; // printf("Are You there?\n");    break;
          case 0xf5:
            return 3; // printf("Abort Output\n");      break;

          case 0x00:
            return 0xff; // printf("sync\n"); break;  // sync or maybe 0xff itself???

          case 0xff:
            return 0xff; // maybe 0xff itself???

          default:
            return -1; // printf("unknown\n");  break;
          }
        }
        buffer[portnum][1] = 0;
        buffer[portnum][2] = 0; // clear remaining buffers
        DEBUG_LOG(0, "Got %c %02x", buffer[portnum][0], buffer[portnum][0]);

        return buffer[portnum][0];
      }
    }

  return -1; // nothing for the client to deal with
}

/////////////////////////////////////////////////////////////////////////////
