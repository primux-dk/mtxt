import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { test as base, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { parse } from 'yaml';

/*
  Every response the recorder API sends in the e2e run is checked against
  packages/contract/openapi.yaml: the status must be documented for that
  operation, and a JSON body must match its schema (Draft 2020-12, the
  dialect OpenAPI 3.1 uses).
*/
type Spec = {
  paths: Record<string, Record<string, { responses: Record<string, Response | { $ref: string }> }>>;
  components: { responses: Record<string, Response> };
};
type Response = { content?: Record<string, { schema: unknown }> };

const spec = parse(
  readFileSync(new URL('../../../packages/contract/openapi.yaml', import.meta.url), 'utf8'),
) as Spec;
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(spec as object, 'openapi');

/** `#/x` refs in a schema taken out of the document, pointed back at it. */
const rebase = (node: unknown): unknown =>
  Array.isArray(node)
    ? node.map(rebase)
    : node && typeof node === 'object'
      ? Object.fromEntries(
          Object.entries(node).map(([k, v]) => [
            k,
            k === '$ref' && typeof v === 'string' && v.startsWith('#/') ? `openapi${v}` : rebase(v),
          ]),
        )
      : node;

const templates = Object.keys(spec.paths).map((path) => ({
  path,
  pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`),
}));

/** Checks one response; returns the operation it matched, or null for a path outside the contract. */
export async function checkContract(method: string, url: string, status: number, body: string) {
  const path = new URL(url, 'http://x').pathname.replace(/^\/api\/v1/, '');
  const template = templates.find((t) => t.pattern.test(path));
  if (!template || !new URL(url, 'http://x').pathname.startsWith('/api/v1/')) return null;
  const operation = spec.paths[template.path]![method.toLowerCase()];
  expect(operation, `${method} ${template.path} is in the contract`).toBeTruthy();
  let response = operation!.responses[String(status)];
  expect(response, `${method} ${template.path} documents ${status}`).toBeTruthy();
  if (response && '$ref' in response) {
    response = spec.components.responses[response.$ref.split('/').pop()!]!;
  }
  const schema = response?.content?.['application/json']?.schema;
  if (schema) {
    const validate = ajv.compile(rebase(schema) as object);
    const ok = validate(JSON.parse(body));
    expect(
      ok,
      `${method} ${template.path} ${status}: ${ajv.errorsText(validate.errors)}\n${body}`,
    ).toBe(true);
  }
  return `${method.toUpperCase()} ${template.path} ${status}`;
}

/** Operation and status of every checked response, one line each, for the run's coverage list. */
const SEEN_FILE = 'test-results/contract-seen.txt';
export const seen = {
  add(hit: string) {
    mkdirSync('test-results', { recursive: true });
    appendFileSync(SEEN_FILE, `${hit}\n`);
  },
};

/** The request context, with every /api/v1 response checked against the contract. */
export function contractChecked(request: APIRequestContext): APIRequestContext {
  const wrap =
    (method: string, call: (url: string, options?: object) => Promise<APIResponse>) =>
    async (url: string, options?: object) => {
      const response = await call(url, options);
      const hit = await checkContract(
        method,
        response.url(),
        response.status(),
        await response.text(),
      );
      if (hit) seen.add(hit);
      return response;
    };
  return new Proxy(request, {
    get(target, key) {
      if (key === 'get' || key === 'post' || key === 'put' || key === 'delete') {
        return wrap(key, target[key].bind(target));
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The same check for a raw fetch. */
export async function checkFetch(method: string, response: globalThis.Response) {
  const text = await response.clone().text();
  const hit = await checkContract(method, response.url, response.status, text);
  if (hit) seen.add(hit);
}

/**
 * The Playwright `test` for specs that touch the API: its `request` checks
 * every response, and so does its `page`, for the calls the browser makes
 * (the upload dialog, the recorder, their retries).
 */
export const test = base.extend({
  request: async ({ request }, provide) => {
    await provide(contractChecked(request));
  },
  page: async ({ page }, provide) => {
    const checks: Promise<unknown>[] = [];
    page.on('response', (response) => {
      if (!new URL(response.url()).pathname.startsWith('/api/v1/')) return;
      checks.push(
        response
          .text()
          .then(async (text) => {
            const hit = await checkContract(
              response.request().method(),
              response.url(),
              response.status(),
              text,
            );
            if (hit) seen.add(hit);
          })
          // A body the page aborted or navigated away from cannot be read; its status still counts.
          .catch((error: Error) => {
            if (error.name === 'Error' && /expect/i.test(error.message)) throw error;
          }),
      );
    });
    await provide(page);
    await Promise.all(checks);
  },
});
