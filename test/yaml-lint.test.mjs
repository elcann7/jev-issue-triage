// Cheap, dependency-free YAML guard. A real bug shipped once: an unquoted `description: ... issues: write ...`
// in action.yml made GitHub reject the whole action ("Mapping values are not allowed in this context").
// This checks every YAML file for plain scalar values that contain ": " (and are therefore invalid).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set([".git", "node_modules", "data", "out"]);

function yamlFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...yamlFiles(full));
    else if (/\.ya?ml$/.test(name)) found.push(full);
  }
  return found;
}

/** Returns lines like "path:12 key: value" whose plain value contains ": ". */
export function findProblems(text, file = "file") {
  const problems = [];
  const lines = text.split(/\r?\n/);
  let blockIndent = -1; // inside a | or > block scalar: contents are free text
  lines.forEach((line, i) => {
    const indent = line.match(/^\s*/)[0].length;
    if (blockIndent >= 0) {
      if (line.trim() === "" || indent > blockIndent) return;
      blockIndent = -1;
    }
    const m = line.match(/^(\s*)(?:- )?([A-Za-z_][\w.-]*):\s+(.+)$/);
    if (!m) return;
    let value = m[3].trim();
    if (/^[|>][+-]?$/.test(value)) { blockIndent = m[1].length; return; }
    if (/^["'\[{&*!]/.test(value)) return;                  // quoted, flow, anchor, tag
    value = value.replace(/\s+#.*$/, "");                    // strip trailing comment
    if (value.includes(": ")) problems.push(`${file}:${i + 1} ${m[2]}: ${value}`);
  });
  return problems;
}

test("no YAML file has an unquoted value containing ': '", () => {
  const files = yamlFiles(root);
  assert.ok(files.length >= 5, "should find action.yml, workflows and issue templates");
  const problems = files.flatMap((f) => findProblems(readFileSync(f, "utf8"), f.replace(root, "")));
  assert.deepEqual(problems, []);
});

test("the lint itself catches the bug that shipped, and ignores block scalars and quoted values", () => {
  assert.equal(findProblems("  description: Needs `issues: write` permission.").length, 1);
  assert.equal(findProblems('  description: "Needs `issues: write` permission."').length, 0);
  assert.equal(findProblems("run: |\n  echo hello: world\nnext: ok").length, 0);
  assert.equal(findProblems("url: https://example.com/a:b").length, 0);
  assert.equal(findProblems("- name: Security problem").length, 0);
  assert.equal(findProblems('run: echo "a: b"').length, 1);
});

test("action.yml declares the node24 runtime, the three outputs and the entry point", () => {
  const text = readFileSync(join(root, "action.yml"), "utf8");
  assert.match(text, /using:\s*node24/);
  assert.match(text, /main:\s*src\/index\.mjs/);
  for (const out of ["labels", "tier", "skipped"]) assert.match(text, new RegExp(`^  ${out}:`, "m"));
});
