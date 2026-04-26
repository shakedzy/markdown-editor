import { Heading } from '../markdown/headings';

interface Props {
  headings: Heading[];
  onSelect: (heading: Heading, index: number) => void;
}

export default function Toc({ headings, onSelect }: Props): JSX.Element {
  if (headings.length === 0) {
    return (
      <aside className="toc toc-empty">
        <div className="toc-header">Table of Contents</div>
        <div className="toc-empty-msg">No headings yet.</div>
      </aside>
    );
  }
  return (
    <aside className="toc">
      <div className="toc-header">Table of Contents</div>
      <ul className="toc-list">
        {headings.map((h, i) => (
          <li
            key={`${i}-${h.line}-${h.slug}`}
            className={`toc-item toc-level-${h.level}`}
          >
            <button type="button" onClick={() => onSelect(h, i)}>
              {h.text}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
