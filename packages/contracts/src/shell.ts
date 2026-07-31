/** POSIX 單引號跳脫（與 Flutter 版 _quoteShellArg 相同）。 */
export function quoteShellArg(input: string): string {
  return `'${input.replace(/'/g, `'"'"'`)}'`;
}
