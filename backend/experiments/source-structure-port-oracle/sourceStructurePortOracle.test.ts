import { expect, test } from "vitest";

import { verifyOracle } from "./verify";

test("real SourceDocs port vectors remain exact and self-verifying", () => {
  expect(verifyOracle()).toMatchObject({ vectors: 24 });
});
