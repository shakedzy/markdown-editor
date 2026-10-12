import type { LintCounts } from '../editor/lint';
import { counted, formatCount } from '../markdown/stats';
import { shortcut } from '../platform';

interface Props {
  counts: LintCounts;
  /** Show or hide the list of warnings. */
  onClick: () => void;
}

/** The status bar's count of Markdown lint warnings; nothing when there are none. */
export default function LintStatus({
  counts: { warnings, infos },
  onClick,
}: Props): JSX.Element | null {
  if (!warnings && !infos) return null;
  const summary = [
    ...(warnings ? [counted(warnings, 'warning')] : []),
    ...(infos ? [counted(infos, 'suggestion')] : []),
  ].join(', ');
  const label =
    `Markdown lint: ${summary}. Click to list them (${shortcut('Mod+Shift+M')}); ` +
    'F8 goes to the next one.';

  return (
    <button
      type="button"
      className="status-bar-lint"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {warnings > 0 && (
        <span className="status-bar-lint-warnings">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="currentColor">
            <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" />
          </svg>
          {formatCount(warnings)}
        </span>
      )}
      {infos > 0 && (
        <span className="status-bar-lint-infos">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="currentColor">
            <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
          </svg>
          {formatCount(infos)}
        </span>
      )}
    </button>
  );
}
