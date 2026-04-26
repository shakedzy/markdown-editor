import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import GithubSlugger from 'github-slugger';

export interface Heading {
  level: number;
  text: string;
  line: number;
  pos: number;
  slug: string;
}

const ATX_LEVELS: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
};

const SETEXT_LEVELS: Record<string, number> = {
  SetextHeading1: 1,
  SetextHeading2: 2,
};

export function extractHeadings(state: EditorState): Heading[] {
  const headings: Heading[] = [];
  const slugger = new GithubSlugger();

  syntaxTree(state).iterate({
    enter(node) {
      const atx = ATX_LEVELS[node.name];
      const setext = SETEXT_LEVELS[node.name];
      if (!atx && !setext) return;

      const fullText = state.doc.sliceString(node.from, node.to);
      let cleaned: string;
      if (atx) {
        cleaned = fullText.replace(/^#{1,6}\s*/, '').replace(/\s+#+\s*$/, '').trim();
      } else {
        cleaned = fullText.split(/\r?\n/)[0]?.trim() ?? '';
      }
      if (!cleaned) return;

      const line = state.doc.lineAt(node.from);
      headings.push({
        level: atx ?? setext ?? 1,
        text: cleaned,
        line: line.number,
        pos: node.from,
        slug: slugger.slug(cleaned),
      });
    },
  });

  return headings;
}
