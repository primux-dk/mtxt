'use client';

import { Copy, KeyRound, Plus, RotateCw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
  createMyApiToken,
  listMyApiTokens,
  revokeMyApiToken,
  type ApiTokenView,
  type CreateResult,
} from '@/app/(app)/api-tokens/actions';
import { LocalTime } from '@/components/local-time';
import { controlClass, describedBy, Field } from '@/components/settings/fields';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

type ListState = { state: 'loading' | 'failed' } | { state: 'done'; tokens: ApiTokenView[] };
type Step = 'list' | 'create' | 'secret';
type Draft = { name: string; scope: 'read' | 'read_write'; days: 30 | 90 | 365 };

/** The client's copy of the limits in packages/adapters (recorder-auth.ts). */
const MAX_TOKENS = 25;
const DAYS = [30, 90, 365] as const;
const blank = (): Draft => ({ name: '', scope: 'read', days: 365 });
const DATE: Intl.DateTimeFormatOptions = { dateStyle: 'medium' };

/**
 * "API tokens" in the user menu (docs/spec.md "API"): the signed-in user's
 * personal API tokens, a form to make one, the token shown once with Copy,
 * and Revoke. The list loads when the dialog opens. Revoke is optimistic:
 * the row goes at once and comes back with a message if the server refuses
 * (behaviour.md rule 2). Each step has one primary action (rule 10); field
 * errors sit at the field and keep what was typed (rule 9). The Dialog
 * traps focus and returns it to the menu's button (rule 11).
 */
