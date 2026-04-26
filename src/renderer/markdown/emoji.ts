import { gemoji } from 'gemoji';

let cached: Record<string, string> | null = null;

export function buildEmojiMap(): Record<string, string> {
  if (cached) return cached;
  const map: Record<string, string> = {};
  for (const g of gemoji) {
    for (const name of g.names) {
      map[name] = g.emoji;
    }
  }
  cached = map;
  return map;
}
