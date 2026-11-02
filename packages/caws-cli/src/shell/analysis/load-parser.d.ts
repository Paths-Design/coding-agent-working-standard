export function loadParser(): Promise<{
  parse(source: string): import('./parser-types').ParsedScript;
}>;
