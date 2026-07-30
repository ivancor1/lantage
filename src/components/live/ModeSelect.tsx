'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { MODULE_CATALOGUE, type LiveModule, type ModuleDescriptor } from '@/lib/live/contract';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { cx } from '@/components/ui/cx';

/**
 * Mode selector over `MODULE_CATALOGUE`.
 *
 * A native `<select>` cannot show each module's blurb, its image count or what it
 * requires, and all three are things the operator has to know *before* running —
 * so this is a `menuitemradio` listbox instead. The catalogue is the single
 * source: nothing here restates a label, a blurb or a requirement.
 */

export interface ModeSelectProps {
  value: LiveModule | null;
  onChange: (next: LiveModule) => void;
  disabled?: boolean;
  className?: string;
}

export function requirementLabel(descriptor: ModuleDescriptor): string {
  return descriptor.requires.length === 0
    ? 'no key required · runs offline'
    : `requires ${descriptor.requires.join(' · ')}`;
}

export function ModeSelect({ value, onChange, disabled = false, className }: ModeSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = MODULE_CATALOGUE.find((entry) => entry.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const index = Math.max(
      0,
      MODULE_CATALOGUE.findIndex((entry) => entry.id === value),
    );
    itemRefs.current[index]?.focus();
  }, [open, value]);

  function moveFocus(from: number, delta: number): void {
    const count = MODULE_CATALOGUE.length;
    const next = (from + delta + count) % count;
    itemRefs.current[next]?.focus();
  }

  return (
    <div ref={rootRef} className={cx('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={cx(
          'flex h-12 w-full items-center gap-3 rounded-full border border-border bg-n-0 px-4 text-left',
          'transition-[background-color,border-color] duration-[140ms] ease-[var(--ease-smooth)]',
          'hover:bg-n-100 hover:border-n-400 disabled:pointer-events-none disabled:opacity-45',
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <Eyebrow mono className="leading-none">
            Mode
          </Eyebrow>
          <span
            className={cx(
              'truncate text-[15px] font-medium leading-none',
              selected ? 'text-fg' : 'text-fg-tertiary',
            )}
          >
            {selected ? selected.label : 'Choose a module'}
          </span>
        </span>
        {selected ? (
          <Eyebrow mono className="shrink-0 rounded-full border border-border px-2 py-[3px]">
            {selected.images === 2 ? '2 images' : '1 image'}
          </Eyebrow>
        ) : null}
        <ChevronDown
          aria-hidden
          className={cx(
            'size-4 shrink-0 text-fg-tertiary transition-transform duration-[140ms] ease-[var(--ease-smooth)]',
            open && 'rotate-180',
          )}
        />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Analysis modules"
          className="glass-card blur-in absolute left-0 right-0 top-[calc(100%+8px)] z-50 flex flex-col gap-1 p-1.5"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
        >
          {MODULE_CATALOGUE.map((descriptor, index) => {
            const active = descriptor.id === value;
            return (
              <button
                key={descriptor.id}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onChange(descriptor.id);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    moveFocus(index, 1);
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    moveFocus(index, -1);
                  }
                }}
                className={cx(
                  'rounded-nested flex w-full items-start gap-3 px-3 py-2.5 text-left',
                  'transition-colors duration-[140ms] ease-[var(--ease-smooth)] hover:bg-n-100',
                  active && 'bg-n-100',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-fg">{descriptor.label}</span>
                    <Eyebrow mono className="shrink-0 rounded-full border border-border px-1.5 py-px">
                      {descriptor.images === 2 ? '2 images' : '1 image'}
                    </Eyebrow>
                  </span>
                  {/* Blurb straight from the catalogue — it describes what the
                      module actually does, which is the point of showing it. */}
                  <span className="mt-1 block text-[12px] leading-snug text-fg-secondary">{descriptor.blurb}</span>
                  <Eyebrow mono className="mt-1.5 block text-n-400">
                    {requirementLabel(descriptor)}
                  </Eyebrow>
                </span>
                {active ? <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-fg" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
