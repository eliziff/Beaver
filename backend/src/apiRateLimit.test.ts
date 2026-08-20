import request from "supertest";
import { expect, it, vi } from "vitest";

vi.mock("./runtime", () => ({ runtime: {
  mode: "cloud",
  chats: async () => ({}),
  chat: async () => ({}),
} }));
vi.mock("./routes/chat", () => ({
  createChatRouter: () => (_req: unknown, res: { sendStatus: (status: number) => void }) =>
    res.sendStatus(204),
}));
vi.mock("./routes/user", () => ({
  userRouter: (_req: unknown, res: { sendStatus: (status: number) => void }) =>
    res.sendStatus(204),
}));

import { api } from "./api";

it("keeps expensive request quotas per authenticated session", async () => {
  const submit = (token: string) => request(api).post("/chat")
    .set("Authorization", `Bearer ${token}`)
    .set("Content-Type", "application/json")
    .send({});

  for (let index = 0; index < 30; index += 1)
    expect((await submit("session.one.signature")).status).toBe(204);
  expect((await submit("session.one.signature")).status).toBe(429);
  expect((await submit("session.two.signature")).status).toBe(204);
});

it("bounds outbound connector discovery per authenticated session", async () => {
  const submit = () => request(api)
    .post("/user/mcp-connectors/connector-1/refresh-tools")
    .set("Authorization", "Bearer connector.session.signature");
  for (let index = 0; index < 60; index += 1)
    expect((await submit()).status).toBe(204);
  expect((await submit()).status).toBe(429);
});
