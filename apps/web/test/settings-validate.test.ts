import { describe, expect, it } from 'vitest';
import { validateSettings, validateTemplate, type Current } from '../lib/settings/validate';

const SELF = 'mette@example.com';
const configured: Current = {
  identityProvider: 'entra',
  hasClientSecret: true,
  sttProvider: 'assemblyai',
  hasSttKey: true,
  recapProvider: 'workers-ai',
  hasRecapKey: false,
};

/** A form that passes, with overrides. `null` removes a field. */
function form(overrides: Record<string, string | string[] | null> = {}) {
  const values: Record<string, string | string[] | null> = {
    productName: 'Primux Møder',
    companyName: 'Fiskerihavnens Værksted på Ærø ApS',
    themeAccent: '#566b45',
    themePrimary: '#111111',
    identityProvider: 'entra',
    oidcTenantId: '00000000-0000-4000-8000-000000000001',
    oidcClientId: '00000000-0000-4000-8000-000000000002',
    oidcClientSecret: '',
    sttProvider: 'assemblyai',
    sttApiKey: '',
    sttRegion: '',
    language: 'da',
    interfaceLanguage: 'da',
    timeZone: 'Europe/Copenhagen',
    keyterms: 'Primux\nlinje 2,2',
    liveTranscriptDefault: 'on',
    defaultVisibility: 'private',
    recordingSources: ['desktop', 'upload'],
    retentionAudioDays: '30',
    retentionTranscriptDays: '365',
    mcpEnabled: null,
    adminEmails: `${SELF}\nAnne@Example.com`,
    ...overrides,
  };
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (value === null) continue;
    for (const v of Array.isArray(value) ? value : [value]) data.append(key, v);
  }
  return data;
}

const errorsOf = (data: FormData, current = configured) => {
  const result = validateSettings(data, current, SELF);
  return result.ok ? {} : result.errors;
};

