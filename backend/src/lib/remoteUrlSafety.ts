import dns from "dns/promises";
import net from "net";

const BLOCKED_METADATA_HOSTS = new Set(["metadata.google.internal", "instance-data"]);

const blockedIpv4 = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) blockedIpv4.addSubnet(network, prefix, "ipv4");

const mappedIpv4 = new net.BlockList();
mappedIpv4.addSubnet("::ffff:0:0", 96, "ipv6");

const publicIpv6 = new net.BlockList();
publicIpv6.addSubnet("2000::", 3, "ipv6");

const blockedIpv6 = new net.BlockList();
for (const [network, prefix] of [
  ["2001::", 32], ["2001:2::", 32], ["2001:db8::", 32], ["2002::", 16],
] as const) blockedIpv6.addSubnet(network, prefix, "ipv6");
blockedIpv6.addRange("2001:10::", "2001:2f:ffff:ffff:ffff:ffff:ffff:ffff", "ipv6");

function isBlockedIp(ip: string) {
  const family = net.isIP(ip);
  if (family === 4) return blockedIpv4.check(ip, "ipv4");
  if (family === 6) {
    if (mappedIpv4.check(ip, "ipv6")) {
      const dotted = /(?:^|:)(\d+(?:\.\d+){3})$/u.exec(ip)?.[1];
      const [upper = 0, lower = 0] = ip.split(":").slice(-2)
        .map((part) => Number.parseInt(part, 16));
      return blockedIpv4.check(dotted ?? `${upper >>> 8}.${upper & 255}.${
        lower >>> 8}.${lower & 255}`, "ipv4");
    }
    return !publicIpv6.check(ip, "ipv6") || blockedIpv6.check(ip, "ipv6");
  }
  return true;
}

type ApprovedAddress = { address: string; family: 4 | 6 };

export type RemoteUrlPolicy = {
  label?: string;
  allowedHosts?: readonly string[];
  allowedOrigins?: readonly string[];
  maxUrlLength?: number;
  defaultPortOnly?: boolean;
  allowIpLiterals?: boolean;
  blockedHostSuffixes?: readonly string[];
};

export type RemoteResponsePolicy = {
  label?: string;
  maxBytes: number;
  contentTypes?: readonly string[];
};

export type RemoteFetchPolicy = RemoteUrlPolicy & {
  timeoutMs?: number;
  response?: RemoteResponsePolicy;
};

export function normalizeRemoteHttpsUrl(rawUrl: string, policy: RemoteUrlPolicy = {}) {
  const label = policy.label ?? "Remote URL";
  const refuse: (detail: string) => never = (detail) => {
    throw new Error(`${label} ${detail}`);
  };
  if (policy.maxUrlLength !== undefined && rawUrl.length > policy.maxUrlLength)
    refuse("is too long.");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return refuse("must be a valid URL.");
  }
  if (url.protocol !== "https:") refuse("must use HTTPS.");
  if (url.username || url.password) refuse("must not include credentials.");
  if (policy.defaultPortOnly && url.port) refuse("must use the default HTTPS port.");
  url.hash = "";

  const hostname = url.hostname.toLowerCase();
  const lookupHostname = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1) : hostname;
  if (hostname === "localhost" || hostname.endsWith(".localhost") ||
      BLOCKED_METADATA_HOSTS.has(hostname) ||
      policy.blockedHostSuffixes?.some((suffix) => hostname.endsWith(suffix.toLowerCase())))
    refuse("points to a blocked host.");
  if (policy.allowIpLiterals === false && net.isIP(lookupHostname))
    refuse("must not use an IP-literal host.");
  const allowedHosts = policy.allowedHosts?.map((value) => value.toLowerCase());
  if (allowedHosts && !allowedHosts.includes(hostname))
    refuse("is outside the allowed hosts.");
  const allowedOrigins = policy.allowedOrigins?.map((value) =>
    new URL(value).origin.toLowerCase());
  if (allowedOrigins && !allowedOrigins.includes(url.origin.toLowerCase()))
    refuse("is outside the allowed origins.");

  return { url, hostname: lookupHostname };
}

async function resolveRemoteHttpsUrl(rawUrl: string, policy: RemoteUrlPolicy = {}) {
  const { url, hostname: lookupHostname } = normalizeRemoteHttpsUrl(rawUrl, policy);
  const literalFamily = net.isIP(lookupHostname);
  const resolved = literalFamily
    ? [{ address: lookupHostname, family: literalFamily }]
    : await dns.lookup(lookupHostname, { all: true, verbatim: true });
  if (!resolved.length || resolved.some(({ address }) => isBlockedIp(address)))
    throw new Error(`${policy.label ?? "Remote URL"} resolves to a blocked network address.`);
  return { url: url.toString(), hostname: lookupHostname,
    addresses: resolved.map(({ address }) => ({ address, family: net.isIP(address) as 4 | 6 })) };
}

