/**
 * Deliberately share a merged visual change in Discord. A walkthrough's durable
 * `after` screenshot is both the visual-change signal and the attachment; the
 * route calls this only after a teammate clicks Send to Discord.
 */
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, extname, relative, resolve } from "path";
import { createHash } from "crypto";
import { audit } from "../../server/audit";
import { stateDir } from "../../server/paths";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import { UPLOADS_DIR } from "../../server/uploads";
import { homeDir } from "../../server/paths";
import type { UnifiedSession } from "../../server/types";
import type { DiscordRest, DiscordUpload } from "../discord/api";

export interface ShippedVisualChange {
  sessionId: string;
  screenshots: string[];
  summary: string;
}

export interface ShippedChangeChannel {
  id: string;
  name: string;
  guildId: string;
  guildName: string;
}

const ANNOUNCEMENT_STATE_ROOT = `${stateDir("github")}/shipped-visual-changes`;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const SCREENSHOT_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export interface ShippedChangeDelivery {
  channel: ShippedChangeChannel;
  permalink: string;
  messageId: string;
  at: string;
  requestedBy?: string;
  prNumber: number;
}

type AnnouncementReceipt =
  | {
      status: "pending";
      claimId: string;
      at: string;
    }
  | {
      status: "sent";
      claimId: string;
      at: string;
      sessionId?: string;
      delivery?: ShippedChangeDelivery;
    };

function announcementReceiptPath(key: string, root: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return `${root}/${digest}.json`;
}

function isShippedChangeChannel(value: unknown): value is ShippedChangeChannel {
  return (
    !!value &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "guildId" in value &&
    typeof value.guildId === "string" &&
    "guildName" in value &&
    typeof value.guildName === "string"
  );
}

function isShippedChangeDelivery(
  value: unknown,
): value is ShippedChangeDelivery {
  return (
    !!value &&
    typeof value === "object" &&
    "channel" in value &&
    isShippedChangeChannel(value.channel) &&
    "permalink" in value &&
    typeof value.permalink === "string" &&
    "messageId" in value &&
    typeof value.messageId === "string" &&
    "at" in value &&
    typeof value.at === "string" &&
    (!("requestedBy" in value) ||
      value.requestedBy === undefined ||
      typeof value.requestedBy === "string") &&
    "prNumber" in value &&
    typeof value.prNumber === "number"
  );
}

function readAnnouncementReceipt(path: string): AnnouncementReceipt | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      !("status" in value) ||
      (value.status !== "pending" && value.status !== "sent") ||
      !("claimId" in value) ||
      typeof value.claimId !== "string" ||
      !("at" in value) ||
      typeof value.at !== "string"
    )
      return null;
    if (value.status === "pending")
      return { status: "pending", claimId: value.claimId, at: value.at };
    const sessionId =
      "sessionId" in value && typeof value.sessionId === "string"
        ? value.sessionId
        : undefined;
    const delivery = "delivery" in value ? value.delivery : undefined;
    if (delivery !== undefined && !isShippedChangeDelivery(delivery))
      return null;
    return {
      status: "sent",
      claimId: value.claimId,
      at: value.at,
      ...(sessionId ? { sessionId } : {}),
      ...(delivery ? { delivery } : {}),
    };
  } catch {
    return null;
  }
}

export function shippedChangeAnnouncementDelivery(
  key: string,
  root = ANNOUNCEMENT_STATE_ROOT,
): ShippedChangeDelivery | null {
  const receipt = readAnnouncementReceipt(announcementReceiptPath(key, root));
  return receipt?.status === "sent" ? (receipt.delivery ?? null) : null;
}

export function claimShippedChangeAnnouncement(
  key: string,
  root = ANNOUNCEMENT_STATE_ROOT,
  now = Date.now(),
): string | null {
  const claimId = crypto.randomUUID();
  const receiptPath = announcementReceiptPath(key, root);
  mkdirSync(dirname(receiptPath), { recursive: true });
  try {
    writeFileSync(
      receiptPath,
      JSON.stringify({
        status: "pending",
        claimId,
        at: new Date(now).toISOString(),
      }),
      { flag: "wx" },
    );
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    // Fail closed after a process crash rather than risk posting the same merge
    // twice. Ordinary upload failures remove their receipt in settle().
    return null;
  }
  return claimId;
}

