import { vi } from "vitest";

// vi.waitFor gives up after 1s unless a call passes its own timeout. The chat
// integration suites poll durable state that settles across several
// transactions, which crossed 1s on the slower self-hosted CI hosts. Default
// to 10s; a call that passes a timeout, as a number or in its options, keeps it.
const DEFAULT_WAIT_FOR_TIMEOUT_MS = 10_000;

type WaitFor = typeof vi.waitFor;
type WaitForOptions = Parameters<WaitFor>[1];

const originalWaitFor = vi.waitFor.bind(vi) as WaitFor;

function withDefaultTimeout(options: WaitForOptions): WaitForOptions {
  if (typeof options === "number") return options;
  return { ...options, timeout: options?.timeout ?? DEFAULT_WAIT_FOR_TIMEOUT_MS };
}

vi.waitFor = ((callback, options) =>
  originalWaitFor(callback, withDefaultTimeout(options))) as WaitFor;
