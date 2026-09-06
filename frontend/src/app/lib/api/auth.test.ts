import { afterEach, expect, it, vi } from "vitest";
import { getAuthSession, isMfaRequiredError, login, logout } from "./auth";

afterEach(() => vi.unstubAllGlobals());

it("keeps sign-in, MFA errors and empty sign-out responses on the shared transport", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const responses = [
    new Response(null, { status: 401 }),
    Response.json({ detail: "Verify your authenticator", code: "mfa_verification_required" }, { status: 403 }),
    new Response(null, { status: 204 }),
    new Response("<h1>Proxy error</h1>", { status: 502 }),
  ];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return responses.shift()!;
  }));

  expect(await getAuthSession()).toBeNull();
  const error = await login("lawyer@example.test", "password").catch((error) => error);
  expect(isMfaRequiredError(error)).toBe(true);
  expect(error.message).toBe("Verify your authenticator");
  await expect(logout()).resolves.toBeUndefined();
  await expect(login("lawyer@example.test", "password"))
    .rejects.toThrow("Authentication could not be completed.");

  expect(requests[1].url).toBe("/api/auth/login");
  expect(requests[1].init.credentials).toBe("include");
  expect(new Headers(requests[1].init.headers).get("Content-Type")).toBe("application/json");
  expect(JSON.parse(String(requests[1].init.body)))
    .toEqual({ email: "lawyer@example.test", password: "password" });
});
