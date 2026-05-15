import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ModelInfo } from '@shared/types';

const MODEL_HOVER_TOOLTIP_MS = 500;
const DROPDOWN_EXIT_MS = 150;

type ModelHoverTooltip = { fullId: string; left: number; top: number };

function sortModelsByFavorites(models: ModelInfo[], favoriteIds: string[]): ModelInfo[] {
  const fav = new Set(favoriteIds);
  return [...models].sort((a, b) => {
    const aF = fav.has(a.id) ? 0 : 1;
    const bF = fav.has(b.id) ? 0 : 1;
    if (aF !== bF) return aF - bF;
    return a.id.localeCompare(b.id);
  });
}

export function ModelSearch({
  models,
  value,
  favoriteIds = [],
  onChange,
  onToggleFavorite,
  portalDropdown = false
}: {
  models: ModelInfo[];
  value: string;
  favoriteIds?: string[];
  onChange: (id: string) => void;
  onToggleFavorite?: (id: string) => void;
  /** Render dropdown in a portal so it escapes overflow-hidden ancestors. */
  portalDropdown?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [animState, setAnimState] = useState<'entering' | 'open' | 'exiting' | 'closed'>('closed');
  const [hoverTooltip, setHoverTooltip] = useState<ModelHoverTooltip | null>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const tipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      setMounted(true);
      setAnimState('entering');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setAnimState('open'));
      });
    } else if (mounted) {
      setAnimState('exiting');
      exitTimerRef.current = setTimeout(() => {
        exitTimerRef.current = null;
        setMounted(false);
        setAnimState('closed');
      }, DROPDOWN_EXIT_MS);
    }
    return () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, [open]);

  const clearTipTimer = useCallback(() => {
    if (tipTimerRef.current) {
      clearTimeout(tipTimerRef.current);
      tipTimerRef.current = null;
    }
  }, []);

  const hideHoverTooltip = useCallback(() => {
    clearTipTimer();
    setHoverTooltip(null);
  }, [clearTipTimer]);

  const scheduleHoverTooltip = useCallback(
    (el: HTMLElement, fullId: string) => {
      clearTipTimer();
      tipTimerRef.current = setTimeout(() => {
        tipTimerRef.current = null;
        const r = el.getBoundingClientRect();
        const margin = 8;
        const estW = 360;
        let left = r.right + margin;
        let top = r.top;
        if (left + estW > window.innerWidth - margin) {
          left = Math.max(margin, r.left);
          top = r.bottom + margin;
        }
        setHoverTooltip({ fullId, left, top });
      }, MODEL_HOVER_TOOLTIP_MS);
    },
    [clearTipTimer]
  );

  useEffect(() => {
    return () => clearTipTimer();
  }, [clearTipTimer]);

  useEffect(() => {
    if (!open) hideHoverTooltip();
  }, [open, hideHoverTooltip]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        if (portalDropdown && dropdownRef.current?.contains(e.target as Node)) return;
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [portalDropdown]);

  const updateDropdownPosition = useCallback(() => {
    if (!portalDropdown || !inputRef.current) {
      setDropdownPos(null);
      return;
    }
    const rect = inputRef.current.getBoundingClientRect();
    setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
  }, [portalDropdown]);

  useLayoutEffect(() => {
    if (!mounted || !portalDropdown) {
      setDropdownPos(null);
      return;
    }
    updateDropdownPosition();
    const onReposition = () => updateDropdownPosition();
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
    return () => {
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
    };
  }, [mounted, portalDropdown, updateDropdownPosition]);

  const baseList = sortModelsByFavorites(
    query ? models.filter((m) => m.id.toLowerCase().includes(query.toLowerCase())) : models,
    favoriteIds
  );
  const filtered = baseList;

  const displayValue = value || '';

  const isPortalAnimated = portalDropdown && (animState === 'entering' || animState === 'open' || animState === 'exiting');
  const portalAnimClass = animState === 'open' ? 'is-open' : animState === 'exiting' ? 'is-exiting' : '';

  const showDropdown = portalDropdown ? mounted : open;

  const dropdownContent = showDropdown ? (
    <div
      ref={dropdownRef}
      className={`model-search__dropdown ${portalDropdown ? `model-search__dropdown--portal ${portalAnimClass}` : ''}`}
      style={
        isPortalAnimated && dropdownPos
          ? { position: 'fixed', top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width }
          : portalDropdown ? { position: 'fixed', visibility: 'hidden' } : undefined
      }
      onScroll={hideHoverTooltip}
    >
      {filtered.length === 0 ? (
        <div className="model-search__empty">No models match &ldquo;{query}&rdquo;</div>
      ) : (
        filtered.slice(0, 50).map((m) => {
          const isFav = favoriteIds.includes(m.id);
          return (
            <div
              className={`model-search__row ${m.id === value ? 'is-active' : ''}`}
              key={m.id}
            >
              {onToggleFavorite && (
                <button
                  className="model-search__star"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onToggleFavorite(m.id);
                  }}
                  type="button"
                  aria-pressed={isFav}
                  title={isFav ? 'Remove from favorites' : 'Favorite this model'}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M12 2.5l2.4 5.3 5.8.5-4.3 3.7 1.3 5.6L12 16.1 6.8 17.5l1.3-5.6-4.3-3.7 5.8-.5L12 2.5z"
                      stroke="currentColor"
                      strokeLinejoin="round"
                      fill={isFav ? 'currentColor' : 'none'}
                      strokeWidth="1.4"
                    />
                  </svg>
                </button>
              )}
              <button
                className="model-search__option"
                onMouseDown={(e) => {
                  // Keeps focus from returning to the input after click so onFocus doesn't reopen the list.
                  e.preventDefault();
                }}
                onClick={() => {
                  hideHoverTooltip();
                  onChange(m.id);
                  setOpen(false);
                  setQuery('');
                  inputRef.current?.blur();
                }}
                onMouseEnter={(e) => scheduleHoverTooltip(e.currentTarget, m.id)}
                onMouseLeave={hideHoverTooltip}
                type="button"
              >
                <span className="model-search__option-id">{m.id}</span>
                {m.contextLength ? (
                  <span className="model-search__option-ctx">{Math.round(m.contextLength / 1024)}k ctx</span>
                ) : null}
              </button>
            </div>
          );
        })
      )}
      {filtered.length > 50 && (
        <div className="model-search__more">+ {filtered.length - 50} more results. Refine your search.</div>
      )}
    </div>
  ) : null;

  return (
    <div className="model-search" ref={ref}>
      <input
        ref={inputRef}
        className="model-search__input"
        placeholder="Search models..."
        value={open ? query : displayValue}
        onFocus={() => {
          setOpen(true);
          setQuery('');
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
      />
      {portalDropdown ? createPortal(dropdownContent, document.body) : dropdownContent}
      {hoverTooltip &&
        createPortal(
          <div
            className="model-search__name-tooltip"
            role="tooltip"
            style={{ left: hoverTooltip.left, top: hoverTooltip.top }}
          >
            {hoverTooltip.fullId}
          </div>,
          document.body
        )}
    </div>
  );
}
