/** POSIX shlex token semantics: quote removal and escaping, without shell execution or expansion. */
export function shellTokens(raw: string): string[] | null {
  const tokens: string[] = [];
  let word = '';
  let active = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index] ?? '';
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (char === '\\') {
      const next = raw[++index];
      if (next === undefined) return null;
      if (quote === '"' && next !== '"' && next !== '\\') word += '\\';
      word += next;
      active = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      active = true;
      continue;
    }
    if (/[ \t\r\n]/.test(char)) {
      if (active) tokens.push(word);
      word = '';
      active = false;
    } else {
      word += char;
      active = true;
    }
  }
  if (quote !== null) return null;
  if (active) tokens.push(word);
  return tokens;
}

function heredocAt(raw: string, index: number): string | null {
  if (raw.slice(index, index + 2) !== '<<') return null;
  return /^<<[ \t]*['"]?([^ \t\n'"\)]+)/.exec(raw.slice(index))?.[1] ?? null;
}

export function segmentCommand(raw: string): string[] {
  const segments: string[] = [];
  let current = '';
  let single = false;
  let double = false;
  let heredoc: string | null = null;
  for (let index = 0; index < raw.length; ) {
    if (heredoc !== null) {
      const newline = raw.indexOf('\n', index);
      if (newline < 0) {
        current += raw.slice(index);
        break;
      }
      const line = raw.slice(index, newline);
      current += `${line}\n`;
      index = newline + 1;
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }
    const char = raw[index] ?? '';
    if (!single && !double) {
      const marker = heredocAt(raw, index);
      if (marker !== null) {
        heredoc = marker;
        const newline = raw.indexOf('\n', index);
        if (newline < 0) {
          current += raw.slice(index);
          break;
        }
        current += raw.slice(index, newline + 1);
        index = newline + 1;
        continue;
      }
    }
    if (char === '\\' && !single) {
      current += raw.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single) double = !double;
    else if (!single && !double) {
      const pair = raw.slice(index, index + 2);
      if (
        pair === '&&' ||
        pair === '||' ||
        (char === ';' && pair !== ';;') ||
        char === '\n' ||
        char === '|'
      ) {
        if (current.trim()) segments.push(current.trim());
        current = '';
        index += pair === '&&' || pair === '||' ? 2 : 1;
        continue;
      }
    }
    current += char;
    index++;
  }
  if (current.trim()) segments.push(current.trim());
  return segments.length ? segments : [raw.trim()];
}

export function stripQuotedRegions(raw: string): string {
  let result = '';
  let single = false;
  let double = false;
  let heredoc: string | null = null;
  for (let index = 0; index < raw.length; ) {
    if (heredoc !== null) {
      const newline = raw.indexOf('\n', index);
      if (newline < 0) break;
      if (raw.slice(index, newline).trim() === heredoc) heredoc = null;
      else result += ' ';
      index = newline + 1;
      continue;
    }
    if (!single && !double) {
      const marker = heredocAt(raw, index);
      if (marker !== null) {
        heredoc = marker;
        result += '<<';
        const newline = raw.indexOf('\n', index);
        index = newline < 0 ? raw.length : newline + 1;
        continue;
      }
    }
    const char = raw[index] ?? '';
    if (char === '\\' && !single) {
      result += ' ';
      index += 2;
      continue;
    }
    if (char === "'" && !double) {
      single = !single;
      index++;
      continue;
    }
    if (char === '"' && !single) {
      double = !double;
      index++;
      continue;
    }
    result += single || double ? ' ' : char;
    index++;
  }
  return result;
}

export function extractCommandSubstitutions(raw: string): string[] {
  const bodies: string[] = [];
  let single = false;
  let heredoc: string | null = null;
  for (let index = 0; index < raw.length; ) {
    if (heredoc !== null) {
      const newline = raw.indexOf('\n', index);
      if (newline < 0) break;
      if (raw.slice(index, newline).trim() === heredoc) heredoc = null;
      index = newline + 1;
      continue;
    }
    if (!single) {
      const marker = heredocAt(raw, index);
      if (marker !== null) {
        heredoc = marker;
        const newline = raw.indexOf('\n', index);
        index = newline < 0 ? raw.length : newline + 1;
        continue;
      }
    }
    const char = raw[index] ?? '';
    if (char === '\\' && index + 1 < raw.length) {
      index += 2;
      continue;
    }
    if (char === "'") {
      single = !single;
      index++;
      continue;
    }
    if (single) {
      index++;
      continue;
    }
    if (raw.slice(index, index + 2) === '$(') {
      let depth = 1;
      let end = index + 2;
      let innerSingle = false;
      let innerDouble = false;
      for (; end < raw.length; end++) {
        const inner = raw[end];
        if (inner === '\\' && end + 1 < raw.length) {
          end++;
          continue;
        }
        if (!innerDouble && inner === "'") innerSingle = !innerSingle;
        else if (!innerSingle && inner === '"') innerDouble = !innerDouble;
        else if (!innerSingle && !innerDouble) {
          if (inner === '(') depth++;
          else if (inner === ')' && --depth === 0) {
            bodies.push(raw.slice(index + 2, end));
            end++;
            break;
          }
        }
      }
      index = end;
      continue;
    }
    if (char === '`') {
      let end = index + 1;
      for (; end < raw.length; end++) {
        if (raw[end] === '\\' && end + 1 < raw.length) {
          end++;
          continue;
        }
        if (raw[end] === '`') {
          bodies.push(raw.slice(index + 1, end));
          end++;
          break;
        }
      }
      index = end;
      continue;
    }
    index++;
  }
  return bodies;
}
