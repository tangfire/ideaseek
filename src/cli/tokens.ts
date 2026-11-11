/**
 * Quote-aware argv splitting for REPL input. A shell already tokenizes the
 * non-interactive CLI's argv; the REPL receives one raw line, so
 * `/ideate --question "ux test"` must still reach commander as
 * `["--question", "ux test"]` instead of being split on the inner space.
 * Surrounding double quotes are stripped (they were shell syntax, not data).
 */
export function tokenizeArgs(text: string): string[] {
  const matches = text.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return matches.map((token) =>
    token.length >= 2 && token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token,
  );
}