export function settleShippedChangeAnnouncement(
  key: string,
  claimId: string,
  sent: boolean,
  sessionId?: string,
  root = ANNOUNCEMENT_STATE_ROOT,
  delivery?: ShippedChangeDelivery,
): void {
  const receiptPath = announcementReceiptPath(key, root);
  const receipt = readAnnouncementReceipt(receiptPath);
  if (receipt?.claimId !== claimId) return;
  if (sent) {
    writeJsonAtomic(receiptPath, {
      status: "sent",
      claimId,
      at: new Date().toISOString(),
      sessionId,
      ...(delivery ? { delivery } : {}),
    });
  } else {
    rmSync(receiptPath, { force: true });
  }
}

/**
 * Drop a receipt so the same update can be shared again. Undo removes the
 * Discord message, so the claim that stopped a second send is stale.
 */
export function forgetShippedChangeAnnouncement(
  key: string,
  root = ANNOUNCEMENT_STATE_ROOT,
): void {
  rmSync(announcementReceiptPath(key, root), { force: true });
}

export function validWalkthroughScreenshot(
  path: string,
  sessionId: string,
  uploadsRoot = UPLOADS_DIR,
): boolean {
  try {
    const root = realpathSync(resolve(uploadsRoot, "walkthrough", sessionId));
    const candidate = realpathSync(path);
    const within = relative(root, candidate);
    if (within.startsWith("..") || resolve(root, within) !== candidate)
      return false;
    const dot = candidate.lastIndexOf(".");
    if (dot < 0 || !SCREENSHOT_EXTS.has(candidate.slice(dot).toLowerCase()))
      return false;
    const stat = statSync(candidate);
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_SCREENSHOT_BYTES;
  } catch {
    return false;
  }
}

export function validFeaturedScreenshot(path: string): boolean {
  try {
    const candidate = realpathSync(path);
    const scoped =
      candidate.startsWith("/tmp/") || candidate.startsWith(`${homeDir()}/`);
    if (!scoped) return false;
    const dot = candidate.lastIndexOf(".");
    if (dot < 0 || !SCREENSHOT_EXTS.has(candidate.slice(dot).toLowerCase()))
      return false;
    const stat = statSync(candidate);
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_SCREENSHOT_BYTES;
  } catch {
    return false;
  }
}

export function selectShippedVisualChange(
  session: UnifiedSession,
  fileExists: (
    path: string,
    sessionId: string,
  ) => boolean = validWalkthroughScreenshot,
  requestedScreenshots?: string[],
): ShippedVisualChange | null {
  const walkthroughScreenshot = session.walkthrough?.shots?.find(
    (shot) => shot.after,
  )?.after;
  const screenshots = [
    ...new Set(
      requestedScreenshots === undefined
        ? walkthroughScreenshot && fileExists(walkthroughScreenshot, session.id)
          ? [walkthroughScreenshot]
          : []
        : requestedScreenshots.filter(validFeaturedScreenshot),
    ),
  ].slice(0, 10);
  if (!screenshots.length) return null;
  return {
    sessionId: session.id,
    screenshots,
    summary: session.walkthrough?.summary || "",
  };
}

/** Collapse the walkthrough's first prose paragraph into share-ready copy. */
export function shippedChangeOneLiner(markdown: string, max = 280): string {
  const paragraphs = markdown
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const prose =
    paragraphs.find(
      (part) => !/^#{1,6}\s/.test(part) && !/^[-*]\s*$/.test(part),
    ) || "";
  const plain = prose
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:#{1,6}|[-*+])\s+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  const clipped = plain.slice(0, max - 1);
  const wordBoundary = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, wordBoundary > max * 0.7 ? wordBoundary : undefined).trimEnd()}…`;
}

export function normalizeShippedChangeMessage(value: unknown): string {
  if (typeof value !== "string") return "";
  const message = value.replace(/\s+/g, " ").trim();
  if (message.length > 500)
    throw new Error("Discord message must be 500 characters or fewer");
  return message;
}

export function shippedChangeAnnouncementKey(
  repoFullName: string,
  prNumber: number,
  channel: string,
  comment: string,
  screenshots: string[],
): string {
  const payload = JSON.stringify({
    destination: "discord",
    channel,
    comment,
    screenshots,
  });
  return `${repoFullName}#${prNumber}:${createHash("sha256").update(payload).digest("hex")}`;
}

