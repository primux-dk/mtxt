/**
 * Name resolution for outbound requests to addresses an admin typed (the
 * webhook endpoints): the caller refuses a host that resolves to a private
 * address before it sends anything. Cloudflare resolves over DNS over
 * HTTPS; a Docker edition binds the system resolver behind the same
 * interface.
 */
export interface ResolvedAddress {
  address: string;
  /** Seconds, as the resolver answered: the lowest TTL on the chain to this address. */
  ttl: number;
}

export interface HostResolver {
  /** Every A and AAAA address of the host, CNAMEs followed. Throws when the lookup itself fails. */
  resolve(host: string): Promise<ResolvedAddress[]>;
}
