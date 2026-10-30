// resp.test.ts — run with: node --test resp.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, bulk,encodeCommand } from "./resp.ts";

// Helper: build a RESP command the way redis-cli would send it.
function encode(...args: string[]): Buffer {
  return Buffer.from(`*${args.length}\r\n` + args.map(bulk).join(""));
}

test("parses a full SET command", () => {
  const buf = encode("SET", "foo", "bar");
  const result = parseCommand(buf);
  assert.deepEqual(result, { args: ["SET", "foo", "bar"], consumed: buf.length });
});

test("returns null for every partial cut", () => {
  const buf = encode("SET", "foo", "bar");
  for (let cut = 0; cut < buf.length; cut++) {
    assert.equal(parseCommand(buf.subarray(0, cut)), null, `cut at ${cut}`);
  }
});

test("parses two commands in one chunk, one at a time", () => {
  const a = encode("SET", "a", "1");
  const b = encode("GET", "a");
  let buf = Buffer.concat([a, b]);

  const first = parseCommand(buf)!;
  assert.deepEqual(first.args, ["SET", "a", "1"]);
  buf = buf.subarray(first.consumed);

  const second = parseCommand(buf)!;
  assert.deepEqual(second.args, ["GET", "a"]);
  assert.equal(second.consumed, buf.length);
});

test("value containing \\r\\n is parsed by length", () => {
  const buf = encode("SET", "k", "line1\r\nline2");
  assert.deepEqual(parseCommand(buf)!.args, ["SET", "k", "line1\r\nline2"]);
});

test("non-ASCII values use byte length", () => {
  const buf = encode("SET", "name", "café");
  assert.deepEqual(parseCommand(buf)!.args, ["SET", "name", "café"]);
});

test("rejects garbage", () => {
  assert.throws(() => parseCommand(Buffer.from("hello\r\n")));
});

test("encodeCommand produces the client format", () => {
  assert.equal(
    encodeCommand(["SET", "foo", "bar"]),
    "*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n"
  );
});