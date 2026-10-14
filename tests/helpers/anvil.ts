import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

export interface AnvilInstance {
  port: number;
  rpcUrl: string;
  chainId: number;
  /** JSON-RPC helper for test setup/assertions (e.g. anvil_* cheat methods). */
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  stop(): Promise<void>;
}

export async function getFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

async function rpcCall<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

export interface StartAnvilOptions {
  chainId?: number;
  mnemonic?: string;
  /** Extra CLI args. */
  args?: string[];
  timeoutMs?: number;
}

/** Starts a local anvil node on a free port and resolves once it answers eth_chainId. */
export async function startAnvil(opts: StartAnvilOptions = {}): Promise<AnvilInstance> {
  const port = await getFreePort();
  const chainId = opts.chainId ?? 31337;
  const bin = resolve(process.cwd(), 'node_modules/.bin/anvil');
  const child: ChildProcess = spawn(
    bin,
    [
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--chain-id',
      String(chainId),
      '--mnemonic',
      opts.mnemonic ?? ANVIL_MNEMONIC,
      '--silent',
      ...(opts.args ?? []),
    ],
    // Own process group so we can kill the wrapper script and the real binary together.
    { stdio: ['ignore', 'ignore', 'pipe'], detached: true },
  );
  let stderr = '';
  child.stderr?.on('data', (d) => (stderr += String(d)));
  let exited = false;
  const exitPromise = new Promise<void>((res) => child.once('exit', () => ((exited = true), res())));

  const rpcUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  for (;;) {
    if (exited) throw new Error(`anvil exited early: ${stderr}`);
    try {
      const id = await rpcCall<string>(rpcUrl, 'eth_chainId');
      if (Number(id) === chainId) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      killGroup(child);
      throw new Error(`anvil did not start within timeout: ${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    port,
    rpcUrl,
    chainId,
    rpc: (method, params) => rpcCall(rpcUrl, method, params),
    async stop() {
      if (exited) return;
      killGroup(child);
      await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 5_000))]);
      if (!exited) killGroup(child, 'SIGKILL');
    },
  };
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}