export async function validateRemoteHttpsUrl(rawUrl: string, policy: RemoteUrlPolicy = {}) {
  return (await resolveRemoteHttpsUrl(rawUrl, policy)).url;
}

const mediaType = (response: Response) =>
  response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";

const matchesContentType = (actual: string, allowed: readonly string[]) =>
  allowed.some((candidate) => {
    const expected = candidate.toLowerCase();
    const wildcard = expected.indexOf("*");
    return wildcard < 0
      ? actual === expected
      : actual.startsWith(expected.slice(0, wildcard)) &&
        actual.endsWith(expected.slice(wildcard + 1));
  });

export async function boundRemoteResponse(response: Response, policy: RemoteResponsePolicy) {
  const label = policy.label ?? "Remote response";
  const oversize = () => new Error(`${label} exceeds the size limit.`);
  if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes <= 0) {
    throw new Error("Remote response maxBytes must be a positive integer.");
  }
  if (response.ok && policy.contentTypes?.length) {
    const actual = mediaType(response);
    if (!actual || !matchesContentType(actual, policy.contentTypes)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${label} has an unsupported content type.`);
    }
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > policy.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw oversize();
  }
  if (!response.body) return response;

  let received = 0;
  const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > policy.maxBytes) throw oversize();
      controller.enqueue(chunk);
    },
  }));
  return new Response(bounded, { status: response.status,
    statusText: response.statusText, headers: response.headers });
}

export async function bufferRemoteResponse(response: Response, policy: RemoteResponsePolicy) {
  const bounded = await boundRemoteResponse(response, policy);
  if (!bounded.body) return bounded;
  const bytes = await bounded.arrayBuffer();
  return new Response(bytes.byteLength ? bytes : null, { status: bounded.status,
    statusText: bounded.statusText, headers: bounded.headers });
}

function pinnedLookup(approved: ApprovedAddress[]): net.LookupFunction {
  return (_hostname, options, callback) => {
    const requestedFamily = options.family === 4 || options.family === "IPv4" ? 4
      : options.family === 6 || options.family === "IPv6" ? 6 : 0;
    const matching = requestedFamily
      ? approved.filter(({ family }) => family === requestedFamily) : approved;
    if (!matching.length) {
      callback(Object.assign(new Error("No approved address matches the requested family."),
        { code: "ENOTFOUND" }), "", 0);
      return;
    }
    if (options.all) {
      callback(null, matching);
      return;
    }
    callback(null, matching[0].address, matching[0].family);
  };
}

export async function guardedRemoteFetch(input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1], policy: RemoteFetchPolicy = {}): Promise<Response> {
  const request = typeof input === "string" || input instanceof URL ? null : input;
  const approved = await resolveRemoteHttpsUrl(
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    policy);
  // undici costs ~100ms to require; guarded fetches are per-request work,
  // so the dependency loads on first use instead of at server boot.
  const { Agent, fetch: undiciFetch } = await import("undici");
  const dispatcher = new Agent({
    connect: {
      lookup: pinnedLookup(approved.addresses),
      ...(net.isIP(approved.hostname) ? {} : { servername: approved.hostname }),
    },
    autoSelectFamily: approved.addresses.length > 1,
  });
  try {
    // A direct dispatcher intentionally ignores HTTP(S)_PROXY: a proxy must
    // enforce the same destination checks at CONNECT time before it is safe.
    const inheritedInit = request ? {
      method: request.method, headers: request.headers, body: request.body,
      cache: request.cache, credentials: request.credentials, integrity: request.integrity,
      keepalive: request.keepalive, mode: request.mode, referrer: request.referrer,
      referrerPolicy: request.referrerPolicy, signal: request.signal,
    } : {};
    const body = init && Object.prototype.hasOwnProperty.call(init, "body")
      ? init.body : request?.body;
    const streamLikeBody = body !== null && typeof body === "object" &&
      (("getReader" in body &&
        typeof (body as { getReader?: unknown }).getReader === "function") ||
        Symbol.asyncIterator in body);
    const hasDuplex = !!init && Object.prototype.hasOwnProperty.call(init, "duplex");
    const signals = [request?.signal, init?.signal]
      .filter((signal): signal is AbortSignal => Boolean(signal));
    if (policy.timeoutMs !== undefined) {
      if (!Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs <= 0) {
        throw new Error("Remote fetch timeoutMs must be a positive integer.");
      }
      signals.push(AbortSignal.timeout(policy.timeoutMs));
    }
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const response = (await undiciFetch(approved.url, {
      ...inheritedInit,
      ...init,
      ...(body === undefined ? {} : { body }),
      ...(streamLikeBody && !hasDuplex ? { duplex: "half" as const } : {}),
      ...(signal ? { signal } : {}),
      redirect: "manual",
      dispatcher,
    } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
    return policy.response ? boundRemoteResponse(response, policy.response) : response;
  } finally {
    // close() is graceful: the streaming response stays usable while its
    // one-request pool shuts down after the body completes.
    void dispatcher.close().catch(() => undefined);
  }
}
