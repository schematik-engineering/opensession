import { expect, test } from "bun:test";
import { BRANDS, BRAND_LOGOS, brandLogo, displayName } from "./brand-logos";

test("Discord integrations use the Discord brand tile", () => {
  expect(BRANDS.discord).toEqual({ bg: "#5865f2" });
  expect(brandLogo("discord")).toBe(BRAND_LOGOS.discord);
});

test("configured MCP servers all use branded vector marks", () => {
  const servers = [
    "AWS",
    "Executor",
    "Gmail",
    "GoogleCalendar",
    "GoogleDrive",
    "Neon",
  ];

  for (const server of servers) {
    expect(BRANDS[server.toLowerCase()]).toBeDefined();
    expect(brandLogo(server)).toBeDefined();
  }
});

test("Google and AWS MCP names have their proper spacing and capitalization", () => {
  expect(displayName("AWS")).toBe("AWS");
  expect(displayName("GoogleCalendar")).toBe("Google Calendar");
  expect(displayName("GoogleDrive")).toBe("Google Drive");
});
