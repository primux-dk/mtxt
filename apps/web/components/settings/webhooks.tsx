'use client';

import { Copy, Plus, Send, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from 'cn';
import {
  addEndpointAction,
  deleteEndpointAction,
  sendTestEventAction,
  setEndpointEnabledAction,
  type AddResult,
  type EndpointRow,
  type EndpointsResult,
} from '@/app/(app)/settings/webhook-actions';
import { LocalTime } from '@/components/local-time';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { answerKey, eventKey, statusKey } from '@/lib/webhooks/labels';
import { MAX_ENDPOINTS, MAX_URL_LENGTH } from '@/lib/webhooks/rules';
import { describedBy, Field, FieldError } from './fields';

const EVENTS = [
  'meeting.transcribed',
  'recap.drafted',
  'recap.saved',
  'meeting.shared',
  'meeting.deleted',
] as const;

type Notice = { tone: 'status' | 'alert'; text: string } | null;
type Draft = { label: string; url: string; events: string[] };
const blank = (): Draft => ({ label: '', url: '', events: [...EVENTS] });

/**
 * The webhook endpoints (docs/spec.md "Webhooks"): the list with each one's
 * last delivery, and Add, which shows the signing secret once. Saved on
 * their own actions, not by "Save settings". Enable and Delete show at once
 * and roll back when the server refuses (behaviour rule 2); every answer
 * carries the server's list, so the screen ends in the server's state.
 */
export function Webhooks({ initial }: { initial: EndpointRow[] }) {
  const t = useTranslations('settings.webhooks');
  const tCommon = useTranslations('common');
  const [endpoints, setEndpoints] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(blank);
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const [addError, setAddError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ value: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [removing, setRemoving] = useState<EndpointRow | null>(null);
  const [pending, startTransition] = useTransition();
  const addButton = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  const deletedRef = useRef(false);

  // The secret takes focus once it is on the screen, so a keyboard user can copy it at once.
  useEffect(() => {
    if (!secret) return;
    secretRef.current?.focus();
    secretRef.current?.select();
  }, [secret]);

  const full = endpoints.length >= MAX_ENDPOINTS;
  const nameOf = (e: { label: string | null }) => e.label || t('unnamed');

  /** Applies the server's answer; on a refusal, `rollback` restores what the screen showed. */
  const settle = (result: EndpointsResult, rollback: () => void) => {
    if (result.ok) {
      setEndpoints(result.endpoints);
      return true;
    }
    rollback();
    if (result.endpoints) setEndpoints(result.endpoints);
    setNotice({ tone: 'alert', text: result.message });
    return false;
  };
  const failed = (message: string): EndpointsResult => ({ ok: false, message });

  const toggle = (endpoint: EndpointRow) => {
    const enabled = !endpoint.enabled;
    const before = endpoints;
    setEndpoints(endpoints.map((e) => (e.id === endpoint.id ? { ...e, enabled } : e)));
    setNotice(null);
    startTransition(async () => {
      const result = await setEndpointEnabledAction(endpoint.id, enabled).catch(() =>
        failed(t('changeFailed')),
      );
      if (settle(result, () => setEndpoints(before)))
        setNotice({
          tone: 'status',
          text: t(enabled ? 'nowEnabled' : 'nowDisabled', { name: nameOf(endpoint) }),
        });
    });
  };

  const sendTest = (endpoint: EndpointRow) => {
    setNotice(null);
    startTransition(async () => {
      const result = await sendTestEventAction(endpoint.id).catch(() => failed(t('testFailed')));
      if (settle(result, () => {}))
        setNotice({ tone: 'status', text: t('testQueued', { name: nameOf(endpoint) }) });
    });
  };

  const remove = () => {
    const gone = removing;
    if (!gone) return;
    const before = endpoints;
    deletedRef.current = true;
    setRemoving(null);
    setEndpoints(endpoints.filter((e) => e.id !== gone.id));
    setNotice(null);
    startTransition(async () => {
      const result = await deleteEndpointAction(gone.id).catch(() => failed(t('deleteFailed')));
      if (settle(result, () => setEndpoints(before)))
        setNotice({ tone: 'status', text: t('deleted', { name: nameOf(gone) }) });
    });
  };

  const openAdd = () => {
    setDraft(blank());
    setErrors({});
    setAddError(null);
    setSecret(null);
    setCopied(false);
    setAdding(true);
  };

  const submitAdd = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // The dialog sits inside the settings form in React's tree: this submit is not that one.
    e.stopPropagation();
    if (pending) return;
    setErrors({});
    setAddError(null);
    startTransition(async () => {
      const result: AddResult = await addEndpointAction(draft).catch(() => ({
        ok: false,
        message: t('addFailed'),
      }));
      if (!result.ok) {
        if (result.errors) setErrors(result.errors);
        setAddError(result.message ?? null);
        const first = result.errors?.url
          ? 'webhook-url'
          : result.errors?.label
            ? 'webhook-label'
            : null;
        if (first) requestAnimationFrame(() => document.getElementById(first)?.focus());
        return;
      }
      setEndpoints(result.endpoints);
      setSecret({ value: result.secret, name: draft.label.trim() || t('unnamed') });
      setNotice({ tone: 'status', text: t('added', { name: draft.label.trim() || t('unnamed') }) });
    });
  };

  const copy = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.value);
      setCopied(true);
    } catch {
      secretRef.current?.select();
    }
  };

  const lastLine = (e: EndpointRow) => {
    if (!e.last) return t('lastNone');
    const status = t(`status.${statusKey(e.last.status, e.last.attempts)}`);
    const answer = answerKey(e.last.error, e.last.code);
    const when = () => (
      <LocalTime
        date={new Date(e.last!.at)}
        options={{ dateStyle: 'medium', timeStyle: 'short' }}
      />
    );
    if (answer === 'none') return t.rich('lastShort', { status, when });
    return t.rich('last', {
      status,
      answer: t(`answer.${answer}`, { code: e.last.code ?? 0 }),
      when: () => (
        <LocalTime
          date={new Date(e.last!.at)}
          options={{ dateStyle: 'medium', timeStyle: 'short' }}
        />
      ),
    });
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-[550]">
          {t('endpoints')}{' '}
          <span className="font-normal text-muted-foreground tabular-nums">
            {t('count', { count: endpoints.length, max: MAX_ENDPOINTS })}
          </span>
        </p>
        <Button
          ref={addButton}
          onClick={openAdd}
          disabled={full}
          aria-describedby={full ? 'webhooks-full' : undefined}
        >
          <Plus aria-hidden="true" />
          {t('add')}
        </Button>
      </div>
      {full && (
        <p id="webhooks-full" className="text-xs text-muted-foreground">
          {t('tooManyNote')}
        </p>
      )}

      {endpoints.length === 0 ? (
        <p className="rounded-card border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <ul
          ref={listRef}
          aria-label={t('endpoints')}
          className="grid gap-3"
          data-testid="webhook-endpoints"
        >
          {endpoints.map((e) => (
            <li
              key={e.id}
              className="grid min-w-0 gap-2 rounded-card border border-border bg-card p-4"
              data-testid="webhook-endpoint"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 font-[550] [overflow-wrap:anywhere]">{nameOf(e)}</span>
                <span
                  className={cn(
                    'inline-flex items-center rounded-pill border px-2 py-px text-xs',
                    e.enabled
                      ? 'border-accent-line bg-accent-tint text-accent-foreground'
                      : 'border-border text-muted-foreground',
                  )}
                >
                  {e.enabled ? t('enabled') : t('disabled')}
                </span>
              </div>
              <p className="truncate font-mono text-xs text-muted-foreground" title={e.url}>
                {e.url}
              </p>
              <p className="text-xs text-muted-foreground">
                {e.events.map((event) => t(`eventNames.${eventKey(event)}`)).join(' · ')}
              </p>
              <p className="text-xs">{lastLine(e)}</p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button asChild>
                  <Link
                    href={`/settings/webhooks/${e.id}`}
                    aria-label={t('logLabel', { name: nameOf(e) })}
                  >
                    {t('log')}
                  </Link>
                </Button>
                <Button
                  onClick={() => sendTest(e)}
                  aria-label={t('testLabel', { name: nameOf(e) })}
                >
                  <Send aria-hidden="true" />
                  {t('test')}
                </Button>
                <Button
                  variant="quiet"
                  aria-pressed={e.enabled}
                  onClick={() => toggle(e)}
                  aria-label={t(e.enabled ? 'disableLabel' : 'enableLabel', { name: nameOf(e) })}
                >
                  {e.enabled ? t('disable') : t('enable')}
                </Button>
                <Button
                  variant="quiet"
                  className="text-destructive"
                  onClick={() => setRemoving(e)}
                  aria-label={t('deleteLabel', { name: nameOf(e) })}
                >
                  <Trash2 aria-hidden="true" />
                  {t('delete')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p
        role={notice?.tone ?? 'status'}
        className={cn(
          'text-sm',
          notice?.tone === 'alert' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {notice?.text}
      </p>

      <Dialog
        open={adding}
        onOpenChange={(open) => {
          if (pending) return;
          setAdding(open);
          if (!open) requestAnimationFrame(() => addButton.current?.focus());
        }}
      >
        <DialogContent closeLabel={tCommon('close')} onCloseAutoFocus={(e) => e.preventDefault()}>
          {secret ? (
            <div className="grid gap-4" data-testid="webhook-secret">
              <DialogTitle>{t('dialog.secretTitle')}</DialogTitle>
              <DialogDescription>{t('dialog.secretBody', { name: secret.name })}</DialogDescription>
              <div className="grid gap-1.5">
                <label htmlFor="webhook-secret" className="font-[550]">
                  {t('dialog.secret')}
                </label>
                <div className="flex gap-2">
                  <Input
                    ref={secretRef}
                    id="webhook-secret"
                    readOnly
                    value={secret.value}
                    spellCheck={false}
                    className="font-mono text-xs"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button onClick={copy}>
                    <Copy aria-hidden="true" />
                    {copied ? t('dialog.copied') : t('dialog.copy')}
                  </Button>
                </div>
                <small className="text-xs text-muted-foreground">{t('dialog.secretNote')}</small>
              </div>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="primary">{t('dialog.done')}</Button>
                </DialogClose>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={submitAdd} noValidate className="grid gap-4">
              <DialogTitle>{t('dialog.title')}</DialogTitle>
              <DialogDescription>{t('dialog.body')}</DialogDescription>
              <Field
                id="webhook-label"
                label={t('dialog.label')}
                help={t('dialog.labelHelp')}
                error={errors.label}
              >
                <Input
                  id="webhook-label"
                  value={draft.label}
                  onChange={(e) => {
                    setDraft({ ...draft, label: e.target.value });
                    setErrors((current) => ({ ...current, label: undefined }));
                  }}
                  autoComplete="off"
                  aria-invalid={errors.label ? true : undefined}
                  aria-describedby={describedBy('webhook-label', true, errors.label)}
                />
              </Field>
              <Field
                id="webhook-url"
                label={t('dialog.url')}
                help={t('dialog.urlHelp', { max: MAX_URL_LENGTH })}
                error={errors.url}
              >
                <Input
                  id="webhook-url"
                  type="url"
                  inputMode="url"
                  value={draft.url}
                  onChange={(e) => {
                    setDraft({ ...draft, url: e.target.value });
                    setErrors((current) => ({ ...current, url: undefined }));
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://"
                  aria-invalid={errors.url ? true : undefined}
                  aria-describedby={describedBy('webhook-url', true, errors.url)}
                />
              </Field>
              <fieldset
                className="grid gap-2"
                aria-describedby={errors.events ? 'webhook-events-error' : undefined}
              >
                <legend className="mb-1 text-sm font-[550]">{t('dialog.events')}</legend>
                {EVENTS.map((event) => (
                  <label
                    key={event}
                    className="flex min-h-6 items-center gap-2 text-sm max-shell:min-h-11"
                  >
                    <input
                      type="checkbox"
                      checked={draft.events.includes(event)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          events: e.target.checked
                            ? [...draft.events, event]
                            : draft.events.filter((x) => x !== event),
                        })
                      }
                      className="size-4 accent-[var(--accent-strong)]"
                    />
                    {t(`eventNames.${eventKey(event)}`)}
                    <code className="text-xs text-muted-foreground">{event}</code>
                  </label>
                ))}
                <FieldError id="webhook-events" error={errors.events} />
              </fieldset>
              {addError && (
                <p role="alert" className="text-sm text-destructive">
                  {addError}
                </p>
              )}
              <DialogFooter>
                <DialogClose asChild>
                  <Button disabled={pending}>{tCommon('cancel')}</Button>
                </DialogClose>
                <Button type="submit" variant="primary" aria-busy={pending || undefined}>
                  <Plus aria-hidden="true" />
                  {t('dialog.submit')}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent
          closeLabel={tCommon('close')}
          onCloseAutoFocus={(e) => {
            // After a delete the row's buttons are gone; focus goes to Add, which is always there.
            if (deletedRef.current) {
              e.preventDefault();
              deletedRef.current = false;
              addButton.current?.focus();
            }
          }}
        >
          <DialogTitle>{t('deleteTitle')}</DialogTitle>
          <DialogDescription>
            {t('deleteBody', { name: removing ? nameOf(removing) : '' })}
          </DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button>{tCommon('cancel')}</Button>
            </DialogClose>
            <Button variant="destructive" onClick={remove}>
              <Trash2 aria-hidden="true" />
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
