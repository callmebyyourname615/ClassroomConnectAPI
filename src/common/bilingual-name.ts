export interface BilingualName {
  la: string;
  en: string | null;
}

/** Outside parentheses is Lao; each parenthesized segment is English.
 * Nested parentheses remain part of the English label, e.g. Math (Advanced). */
export function parseBilingualName(input: string): BilingualName {
  const source = input.trim();
  if (!source) throw new Error('Name must not be empty');
  let depth = 0;
  let lao = '';
  let segment = '';
  const english: string[] = [];
  for (const character of source) {
    if (character === '(') {
      if (depth++ > 0) segment += character;
    } else if (character === ')') {
      if (!depth) throw new Error('Name contains an unmatched parenthesis');
      if (--depth > 0) segment += character;
      else {
        if (!segment.trim()) throw new Error('English name must not be empty');
        english.push(segment.trim());
        segment = '';
      }
    } else if (depth) segment += character;
    else lao += character;
  }
  if (depth) throw new Error('Name contains an unmatched parenthesis');
  if (english.length && !lao.trim()) {
    throw new Error('Enter the Lao name before the English translation');
  }
  return { la: lao.trim(), en: english.length ? english.join(' ') : null };
}
