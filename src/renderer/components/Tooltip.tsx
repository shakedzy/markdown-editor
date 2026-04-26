import { ReactNode } from 'react';

interface Props {
  content: ReactNode;
  children: ReactNode;
}

export default function Tooltip({ content, children }: Props): JSX.Element {
  return (
    <span className="tooltip-wrap">
      {children}
      <span className="tooltip-bubble" role="tooltip">
        {content}
      </span>
    </span>
  );
}
