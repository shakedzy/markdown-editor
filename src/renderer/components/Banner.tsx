import { ReactNode } from 'react';

export type BannerKind = 'info' | 'warning' | 'error';

export interface BannerAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export interface BannerProps {
  message: ReactNode;
  kind: BannerKind;
  actions?: BannerAction[];
  /** Shows a close (×) button when set. */
  onDismiss?: () => void;
}

/**
 * A banner as App holds it: one is shown at a time, and `source` names the
 * feature that raised it (e.g. 'disk', 'save') so that feature can replace or
 * clear its own notice without clobbering another's.
 */
export interface BannerNotice extends BannerProps {
  source: string;
}

const ICONS: Record<BannerKind, string> = {
  info: 'M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z',
  warning:
    'M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
  error:
    'M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z',
};

export default function Banner({ message, kind, actions = [], onDismiss }: BannerProps): JSX.Element {
  return (
    <div className={`banner banner-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <svg className="banner-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path d={ICONS[kind]} />
      </svg>
      <span className="banner-message">{message}</span>
      {actions.length > 0 && (
        <div className="banner-actions">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              className={`banner-button ${a.primary ? 'primary' : ''}`}
              onClick={a.onClick}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
      {onDismiss && (
        <button type="button" className="banner-close" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}
