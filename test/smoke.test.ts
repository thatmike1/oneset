import assert from "node:assert/strict";
import { test } from "node:test";
import { version } from "../src/index.ts";

test("the package loads", () => {
  assert.equal(typeof version, "string");
});
