// Where a command writes: `out` for its output, `err` for messages and errors.
export type Io = { out: (s: string) => void; err: (s: string) => void };

/** A command that can't do what was asked in the current state: the router prints the message and exits 1. */
export class CommandError extends Error {}
