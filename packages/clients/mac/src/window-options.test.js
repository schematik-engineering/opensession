const { expect, test } = require("bun:test");
const { restoredFullscreenOptions } = require("./window-options");

test("restored fullscreen state only sets Electron's fullscreen option when true", () => {
  expect(restoredFullscreenOptions(false)).toEqual({});
  expect(restoredFullscreenOptions(true)).toEqual({ fullscreen: true });
});
