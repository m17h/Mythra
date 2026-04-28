import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface AppSelectOption<T extends string> {
  value: T;
  label: string;
}

interface AppSelectProps<T extends string> {
  options: Array<AppSelectOption<T>>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
  portalDropdown?: boolean;
  /** For accessibility when the control is not wrapped in a `<label>`. */
  ariaLabelledBy?: string;
}

export function AppSelect<T extends string>({
  options,
  value,
  onChange,
  className = '',
  portalDropdown = false,
  ariaLabelledBy
}: AppSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const activeOption = useMemo(() => options.find((option) => option.value === value) ?? options[0], [options, value]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        if (portalDropdown && menuRef.current?.contains(event.target as Node)) return;
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [portalDropdown]);

  useLayoutEffect(() => {
    if (!open || !portalDropdown || !rootRef.current) {
      setDropdownPos(null);
      return;
    }
    const update = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      setDropdownPos({ top: rect.bottom + 5, left: rect.left, width: rect.width });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, portalDropdown]);

  const menu = open ? (
    <div
      className={`app-select__menu ${portalDropdown ? 'app-select__menu--portal' : ''}`}
      ref={menuRef}
      role="listbox"
      style={portalDropdown && dropdownPos ? { position: 'fixed', top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width } : undefined}
    >
      {options.map((option) => (
        <button
          aria-selected={option.value === value}
          className={`app-select__option ${option.value === value ? 'is-active' : ''}`}
          key={option.value}
          onClick={(event) => {
            event.stopPropagation();
            onChange(option.value);
            setOpen(false);
          }}
          onMouseDown={(event) => {
            /* Keep label parents from re-activating the trigger (menu “stays open”). */
            event.stopPropagation();
          }}
          role="option"
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div className={`app-select ${open ? 'is-open' : ''} ${className}`.trim()} ref={rootRef}>
      <button
        aria-expanded={open}
        aria-labelledby={ariaLabelledBy}
        className="app-select__button"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
        type="button"
      >
        <span>{activeOption?.label ?? value}</span>
        <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M4 5.5L7 8.5l3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {portalDropdown ? createPortal(menu, document.body) : menu}
    </div>
  );
}
