"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("vm");
const c = require("../lib/contrast");

test("contrast math matches WCAG reference values", () => {
  assert.equal(Math.round(c.contrastRatio([0, 0, 0], [255, 255, 255]) * 10) / 10, 21);
  assert.equal(Math.round(c.contrastRatio([119, 119, 119], [255, 255, 255]) * 100) / 100, 4.48);
  assert.deepEqual(c.parseColor("rgba(10, 20, 30, 0.5)"), [10, 20, 30, 0.5]);
  assert.deepEqual(c.parseColor("rgb(1 2 3 / 50%)"), [1, 2, 3, 0.5]);
  assert.deepEqual(c.blend([255, 255, 255, 0.5], [0, 0, 0, 1]), [127.5, 127.5, 127.5, 1]);
  assert.equal(c.requiredRatio(14, "400"), 4.5);
  assert.equal(c.requiredRatio(19, "700"), 3);
});

test("reproduces the 0.2.1 bug: light-skin text var on the hard-coded navy setup card", () => {
  const navy = c.blend([8, 16, 30, 0.96], [187, 184, 179, 1]); // .date-ask-card over the dawn skin
  assert.ok(c.contrastRatio([15, 23, 42], navy) < 1.5, "#0f172a on navy is unreadable");
  assert.ok(c.contrastRatio([248, 250, 252], navy) > 12);
  const light = c.blend([255, 255, 255, 0.98], [187, 184, 179, 1]); // 0.2.2: light card in light skins
  assert.ok(c.contrastRatio([15, 23, 42], light) > 12);
});

test("browser script compiles", () => {
  assert.doesNotThrow(() => new vm.Script(c.browserScript(["#x"], "lake", false)));
});