describe('validateSettings', () => {
  it('accepts a complete form and keeps stored secrets when the fields are blank', () => {
    const result = validateSettings(form(), configured, SELF);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch).toMatchObject({
      productName: 'Primux Møder',
      liveTranscriptDefault: true,
      mcpEnabled: false,
      recordingSources: ['desktop', 'upload'],
      adminEmails: [SELF, 'anne@example.com'],
    });
    expect(result.keyterms).toEqual([
      { term: 'Primux', boost: null },
      { term: 'linje 2', boost: 2 },
    ]);
    expect(result.secrets).toEqual({});
    expect(result.clearSttKey).toBe(false);
  });

  it('takes a 120-character product name and refuses 121', () => {
    expect(errorsOf(form({ productName: 'x'.repeat(120) }))).toEqual({});
    expect(errorsOf(form({ productName: 'x'.repeat(121) })).productName).toEqual({
      code: 'tooLong',
      max: 120,
    });
    expect(errorsOf(form({ productName: '   ' })).productName).toEqual({ code: 'required' });
  });

  it('refuses a bad hex value', () => {
    expect(errorsOf(form({ themeAccent: '#56b45' })).themeAccent).toEqual({
      code: 'hex',
      value: '#56b45',
    });
    expect(errorsOf(form({ themePrimary: 'black' })).themePrimary).toMatchObject({ code: 'hex' });
  });

  it('refuses a colour that fails 4.5:1, with the ratio, at the field it depends on', () => {
    const errors = errorsOf(form({ themeAccent: '#a3c47d' }));
    expect(errors.themeAccent).toMatchObject({
      code: 'contrast',
      pair: 'accentText',
      mode: 'light',
    });
    expect((errors.themeAccent as { ratio: number }).ratio).toBeLessThan(4.5);
    expect(errors.themePrimary).toBeUndefined();
    expect(errorsOf(form({ themePrimary: '#ffd400' })).themePrimary).toMatchObject({
      code: 'contrast',
      pair: 'primaryText',
    });
  });

  it('refuses retention 0, a fraction and more than ten years', () => {
    expect(errorsOf(form({ retentionAudioDays: '0' })).retentionAudioDays).toEqual({
      code: 'range',
      min: 1,
      max: 3650,
    });
    expect(
      errorsOf(form({ retentionTranscriptDays: '1.5' })).retentionTranscriptDays,
    ).toBeDefined();
    expect(
      errorsOf(form({ retentionTranscriptDays: '3651' })).retentionTranscriptDays,
    ).toBeDefined();
    expect(errorsOf(form({ retentionAudioDays: '1' })).retentionAudioDays).toBeUndefined();
  });

  it('refuses a bad admin email, an empty list and a list without the signed-in admin', () => {
    expect(errorsOf(form({ adminEmails: `${SELF}\nnot-an-email` })).adminEmails).toEqual({
      code: 'email',
      value: 'not-an-email',
    });
    expect(errorsOf(form({ adminEmails: '  ' })).adminEmails).toEqual({ code: 'atLeastOneAdmin' });
    expect(errorsOf(form({ adminEmails: 'anne@example.com' })).adminEmails).toEqual({
      code: 'keepSelf',
      email: SELF,
    });
  });

  it('asks for a client secret on a fresh install and when the provider changes', () => {
    const fresh: Current = {
      identityProvider: null,
      hasClientSecret: false,
      sttProvider: null,
      hasSttKey: false,
      recapProvider: 'workers-ai',
      hasRecapKey: false,
    };
    expect(errorsOf(form(), fresh).oidcClientSecret).toEqual({ code: 'secretRequired' });
    expect(
      errorsOf(form({ identityProvider: 'google', oidcTenantId: 'example.com' })).oidcClientSecret,
    ).toEqual({ code: 'secretRequired' });
    const withSecret = validateSettings(
      form({ oidcClientSecret: 'new-secret', sttProvider: '' }),
      fresh,
      SELF,
    );
    expect(withSecret.ok && withSecret.secrets).toEqual({ oidcClientSecret: 'new-secret' });
  });

  it('pins Entra to a tenant GUID, and holds Google to a domain', () => {
    // Domains and the multi-tenant aliases are refused for Entra.
    for (const tenant of ['contoso.onmicrosoft.com', 'common', 'organizations', 'consumers']) {
      expect(errorsOf(form({ oidcTenantId: tenant })).oidcTenantId, tenant).toEqual({
        code: 'tenantFormat',
      });
    }
    expect(errorsOf(form({ oidcTenantId: 'not a tenant' })).oidcTenantId).toEqual({
      code: 'tenantFormat',
    });
    expect(
      errorsOf(
        form({
          identityProvider: 'google',
          oidcTenantId: '00000000-0000-4000-8000-000000000001',
          oidcClientSecret: 's',
        }),
      ).oidcTenantId,
    ).toEqual({ code: 'domainFormat' });
  });

  it('needs a key for hosted speech-to-text and none for Workers AI or a local model', () => {
    expect(errorsOf(form({ sttProvider: 'elevenlabs' })).sttApiKey).toEqual({
      code: 'secretRequired',
    });
    const result = validateSettings(
      form({ sttProvider: 'workers-ai-whisper', sttApiKey: 'ignored' }),
      configured,
      SELF,
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.secrets).toEqual({});
    expect(result.ok && result.clearSttKey).toBe(true);
    for (const provider of ['local-whisper', 'local-parakeet']) {
      expect(errorsOf(form({ sttProvider: provider })).sttApiKey).toBeUndefined();
    }
  });

  it('refuses the providers this version does not have, and keeps the three it has', () => {
    for (const provider of ['azure', 'local-whisper', 'local-parakeet']) {
      expect(
        errorsOf(form({ sttProvider: provider, sttApiKey: 'k', sttRegion: 'westeurope' }))
          .sttProvider,
      ).toEqual({
        code: 'notAvailable',
      });
    }
    expect(
      validateSettings(form({ sttProvider: 'assemblyai', sttApiKey: 'k' }), configured, SELF).ok,
    ).toBe(true);
    expect(
      validateSettings(form({ sttProvider: 'elevenlabs', sttApiKey: 'k' }), configured, SELF).ok,
    ).toBe(true);
  });

  it('saves ElevenLabs with its key sealed and no region, whatever the form sends', () => {
    const result = validateSettings(
      form({ sttProvider: 'elevenlabs', sttApiKey: 'xi-1', sttRegion: 'eu' }),
      configured,
      SELF,
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.patch.sttProvider).toBe('elevenlabs');
    expect(result.ok && result.patch.sttRegion).toBeNull();
    expect(result.ok && result.secrets).toEqual({ sttApiKey: 'xi-1' });
    expect(result.ok && result.clearSttKey).toBe(false);
    // The stored key is AssemblyAI's (configured); it does not carry over.
    expect(validateSettings(form({ sttProvider: 'elevenlabs' }), configured, SELF)).toMatchObject({
      ok: false,
      errors: { sttApiKey: { code: 'secretRequired' } },
    });
    const same = { ...configured, sttProvider: 'elevenlabs' as const, hasSttKey: true };
    expect(validateSettings(form({ sttProvider: 'elevenlabs' }), same, SELF).ok).toBe(true);
  });

  it('takes an AI Gateway id, or none', () => {
    const ok = validateSettings(form({ aiGatewayId: 'mtxt-gateway_1' }), configured, SELF);
    expect(ok.ok && ok.patch.aiGatewayId).toBe('mtxt-gateway_1');
    const none = validateSettings(form({}), configured, SELF);
    expect(none.ok && none.patch.aiGatewayId).toBeNull();
    expect(errorsOf(form({ aiGatewayId: 'no spaces/here' })).aiGatewayId).toEqual({
      code: 'gatewayFormat',
    });
  });

  it('needs an Azure region', () => {
    expect(errorsOf(form({ sttProvider: 'azure', sttApiKey: 'k' })).sttRegion).toEqual({
      code: 'required',
    });
    expect(
      errorsOf(form({ sttProvider: 'azure', sttApiKey: 'k', sttRegion: 'West Europe' })).sttRegion,
    ).toEqual({ code: 'regionFormat' });
  });

  it('needs at least one recording source', () => {
    expect(errorsOf(form({ recordingSources: null })).recordingSources).toEqual({
      code: 'atLeastOneSource',
    });
    // Teams and Meet are no longer recording sources: a stale form value is dropped like any other.
    expect(errorsOf(form({ recordingSources: ['meet', 'teams'] })).recordingSources).toEqual({
      code: 'atLeastOneSource',
    });
    const result = validateSettings(
      form({ recordingSources: ['meet', 'zoom', 'browser'] }),
      configured,
      SELF,
    );
    expect(result.ok && result.patch.recordingSources).toEqual(['browser']);
  });

  it('reports a keyterm error with its line', () => {
    expect(errorsOf(form({ keyterms: 'Primux\nlinje 2,lots' })).keyterms).toEqual({
      code: 'badBoost',
      record: 2,
      value: 'lots',
      max: 10,
    });
  });

  it('reports every failing field at once', () => {
    const errors = errorsOf(form({ productName: '', retentionAudioDays: '0', adminEmails: 'x' }));
    expect(Object.keys(errors).sort()).toEqual([
      'adminEmails',
      'productName',
      'retentionAudioDays',
    ]);
  });
});

