export function loadParser(): Promise<{
  parse(source: string): import('./parser-types').ParsedScript;
  forEachChild(
    node: import('./parser-types').SyntaxNode,
    callback: (child: import('./parser-types').SyntaxNode) => void
  ): void;
}>;
