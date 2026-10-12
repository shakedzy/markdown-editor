import {
  Input,
  NodeSet,
  NodeType,
  ParseWrapper,
  Parser,
  PartialParse,
  Tree,
  TreeFragment,
  parseMixed,
} from '@lezer/common';
import { styleTags, tags as t } from '@lezer/highlight';
import {
  Language,
  LanguageSupport,
  defineLanguageFacet,
  languageDataProp,
} from '@codemirror/language';
import { yamlLanguage } from '@codemirror/lang-yaml';
import { FrontMatterBounds, findFrontMatter, opensFrontMatter } from '../markdown/frontmatter';

// The editor side of YAML front matter. This is @codemirror/lang-yaml's
// yamlFrontmatter() (same node names: Frontmatter > DashLine,
// FrontmatterContent, DashLine, then Body), except that the block is detected
// with the preview's rules from markdown/frontmatter.ts. That grammar rejects
// trailing blanks and `...` closers, and treats an unclosed `---` at the top
// as front matter running to the end of the document, so the editor and the
// preview would disagree about which headings and task items exist.

const data = defineLanguageFacet();

const nodeSet = new NodeSet([
  NodeType.define({ id: 0, name: 'Document', top: true, props: [[languageDataProp, data]] }),
  NodeType.define({ id: 1, name: 'Frontmatter' }),
  NodeType.define({ id: 2, name: 'DashLine' }),
  NodeType.define({ id: 3, name: 'FrontmatterContent' }),
  NodeType.define({ id: 4, name: 'Body' }),
]).extend(styleTags({ DashLine: t.meta }));

const [Document, Frontmatter, DashLine, FrontmatterContent, Body] = nodeSet.types as [
  NodeType,
  NodeType,
  NodeType,
  NodeType,
  NodeType,
];

function readFrontMatter(input: Input, from: number, to: number): FrontMatterBounds | null {
  // Front matter is short, so read a growing prefix instead of copying out
  // the whole (possibly huge) document on every reparse.
  for (let size = 1024; ; size *= 8) {
    const end = Math.min(to, from + size);
    const text = input.read(from, end);
    const fm = findFrontMatter(text);
    if (end === to) return fm;
    // The prefix may cut the closing line short (`---` of `----`); only trust
    // a match whose line break made it in.
    if (fm) {
      if (fm.end < text.length) return fm;
    } else if (!opensFrontMatter(text)) {
      return null;
    }
  }
}

// One pass, no incremental state: finding the block is cheap, and the
// markdown inside Body is reparsed incrementally by parseMixed regardless.
class FrontMatterParse implements PartialParse {
  parsedPos: number;
  stoppedAt: number | null = null;

  constructor(
    private readonly input: Input,
    private readonly from: number,
    private readonly to: number,
  ) {
    this.parsedPos = from;
  }

  advance(): Tree {
    const length = this.to - this.from;
    const fm = readFrontMatter(this.input, this.from, this.to);
    const children: Tree[] = [];
    const positions: number[] = [];
    if (fm) {
      children.push(
        new Tree(
          Frontmatter,
          [
            new Tree(DashLine, [], [], fm.openTo),
            new Tree(FrontmatterContent, [], [], fm.closeFrom - fm.contentFrom),
            new Tree(DashLine, [], [], fm.closeTo - fm.closeFrom),
          ],
          [0, fm.contentFrom, fm.closeFrom],
          fm.closeTo,
        ),
      );
      positions.push(0);
    }
    const bodyFrom = fm ? fm.end : 0;
    children.push(new Tree(Body, [], [], length - bodyFrom));
    positions.push(bodyFrom);
    this.parsedPos = this.to;
    return new Tree(Document, children, positions, length);
  }

  stopAt(pos: number): void {
    this.stoppedAt = pos;
  }
}

class FrontMatterParser extends Parser {
  constructor(private readonly wrap: ParseWrapper) {
    super();
  }

  createParse(
    input: Input,
    fragments: readonly TreeFragment[],
    ranges: readonly { from: number; to: number }[],
  ): PartialParse {
    const parse = new FrontMatterParse(input, ranges[0]!.from, ranges[ranges.length - 1]!.to);
    return this.wrap(parse, input, fragments, ranges);
  }
}

/** `content` (the markdown language) behind an optional YAML front matter block. */
export function withFrontMatter(content: LanguageSupport): LanguageSupport {
  const wrap = parseMixed((node) => {
    if (node.type === FrontmatterContent) return { parser: yamlLanguage.parser };
    if (node.type === Body) return { parser: content.language.parser };
    return null;
  });
  const language = new Language(data, new FrontMatterParser(wrap), [], 'markdown-frontmatter');
  return new LanguageSupport(language, content.support);
}