describe('validateSettings, one tab at a time (packet 14)', () => {
  /** Only the named fields, as one tab's form sends them. */
  const only = (names: string[], overrides: Record<string, string | string[] | null> = {}) => {
    const full = form(overrides);
    const data = new FormData();
    for (const [key, value] of full.entries()) if (names.includes(key)) data.append(key, value);
    return data;
  };

  it('saves the General tab alone, and leaves every other column out of the patch', () => {
    const data = only([
      'productName',
      'companyName',
      'themeAccent',
      'themePrimary',
      'interfaceLanguage',
      'timeZone',
    ]);
    const result = validateSettings(data, configured, SELF, ['general']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.patch).sort()).toEqual([
      'companyName',
      'interfaceLanguage',
      'productName',
      'themeAccent',
      'themePrimary',
      'timeZone',
    ]);
    // The keyterm list, the stored keys and the admin list stay as they are.
    expect(result.keyterms).toBeUndefined();
    expect(result.clearSttKey).toBe(false);
    expect(result.clearRecapKey).toBe(false);
  });

  it("reports only the tab's own fields", () => {
    // A form with every field broken: the Sharing tab hears only about its own.
    const broken = form({
      productName: '',
      adminEmails: 'x',
      retentionAudioDays: '0',
      keyterms: 'a,b',
    });
    const result = validateSettings(broken, configured, SELF, ['sharing']);
    expect(result.ok ? {} : Object.keys(result.errors)).toEqual(['retentionAudioDays']);
  });

  it('writes the keyterm list and the key state only from the Transcription tab', () => {
    const data = only(
      ['sttProvider', 'sttApiKey', 'sttRegion', 'aiGatewayId', 'language', 'keyterms'],
      {
        sttProvider: 'workers-ai-whisper',
      },
    );
    const result = validateSettings(data, configured, SELF, ['transcription']);
    expect(result).toMatchObject({
      ok: true,
      patch: { sttProvider: 'workers-ai-whisper', liveTranscriptDefault: false },
      keyterms: [{ term: 'Primux' }, { term: 'linje 2' }],
      clearSttKey: true,
      clearRecapKey: false,
    });
  });

  it('checks the admin list only on the Login tab, where it still keeps the signed-in admin', () => {
    const login = only(['identityProvider', 'oidcTenantId', 'oidcClientId', 'adminEmails'], {
      adminEmails: 'anne@example.com',
    });
    expect(validateSettings(login, configured, SELF, ['login'])).toMatchObject({
      ok: false,
      errors: { adminEmails: { code: 'keepSelf' } },
    });
    const recap = only(['recapProvider', 'recapModel']);
    const result = validateSettings(recap, configured, SELF, ['recap']);
    expect(result.ok && Object.keys(result.patch).sort()).toEqual(['recapModel', 'recapProvider']);
  });
});

