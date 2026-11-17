// Small shared pieces: buttons that never take focus from the terminal, the tab strip, the select,
// icons, durations.

import { isValidElement, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'plain'; small?: boolean; shortcut?: string };

/** A button that keeps keyboard focus where it was (the terminal) when clicked. */
export function Button({ variant = 'plain', small, shortcut, className, title, children, ...rest }: ButtonProps) {
  // A button whose only content is an icon is square (styles.css .btn-icon).
  const iconOnly = isValidElement(children) && children.type === Icon;
  const cls = ['btn', variant !== 'plain' ? `btn-${variant}` : '', small ? 'btn-small' : '', iconOnly ? 'btn-icon' : '', className ?? ''].filter(Boolean).join(' ');
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
  // To the next event: play to a bar.
  skip: (
    <>
      <path d="M5 4.5l8 5.5-8 5.5z" />
      <path d="M15.5 4.5v11" />
    </>
  ),
  why: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M7.8 7.8a2.3 2.3 0 1 1 3.2 2.1c-.6.3-1 .8-1 1.4v.4M10 14.4h.01" />
    </>
  ),
  // A past moment: a clock with its arrow turned back.
  history: (
    <>
      <path d="M3.5 10a6.5 6.5 0 1 0 1.9-4.6" />
      <path d="M3 3.5v3h3" />
      <path d="M10 6.5V10l2.5 1.5" />
    </>
  ),
  play: <path d="M6.5 4.5l9 5.5-9 5.5z" />,
  plus: <path d="M10 4.5v11M4.5 10h11" />,
  minus: <path d="M4.5 10h11" />,
  fit: <path d="M3.5 7v-3.5H7M13 3.5h3.5V7M16.5 13v3.5H13M7 16.5H3.5V13M7.5 7.5h5v5h-5z" />,
  xray: (
    <>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <rect x="5.5" y="6.5" width="4" height="3" rx="0.8" />
      <rect x="10.5" y="10.5" width="4" height="3" rx="0.8" />
      <path d="M9.5 8h2.5v2.5" />
    </>
  ),
  close: <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />,
  prev: <path d="M12.5 4.5L7 10l5.5 5.5" />,
  next: <path d="M7.5 4.5L13 10l-5.5 5.5" />,
  enlarge: <path d="M11.5 3.5h5v5M8.5 16.5h-5v-5M16.5 3.5l-5.5 5.5M3.5 16.5L9 11" />,
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
  expand: <path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4" />,
  shrink: <path d="M7.5 3.5v4h-4M12.5 3.5v4h4M7.5 16.5v-4h-4M12.5 16.5v-4h4" />,
  chevron: <path d="M5.5 8l4.5 4.5L14.5 8" />,
  lock: (
    <>
      <rect x="4.5" y="9" width="11" height="8" rx="2" />
      <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
    </>
  ),
  // A panel lifted off the workspace, and one set into its side.
  float: (
    <>
      <path d="M12.5 3.5h-8a2 2 0 0 0-2 2v7" />
      <rect x="6.5" y="7.5" width="11" height="9" rx="2" />
    </>
  ),
  dock: (
    <>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="M12 3.5v13" />
    </>
  ),
  grip: <path d="M7.5 5.5h.01M12.5 5.5h.01M7.5 10h.01M12.5 10h.01M7.5 14.5h.01M12.5 14.5h.01" />,
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

export interface TabItem<T extends string = string> {
  id: T;
  label: string;
  /** What the tab holds, read before it is opened: a score, a count. */
  badge?: string;
  /** The badge spoken in full ("2 of 3 checks pass"). */
  badgeLabel?: string;
  tone?: 'ok' | 'accent';
  icon?: string;
  /** Something arrived in this tab since it was last open. */
  fresh?: boolean;
  /** The tab's spoken name, when its label alone says too little (a lesson's step shows only its number). */
  name?: string;
}

/** The DOM ids that tie a tab to its panel. */
export const tabDomId = (prefix: string, id: string): string => `${prefix}-tab-${id}`;
export const panelDomId = (prefix: string, id: string): string => `${prefix}-panel-${id}`;

/**
 * A strip of tabs after the ARIA tabs pattern: one tab stop, the arrow keys move and select, Home
 * and End go to the ends. A click selects without taking focus from the terminal. It scrolls
 * sideways when the tabs do not fit, so a strip can hold any number of them (a lesson's steps in
 * phase 12 are more tabs of this strip).
 */
