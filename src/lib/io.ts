// Where a command writes: `out` for its output, `err` for messages and errors.
export type Io = { out: (s: string) => void; err: (s: string) => void };