export function ApiTokensDialog({
  open,
  onOpenChange,
  returnFocusTo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusTo: React.RefObject<HTMLElement | null>;
}) {
  const t = useTranslations('apiTokens');
  const common = useTranslations('common');
  const [list, setList] = useState<ListState>({ state: 'loading' });
  const [step, setStep] = useState<Step>('list');
  const [draft, setDraft] = useState<Draft>(blank);
  const [nameError, setNameError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ token: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();
  const asked = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);

  const load = async () => {
    const n = ++asked.current;
    setList({ state: 'loading' });
    let result: Awaited<ReturnType<typeof listMyApiTokens>>;
    try {
      result = await listMyApiTokens();
    } catch {
      result = { ok: false };
    }
    if (n !== asked.current) return;
    setList(result.ok ? { state: 'done', tokens: result.tokens } : { state: 'failed' });
  };

  useEffect(() => {
    if (open) void load();
    else {
      // The token is gone from the screen once the dialog closes; it was shown once.
      setStep('list');
      setSecret(null);
      setError(null);
      setDraft(blank());
      setNameError(undefined);
      setFormError(null);
    }
  }, [open]);

  // Each step's heading takes focus as it appears; the token's field takes it on the last step.
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      if (step === 'secret') {
        secretRef.current?.focus();
        secretRef.current?.select();
      } else heading.current?.focus();
    });
  }, [step, open]);

  const tokens = list.state === 'done' ? list.tokens : [];
  const full = list.state === 'done' && tokens.length >= MAX_TOKENS;

  const nameMessage = (
    code: NonNullable<Extract<CreateResult, { ok: false }>['errors']>['name'],
  ) =>
    code === 'required'
      ? t('errors.nameRequired')
      : code === 'tooLong'
        ? t('errors.nameTooLong', { max: 64 })
        : t('errors.nameInvalid');

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    setNameError(undefined);
    setFormError(null);
    startTransition(async () => {
      const result: CreateResult = await createMyApiToken(draft).catch(() => ({
        ok: false,
        code: 'server' as const,
      }));
      if (!result.ok) {
        if (result.errors?.name) {
          setNameError(nameMessage(result.errors.name));
          requestAnimationFrame(() => document.getElementById('api-token-name')?.focus());
        } else {
          setFormError(
            result.code === 'too_many'
              ? t('errors.tooMany', { max: MAX_TOKENS })
              : t('errors.createFailed'),
          );
        }
        return;
      }
      setList((current) =>
        current.state === 'done'
          ? { state: 'done', tokens: [result.row, ...current.tokens] }
          : current,
      );
      setSecret({ token: result.token, name: result.row.name });
      setCopied(false);
      setDraft(blank());
      setStep('secret');
    });
  };

  const copy = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.token);
      setCopied(true);
    } catch {
      secretRef.current?.select();
    }
  };

  const revoke = async (token: ApiTokenView, index: number) => {
    setError(null);
    setList((current) =>
      current.state === 'done'
        ? { state: 'done', tokens: current.tokens.filter((x) => x.id !== token.id) }
        : current,
    );
    // Focus moves to the row that takes this one's place, else to New token.
    requestAnimationFrame(() => {
      const rows = document.querySelectorAll<HTMLButtonElement>('[data-api-token-revoke]');
      (rows[Math.min(index, rows.length - 1)] ?? newButton.current ?? heading.current)?.focus();
    });
    let result: Awaited<ReturnType<typeof revokeMyApiToken>>;
    try {
      result = await revokeMyApiToken(token.id);
    } catch {
      result = { ok: false, code: 'server' };
    }
    // Already gone on the server (another window revoked it): the row stays away.
    if (result.ok || result.code === 'not_found') return;
    setList((current) =>
      current.state === 'done'
        ? {
            state: 'done',
            tokens: [...current.tokens, token].sort((a, b) =>
              b.createdAt.localeCompare(a.createdAt),
            ),
          }
        : current,
    );
    setError(t('revokeFailed', { name: token.name }));
  };

  const scopeLabel = (scope: ApiTokenView['scope']) =>
    scope === 'read_write' ? t('scope.readWrite') : t('scope.read');

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        closeLabel={common('close')}
        className="max-w-[600px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          heading.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (!returnFocusTo.current) return;
          event.preventDefault();
          returnFocusTo.current.focus();
        }}
      >
        {step === 'secret' && secret ? (
          <div className="grid gap-4" data-testid="api-token-secret">
            <div className="grid gap-2">
              <DialogTitle ref={heading} tabIndex={-1} className="outline-none">
                {t('secret.title')}
              </DialogTitle>
              <DialogDescription>{t('secret.body', { name: secret.name })}</DialogDescription>
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="api-token-value" className="font-[550]">
                {t('secret.label')}
              </label>
              <div className="flex gap-2 max-shell:flex-col">
                <Input
                  ref={secretRef}
                  id="api-token-value"
                  readOnly
                  value={secret.token}
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button onClick={copy}>
                  <Copy aria-hidden="true" />
                  {copied ? t('secret.copied') : t('secret.copy')}
                </Button>
              </div>
              <small className="text-xs text-muted-foreground">{t('secret.note')}</small>
              <p role="status" className="sr-only">
                {copied ? t('secret.copied') : ''}
              </p>
            </div>
            <DialogFooter>
              <Button variant="primary" onClick={() => setStep('list')}>
                {t('secret.done')}
              </Button>
            </DialogFooter>
          </div>
        ) : step === 'create' ? (
          <form onSubmit={submit} noValidate className="grid gap-4">
            <div className="grid gap-2">
              <DialogTitle ref={heading} tabIndex={-1} className="outline-none">
                {t('create.title')}
              </DialogTitle>
              <DialogDescription>{t('create.body')}</DialogDescription>
            </div>
            <Field
              id="api-token-name"
              label={t('create.name')}
              help={t('create.nameHelp', { max: 64 })}
              error={nameError}
            >
              <Input
                id="api-token-name"
                value={draft.name}
                onChange={(e) => {
                  setDraft({ ...draft, name: e.target.value });
                  setNameError(undefined);
                }}
                autoComplete="off"
                aria-invalid={nameError ? true : undefined}
                aria-describedby={describedBy('api-token-name', true, nameError)}
              />
            </Field>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-[550]">{t('create.scope')}</legend>
              {(['read', 'read_write'] as const).map((scope) => (
                <label key={scope} className="flex items-start gap-2 text-sm max-shell:min-h-11">
                  <input
                    type="radio"
                    name="api-token-scope"
                    value={scope}
                    checked={draft.scope === scope}
                    onChange={() => setDraft({ ...draft, scope })}
                    className="mt-0.5 size-4 accent-[var(--accent-strong)]"
                  />
                  <span>
                    <span className="block font-[550]">{scopeLabel(scope)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {scope === 'read' ? t('create.readHelp') : t('create.readWriteHelp')}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            <Field id="api-token-days" label={t('create.lifetime')}>
              <select
                id="api-token-days"
                className={controlClass}
                value={draft.days}
                onChange={(e) =>
                  setDraft({ ...draft, days: Number(e.target.value) as Draft['days'] })
                }
              >
                {DAYS.map((days) => (
                  <option key={days} value={days}>
                    {t(`create.days.${days}`)}
                  </option>
                ))}
              </select>
            </Field>
            {formError && (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            )}
            <DialogFooter>
              <Button disabled={pending} onClick={() => setStep('list')}>
                {common('cancel')}
              </Button>
              <Button type="submit" variant="primary" aria-busy={pending || undefined}>
                <Plus aria-hidden="true" />
                {t('create.submit')}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <div className="grid gap-2">
              <DialogTitle ref={heading} tabIndex={-1} className="outline-none">
                {t('title')}
              </DialogTitle>
              <DialogDescription>{t('description')}</DialogDescription>
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
                {error}
              </p>
            )}

            {list.state === 'loading' && (
              <p role="status" className="text-sm text-muted-foreground">
                {t('loading')}
              </p>
            )}
            {list.state === 'failed' && (
              <div role="alert" className="grid justify-items-start gap-3">
                <p className="text-sm text-destructive">{t('failed')}</p>
                <Button onClick={() => void load()}>
                  <RotateCw aria-hidden="true" />
                  {t('retry')}
                </Button>
              </div>
            )}
            {list.state === 'done' && (
              <div className="grid justify-items-start gap-2">
                <Button
                  ref={newButton}
                  variant="primary"
                  disabled={full}
                  aria-describedby={full ? 'api-tokens-full' : undefined}
                  onClick={() => {
                    setError(null);
                    setStep('create');
                  }}
                >
                  <Plus aria-hidden="true" />
                  {t('new')}
                </Button>
                {full && (
                  <p id="api-tokens-full" className="text-xs text-muted-foreground">
                    {t('full', { max: MAX_TOKENS })}
                  </p>
                )}
              </div>
            )}
            {list.state === 'done' && tokens.length === 0 && (
              <div className="grid gap-1 rounded-control border border-border px-4 py-5 text-sm">
                <p className="font-[550]">{t('empty.title')}</p>
                <p className="text-muted-foreground">{t('empty.body')}</p>
              </div>
            )}
            {list.state === 'done' && tokens.length > 0 && (
              <section aria-labelledby="api-tokens-count" className="grid gap-2">
                <h3 id="api-tokens-count" className="text-sm font-[550]">
                  {t('count', { count: tokens.length })}
                </h3>
                <ul
                  data-testid="api-tokens-list"
                  className="max-h-[min(420px,50dvh)] overflow-y-auto rounded-control border border-border"
                >
                  {tokens.map((token, i) => (
                    <li
                      key={token.id}
                      className="flex items-center gap-3 border-b border-line-subtle px-3 py-3 last:border-b-0"
                    >
                      <KeyRound
                        aria-hidden="true"
                        strokeWidth={1.5}
                        className="size-5 shrink-0 text-muted-foreground"
                      />
                      <div className="min-w-0 grow">
                        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="font-[550] [overflow-wrap:anywhere]">{token.name}</span>
                          <span className="rounded-pill border border-border px-2 text-xs text-muted-foreground">
                            {scopeLabel(token.scope)}
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t('created')} <LocalTime date={token.createdAt} options={DATE} />
                          {' · '}
                          {t('expires')} <LocalTime date={token.expiresAt} options={DATE} />
                          {' · '}
                          {token.lastUsedAt ? (
                            <>
                              {t('lastUsed')} <LocalTime date={token.lastUsedAt} options={DATE} />
                            </>
                          ) : (
                            t('neverUsed')
                          )}
                        </p>
                      </div>
                      <Button
                        data-api-token-revoke
                        aria-label={t('revokeLabel', { name: token.name })}
                        onClick={() => void revoke(token, i)}
                      >
                        <Trash2 aria-hidden="true" />
                        <span className="max-shell:sr-only">{t('revoke')}</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
