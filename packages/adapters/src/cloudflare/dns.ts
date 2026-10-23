import type { HostResolver, ResolvedAddress } from '../dns';

const DOH = 'https://cloudflare-dns.com/dns-query';
/** DNS record types in a DoH JSON answer: A and AAAA. */
const ADDRESS_TYPES = new Set([1, 28]);

interface DohAnswer {
  Status?: number;
  Answer?: { type?: number; data?: string; TTL?: number }[];
}

/**
 * Resolves over Cloudflare's DNS over HTTPS (JSON API), A and AAAA at once.
 * A Worker has no resolver of its own; this is the same answer its fetch
 * would get. NXDOMAIN gives no addresses; any other failure throws.
 */
export function dohResolver(fetcher: typeof fetch = fetch, timeoutMs = 5000): HostResolver {
  const lookup = async (host: string, type: 'A' | 'AAAA'): Promise<ResolvedAddress[]> => {
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
    const records = answer.Answer ?? [];
    // A CNAME on the way counts too: the shortest TTL on the chain is how long the answer holds.
    const chainTtl = Math.min(...records.map((a) => (Number.isFinite(a.TTL) ? a.TTL! : 0)));
    return records
      .filter((a) => ADDRESS_TYPES.has(a.type ?? 0) && typeof a.data === 'string')
      .map((a) => ({ address: a.data!, ttl: chainTtl }));
  };
  return {
    async resolve(host) {
      const [v4, v6] = await Promise.all([lookup(host, 'A'), lookup(host, 'AAAA')]);
      return [...v4, ...v6];
    },
  };
}
