import express from "express";
import request from "supertest";
import { expect, it } from "vitest";
import { singleFileUpload } from "../upload";

it("bounds concurrent staged uploads", async () => {
  const app = express();
  let entered = 0;
  let admit!: () => void;
  let release!: () => void;
  const admitted = new Promise<void>((resolve) => admit = resolve);
  const gate = new Promise<void>((resolve) => release = resolve);
  app.post("/", singleFileUpload("file"), async (_req, res) => {
    if (++entered === 4) admit();
    await gate;
    res.sendStatus(204);
  });
  const submit = () => request(app).post("/").attach("file", Buffer.from("x"), "x.txt");
  const pending = Array.from({ length: 4 }, () =>
    submit().then((response) => response));

  try {
    await admitted;
    const busy = await submit();
    expect(busy.status).toBe(503);
    expect(busy.headers["retry-after"]).toBe("1");
  } finally {
    release();
  }
  expect((await Promise.all(pending)).map(({ status }) => status)).toEqual([204, 204, 204, 204]);
  expect((await submit()).status).toBe(204);
});
