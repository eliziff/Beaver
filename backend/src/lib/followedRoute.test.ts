import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ApplicationError } from "./applicationError";
import { followedRoute, PROGRESS_STREAM } from "./followedRoute";

const app = express();
app.post("/work", followedRoute(async (_req, res, progress) => {
  progress?.("Fetching one · 1 of 2"); progress?.("Fetching two · 2 of 2");
  res.json({ done: true });
}));
app.post("/refused", followedRoute(async (_req, _res, progress) => {
  progress?.("Looking up authorities · 0 of 1");
  throw new ApplicationError(409, "This draft changed.");
}));

const lines = (text: string) => text.split("\n");

describe("followedRoute", () => {
  it("answers as usual unless the progress stream is asked for", async () => {
    const response = await request(app).post("/work");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ done: true });
  });

  it("streams progress, then the result's status and type, then the result", async () => {
    const response = await request(app).post("/work").set("Accept", PROGRESS_STREAM).buffer(true)
      .parse((res, done) => { let text = ""; res.on("data", (chunk) => { text += chunk; }); res.on("end", () => done(null, text)); });
    expect(response.headers["content-type"]).toBe(PROGRESS_STREAM);
    expect(lines(response.body as string)).toEqual([
      JSON.stringify({ progress: "Fetching one · 1 of 2" }), JSON.stringify({ progress: "Fetching two · 2 of 2" }),
      JSON.stringify({ result: { status: 200, type: "application/json" } }), JSON.stringify({ done: true })]);
  });

  it("reports a refusal as the result, after the progress already sent", async () => {
    const response = await request(app).post("/refused").set("Accept", PROGRESS_STREAM).buffer(true)
      .parse((res, done) => { let text = ""; res.on("data", (chunk) => { text += chunk; }); res.on("end", () => done(null, text)); });
    expect(response.status).toBe(200);
    expect(lines(response.body as string).slice(1)).toEqual([
      JSON.stringify({ result: { status: 409, type: "application/json" } }), JSON.stringify({ detail: "This draft changed." })]);
  });
});
