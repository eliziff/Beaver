import dns from "dns/promises";
import net from "net";

const BLOCKED_METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "instance-data",
]);

function isPrivateIpv4(ip: string) {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && parts[2] === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}

function isPrivateIpv6(ip: string) {
  let normalized = ip.toLowerCase();
  const dottedTail = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (dottedTail) {
    const octets = dottedTail
      .split(".")
      .map((part) => Number.parseInt(part, 10));
    normalized =
      `${normalized.slice(0, -dottedTail.length)}` +
      `${((octets[0] << 8) | octets[1]).toString(16)}:` +
      `${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return true;
  const left = halves[0]
    ? halves[0].split(":").map((part) => Number.parseInt(part, 16))
    : [];
  const right = halves[1]
    ? halves[1].split(":").map((part) => Number.parseInt(part, 16))
    : [];
  const missing = 8 - left.length - right.length;
  const groups =
    halves.length === 2
      ? [...left, ...Array(Math.max(0, missing)).fill(0), ...right]
      : left;
  if (
    groups.length !== 8 ||
    groups.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)
  ) {
    return true;
  }

  const mapped =
    groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff;
  if (mapped) {
    return isPrivateIpv4(
      `${groups[6] >> 8}.${groups[6] & 0xff}.` +
        `${groups[7] >> 8}.${groups[7] & 0xff}`,
    );
  }
  if (groups.slice(0, 6).every((part) => part === 0)) {
    return true;
  }

  // Public IPv6 unicast is 2000::/3. Block reserved transition,
  // documentation, benchmarking, and ORCHID ranges inside it.
  if ((groups[0] & 0xe000) !== 0x2000) return true;
  if (groups[0] === 0x2002) return true;
  if (groups[0] === 0x2001) {
    if (groups[1] === 0 || groups[1] === 2 || groups[1] === 0x0db8) {
      return true;
    }
    if (groups[1] >= 0x10 && groups[1] <= 0x2f) {
      return true;
    }
  }
  return false;
}

function isBlockedIp(ip: string) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return true;
}

type ApprovedAddress = {
  address: string;
  family: 4 | 6;
};

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

export function normalizeRemoteHttpsUrl(
  rawUrl: string,
  policy: RemoteUrlPolicy = {},
) {
  const label = policy.label ?? "Remote URL";
  if (
    policy.maxUrlLength !== undefined &&
    rawUrl.length > policy.maxUrlLength
  ) {
    throw new Error(`${label} is too long.`);
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS.`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not include credentials.`);
  }
  if (policy.defaultPortOnly && url.port) {
    throw new Error(`${label} must use the default HTTPS port.`);
  }
  url.hash = "";

  const hostname = url.hostname.toLowerCase();
  const lookupHostname =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    BLOCKED_METADATA_HOSTS.has(hostname) ||
    policy.blockedHostSuffixes?.some((suffix) =>
      hostname.endsWith(suffix.toLowerCase()))
  ) {
    throw new Error(`${label} points to a blocked host.`);
  }
  if (policy.allowIpLiterals === false && net.isIP(lookupHostname)) {
    throw new Error(`${label} must not use an IP-literal host.`);
  }
  const allowedHosts = policy.allowedHosts?.map((value) =>
    value.toLowerCase());
  if (allowedHosts && !allowedHosts.includes(hostname)) {
    throw new Error(`${label} is outside the allowed hosts.`);
  }
  const allowedOrigins = policy.allowedOrigins?.map((value) =>
    new URL(value).origin.toLowerCase());
  if (allowedOrigins && !allowedOrigins.includes(url.origin.toLowerCase())) {
    throw new Error(`${label} is outside the allowed origins.`);
  }

  return { url, hostname: lookupHostname };
}

async function resolveRemoteHttpsUrl(
  rawUrl: string,
  policy: RemoteUrlPolicy = {},
) {
  const { url, hostname: lookupHostname } = normalizeRemoteHttpsUrl(rawUrl, policy);
  const label = policy.label ?? "Remote URL";

  const literalFamily = net.isIP(lookupHostname);
  const resolved = literalFamily
    ? [{ address: lookupHostname, family: literalFamily }]
    : await dns.lookup(lookupHostname, { all: true, verbatim: true });
  if (
    !resolved.length ||
    resolved.some(({ address }) => isBlockedIp(address))
  ) {
    throw new Error(`${label} resolves to a blocked network address.`);
  }
  const addresses = resolved.map(({ address }) => ({
    address,
    family: net.isIP(address) as 4 | 6,
  }));
  return {
    url: url.toString(),
    hostname: lookupHostname,
    addresses,
  };
}

export async function validateRemoteHttpsUrl(
  rawUrl: string,
  policy: RemoteUrlPolicy = {},
) {
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

export async function boundRemoteResponse(
  response: Response,
  policy: RemoteResponsePolicy,
) {
  const label = policy.label ?? "Remote response";
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
    throw new Error(`${label} exceeds the size limit.`);
  }
  if (!response.body) return response;

  let received = 0;
  const bounded = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > policy.maxBytes) {
          throw new Error(`${label} exceeds the size limit.`);
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(bounded, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function bufferRemoteResponse(
  response: Response,
  policy: RemoteResponsePolicy,
) {
  const bounded = await boundRemoteResponse(response, policy);
  if (!bounded.body) return bounded;
  const bytes = await bounded.arrayBuffer();
  return new Response(bytes.byteLength ? bytes : null, {
    status: bounded.status,
    statusText: bounded.statusText,
    headers: bounded.headers,
  });
}

function pinnedLookup(approved: ApprovedAddress[]): net.LookupFunction {
  return (_hostname, options, callback) => {
    const requestedFamily =
      options.family === 4 || options.family === "IPv4"
        ? 4
        : options.family === 6 || options.family === "IPv6"
          ? 6
          : 0;
    const matching = requestedFamily
      ? approved.filter(({ family }) => family === requestedFamily)
      : approved;
    if (!matching.length) {
      const error = Object.assign(
        new Error("No approved address matches the requested family."),
        { code: "ENOTFOUND" },
      );
      callback(error, "", 0);
      return;
    }
    if (options.all) {
      callback(null, matching);
      return;
    }
    callback(null, matching[0].address, matching[0].family);
  };
}

export async function guardedRemoteFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  policy: RemoteFetchPolicy = {},
): Promise<Response> {
  const options = policy;
  const rawUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const approved = await resolveRemoteHttpsUrl(rawUrl, options);
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
    const request =
      typeof input === "string" || input instanceof URL ? null : input;
    const inheritedInit = request
      ? {
          method: request.method,
          headers: request.headers,
          body: request.body,
          cache: request.cache,
          credentials: request.credentials,
          integrity: request.integrity,
          keepalive: request.keepalive,
          mode: request.mode,
          referrer: request.referrer,
          referrerPolicy: request.referrerPolicy,
          signal: request.signal,
        }
      : {};
    const body =
      init && Object.prototype.hasOwnProperty.call(init, "body")
        ? init.body
        : request?.body;
    const streamLikeBody =
      body !== null &&
      typeof body === "object" &&
      (("getReader" in body &&
        typeof (body as { getReader?: unknown }).getReader === "function") ||
        Symbol.asyncIterator in body);
    const hasDuplex =
      !!init && Object.prototype.hasOwnProperty.call(init, "duplex");
    const signals = [request?.signal, init?.signal].filter(
      (signal): signal is AbortSignal => Boolean(signal),
    );
    if (options.timeoutMs !== undefined) {
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
        throw new Error("Remote fetch timeoutMs must be a positive integer.");
      }
      signals.push(AbortSignal.timeout(options.timeoutMs));
    }
    const signal = signals.length > 1
      ? AbortSignal.any(signals)
      : signals[0];
    const response = (await undiciFetch(approved.url, {
      ...inheritedInit,
      ...init,
      ...(body === undefined ? {} : { body }),
      ...(streamLikeBody && !hasDuplex ? { duplex: "half" as const } : {}),
      ...(signal ? { signal } : {}),
      redirect: "manual",
      dispatcher,
    } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
    return options.response
      ? boundRemoteResponse(response, options.response)
      : response;
  } finally {
    // close() is graceful: the streaming response stays usable while its
    // one-request pool shuts down after the body completes.
    void dispatcher.close().catch(() => undefined);
  }
}
