'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  saveSettings,
  seal,
  setDefaultTemplate,
  updateTemplate,
  type SecretContext,
  type Template,
} from '@mtxt/adapters';
import { getSessionUser } from '@/lib/auth/session';
import { getAdapters, getEnv, getInstallSettings } from '@/lib/install';
import { fieldMessage } from '@/lib/settings/messages';
import { isFormTab, TAB_FIELDS, type FormTab } from '@/lib/settings/tabs';
import {
  validateSettings,
  validateTemplate,
  type Field,
  type TemplateField,
} from '@/lib/settings/validate';

/*
  The settings page's server actions. Each one checks for an admin itself: a
  server action is a public endpoint, whatever the page around it shows.
*/

export type SaveResult =
  | { status: 'saved'; message: string }
  | { status: 'invalid'; errors: Partial<Record<Field, string>> }
  | { status: 'error'; message: string };

async function admin() {
  const user = await getSessionUser();
  return user?.isAdmin ? user : null;
}

/**
 * Saves one tab of the settings page: its fields are validated and written,
 * every other column stays as it is, so two tabs never clobber each other.
 */
export async function saveSettingsAction(tab: FormTab, form: FormData): Promise<SaveResult> {
  const t = await getTranslations('settings');
  const user = await admin();
  if (!user) return { status: 'error', message: (await getTranslations('auth'))('forbidden.body') };
  if (!isFormTab(tab)) return { status: 'error', message: t('errors.saveFailed') };

  const current = await getInstallSettings();
  const result = validateSettings(
    form,
    {
      identityProvider: current.identityProvider,
      hasClientSecret: Boolean(current.oidcClientSecret),
      sttProvider: current.sttProvider,
      hasSttKey: Boolean(current.sttApiKey),
      recapProvider: current.recapProvider,
      hasRecapKey: Boolean(current.recapApiKey),
    },
    user.email,
    [tab],
  );
  if (!result.ok) {
    const errors: Partial<Record<Field, string>> = {};
    for (const field of TAB_FIELDS[tab]) {
      const error = result.errors[field];
      if (error) errors[field] = fieldMessage(t, error);
    }
    return { status: 'invalid', errors };
  }

  try {
    const env = await getEnv();
    const sealWith = async (value: string, context: SecretContext) => {
      if (!env.SETTINGS_KEY) throw new Error('SETTINGS_KEY is not set.');
      return seal(value, context, env.SETTINGS_KEY);
    };
    const { db, installId } = await getAdapters();
    await saveSettings(
      db,
      installId,
      {
        ...result.patch,
        ...(result.secrets.oidcClientSecret
          ? {
              oidcClientSecret: await sealWith(
                result.secrets.oidcClientSecret,
                'settings.oidc_client_secret',
              ),
            }
          : {}),
        ...(result.secrets.sttApiKey
          ? { sttApiKey: await sealWith(result.secrets.sttApiKey, 'settings.stt_api_key') }
          : result.clearSttKey
            ? { sttApiKey: null }
            : {}),
        ...(result.secrets.recapApiKey
          ? {
              recapApiKey: await sealWith(result.secrets.recapApiKey, 'settings.recap_api_key'),
            }
          : result.clearRecapKey
            ? { recapApiKey: null }
            : {}),
      },
      result.keyterms,
    );
  } catch (error) {
    console.error('Could not save the settings:', error);
    return { status: 'error', message: t('errors.saveFailed') };
  }
  // Saving the Transcription tab with a provider: recordings that waited for one start now: one drain job queues them, 100 at a
  // time (docs/decisions.md, packet 4 review). A queue failure is said, not swallowed.
  if (result.patch.sttProvider) {
    const { installId, queue } = await getAdapters();
    try {
      await queue.send({ type: 'drain_transcriptions', install_id: installId });
    } catch (error) {
      console.error('Could not queue the waiting recordings:', (error as Error).name);
      revalidatePath('/', 'layout');
      return { status: 'error', message: (await getTranslations('stt'))('drainFailed') };
    }
  }
  // The shell, the theme and the language come from this row on every page.
  revalidatePath('/', 'layout');
  return { status: 'saved', message: t('saved') };
}

export type TemplateRow = Pick<Template, 'id' | 'name' | 'bodyMd' | 'isDefault'>;
export type TemplateResult =
  | { ok: true; templates: TemplateRow[] }
  | {
      ok: false;
      /** The server's list, so the screen ends in the server's state. */
      templates?: TemplateRow[];
      errors?: Partial<Record<TemplateField, string>>;
      message?: string;
    };

const rows = (list: Template[]): TemplateRow[] =>
  list.map(({ id, name, bodyMd, isDefault }) => ({ id, name, bodyMd, isDefault }));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function templateAction(
  id: string,
  run: (
    db: Awaited<ReturnType<typeof getAdapters>>['db'],
    installId: string,
    list: Template[],
  ) => Promise<TemplateResult | void>,
): Promise<TemplateResult> {
  if (!(await admin()) || !UUID.test(id)) return { ok: false };
  const { db, installId } = await getAdapters();
  try {
    const list = await listTemplates(db, installId);
    const early = await run(db, installId, list);
    if (early) return early;
    revalidatePath('/settings/recap');
    return { ok: true, templates: rows(await listTemplates(db, installId)) };
  } catch (error) {
    console.error('Template change failed:', error);
    return { ok: false, templates: rows(await listTemplates(db, installId).catch(() => [])) };
  }
}

async function checked(value: { id: string; name: string; bodyMd: string }, list: Template[]) {
  const result = validateTemplate(
    value,
    list.filter((t) => t.id !== value.id),
  );
  if (result.ok) return result;
  const t = await getTranslations('settings');
  const errors: Partial<Record<TemplateField, string>> = {};
  for (const [field, error] of Object.entries(result.errors)) {
    errors[field as TemplateField] = fieldMessage(t, error);
  }
  return { ok: false as const, errors };
}

/** Adds a template. The id comes from the browser, so a retry of the same add cannot make two. */
export async function addTemplateAction(value: { id: string; name: string; bodyMd: string }) {
  return templateAction(value.id, async (db, installId, list) => {
    const result = await checked(value, list);
    if (!result.ok) return { ...result, templates: rows(list) };
    await createTemplate(db, installId, { id: value.id, name: result.name, bodyMd: result.bodyMd });
  });
}

export async function saveTemplateAction(value: { id: string; name: string; bodyMd: string }) {
  return templateAction(value.id, async (db, installId, list) => {
    const result = await checked(value, list);
    if (!result.ok) return { ...result, templates: rows(list) };
    await updateTemplate(db, installId, value.id, { name: result.name, bodyMd: result.bodyMd });
  });
}

export async function setDefaultTemplateAction(id: string) {
  return templateAction(id, (db, installId) => setDefaultTemplate(db, installId, id));
}

export async function deleteTemplateAction(id: string) {
  return templateAction(id, (db, installId) => deleteTemplate(db, installId, id));
}
