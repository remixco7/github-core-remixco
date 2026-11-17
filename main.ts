// Entry lifecycle: bind an ephemeral port, register it with the trial env, then poll
// GET /done until the env reports the trial is over, and exit 0.
//
// The env lives at MAKEFUN_ENV_URL (http://store:8080 inside a trial pod). Without
// that variable there is nothing to register with, so the process exits 1 at once.
//
//   1. createApp() builds the forge server; listen(0) lets the kernel pick a free
//      port. Never bind 8080: the env owns it.
//   2. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address the
//      request came from plus N as the base URL and dials it from then on. The first
//      register wins; a 409 means another entry already registered, and this process
//      just keeps waiting like any other.
//   3. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env answers at
//      once ({"done": false} while the suite runs), so this is a poll, not a long-held
//      request. A failed or slow poll is retried with a short exponential backoff;
//      the process never exits before the env says done.
//   4. Close the server and exit 0. The harness then stops the env, which writes the
//      export the scorer reads.
//
// main.ts imports its own server and nothing else: no package, no Node built-in, no
// model call.

import { createApp } from './app.ts';

/** The env origin, with any trailing slashes stripped off. Exits 1 when unset. */
function envOrigin(): string {
  const origin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (origin === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
    process.exit(1);
  }
  return origin;
}

const ENV_URL = envOrigin();

/** How long one register or done request may run before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Backoff starts here and doubles per failed attempt, up to this ceiling. */
const BACKOFF_START_MS = 250;
const BACKOFF_CEILING_MS = 2_000;
/** The doubling stops growing after this many attempts, so the wait stays capped. */
const BACKOFF_MAX_DOUBLINGS = 8;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait after `failures` consecutive failed attempts: exponential, capped at the ceiling. */
function backoffMs(failures: number): number {
  const doublings = Math.min(failures, BACKOFF_MAX_DOUBLINGS);
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_START_MS * 2 ** doublings);
}

/**
 * A failure the retry loop must not swallow: a contract error from the env, where
 * retrying the same request would never help.
 */
class FatalEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalEnvError';
  }
}

/**
 * Run `step` until it reports success. The step returns true when its work is done
 * and false when it should be tried again after a backoff; a FatalEnvError ends the
 * program at once, and any other thrown error is treated as transient and retried.
 */
async function retryUntilDone(step: () => Promise<boolean>): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      if (await step()) return;
    } catch (err) {
      if (err instanceof FatalEnvError) throw err;
      // A network error or a timeout: the env may still be starting, so retry.
    }
    await sleep(backoffMs(failures));
  }
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409 means
 * a first register already won, which is not this process's to fix. 400 and 405 are
 * contract errors and end the program; a network error or another status is retried,
 * since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  await retryUntilDone(async () => {
    const res = await fetch(`${ENV_URL}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 200 || res.status === 409) return true;
    if (res.status === 400 || res.status === 405) {
      throw new FatalEnvError(`register answered HTTP ${res.status}: ${await res.text()}`);
    }
    return false;
  });
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  await retryUntilDone(async () => {
    const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) return false;
    const body = (await res.json()) as { done?: unknown };
    return body.done === true;
  });
}

/** Start the server on an ephemeral port and return the port the kernel picked. */
async function bindEphemeral(): Promise<{ server: ReturnType<typeof createApp>; port: number }> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  return { server, port: address.port };
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const { server, port } = await bindEphemeral();
  process.stdout.write(`[entry] listening on port ${port}\n`);

  await register(port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
