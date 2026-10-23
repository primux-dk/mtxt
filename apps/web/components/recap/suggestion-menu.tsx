'use client';

/*
  The `/` block menu and the `@` mention menu: one listbox under the caret,
  driven by Tiptap's open Suggestion utility. Focus stays in the editor;
  the arrow keys move the active option (aria-activedescendant on the
  editor), Enter picks it, Escape closes. Clicking an option picks it too.
*/
import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import { cn } from 'cn';

export interface MenuItem {
  id: string;
  label: string;
  detail?: string | null;
  icon?: React.ReactNode;
}

interface MenuState<T extends MenuItem> {
  open: boolean;
  items: T[];
  active: number;
  rect: DOMRect | null;
  pick: ((item: T) => void) | null;
  loading: boolean;
}

/** One menu's state outside React, so the Suggestion plugin's callbacks can drive it. */
export function createMenu<T extends MenuItem>(id: string) {
  let state: MenuState<T> = {
    open: false,
    items: [],
    active: 0,
    rect: null,
    pick: null,
    loading: false,
  };
  const listeners = new Set<() => void>();
  let editor: Editor | null = null;
  const emit = () => listeners.forEach((l) => l());
  const set = (patch: Partial<MenuState<T>>) => {
    state = { ...state, ...patch };
    const dom = editor?.view.dom;
    if (dom) {
      if (state.open && state.items.length) {
        dom.setAttribute('aria-controls', id);
        dom.setAttribute('aria-expanded', 'true');
        dom.setAttribute('aria-activedescendant', `${id}-${state.active}`);
      } else {
        dom.removeAttribute('aria-controls');
        dom.setAttribute('aria-expanded', 'false');
        dom.removeAttribute('aria-activedescendant');
      }
    }
    emit();
  };
  const fromProps = (props: SuggestionProps<T, T>) => {
    editor = props.editor;
    set({
      open: true,
      items: props.items,
      active: Math.min(state.active, Math.max(0, props.items.length - 1)),
      rect: props.clientRect?.() ?? null,
      pick: (item) => props.command(item),
      loading: false,
    });
  };
  return {
    id,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => state,
    /** Suggestion's `render`. */
    render: () => ({
      onStart: (props: SuggestionProps<T, T>) => {
        state = { ...state, active: 0 };
        fromProps(props);
      },
      onUpdate: (props: SuggestionProps<T, T>) => fromProps(props),
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        if (!state.open) return false;
        if (event.key === 'Escape') {
          set({ open: false });
          return true;
        }
        if (!state.items.length) return false;
        if (event.key === 'ArrowDown') {
          set({ active: (state.active + 1) % state.items.length });
          return true;
        }
        if (event.key === 'ArrowUp') {
          set({ active: (state.active - 1 + state.items.length) % state.items.length });
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const item = state.items[state.active];
          if (item) state.pick?.(item);
          return true;
        }
        return false;
      },
      onExit: () => set({ open: false, items: [], rect: null, pick: null }),
    }),
  };
}

export type Menu<T extends MenuItem> = ReturnType<typeof createMenu<T>>;

export function SuggestionMenu<T extends MenuItem>({
  menu,
  label,
  empty,
}: {
  menu: Menu<T>;
  /** The listbox's accessible name. */
  label: string;
  /** Said when nothing matches. */
  empty: string;
}) {
  const state = useSyncExternalStore(menu.subscribe, menu.get, menu.get);
  if (!state.open || !state.rect || typeof document === 'undefined') return null;
  // Under the caret, kept on screen.
  const width = 288;
  const left = Math.max(8, Math.min(state.rect.left, window.innerWidth - width - 8));
  const below = state.rect.bottom + 6;
  const room = window.innerHeight - below;
  const style: React.CSSProperties =
    room > 220
      ? { left, top: below, width, maxHeight: Math.min(320, room - 8) }
      : { left, bottom: window.innerHeight - state.rect.top + 6, width, maxHeight: 320 };
  return createPortal(
    <div
      id={menu.id}
      role="listbox"
      aria-label={label}
      className="fixed z-50 overflow-y-auto rounded-card border border-border bg-popover p-1 text-sm text-popover-foreground shadow-floating"
      style={style}
      // Clicks pick without moving the editor's focus.
      onMouseDown={(e) => e.preventDefault()}
    >
      {state.items.length === 0 ? (
        <p className="px-3 py-2 text-muted-foreground">{empty}</p>
      ) : (
        state.items.map((item, i) => (
          <div
            key={item.id}
            id={`${menu.id}-${i}`}
            role="option"
            aria-selected={i === state.active}
            className={cn(
              'flex min-h-10 cursor-pointer items-center gap-3 rounded-control px-3 py-1.5 max-shell:min-h-11',
              i === state.active && 'bg-accent text-accent-foreground',
            )}
            onClick={() => state.pick?.(item)}
          >
            {item.icon && (
              <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center">
                {item.icon}
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate">{item.label}</span>
              {item.detail && (
                <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>
              )}
            </span>
          </div>
        ))
      )}
    </div>,
    document.body,
  );
}
