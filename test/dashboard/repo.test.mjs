import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRepo } from "../../dashboard/repo.mjs";

test("parseRepo: owner/name and various GitHub links give the same result", () => {
  const ok = [
    "tryliner/desktop", " tryliner/desktop ", "https://github.com/tryliner/desktop", "https://github.com/tryliner/desktop/",
    "https://github.com/tryliner/desktop/issues", "https://github.com/tryliner/desktop/issues/316", "github.com/tryliner/desktop/pulls",
    "http://www.github.com/tryliner/desktop/tree/main/src", "https://github.com/tryliner/desktop.git", "git@github.com:tryliner/desktop.git",
    "https://github.com/tryliner/desktop/issues?q=is%3Aopen#top",
  ];
  for (const input of ok) assert.equal(parseRepo(input), "tryliner/desktop", input);
});

test("parseRepo: malformed and unsafe input returns null", () => {
  for (const bad of ["", "   ", null, undefined, "no-slash", "../etc/passwd", "./x", "o/..", "a b/c", "https://evil.com/a/b-c d", "https://github.com/onlyowner", "o/r;rm -rf", "o/r$(x)"]) {
    assert.equal(parseRepo(bad), null, String(bad));
  }
});

test("parseRepo: names containing dots and dashes are accepted", () => {
  assert.equal(parseRepo("my-org/my.repo_x"), "my-org/my.repo_x");
});
