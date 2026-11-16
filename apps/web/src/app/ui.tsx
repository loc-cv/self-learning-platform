// Small shared pieces: buttons that never take focus from the terminal, icons, durations.

import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'plain'; small?: boolean; shortcut?: string };

/** A button that keeps keyboard focus where it was (the terminal) when clicked. */
export function Button({ variant = 'plain', small, shortcut, className, title, children, ...rest }: ButtonProps) {
  const cls = ['btn', variant !== 'plain' ? `btn-${variant}` : '', small ? 'btn-small' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} title={shortcut ? `${title ?? ''}${title ? ' ' : ''}(${shortcut})` : title} onMouseDown={(e) => e.preventDefault()} {...rest}>
      {children}
    </button>
  );
}

const PATHS: Record<string, ReactNode> = {
  check: <path d="M4 10.5l3.5 3.5L16 5.5" />,
  hint: (
    <>
      <path d="M7.5 15.5h5M8.5 18h3" />
      <path d="M10 2.5a5.5 5.5 0 0 0-3.2 10c.5.4.7.9.7 1.5v.5h5V14c0-.6.2-1.1.7-1.5A5.5 5.5 0 0 0 10 2.5z" />
    </>
  ),
  reset: (
    <>
      <path d="M3.5 10a6.5 6.5 0 1 0 2-4.7" />
      <path d="M3 3.5v3.5h3.5" />
    </>
  ),
  book: (
    <>
      <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H16v12H5.5A1.5 1.5 0 0 0 4 16.5z" />
      <path d="M4 16.5A1.5 1.5 0 0 0 5.5 18H16v-3" />
    </>
  ),
  key: (
    <>
      <circle cx="6.5" cy="13.5" r="3" />
      <path d="M8.8 11.2L16 4M13.5 6.5l2 2M11.5 8.5l1.5 1.5" />
    </>
  ),
  pause: <path d="M7 4.5v11M13 4.5v11" />,
  play: <path d="M6.5 4.5l9 5.5-9 5.5z" />,
  plus: <path d="M10 4.5v11M4.5 10h11" />,
  close: <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />,
  list: <path d="M7 5.5h9M7 10h9M7 14.5h9M3.8 5.5h.4M3.8 10h.4M3.8 14.5h.4" />,
  gear: (
    <>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.5" y="5" width="15" height="10" rx="2" />
      <path d="M5.5 8h.01M8.5 8h.01M11.5 8h.01M14.5 8h.01M6 12h8" />
    </>
  ),
  panel: (
    <>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="M8 3.5v13" />
    </>
  ),
  terminal: (
    <>
      <path d="M4.5 6.5l3.5 3.5-3.5 3.5" />
      <path d="M10 14h5.5" />
    </>
  ),
  flag: (
    <>
      <path d="M4.5 17.5V3.5" />
      <path d="M4.5 4h10l-2 3.5 2 3.5h-10" />
    </>
  ),
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/** mm:ss, or h:mm:ss past an hour. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function Dots({ n, of }: { n: number; of: number }) {
  return (
    <span className="dots" aria-label={`difficulty ${n} of ${of}`}>
      {Array.from({ length: of }, (_, i) => (
        <span key={i} className={i < n ? 'dot is-on' : 'dot'} />
      ))}
    </span>
  );
}
