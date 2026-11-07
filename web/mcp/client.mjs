// A minimal MCP stdio client, for tests and experiments: spawns the server and speaks JSON-RPC to it.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function startServer(args = []) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let id = 0;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg); pending.delete(msg.id);
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const i = ++id; pending.set(i, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  });
  return {
    rpc,
    notify: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    raw: (s) => child.stdin.write(s + '\n'),
    async init() {
      const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return r.result;
    },
    async call(name, args = {}) { const r = await rpc('tools/call', { name, arguments: args }); if (r.error) throw new Error(JSON.stringify(r.error)); return r.result; },
    close() { child.stdin.end(); child.kill(); },
  };
}
export const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
