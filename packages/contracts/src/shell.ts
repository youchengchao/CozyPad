/** POSIX single-quote escaping migrated from the Flutter v1.0.2 baseline. */
export function quoteShellArg(input: string): string {
  return `'${input.replace(/'/g, `'"'"'`)}'`;
}
