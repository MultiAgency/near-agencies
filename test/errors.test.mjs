import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import express from "express";

import { errorHandler, readFailure } from "../lib/errors.mjs";

const SECRET = "GitHub GET /repos/MultiAgency/kanban-sandbox/issues: 403 {\"message\":\"secret detail\"}";

describe("error handler", () => {
  let server;
  let base;
  const realError = console.error;

  before(async () => {
    console.error = () => {};
    const app = express();
    app.use(express.json({ limit: "16b", strict: true }));
    app.get("/boom", async () => { throw new Error(SECRET); });
    app.post("/echo", (request, response) => response.json(request.body));
    app.use(errorHandler);
    await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    console.error = realError;
    server.close();
  });

  test("an unexpected failure is a 500 that does not repeat the message", async () => {
    const response = await fetch(`${base}/boom`);
    const text = await response.text();
    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(text), { error: "internal error" });
    assert.ok(!text.includes("secret detail"));
  });

  test("a request body Express rejects keeps its 4xx status", async () => {
    const headers = { "content-type": "application/json" };
    const malformed = await fetch(`${base}/echo`, { method: "POST", headers, body: "{nope" });
    assert.equal(malformed.status, 400);
    assert.ok((await malformed.json()).error);
    const tooLarge = await fetch(`${base}/echo`, { method: "POST", headers, body: JSON.stringify({ a: "x".repeat(64) }) });
    assert.equal(tooLarge.status, 413);
  });
});

describe("readFailure", () => {
  const capture = () => {
    const sent = {};
    const response = { status(code) { sent.status = code; return response; }, json(body) { sent.body = body; } };
    return { response, sent };
  };
  const realError = console.error;
  before(() => { console.error = () => {}; });
  after(() => { console.error = realError; });

  test("an unknown engagement is a 404 with the caller's message", () => {
    const { response, sent } = capture();
    readFailure(response, new Error("#9 is not an engagement"), "There is no job #9.");
    assert.deepEqual(sent, { status: 404, body: { error: "There is no job #9." } });
  });

  test("a GitHub 404 is a 404 without GitHub's response text", () => {
    const { response, sent } = capture();
    readFailure(response, new Error(`GitHub GET /repos/x/issues/9: 404 ${SECRET}`));
    assert.deepEqual(sent, { status: 404, body: { error: "not found" } });
  });

  test("a 404 only inside the upstream's text is not a not-found", () => {
    const { response, sent } = capture();
    readFailure(response, new Error("GitHub GET /repos/x/issues: 403 {\"message\":\"see 404 docs\"}"));
    assert.deepEqual(sent, { status: 502, body: { error: "upstream request failed" } });
  });

  test("any other failure is a 502 without the upstream's message", () => {
    const { response, sent } = capture();
    readFailure(response, new Error(SECRET));
    assert.deepEqual(sent, { status: 502, body: { error: "upstream request failed" } });
  });
});
