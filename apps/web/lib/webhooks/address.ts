/*
  Where a webhook may go (docs/spec.md "Webhooks", Outbound addresses). An
  endpoint's URL is https, at most 2,048 characters, without credentials,
  and its host is neither a local name nor, once resolved, any private
  address: the Worker must never become a way into someone's network.
  Checked when the endpoint is saved and again before every attempt, since
  DNS can change in between. The e2e run's receiver on http://localhost
  passes only with `allowLocal`, which only the e2e build sets.
*/
import type { HostResolver } from '@mtxt/adapters';
import { MAX_URL_LENGTH } from './rules';

export type UrlProblem = 'invalid' | 'not_https' | 'credentials' | 'too_long' | 'private_host';
export type TargetProblem = 'private_address' | 'dns';

const LOCAL_TEST_HOSTS = new Set(['localhost', '127.0.0.1']);
const LOCAL_NAMES = /(^|\.)(localhost|internal|local)$/i;

/** The e2e receiver's form: http on localhost or 127.0.0.1 with a port. */
const isLocalTestUrl = (url: URL) =>
  url.protocol === 'http:' && LOCAL_TEST_HOSTS.has(url.hostname) && url.port !== '';

export function checkEndpointUrl(
  raw: string,
  options: { allowLocal?: boolean } = {},
): { ok: true; url: URL } | { ok: false; problem: UrlProblem } {
  if (raw.length > MAX_URL_LENGTH) return { ok: false, problem: 'too_long' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: 'invalid' };
  }
  if (options.allowLocal && isLocalTestUrl(url)) return { ok: true, url };
  if (url.protocol !== 'https:') return { ok: false, problem: 'not_https' };
  if (url.username || url.password) return { ok: false, problem: 'credentials' };
  const host = hostOf(url);
  if (!host || LOCAL_NAMES.test(host) || (!host.includes('.') && !host.includes(':')))
    return { ok: false, problem: 'private_host' };
  if (isIpLiteral(host) && isPrivateAddress(host)) return { ok: false, problem: 'private_host' };
  return { ok: true, url };
}

/** The hostname without IPv6 brackets or a trailing dot. */
function hostOf(url: URL) {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

const isIpLiteral = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');

/**
 * Resolves the URL's host and refuses it when any address is private, or
 * when it has none. Null means the request may go.
 */
export async function checkTarget(
  url: URL,
  resolver: HostResolver,
  options: { allowLocal?: boolean } = {},
): Promise<TargetProblem | null> {
  if (options.allowLocal && isLocalTestUrl(url)) return null;
  const checked = checkEndpointUrl(url.toString());
  if (!checked.ok) return 'private_address';
  const host = hostOf(url);
  if (isIpLiteral(host)) return isPrivateAddress(host) ? 'private_address' : null;
  let addresses: string[];
  try {
    addresses = await resolver.resolve(host);
  } catch {
    return 'dns';
  }
  if (addresses.length === 0) return 'dns';
  return addresses.some(isPrivateAddress) ? 'private_address' : null;
}

/** IPv4 as four numbers, or null. */
function v4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

function privateV4([a, b]: number[]): boolean {
  return (
    a === 0 || // "this network"
    a === 10 || // RFC 1918
    (a === 100 && b! >= 64 && b! <= 127) || // carrier-grade NAT, RFC 6598
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local
    (a === 172 && b! >= 16 && b! <= 31) || // RFC 1918
    (a === 192 && b === 0) || // IETF protocol assignments (192.0.0/24) and 192.0.2/24
    (a === 192 && b === 168) || // RFC 1918
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a! >= 224 // multicast and reserved, broadcast included
  );
}

/** IPv6 as eight 16-bit groups, or null. Takes an embedded dotted IPv4 tail. */
function v6(text: string): number[] | null {
  let address = text.toLowerCase().split('%')[0]!;
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (tail) {
    const four = v4(tail[1]!);
    if (!four) return null;
    address =
      address.slice(0, -tail[1]!.length) +
      `${((four[0]! << 8) | four[1]!).toString(16)}:${((four[2]! << 8) | four[3]!).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * Whether an address is anything but a public unicast one: RFC 1918,
 * loopback, link-local, carrier-grade NAT, unique local, multicast,
 * unspecified, and IPv6 forms that carry such an IPv4 address. Anything
 * that does not parse counts as private.
 */
export function isPrivateAddress(address: string): boolean {
  const four = v4(address);
  if (four) return privateV4(four);
  const g = v6(address);
  if (!g) return true;
  const embedded = () => [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
  if (g.slice(0, 7).every((x) => x === 0)) return true; // :: and ::1
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0))
    return privateV4(embedded()); // IPv4-mapped and IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
    return privateV4(embedded()); // NAT64
  if (g[0] === 0x2002) return privateV4([g[1]! >> 8, g[1]! & 255, g[2]! >> 8, g[2]! & 255]); // 6to4
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  return false;
}
