import { beforeEach, describe, expect, it, vi } from "vitest";

const dnsLookup = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const agentOptions = vi.hoisted(() => [] as Array<Record<string, any>>);
const agentClose = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("dns/promises", () => ({
  default: { lookup: dnsLookup },
}));

vi.mock("undici", () => ({
  fetch: fetchMock,
  Agent: class {
    constructor(options: Record<string, any>) {
      agentOptions.push(options);
    }

    close() {
      return agentClose();
    }
  },
}));

import { guardedRemoteFetch, validateRemoteHttpsUrl } from "../remoteUrlSafety";

beforeEach(() => {
  dnsLookup.mockReset();
  fetchMock.mockReset();
  agentOptions.length = 0;
  agentClose.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("global fetch must not be used");
    }),
  );
});

describe("remote URL network safety", () => {
  it("blocks private IPv4 embedded in hex, dotted, and compatible IPv6", async () => {
    for (const url of [
      "https://[::ffff:7f00:1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://[::7f00:1]/",
      "https://192.88.99.1/",
      "https://198.51.100.7/",
      "https://203.0.113.9/",
    ]) {
      await expect(validateRemoteHttpsUrl(url)).rejects.toThrow(
        "blocked network address",
      );
    }

    dnsLookup.mockResolvedValueOnce([
      { address: "::ffff:127.0.0.1", family: 6 },
    ]);
    await expect(
      validateRemoteHttpsUrl("https://provider.example/document.pdf"),
    ).rejects.toThrow("blocked network address");

    dnsLookup.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(
      validateRemoteHttpsUrl("https://provider.example/document.pdf"),
    ).rejects.toThrow("blocked network address");
  });

  it("allows public native IPv6 and public IPv4-mapped IPv6", async () => {
    await expect(
      validateRemoteHttpsUrl("https://[2606:4700:4700::1111]/"),
    ).resolves.toBe("https://[2606:4700:4700::1111]/");
    await expect(
      validateRemoteHttpsUrl("https://[::ffff:5db8:d822]/"),
    ).resolves.toBe("https://[::ffff:5db8:d822]/");

    dnsLookup.mockResolvedValueOnce([
      { address: "2001:4860:4860::8888", family: 6 },
    ]);
    await expect(
      validateRemoteHttpsUrl("https://provider.example/document.pdf"),
    ).resolves.toBe("https://provider.example/document.pdf");
  });

  it("pins the checked address while preserving TLS hostname and request semantics", async () => {
    dnsLookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    fetchMock.mockImplementationOnce(
      async (input: RequestInfo | URL, init: Record<string, any>) => {
        const lookup = agentOptions[0].connect.lookup;
        const connectedAddress = await new Promise<{
          address: string;
          family: number;
        }>((resolve, reject) => {
          lookup(
            "provider.example",
            { all: false, family: 0, hints: 0 },
            (error: Error | null, address: string, family: number) => {
              if (error) reject(error);
              else resolve({ address, family });
            },
          );
        });
        expect(connectedAddress).toEqual({
          address: "93.184.216.34",
          family: 4,
        });
        expect(input).toBe("https://provider.example/document.pdf");
        expect(init).toMatchObject({
          body: "request body",
          method: "POST",
          redirect: "manual",
        });
        return new Response("streamed response");
      },
    );

    const response = await guardedRemoteFetch(
      "https://provider.example/document.pdf#local-fragment",
      { body: "request body", method: "POST", redirect: "follow" },
      "Provider PDF URL",
    );

    expect(await response.text()).toBe("streamed response");
    expect(dnsLookup).toHaveBeenCalledTimes(1);
    expect(agentOptions[0].connect.servername).toBe("provider.example");
    expect(agentClose).toHaveBeenCalledOnce();
  });

  it("pins the complete checked DNS snapshot for address and family fallback", async () => {
    const approved = [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      { address: "93.184.216.35", family: 4 },
    ];
    dnsLookup.mockResolvedValueOnce(approved);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await guardedRemoteFetch("https://provider.example/document.pdf");

    const lookup = agentOptions[0].connect.lookup;
    const resolveAll = (family: 0 | 4 | 6) =>
      new Promise<Array<{ address: string; family: number }>>(
        (resolve, reject) => {
          lookup(
            "provider.example",
            { all: true, family, hints: 0 },
            (
              error: Error | null,
              addresses: Array<{ address: string; family: number }>,
            ) => {
              if (error) reject(error);
              else resolve(addresses);
            },
          );
        },
      );

    await expect(resolveAll(0)).resolves.toEqual(approved);
    await expect(resolveAll(4)).resolves.toEqual([approved[0], approved[2]]);
    await expect(resolveAll(6)).resolves.toEqual([approved[1]]);
    expect(agentOptions[0].autoSelectFamily).toBe(true);
    expect(dnsLookup).toHaveBeenCalledOnce();
  });

  it("normalizes a global Request without buffering its body stream", async () => {
    dnsLookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streamed request"));
        controller.close();
      },
    });
    const request = new Request(
      "https://provider.example/document.pdf#local-fragment",
      {
        method: "POST",
        headers: { "x-original": "yes" },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );
    fetchMock.mockImplementationOnce(
      async (input: RequestInfo | URL, init: Record<string, any>) => {
        expect(input).toBe("https://provider.example/document.pdf");
        expect(init.method).toBe("PATCH");
        expect(init.headers).toEqual({ "x-override": "yes" });
        expect(init.body).toBe(request.body);
        expect(init.duplex).toBe("half");
        return new Response(null, { status: 204 });
      },
    );

    await guardedRemoteFetch(request, {
      method: "PATCH",
      headers: { "x-override": "yes" },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sets duplex for a caller-supplied stream body", async () => {
    dnsLookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    const body = new ReadableStream<Uint8Array>();
    fetchMock.mockImplementationOnce(
      async (_input: RequestInfo | URL, init: Record<string, any>) => {
        expect(init.body).toBe(body);
        expect(init.duplex).toBe("half");
        return new Response(null, { status: 204 });
      },
    );

    await guardedRemoteFetch("https://provider.example/document.pdf", {
      method: "POST",
      body,
    });
  });

  it("rejects URL credentials before DNS or transport", async () => {
    await expect(
      guardedRemoteFetch("https://user:secret@provider.example/document.pdf"),
    ).rejects.toThrow("must not include credentials");

    expect(dnsLookup).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(agentOptions).toHaveLength(0);
  });
});
