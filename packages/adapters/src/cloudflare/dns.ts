import type { HostResolver } from '../dns';

const DOH = 'https://cloudflare-dns.com/dns-query';
/** DNS record types in a DoH JSON answer: A and AAAA. */
const ADDRESS_TYPES = new Set([1, 28]);

interface DohAnswer {
  Status?: number;
  Answer?: { type?: number; data?: string }[];
}

/**
 * Resolves over Cloudflare's DNS over HTTPS (JSON API), A and AAAA at once.
 * A Worker has no resolver of its own; this is the same answer its fetch
 * would get. NXDOMAIN gives no addresses; any other failure throws.
 */
export function dohResolver(fetcher: typeof fetch = fetch, timeoutMs = 5000): HostResolver {
  const lookup = async (host: string, type: 'A' | 'AAAA') => {
    const url = `${DOH}?name=${encodeURIComponent(host)}&type=${type}`;
    const response = await fetcher(url, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`DNS lookup failed: HTTP ${response.status}`);
    }
    const answer = (await response.json()) as DohAnswer;
    // 0 is NOERROR, 3 is NXDOMAIN: both are answers. Anything else is a failed lookup.
    if (answer.Status !== 0 && answer.Status !== 3) throw new Error('DNS lookup failed');
    return (answer.Answer ?? [])
      .filter((a) => ADDRESS_TYPES.has(a.type ?? 0) && typeof a.data === 'string')
      .map((a) => a.data!);
  };
  return {
    async resolve(host) {
      const [v4, v6] = await Promise.all([lookup(host, 'A'), lookup(host, 'AAAA')]);
      return [...v4, ...v6];
    },
  };
}
