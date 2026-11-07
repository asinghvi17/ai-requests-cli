// Hand-rolled argv parser. Flags are declared up front so `--flag value` and boolean flags are unambiguous.
// Supports `--name value`, `--name=value`, boolean `--name`, `-h`-style short aliases and `--` to end flags.

export type FlagSpec = { type: 'string' | 'boolean'; short?: string; multiple?: boolean };
export type FlagSpecs = Record<string, FlagSpec>;
export type Parsed = { flags: Record<string, string | boolean | string[]>; positionals: string[] };

export class ArgError extends Error {}

export function parseArgs(argv: readonly string[], specs: FlagSpecs): Parsed {
  const flags: Parsed['flags'] = {};
  const positionals: string[] = [];
  const byShort = new Map<string, string>();
  for (const [name, spec] of Object.entries(specs)) if (spec.short) byShort.set(spec.short, name);

  const set = (name: string, value: string | boolean) => {
    const spec = specs[name]!;
    if (spec.multiple) {
      const prev = flags[name];
      flags[name] = [...(Array.isArray(prev) ? prev : []), String(value)];
    } else if (name in flags) {
      throw new ArgError(`--${name} given more than once`);
    } else {
      flags[name] = value;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    let name: string | undefined;
    let inline: string | undefined;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      inline = eq < 0 ? undefined : arg.slice(eq + 1);
      if (!(name in specs)) throw new ArgError(`unknown flag --${name}`);
    } else if (arg.length === 2 && arg[0] === '-' && arg !== '-') {
      name = byShort.get(arg[1]!);
      if (!name) throw new ArgError(`unknown flag ${arg}`);
    } else {
      positionals.push(arg);
      continue;
    }
    const spec = specs[name]!;
    if (spec.type === 'boolean') {
      if (inline !== undefined) throw new ArgError(`--${name} takes no value`);
      set(name, true);
    } else if (inline !== undefined) {
      set(name, inline);
    } else {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) throw new ArgError(`--${name} needs a value`);
      set(name, next);
      i++;
    }
  }
  return { flags, positionals };
}
