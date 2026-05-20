import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Matches `.chart-embed__details-slot` grid transition duration + buffer. */
export const CHART_DETAILS_LAYOUT_LOCK_MS = 280;

function getPinnedScrollTop(scroll: HTMLElement): number {
  const pinned = Number(scroll.dataset.chartDetailsPinnedTop);
  return Number.isFinite(pinned) ? pinned : scroll.scrollTop;
}

function restorePinnedScrollTop(scroll: HTMLElement) {
  const pinned = getPinnedScrollTop(scroll);
  const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
  scroll.scrollTop = Math.min(Math.max(0, pinned), max);
}

export function lockChartDetailsScroll(slot: HTMLElement | null) {
  const scroll = slot?.closest('.chat-scroll') as HTMLElement | null;
  if (!scroll) return;

  scroll.dataset.chartDetailsPinnedTop = String(scroll.scrollTop);
  scroll.dataset.chartDetailsLayoutLockUntil = String(Date.now() + CHART_DETAILS_LAYOUT_LOCK_MS);
}

/**
 * While chart hover details animate open/closed, block ChatPanel's auto scroll-to-bottom
 * so the message can grow downward without yanking the viewport (and the hovered bar).
 */
export function useChartDetailsLayoutLock(slotRef: RefObject<HTMLDivElement | null>) {
  const lastHeightRef = useRef(0);
  const lastScrollTopRef = useRef(0);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;

    const scroll = slot.closest('.chat-scroll') as HTMLElement | null;
    if (!scroll) return;

    lastHeightRef.current = slot.getBoundingClientRect().height;
    lastScrollTopRef.current = scroll.scrollTop;

    const rememberScrollTop = () => {
      if (isChartDetailsLayoutLocked(scroll)) return;
      lastScrollTopRef.current = scroll.scrollTop;
    };

    const ro = new ResizeObserver(() => {
      const nextHeight = slot.getBoundingClientRect().height;
      const delta = nextHeight - lastHeightRef.current;
      lastHeightRef.current = nextHeight;
      if (Math.abs(delta) < 0.5) return;

      if (scroll.dataset.chartDetailsPinnedTop == null) {
        scroll.dataset.chartDetailsPinnedTop = String(lastScrollTopRef.current);
      }
      scroll.dataset.chartDetailsLayoutLockUntil = String(Date.now() + CHART_DETAILS_LAYOUT_LOCK_MS);
      restorePinnedScrollTop(scroll);
      requestAnimationFrame(() => {
        restorePinnedScrollTop(scroll);
        lastScrollTopRef.current = scroll.scrollTop;
      });
    });

    scroll.addEventListener('scroll', rememberScrollTop, { passive: true });
    ro.observe(slot);
    return () => {
      scroll.removeEventListener('scroll', rememberScrollTop);
      ro.disconnect();
    };
  }, [slotRef]);
}

export function isChartDetailsLayoutLocked(scroll: HTMLElement): boolean {
  const raw = scroll.dataset.chartDetailsLayoutLockUntil;
  return raw != null && raw !== '' && Number(raw) > Date.now();
}
