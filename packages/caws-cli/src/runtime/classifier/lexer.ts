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

/** Find one balanced executing substitution without borrowing its quote state. */
function commandSubstitutionAt(raw: string, start: number): { body: string; end: number } | null {
  if (raw[start] === '`') {
    for (let end = start + 1; end < raw.length; end++) {
      if (raw[end] === '\\' && end + 1 < raw.length) end++;
      else if (raw[end] === '`') return { body: raw.slice(start + 1, end), end: end + 1 };
    }
    return null;
  }
  if (raw.slice(start, start + 2) !== '$(') return null;
  const frames = [{ depth: 1, single: false, double: false }];
  for (let end = start + 2; end < raw.length; end++) {
    const char = raw[end];
    const frame = frames[frames.length - 1]!;
    if (char === '\\' && !frame.single && end + 1 < raw.length) {
      end++;
      continue;
    }
    if (!frame.single && raw.slice(end, end + 2) === '$(') {
      // Input nesting must not consume the JavaScript call stack before the
      // classification recursion budget can require confirmation.
      frames.push({ depth: 1, single: false, double: false });
      end++;
      continue;
    }
    if (!frame.single && char === '`') {
      const nested = commandSubstitutionAt(raw, end);
      if (nested === null) return null;
      end = nested.end - 1;
      continue;
    }
    if (char === "'" && !frame.double) frame.single = !frame.single;
    else if (char === '"' && !frame.single) frame.double = !frame.double;
    else if (!frame.single && !frame.double) {
      if (char === '(') frame.depth++;
      else if (char === ')' && --frame.depth === 0) {
        frames.pop();
        if (!frames.length) return { body: raw.slice(start + 2, end), end: end + 1 };
      }
    }
  }
  return null;
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
    if (!single && (raw.slice(index, index + 2) === '$(' || char === '`')) {
      const substitution = commandSubstitutionAt(raw, index);
      if (substitution !== null) {
        current += raw.slice(index, substitution.end);
        index = substitution.end;
        continue;
      }
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
  let double = false;
  let heredoc: string | null = null;
  for (let index = 0; index < raw.length; ) {
    if (heredoc !== null) {
      const newline = raw.indexOf('\n', index);
      if (newline < 0) break;
      if (raw.slice(index, newline).trim() === heredoc) heredoc = null;
      index = newline + 1;
      continue;
    }
    if (!single && !double) {
      const marker = heredocAt(raw, index);
      if (marker !== null) {
        heredoc = marker;
        const newline = raw.indexOf('\n', index);
        index = newline < 0 ? raw.length : newline + 1;
        continue;
      }
    }
    const char = raw[index] ?? '';
    if (char === '\\' && !single && index + 1 < raw.length) {
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
    if (single) {
      index++;
      continue;
    }
    if (raw.slice(index, index + 2) === '$(' || char === '`') {
      const substitution = commandSubstitutionAt(raw, index);
      if (substitution === null) break;
      bodies.push(substitution.body);
      index = substitution.end;
      continue;
    }
    index++;
  }
  return bodies;
}