/** Discord accepts nonce strings up to 25 characters for message deduplication. */
export function shippedChangeAnnouncementNonce(key: string): string {
  return createHash("sha256").update(key).digest("base64url").slice(0, 25);
}

function screenshotUpload(path: string, title: string): DiscordUpload {
  const extension = extname(path).toLowerCase();
  const contentType =
    extension === ".png"
      ? "image/png"
      : extension === ".gif"
        ? "image/gif"
        : extension === ".webp"
          ? "image/webp"
          : "image/jpeg";
  return {
    filename: basename(path),
    contentType,
    data: Uint8Array.from(readFileSync(path)).buffer,
    description: `Screenshot of the shipped visual change: ${title}`,
  };
}

export type ShippedVisualChangeResult =
  | ({
      status: "shared" | "already_shared";
      announcementKey: string;
    } & ShippedChangeDelivery)
  | { status: "already_shared" };

export async function shareShippedVisualChange(opts: {
  session: UnifiedSession;
  pr: { number: number; title: string; url: string };
  repoFullName: string;
  requestedBy?: string;
  channel: ShippedChangeChannel;
  message?: string;
  screenshots?: string[];
  discord: Pick<DiscordRest, "sendMessage" | "sendFiles">;
  announcementRoot?: string;
}): Promise<ShippedVisualChangeResult> {
  if (opts.screenshots?.some((path) => !validFeaturedScreenshot(path)))
    throw new Error(
      "Each Discord screenshot must be a PNG, JPEG, GIF, or WebP file no larger than 10 MB",
    );
  const visual = selectShippedVisualChange(
    opts.session,
    validWalkthroughScreenshot,
    opts.screenshots,
  );
  const title = opts.pr.title.replace(/\|/g, "¦");
  const message =
    normalizeShippedChangeMessage(opts.message) ||
    shippedChangeOneLiner(visual?.summary || "");
  if (!message) throw new Error("Write a short Discord message first");
  const announcementKey = shippedChangeAnnouncementKey(
    opts.repoFullName,
    opts.pr.number,
    opts.channel.id,
    message,
    visual?.screenshots || [],
  );
  const claimId = claimShippedChangeAnnouncement(
    announcementKey,
    opts.announcementRoot,
  );
  if (!claimId) {
    const delivery = shippedChangeAnnouncementDelivery(
      announcementKey,
      opts.announcementRoot,
    );
    return delivery
      ? { status: "already_shared", ...delivery, announcementKey }
      : { status: "already_shared" };
  }
  const nonce = shippedChangeAnnouncementNonce(announcementKey);
  let messageId: string;
  try {
    const posted = visual
      ? await opts.discord.sendFiles(
          opts.channel.id,
          message,
          visual.screenshots.map((path) => screenshotUpload(path, title)),
          nonce,
        )
      : await opts.discord.sendMessage(
          opts.channel.id,
          message,
          undefined,
          nonce,
        );
    messageId = posted.id;
  } catch (error) {
    settleShippedChangeAnnouncement(
      announcementKey,
      claimId,
      false,
      undefined,
      opts.announcementRoot,
    );
    throw error;
  }
  const delivery: ShippedChangeDelivery = {
    channel: opts.channel,
    permalink: `https://discord.com/channels/${opts.channel.guildId}/${opts.channel.id}/${messageId}`,
    messageId,
    at: new Date().toISOString(),
    ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}),
    prNumber: opts.pr.number,
  };
  settleShippedChangeAnnouncement(
    announcementKey,
    claimId,
    true,
    opts.session.id,
    opts.announcementRoot,
    delivery,
  );
  audit({
    msg: "github_shipped_visual_change_announced",
    repo: opts.repoFullName,
    pr_number: opts.pr.number,
    session_id: opts.session.id,
    discord_channel: opts.channel.id,
    requested_by: opts.requestedBy,
  });
  console.log(
    `[github] Shared merged change ${opts.repoFullName}#${opts.pr.number} in Discord from ${opts.session.id}`,
  );
  return {
    status: "shared",
    ...delivery,
    announcementKey,
  };
}