export function TabStrip<T extends string>({ tabs, active, onSelect, label, prefix }: { tabs: TabItem<T>[]; active: T; onSelect(id: T): void; label: string; prefix: string }) {
  const strip = useRef<HTMLDivElement>(null);
  // The selected tab stays in sight; only the strip itself scrolls (D-130).
  useEffect(() => {
    const box = strip.current;
    const el = box?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!box || !el) return;
    if (el.offsetLeft < box.scrollLeft) box.scrollLeft = el.offsetLeft;
    else if (el.offsetLeft + el.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = el.offsetLeft + el.offsetWidth - box.clientWidth;
  }, [active, tabs.length]);
  const key = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const at = tabs.findIndex((t) => t.id === active);
    const to = e.key === 'ArrowRight' ? (at + 1) % tabs.length : e.key === 'ArrowLeft' ? (at - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    const next = tabs[to];
    if (!next) return;
    e.preventDefault();
    onSelect(next.id);
    document.getElementById(tabDomId(prefix, next.id))?.focus();
  };
  return (
    <div className="tabstrip" role="tablist" aria-label={label} ref={strip} onKeyDown={key}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" id={tabDomId(prefix, t.id)} aria-selected={t.id === active} aria-controls={panelDomId(prefix, t.id)} aria-label={t.name} tabIndex={t.id === active ? 0 : -1} className={`tabstrip-tab${t.id === active ? ' is-active' : ''}${t.tone ? ` is-${t.tone}` : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => onSelect(t.id)}>
          {t.icon ? <Icon name={t.icon} size={13} /> : null}
          <span className="tabstrip-label">{t.label}</span>
          {t.badge !== undefined ? (
            <span className="tabstrip-badge" aria-label={t.badgeLabel}>
              {t.badge}
            </span>
          ) : null}
          {t.fresh ? (
            <span className="tabstrip-fresh">
              <span className="sr-only">new</span>
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/**
 * A select drawn in the interface's own look (a native one shows the system's). A button that
 * opens a list box: arrow keys move, Enter chooses, Escape closes without reaching the shell.
 * Opened with the pointer it leaves focus in the terminal.
 */
export function Select<T extends string>({ value, options, onChange, label, className }: { value: T; options: { value: T; label: string }[]; onChange(v: T): void; label: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const current = options.find((o) => o.value === value);
  const show = (focus: boolean): void => {
    setAt(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
    if (focus) requestAnimationFrame(() => list.current?.focus());
  };
  const hide = (): void => {
    if (list.current && document.activeElement === list.current) trigger.current?.focus();
    setOpen(false);
  };
  useEffect(() => {
    if (!open) return undefined;
    const down = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', down);
    return () => window.removeEventListener('mousedown', down);
  }, [open]);
  const choose = (v: T): void => {
    hide();
    if (v !== value) onChange(v);
  };
  const listKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const n = options.length;
    if (e.key === 'ArrowDown') setAt((at + 1) % n);
    else if (e.key === 'ArrowUp') setAt((at - 1 + n) % n);
    else if (e.key === 'Home') setAt(0);
    else if (e.key === 'End') setAt(n - 1);
    else if (e.key === 'Enter' || e.key === ' ') {
      const o = options[at];
      if (o) choose(o.value);
    } else if (e.key === 'Escape' || e.key === 'Tab') hide();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div className={`select${className ? ` ${className}` : ''}`} ref={root}>
      <button
        type="button"
        ref={trigger}
        className="select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current?.label ?? ''}`}
        title={label}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (open ? hide() : show(false))}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          show(true);
        }}
      >
        <span className="select-value">{current?.label ?? ''}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open ? (
        <div className="select-menu" role="listbox" aria-label={label} tabIndex={-1} ref={list} aria-activedescendant={`${id}-${at}`} onKeyDown={listKey}>
          {options.map((o, i) => (
            <div key={o.value} id={`${id}-${i}`} role="option" aria-selected={o.value === value} className={`select-option${i === at ? ' is-active' : ''}${o.value === value ? ' is-selected' : ''}`} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setAt(i)} onClick={() => choose(o.value)}>
              <span className="select-mark" aria-hidden="true">
                {o.value === value ? <Icon name="check" size={12} /> : null}
              </span>
              {o.label}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A segmented control after the ARIA radio group pattern: one tab stop (the chosen option), the
 * arrow keys move and choose, Home and End go to the ends.
 */
export function Segmented<T extends string | number>({ value, options, onChange, label, className }: { value: T; options: { value: T; label: string; title?: string }[]; onChange(v: T): void; label: string; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const key = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const at = Math.max(0, options.findIndex((o) => o.value === value));
    const n = options.length;
    const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (at + 1) % n : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (at - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    const next = options[to];
    if (!next) return;
    e.preventDefault();
    if (next.value !== value) onChange(next.value);
    root.current?.querySelectorAll<HTMLElement>('[role="radio"]')[to]?.focus();
  };
  const chosen = options.some((o) => o.value === value);
  return (
    <div className={`segmented${className ? ` ${className}` : ''}`} role="radiogroup" aria-label={label} ref={root} onKeyDown={key}>
      {options.map((o, i) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value || (!chosen && i === 0) ? 0 : -1} title={o.title} className={o.value === value ? 'is-on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => o.value !== value && onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
