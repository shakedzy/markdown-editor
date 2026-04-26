import type { TokenizerExtension, RendererExtension, Tokens } from 'marked';

const TILDE_BOUNDARY = /(?<!~)~(?!~)/;
const SINGLE_TILDE = /^~(?!~)([^~\n]+?)(?<!~)~(?!~)/;

export const singleTildeStrikethrough: TokenizerExtension & RendererExtension = {
  name: 'singleTildeStrike',
  level: 'inline',
  start(src: string): number | undefined {
    const m = TILDE_BOUNDARY.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(this: { lexer: { inlineTokens: (src: string) => Tokens.Generic[] } }, src: string) {
    const m = SINGLE_TILDE.exec(src);
    if (!m) return undefined;
    return {
      type: 'singleTildeStrike',
      raw: m[0],
      text: m[1],
      tokens: this.lexer.inlineTokens(m[1]),
    } as never;
  },
  renderer(token) {
    const tokens = (token as { tokens?: Tokens.Generic[] }).tokens ?? [];
    const inner = (this as unknown as { parser: { parseInline: (t: Tokens.Generic[]) => string } }).parser.parseInline(tokens);
    return `<del>${inner}</del>`;
  },
};
