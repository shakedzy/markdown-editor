import { useEffect, useState } from 'react';
import { shortcut } from '../platform';

// The corner region (px from the window's top-right) the pointer reveals the button in.
const REVEAL_WIDTH = 240;
const REVEAL_HEIGHT = 120;
// Shown for a moment on entering focus mode, so the way out can be found.
const INTRO_MS = 2000;

interface Props {
  onExit: () => void;
  /** Escape leaves focus mode too (not with Vim keys, where Escape is Vim's). */
  escapeExits: boolean;
}

/**
 * Focus mode's way out: a small button in the top-right corner that fades in
 * as the pointer comes near.
 */
export default function FocusExit({ onExit, escapeExits }: Props): JSX.Element {
  const [intro, setIntro] = useState(true);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setIntro(false), INTRO_MS);
    const onMove = (e: MouseEvent) =>
      setNear(e.clientX >= window.innerWidth - REVEAL_WIDTH && e.clientY <= REVEAL_HEIGHT);
    const onLeave = () => setNear(false);
    const root = document.documentElement;
    window.addEventListener('mousemove', onMove, { passive: true });
    root.addEventListener('mouseleave', onLeave);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousemove', onMove);
      root.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  return (
    <button
      type="button"
      className={`focus-exit ${intro || near ? 'visible' : ''}`}
      // Clicking mustn't take the caret out of the editor first.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onExit}
      title={`Exit focus mode (${shortcut('Mod+Shift+Enter')}${escapeExits ? ' or Esc' : ''})`}
    >
      Exit Focus
    </button>
  );
}
