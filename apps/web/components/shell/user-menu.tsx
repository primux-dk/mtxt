'use client';

import { ChevronsUpDown, KeyRound, Laptop, LogOut } from 'lucide-react';
import { useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Avatar } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ApiTokensDialog } from './api-tokens-dialog';
import { RecordersDialog } from './recorders-dialog';

/**
 * The signed-in user as one row, a button that opens a menu with Recorders,
 * API tokens and Sign out. The sidebar and the mobile Sheet render the same menu. Enter or
 * Space opens it, arrows move, Escape closes it and focus returns to the row;
 * Recorders and API tokens return focus there when their dialogs close
 * (behaviour.md rule 11).
 */
export function UserMenu({
  user,
  companyName,
  signOut,
}: {
  user: { name: string };
  companyName?: string | null;
  /** The server action that ends the session and goes to /login. */
  signOut: () => Promise<void>;
}) {
  const t = useTranslations('auth');
  const r = useTranslations('recorders');
  const a = useTranslations('apiTokens');
  const [recorders, setRecorders] = useState(false);
  const [apiTokens, setApiTokens] = useState(false);
  const [, startTransition] = useTransition();
  const row = useRef<HTMLButtonElement>(null);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            ref={row}
            type="button"
            className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-control px-2 py-1.5 text-left text-[13px] transition-[background-color] hover:bg-secondary data-[state=open]:bg-secondary"
          >
            <Avatar name={user.name} />
            <span className="min-w-0 grow">
              <span className="block truncate font-[550]" title={user.name}>
                {user.name}
              </span>
              {companyName && (
                <span className="block truncate text-xs text-muted-foreground" title={companyName}>
                  {companyName}
                </span>
              )}
            </span>
            <ChevronsUpDown
              aria-hidden="true"
              strokeWidth={1.5}
              className="size-4 shrink-0 text-muted-foreground"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          className="w-(--radix-dropdown-menu-trigger-width)"
        >
          <DropdownMenuItem onSelect={() => setRecorders(true)}>
            <Laptop aria-hidden="true" />
            {r('open')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setApiTokens(true)}>
            <KeyRound aria-hidden="true" />
            {a('open')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => startTransition(() => signOut())}>
            <LogOut aria-hidden="true" />
            {t('signOut')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RecordersDialog open={recorders} onOpenChange={setRecorders} returnFocusTo={row} />
      <ApiTokensDialog open={apiTokens} onOpenChange={setApiTokens} returnFocusTo={row} />
    </>
  );
}
