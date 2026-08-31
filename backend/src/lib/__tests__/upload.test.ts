import express from "express";
import request from "supertest";
import { expect, it } from "vitest";
import { multipleFileUpload, singleFileUpload } from "../upload";

it("accepts only the declared number of repeated files", async () => {
  const app = express();
  app.post("/", multipleFileUpload("files", 2), (req, res) => {
    res.json({ count: Array.isArray(req.files) ? req.files.length : 0 });
  });
  await request(app).post("/")
    .attach("files", Buffer.from("one"), "one.txt")
    .attach("files", Buffer.from("two"), "two.txt")
    .expect(200, { count: 2 });
  const excess = await request(app).post("/")
    .attach("files", Buffer.from("one"), "one.txt")
    .attach("files", Buffer.from("two"), "two.txt")
    .attach("files", Buffer.from("three"), "three.txt");
  expect(excess.status).toBe(400);
  expect(excess.body.detail).toMatch(/too many files/iu);
});

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
