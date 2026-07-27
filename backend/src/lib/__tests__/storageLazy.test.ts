import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const send = vi.fn(async () => ({}));
  const loadClientSdk = vi.fn(() => ({
    S3Client: class {
      send = send;
    },
    PutObjectCommand: class {},
    GetObjectCommand: class {},
    ListObjectsV2Command: class {},
    DeleteObjectCommand: class {},
  }));
  const sign = vi.fn(async () => "https://storage.test/signed");
  return {
    loadClientSdk,
    loadPresigner: vi.fn(() => ({ getSignedUrl: sign })),
    send,
  };
});

vi.mock("@aws-sdk/client-s3", mocks.loadClientSdk);
vi.mock("@aws-sdk/s3-request-presigner", mocks.loadPresigner);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

describe("R2 loading", () => {
  it("loads the cloud SDK only when configured storage is used", async () => {
    vi.stubEnv("R2_ENDPOINT_URL", "https://storage.test");
    vi.stubEnv("R2_ACCESS_KEY_ID", "access");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret");

    const storage = await import("../storage");
    expect(mocks.loadClientSdk).not.toHaveBeenCalled();
    expect(mocks.loadPresigner).not.toHaveBeenCalled();

    await storage.uploadFile("key", new ArrayBuffer(0), "text/plain");

    expect(mocks.loadClientSdk).toHaveBeenCalledOnce();
    expect(mocks.loadPresigner).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledOnce();
  });
});
