import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { DESKTOP, useMedia } from '../lib/media.ts';
import { spring } from '../lib/motion.ts';

interface SheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Side panel on desktop, full-screen sheet on mobile, over a blurred backdrop. */
export function Sheet({ open, title, onClose, children, footer }: SheetProps) {
  const desktop = useMedia(DESKTOP);
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && items.includes(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => panel.current?.focus());
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = '';
      returnTo.current?.focus?.();
    };
  }, [open, onClose]);

  const offscreen = desktop ? { x: 48, opacity: 0 } : { y: '100%', opacity: 1 };

  return (
    <AnimatePresence>
      {open && (
        <div className="sheet-root">
          <motion.div
            className="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />
          <motion.div
            ref={panel}
            className={desktop ? 'sheet sheet-side' : 'sheet sheet-full'}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={offscreen}
            animate={{ x: 0, y: 0, opacity: 1 }}
            exit={offscreen}
            transition={spring}
          >
            <header className="sheet-head">
              <h2 id={titleId}>{title}</h2>
              <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </header>
            <div className="sheet-body">{children}</div>
            {footer && <footer className="sheet-foot">{footer}</footer>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
