import { expect, test } from "bun:test";
import { BRANDS, BRAND_LOGOS, brandLogo } from "./brand-logos";

test("Discord integrations use the Discord brand tile", () => {
  expect(BRANDS.discord).toEqual({ bg: "#5865f2" });
  expect(brandLogo("discord")).toBe(BRAND_LOGOS.discord);
});
