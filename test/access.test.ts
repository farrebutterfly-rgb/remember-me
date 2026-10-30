import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp, api } from "./helpers.ts";

test("without a valid token every memory route is 401", async () => {
  await withApp(async ({ url, alice }) => {
    assert.equal((await api(url, "GET", "/memories")).status, 401);
    assert.equal((await api(url, "GET", "/memories", { token: "rmt1.abc.def" })).status, 401);
    assert.equal((await api(url, "GET", "/memories", { token: alice.slice(0, -2) + "xx" })).status, 401);
    assert.equal((await api(url, "POST", "/login", { body: { username: "alice", password: "wrong" } })).status, 401);
  });
});

test("user B cannot read, update or delete user A's item: 404 every time, A's item untouched", async () => {
  await withApp(async ({ url, alice, bob, app }) => {
    const created = await api(url, "POST", "/memories", { token: alice, body: { key: "language", value: "fr" } });
    assert.equal(created.status, 201);
    const id = created.body.item.id as string;

    const read = await api(url, "GET", `/memories/${id}`, { token: bob });
    const update = await api(url, "PATCH", `/memories/${id}`, { token: bob, body: { value: "sv" } });
    const del = await api(url, "DELETE", `/memories/${id}`, { token: bob });
    const ghost = await api(url, "GET", "/memories/mem_000000000000", { token: bob });
    assert.deepEqual([read.status, update.status, del.status], [404, 404, 404]);
    // Same answer as for an id that does not exist at all: nothing to learn by probing.
    assert.deepEqual(read.body, { error: { code: "NOT_FOUND", message: `no memory item ${id} for this user` } });
    assert.equal(ghost.status, 404);

    const bobList = await api(url, "GET", "/memories", { token: bob });
    assert.deepEqual(bobList.body.items, []);

    const mine = await api(url, "GET", `/memories/${id}`, { token: alice });
    assert.equal(mine.body.item.value, "fr");
    assert.equal(mine.body.item.history.length, 1);
    assert.equal(app.events.events.filter((e) => e.type === "access_denied_or_missing").length, 4);
  });
});

test("a user id in the body is never trusted: the request is rejected and nothing is written for the named user", async () => {
  await withApp(async ({ url, alice, bob }) => {
    for (const field of ["owner", "user_id", "userId"]) {
      const r = await api(url, "POST", "/memories", { token: bob, body: { key: "language", value: "sv", [field]: "usr_alice" } });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, "IDENTITY_IN_BODY");
    }
    const chat = await api(url, "POST", "/chat", { token: bob, body: { message: "/remember language: sv", owner: "usr_alice" } });
    assert.equal(chat.status, 400);
    // Query strings are never read either.
    const q = await api(url, "GET", "/memories?owner=usr_alice", { token: bob });
    assert.deepEqual(q.body.items, []);
    assert.deepEqual((await api(url, "GET", "/memories", { token: alice })).body.items, []);
  });
});

test("conversation history is owner scoped too", async () => {
  await withApp(async ({ url, alice, bob }) => {
    const c = await api(url, "POST", "/chat", { token: alice, body: { message: "orders report" } });
    const conv = c.body.conversation_id as string;
    assert.equal((await api(url, "GET", `/conversations/${conv}/messages`, { token: alice })).status, 200);
    assert.equal((await api(url, "GET", `/conversations/${conv}/messages`, { token: bob })).status, 404);
    // Bob cannot post into Alice's conversation and so cannot read her history through the model.
    assert.equal((await api(url, "POST", "/chat", { token: bob, body: { message: "orders report", conversation_id: conv } })).status, 404);
  });
});

test("same key for two users gives two independent items", async () => {
  await withApp(async ({ url, alice, bob }) => {
    await api(url, "POST", "/memories", { token: alice, body: { key: "language", value: "fr" } });
    await api(url, "POST", "/memories", { token: bob, body: { key: "language", value: "sv" } });
    const a = (await api(url, "GET", "/memories", { token: alice })).body.items;
    const b = (await api(url, "GET", "/memories", { token: bob })).body.items;
    assert.deepEqual([a[0].value, b[0].value], ["fr", "sv"]);
    assert.notEqual(a[0].id, b[0].id);
  });
});