describe('the time zone', () => {
  it('takes a zone the runtime knows, UTC when the field is missing, and refuses any other', () => {
    const zone = (value: string | null) => {
      const result = validateSettings(form({ timeZone: value }), configured, SELF, ['general']);
      return result.ok ? result.patch.timeZone : result.errors.timeZone;
    };
    expect(zone('Europe/Copenhagen')).toBe('Europe/Copenhagen');
    expect(zone('America/Buenos_Aires')).toBe('America/Buenos_Aires');
    expect(zone(null)).toBe('UTC');
    expect(zone('Europe/Atlantis')).toEqual({ code: 'invalid' });
    // Intl reads these; the list on the page has neither (packet 15 review).
    expect(zone('+01:00')).toEqual({ code: 'invalid' });
    expect(zone('CET')).toEqual({ code: 'invalid' });
    expect(zone('x'.repeat(65))).toEqual({ code: 'invalid' });
  });
});

describe('validateTemplate', () => {
  const others = [{ name: 'Produktionsmøde' }];

  it('accepts a new name', () => {
    expect(validateTemplate({ name: ' Projektstatus ', bodyMd: '# Overblik' }, others)).toEqual({
      ok: true,
      name: 'Projektstatus',
      bodyMd: '# Overblik',
    });
  });

  it('refuses a duplicate name, whatever the casing', () => {
    expect(validateTemplate({ name: 'PRODUKTIONSMØDE', bodyMd: '' }, others)).toEqual({
      ok: false,
      errors: { name: { code: 'duplicate', name: 'PRODUKTIONSMØDE' } },
    });
  });

  it('refuses a name that differs only by width or ß', () => {
    expect(validateTemplate({ name: 'STRASSE', bodyMd: '' }, [{ name: 'Straße' }])).toMatchObject({
      ok: false,
      errors: { name: { code: 'duplicate' } },
    });
  });

  it('refuses an empty name', () => {
    expect(validateTemplate({ name: '  ', bodyMd: '' }, others)).toMatchObject({
      ok: false,
      errors: { name: { code: 'required' } },
    });
  });
});

describe('the recap model', () => {
  it('defaults to Workers AI with no key and the default model', () => {
    const result = validateSettings(form(), configured, SELF);
    expect(result.ok && result.patch).toMatchObject({
      recapProvider: 'workers-ai',
      recapModel: null,
    });
    expect(result.ok && result.clearRecapKey).toBe(true);
  });

  it('needs a key for Anthropic, OpenAI and Azure OpenAI, and keeps one already stored for the same provider', () => {
    expect(errorsOf(form({ recapProvider: 'anthropic' })).recapApiKey).toEqual({
      code: 'secretRequired',
    });
    const withKey = validateSettings(
      form({ recapProvider: 'anthropic', recapApiKey: 'sk-1' }),
      configured,
      SELF,
    );
    expect(withKey.ok && withKey.secrets.recapApiKey).toBe('sk-1');
    const kept = validateSettings(
      form({ recapProvider: 'openai', recapModel: 'gpt-5.4' }),
      { ...configured, recapProvider: 'openai', hasRecapKey: true },
      SELF,
    );
    expect(kept.ok && kept.clearRecapKey).toBe(false);
    // Another provider needs its own key.
    expect(
      errorsOf(form({ recapProvider: 'anthropic' }), {
        ...configured,
        recapProvider: 'openai',
        hasRecapKey: true,
      }).recapApiKey,
    ).toEqual({ code: 'secretRequired' });
  });

  it('refuses a model id with spaces, and an Azure model that is not resource/deployment', () => {
    expect(errorsOf(form({ recapModel: 'llama 4' })).recapModel).toEqual({ code: 'modelFormat' });
    expect(
      errorsOf(form({ recapProvider: 'azure-openai', recapApiKey: 'k', recapModel: 'recaps' }))
        .recapModel,
    ).toEqual({ code: 'azureModel' });
    expect(
      errorsOf(
        form({ recapProvider: 'azure-openai', recapApiKey: 'k', recapModel: 'acme-openai/recaps' }),
      ).recapModel,
    ).toBeUndefined();
    expect(errorsOf(form({ recapProvider: 'gemini' })).recapProvider).toEqual({ code: 'invalid' });
  });
});
