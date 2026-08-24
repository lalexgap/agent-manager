import { describe, expect, test } from "bun:test";
import { createSseParser } from "../src/sse";

describe("createSseParser", () => {
  test("delivers each complete block's data payload", () => {
    const seen: string[] = [];
    const parse = createSseParser((data) => seen.push(data));
    parse('event: fleet\ndata: {"a":1}\n\nevent: fleet\ndata: {"b":2}\n\n');
    expect(seen).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("reassembles blocks split across chunks at any boundary", () => {
    const raw = 'id: 1\nevent: fleet\ndata: {"type":"fleet","event":"stop"}\n\n';
    for (let split = 1; split < raw.length; split++) {
      const seen: string[] = [];
      const parse = createSseParser((data) => seen.push(data));
      parse(raw.slice(0, split));
      parse(raw.slice(split));
      expect(seen).toEqual(['{"type":"fleet","event":"stop"}']);
    }
  });

  test("skips keepalive comment blocks", () => {
    const seen: string[] = [];
    const parse = createSseParser((data) => seen.push(data));
    parse(": keepalive\n\n: keepalive\n\ndata: real\n\n");
    expect(seen).toEqual(["real"]);
  });

  test("joins multi-line data fields", () => {
    const seen: string[] = [];
    const parse = createSseParser((data) => seen.push(data));
    parse("data: line one\ndata: line two\n\n");
    expect(seen).toEqual(["line one\nline two"]);
  });

  test("holds an incomplete block until its terminator arrives", () => {
    const seen: string[] = [];
    const parse = createSseParser((data) => seen.push(data));
    parse("data: pending\n");
    expect(seen).toEqual([]);
    parse("\n");
    expect(seen).toEqual(["pending"]);
  });
});
