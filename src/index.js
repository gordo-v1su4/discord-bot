import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
} from "discord.js";

const PANEL_MARKER_PREFIX = "[PINDECK_IMAGE_PANEL]";
const MOD_ACTION_PREFIX = "pindeck_mod";
const VAR_ACTION_PREFIX = "pindeck_var";
const MAX_MENU_ITEMS = 25;
const HARD_MAX_IMPORTED_IMAGES_PER_MESSAGE = 10;
const DEFAULT_QUEUE_REVIEW_LIMIT = 5;
const DEFAULT_HTTP_RETRY_ATTEMPTS = 3;
const RETRYABLE_HTTP_STATUS_CODES = new Set([429, 502, 503, 504, 522, 524]);
const MAX_LOG_BODY_LENGTH = 280;
const VARIATION_MODE_OPTIONS = [
  { mode: "shot-variation", label: "Shot" },
  { mode: "action-shot", label: "Action" },
  { mode: "coverage", label: "Coverage" },
  { mode: "b-roll", label: "B-Roll" },
  { mode: "style-variation", label: "Style" },
  { mode: "subtle-variation", label: "Subtle" },
];

const BASE_CHANNEL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
];

const MESSAGE_POST_PERMISSIONS = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
];

const PERMISSION_NAME_MAP = new Map([
  [PermissionFlagsBits.ViewChannel, "View Channels"],
  [PermissionFlagsBits.SendMessages, "Send Messages"],
  [PermissionFlagsBits.EmbedLinks, "Embed Links"],
  [PermissionFlagsBits.ReadMessageHistory, "Read Message History"],
  [PermissionFlagsBits.AddReactions, "Add Reactions"],
  [PermissionFlagsBits.UseApplicationCommands, "Use Application Commands"],
]);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;

    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadLocalEnv() {
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, ".env.local"),
    path.resolve(cwd, ".env"),
    path.resolve(cwd, "../../.env.local"),
    path.resolve(cwd, "../../.env"),
    path.resolve(cwd, "../.env.local"),
    path.resolve(cwd, "../.env"),
  ];

  for (const candidate of candidates) {
    loadEnvFile(candidate);
  }
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "image";
}

function normalizeEmoji(emoji) {
  if (!emoji || typeof emoji !== "string") return null;
  return emoji.trim();
}

function emojiMatchKeys(emoji) {
  if (!emoji) return new Set();
  const keys = new Set([emoji]);
  const custom = emoji.match(/^<a?:([a-zA-Z0-9_]+):(\d+)>$/);
  if (custom) {
    keys.add(`id:${custom[2]}`);
    keys.add(`name:${custom[1]}`);
  }
  return keys;
}

function reactionKeys(reaction) {
  const keys = new Set();
  if (reaction.emoji?.id) {
    keys.add(`id:${reaction.emoji.id}`);
  }
  if (reaction.emoji?.name) {
    keys.add(reaction.emoji.name);
    keys.add(`name:${reaction.emoji.name}`);
  }
  const rendered = reaction.emoji?.toString?.();
  if (rendered) keys.add(rendered);
  return keys;
}

function toComponentEmoji(emoji) {
  if (!emoji) return undefined;
  const custom = emoji.match(/^<(a?):([a-zA-Z0-9_]+):(\d+)>$/);
  if (custom) {
    return {
      animated: custom[1] === "a",
      name: custom[2],
      id: custom[3],
    };
  }

  return { name: emoji };
}

function parseImagesFromEnv(raw) {
  if (!raw) {
    return [
      {
        id: "sample-1",
        label: "Sample Image 1",
        url: "https://placehold.co/1200x675/png?text=Sample+Image+1",
        emoji: "1️⃣",
      },
      {
        id: "sample-2",
        label: "Sample Image 2",
        url: "https://placehold.co/1200x675/png?text=Sample+Image+2",
        emoji: "2️⃣",
      },
      {
        id: "sample-3",
        label: "Sample Image 3",
        url: "https://placehold.co/1200x675/png?text=Sample+Image+3",
        emoji: "3️⃣",
      },
    ];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`DISCORD_IMAGES_JSON must be valid JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("DISCORD_IMAGES_JSON must be a non-empty JSON array");
  }

  return parsed.map((item, idx) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Image at index ${idx} must be an object`);
    }

    const label = String(item.label || item.name || `Image ${idx + 1}`).trim();
    const id = slugify(item.id || label || `image-${idx + 1}`);
    const url = String(item.url || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`Image ${id} has invalid url. Expected http(s) URL`);
    }

    const emoji = normalizeEmoji(item.emoji);

    return {
      id,
      label: label.slice(0, 100),
      url,
      emoji,
    };
  });
}

function parseCsv(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInt(raw, fallback) {
  const parsed = Number.parseInt(String(raw || ""), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateForLog(value, limit = MAX_LOG_BODY_LENGTH) {
  const text = compactWhitespace(value);
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function logStructured(level, event, data = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

function describeReaction(reaction) {
  if (!reaction?.emoji) return "unknown";
  if (reaction.emoji.id) {
    return `<:${reaction.emoji.name || "emoji"}:${reaction.emoji.id}>`;
  }
  return reaction.emoji.name || "unknown";
}

async function fetchJsonWithRetry({
  url,
  options,
  operation,
  context = {},
  maxAttempts = DEFAULT_HTTP_RETRY_ATTEMPTS,
}) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      const rawText = await response.text().catch(() => "");

      if (!response.ok) {
        const bodySnippet = truncateForLog(rawText);
        const retryable =
          RETRYABLE_HTTP_STATUS_CODES.has(response.status) && attempt < maxAttempts;

        logStructured(retryable ? "warn" : "error", `${operation}_http_error`, {
          ...context,
          attempt,
          maxAttempts,
          status: response.status,
          retryable,
          bodySnippet,
          url,
        });

        if (retryable) {
          await sleep(400 * attempt);
          continue;
        }

        throw new Error(
          `${operation} failed (${response.status}): ${bodySnippet || "no response body"}`
        );
      }

      let parsed = {};
      if (rawText) {
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parsed = { rawText };
        }
      }

      logStructured("info", `${operation}_ok`, {
        ...context,
        attempt,
        maxAttempts,
        status: response.status,
        url,
        imageId: parsed?.imageId,
        userId: parsed?.userId,
        itemCount: Array.isArray(parsed?.items) ? parsed.items.length : undefined,
      });
      return parsed;
    } catch (error) {
      const retryable = attempt < maxAttempts;
      logStructured(retryable ? "warn" : "error", `${operation}_request_error`, {
        ...context,
        attempt,
        maxAttempts,
        retryable,
        url,
        message: error?.message || String(error),
      });
      lastError = error;
      if (!retryable) {
        throw error;
      }
      await sleep(400 * attempt);
    }
  }

  throw lastError || new Error(`${operation} failed`);
}

function normalizeBaseUrl(raw) {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function deriveIngestEndpoint() {
  const explicit = normalizeBaseUrl(process.env.PINDECK_INGEST_URL || process.env.DISCORD_INGEST_URL);
  if (explicit) {
    if (explicit.endsWith("/ingestExternal")) return explicit;
    return `${explicit}/ingestExternal`;
  }

  const candidates = [
    process.env.CONVEX_SITE_URL,
    process.env.VITE_CONVEX_SITE_URL,
    process.env.CONVEX_URL,
    process.env.VITE_CONVEX_URL,
  ];

  for (const candidate of candidates) {
    const base = normalizeBaseUrl(candidate);
    if (!base) continue;

    try {
      const url = new URL(base);
      if (url.hostname.endsWith(".convex.cloud")) {
        url.hostname = url.hostname.replace(".convex.cloud", ".convex.site");
      }
      return `${url.toString().replace(/\/$/, "")}/ingestExternal`;
    } catch {
      // ignore invalid candidate
    }
  }

  return null;
}

function deriveEndpointFromBase({
  explicitRaw,
  suffix,
  fallbackIngestEndpoint,
}) {
  const explicit = normalizeBaseUrl(explicitRaw);
  if (explicit) {
    // Accept both current and legacy route styles when explicitly configured.
    if (
      explicit.endsWith(`/${suffix}`) ||
      explicit.endsWith("/discordQueue") ||
      explicit.endsWith("/discordModerate") ||
      explicit.endsWith("/discord/queue") ||
      explicit.endsWith("/discord/moderation")
    ) {
      return explicit;
    }
    return `${explicit}/${suffix}`;
  }
  if (fallbackIngestEndpoint) {
    return fallbackIngestEndpoint.replace(/\/ingestExternal$/, `/${suffix}`);
  }
  return null;
}

function deriveDiscordQueueEndpoint(fallbackIngestEndpoint) {
  return deriveEndpointFromBase({
    explicitRaw: process.env.PINDECK_DISCORD_QUEUE_URL || process.env.DISCORD_QUEUE_URL,
    suffix: "discordQueue",
    fallbackIngestEndpoint,
  });
}

function deriveDiscordModerationEndpoint(fallbackIngestEndpoint) {
  return deriveEndpointFromBase({
    explicitRaw:
      process.env.PINDECK_DISCORD_MODERATION_URL || process.env.DISCORD_MODERATION_URL,
    suffix: "discordModerate",
    fallbackIngestEndpoint,
  });
}

function parseEmojiTriggers(raw) {
  const values = parseCsv(raw || "📥");
  return values.map((value) => ({
    raw: value,
    keys: emojiMatchKeys(value),
  }));
}

function isReactionIngestTrigger(reaction, triggers) {
  if (!triggers.length) return false;
  const keys = reactionKeys(reaction);
  return triggers.some((trigger) => [...trigger.keys].some((key) => keys.has(key)));
}

function canonicalImageUrlKey(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;
    if (host.includes("twimg.com") && pathname.includes("/media/")) {
      const mediaId = pathname.split("/").pop()?.split(".")[0] || pathname;
      const format = parsed.searchParams.get("format") || pathname.split(".").pop() || "jpg";
      return `${host}/media/${mediaId}.${format}`.toLowerCase();
    }
    return `${host}${pathname}`.toLowerCase();
  } catch {
    return String(rawUrl || "").trim().toLowerCase();
  }
}

function isLikelyImportImageUrl(rawUrl) {
  if (!looksLikeImageUrl(rawUrl)) return false;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const full = `${host}${path}`;

    const blockedFragments = [
      "profile_images",
      "profile_banners",
      "emoji",
      "twemoji",
      "favicon",
      "apple-touch-icon",
      "/icons/",
      "/icon/",
      "/avatar",
      "/sprite",
      "/logo",
      "abs.twimg.com",
      "static.xx.fbcdn.net",
    ];

    if (blockedFragments.some((frag) => full.includes(frag))) return false;
    if (host.includes("twimg.com") && !path.includes("/media/")) return false;
    return true;
  } catch {
    return false;
  }
}

function dedupeImageUrls(urls) {
  const map = new Map();
  for (const raw of urls) {
    const cleaned = cleanCapturedUrl(raw).replace(/&amp;/g, "&");
    if (!isLikelyImportImageUrl(cleaned)) continue;
    const key = canonicalImageUrlKey(cleaned);
    if (!map.has(key)) {
      map.set(key, cleaned);
    }
  }
  return [...map.values()];
}

function rankImportImageUrls(urls) {
  const scored = urls.map((url) => {
    const u = url.toLowerCase();
    let score = 0;
    if (u.includes("pbs.twimg.com/media/")) score += 100;
    if (u.includes("media.discordapp.net/attachments/") || u.includes("cdn.discordapp.com/attachments/")) score += 90;
    if (u.includes("name=orig")) score += 15;
    if (u.includes("name=large")) score += 10;
    if (u.includes("/thumb")) score -= 20;
    return { url, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((item) => item.url);
}

function buildImportExternalId({ sourceMessage, imageUrl, pindeckUserId }) {
  const key = canonicalImageUrlKey(imageUrl);
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 20);
  return `discord:url:${pindeckUserId || "unknown"}:${sourceMessage.guildId || "dm"}:${digest}`;
}

function extractImageLinksFromMessage(message) {
  const urls = [];

  for (const attachment of message.attachments?.values?.() || []) {
    const contentType = attachment.contentType || "";
    const looksLikeImage =
      contentType.startsWith("image/") ||
      /\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/i.test(attachment.url || "");
    if (looksLikeImage && attachment.url) {
      urls.push(attachment.url);
    }
  }

  for (const embed of message.embeds || []) {
    if (embed.image?.url) urls.push(embed.image.url);
    if (embed.url && /\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/i.test(embed.url)) {
      urls.push(embed.url);
    }
  }

  const content = message.content || "";
  const urlMatches = content.match(/https?:\/\/\S+/g) || [];
  for (const match of urlMatches) {
    if (/\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/i.test(match)) {
      urls.push(match);
    }
  }

  return rankImportImageUrls(dedupeImageUrls(urls));
}

function extractAllUrls(text) {
  if (!text) return [];
  return text.match(/https?:\/\/\S+/g) || [];
}

function cleanCapturedUrl(raw) {
  return String(raw || "").replace(/[),.;!?]+$/g, "").trim();
}

function looksLikeImageUrl(url) {
  return (
    /\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/i.test(url || "") ||
    /[?&]format=(jpg|jpeg|png|webp|gif|bmp)(?:&|$)/i.test(url || "")
  );
}

function extractSrefFromText(text) {
  if (!text) return undefined;
  const patterns = [
    /\bsref(?:\s*(?:number|num|#|:|-))?\s*(\d{2,})\b/i,
    /#sref[-\s]?(\d{2,})\b/i,
    /\bsref[-_]?(\d{2,})\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }

  return undefined;
}

function extractPostMetadataFromMessage(message) {
  const content = (message.content || "").trim();
  const firstEmbed = message.embeds?.[0];
  const embedTitle = firstEmbed?.title?.trim();
  const embedDescription = firstEmbed?.description?.trim();
  const embedUrl = firstEmbed?.url?.trim();
  const embedAuthor = firstEmbed?.author?.name?.trim();

  const combinedText = [content, embedTitle, embedDescription, embedAuthor]
    .filter(Boolean)
    .join("\n");

  const urls = extractAllUrls(content);
  const nonImageUrls = urls.filter((url) => !looksLikeImageUrl(url));

  const sourcePostUrl =
    embedUrl ||
    nonImageUrls.find((url) => !url.includes("discord.com/channels/")) ||
    buildMessagePermalink(message);

  const title =
    embedTitle ||
    content.split("\n").map((line) => line.trim()).find(Boolean) ||
    `Discord import ${new Date(message.createdTimestamp).toISOString()}`;

  let description = content;
  if (!description && embedDescription) {
    description = embedDescription;
  } else if (description && embedDescription && !description.includes(embedDescription)) {
    description = `${description}\n\n${embedDescription}`;
  }

  const sref = extractSrefFromText(combinedText);

  return {
    title: title.slice(0, 120),
    description: description ? description.slice(0, 1000) : undefined,
    sourcePostUrl,
    sref,
  };
}

function toFxTwitterUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (host === "x.com" || host === "www.x.com" || host === "twitter.com" || host === "www.twitter.com") {
      parsed.hostname = "fxtwitter.com";
      return parsed.toString();
    }
    return rawUrl;
  } catch {
    return null;
  }
}

async function fetchExternalImageUrls(sourcePostUrl) {
  const normalized = toFxTwitterUrl(sourcePostUrl);
  if (!normalized) return [];

  try {
    const url = new URL(normalized);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return [];

    const response = await fetch(normalized, {
      signal: AbortSignal.timeout(5000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; PindeckDiscordBot/1.0)",
      },
    });
    if (!response.ok) return [];

    const html = await response.text();
    const candidates = [];

    const urlMatches = html.match(/https?:\/\/[^"'\\\s<>)]+/g) || [];
    for (const match of urlMatches) {
      candidates.push(match);
    }

    // Catch escaped URLs often found in script tags.
    const escapedMatches = html.match(/https?:\\\/\\\/[^"'\\\s<>)]+/g) || [];
    for (const match of escapedMatches) {
      candidates.push(match.replace(/\\\//g, "/"));
    }

    return rankImportImageUrls(dedupeImageUrls(candidates));
  } catch (error) {
    console.warn("Failed external media parse:", error.message);
    return [];
  }
}

async function collectImageLinksForImport(message, sourcePostUrl, fetchExternal) {
  const direct = extractImageLinksFromMessage(message);
  if (!fetchExternal || !sourcePostUrl) {
    return rankImportImageUrls(dedupeImageUrls(direct));
  }

  const fromSource = await fetchExternalImageUrls(sourcePostUrl);
  return rankImportImageUrls(dedupeImageUrls([...direct, ...fromSource]));
}

function buildMessagePermalink(message) {
  if (!message.guildId) return undefined;
  return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
}

function parseDiscordMessageLink(link) {
  if (!link) return null;
  const match = link.match(
    /^https?:\/\/(?:canary\.|ptb\.)?discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)$/
  );
  if (!match) return null;
  return {
    guildId: match[1],
    channelId: match[2],
    messageId: match[3],
  };
}

async function resolveMessageForImport(interaction, messageLink) {
  if (messageLink) {
    const parsed = parseDiscordMessageLink(messageLink);
    if (!parsed) {
      throw new Error("Invalid message_link. Use a full Discord message URL.");
    }

    const channel = await interaction.client.channels.fetch(parsed.channelId);
    if (!channel?.isTextBased?.()) {
      throw new Error("Target message channel is not text-based.");
    }

    const targetMessage = await channel.messages.fetch(parsed.messageId);
    if (!targetMessage) {
      throw new Error("Could not fetch target message.");
    }

    return targetMessage;
  }

  const recent = await interaction.channel.messages.fetch({ limit: 50 });
  const fallback = recent.find((msg) => extractImageLinksFromMessage(msg).length > 0);
  if (!fallback) {
    throw new Error("No recent image message found in this channel.");
  }
  return fallback;
}

function decodeBase64Url(value) {
  if (!value) return null;
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function deriveClientIdFromToken(botToken) {
  if (!botToken || typeof botToken !== "string") return null;
  const first = botToken.split(".")[0];
  if (!first) return null;
  const decoded = decodeBase64Url(first)?.trim();
  return decoded && /^\d+$/.test(decoded) ? decoded : null;
}

function buildCommands(images) {
  const choiceImages = images.slice(0, MAX_MENU_ITEMS);

  const imagesCommand = new SlashCommandBuilder()
    .setName("images")
    .setDescription("Pindeck image presets and Discord ingest moderation")
    .addSubcommand((sub) =>
      sub
        .setName("menu")
        .setDescription("Post an interactive select menu in this channel")
    )
    .addSubcommand((sub) =>
      sub
        .setName("send")
        .setDescription("Send one image preset directly")
        .addStringOption((opt) => {
          let option = opt
            .setName("preset")
            .setDescription("Preset image to send")
            .setRequired(true);
          for (const image of choiceImages) {
            option = option.addChoices({ name: image.label, value: image.id });
          }
          return option;
        })
    )
    .addSubcommand((sub) =>
      sub
        .setName("panel")
        .setDescription("Post an emoji reaction panel in this channel")
    )
    .addSubcommand((sub) =>
      sub
        .setName("import")
        .setDescription("Import image(s) from an existing Discord post into Pindeck")
        .addStringOption((opt) =>
          opt
            .setName("message_link")
            .setDescription("Optional Discord message URL. If omitted, imports latest image post in this channel.")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("review")
        .setDescription("Show Discord queue items with Approve / Deny / Generate buttons")
        .addStringOption((opt) =>
          opt
            .setName("image_id")
            .setDescription("Optional specific image ID from queue")
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("limit")
            .setDescription("How many queued items to show (1-10)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(10)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("approve")
        .setDescription("Approve a queued image by image ID")
        .addStringOption((opt) =>
          opt
            .setName("image_id")
            .setDescription("Pindeck image ID")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("reject")
        .setDescription("Reject and delete a queued image by image ID")
        .addStringOption((opt) =>
          opt
            .setName("image_id")
            .setDescription("Pindeck image ID")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("generate")
        .setDescription("Generate variations for an approved image by image ID")
        .addStringOption((opt) =>
          opt
            .setName("image_id")
            .setDescription("Pindeck image ID")
            .setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("count")
            .setDescription("Number of variations (1-12)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(12)
        )
        .addStringOption((opt) =>
          opt
            .setName("mode")
            .setDescription("Variation mode")
            .setRequired(false)
            .addChoices(
              { name: "Shot Variation", value: "shot-variation" },
              { name: "Action Shot", value: "action-shot" },
              { name: "Coverage", value: "coverage" },
              { name: "B-Roll", value: "b-roll" },
              { name: "Style Variation", value: "style-variation" },
              { name: "Subtle Variation", value: "subtle-variation" }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName("detail")
            .setDescription("Optional custom direction for generation")
            .setRequired(false)
        )
    );

  return [imagesCommand];
}

function checkChannelPermissions(channel, additional = []) {
  if (!channel?.isTextBased?.()) {
    return { ok: false, missing: ["Text channel required"] };
  }

  if (!channel.guild) {
    return { ok: true, missing: [] };
  }

  const me = channel.guild.members.me;
  if (!me) {
    return { ok: false, missing: ["Cannot resolve bot member in this guild"] };
  }

  const perms = channel.permissionsFor(me);
  if (!perms) {
    return { ok: false, missing: ["Cannot inspect channel permissions"] };
  }

  const needed = [...new Set([...BASE_CHANNEL_PERMISSIONS, ...additional])];
  const missingBits = needed.filter((bit) => !perms.has(bit));
  return {
    ok: missingBits.length === 0,
    missing: missingBits.map((bit) => PERMISSION_NAME_MAP.get(bit) || String(bit)),
  };
}

function buildImageEmbed(image, actorTag) {
  return new EmbedBuilder()
    .setTitle(image.label)
    .setImage(image.url)
    .setFooter({ text: actorTag ? `Requested by ${actorTag}` : "Pindeck bot" });
}

function buildMenuRow(images) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("pindeck_image_picker")
    .setPlaceholder("Choose an image to post")
    .addOptions(
      images.slice(0, MAX_MENU_ITEMS).map((image) => {
        const option = {
          label: image.label.slice(0, 100),
          description: image.id.slice(0, 100),
          value: image.id,
        };

        if (image.emoji) {
          option.emoji = toComponentEmoji(image.emoji);
        }

        return option;
      })
    );

  return new ActionRowBuilder().addComponents(menu);
}

function buildReactionPanelDescription(images) {
  const lines = images
    .filter((img) => Boolean(img.emoji))
    .slice(0, MAX_MENU_ITEMS)
    .map((img) => `${img.emoji}  ${img.label}`);

  if (lines.length === 0) {
    return "No emoji mappings configured. Add `emoji` for each image in `DISCORD_IMAGES_JSON`.";
  }

  return lines.join("\n");
}

async function registerCommands({ token, clientId, guildId, commands }) {
  const rest = new REST({ version: "10" }).setToken(token);
  const body = commands.map((command) => command.toJSON());

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
    console.log(`Registered ${body.length} command(s) in guild ${guildId}`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
    console.log("Registered global commands (can take up to ~1 hour to appear)");
  }
}

async function ingestIntoPindeck({
  ingestEndpoint,
  ingestApiKey,
  fallbackUserId,
  defaultTags,
  defaultCategory,
  actorUser,
  sourceMessage,
  imageUrl,
  externalId,
  title,
  description,
  sourceUrl,
  sref,
}) {
  if (!ingestEndpoint || !ingestApiKey) {
    throw new Error("Pindeck ingest is not configured. Set PINDECK_INGEST_URL and INGEST_API_KEY.");
  }

  const body = {
    userId: fallbackUserId || undefined,
    discordUserId: actorUser.id,
    discordUsername: actorUser.tag,
    title:
      title ||
      (sourceMessage.content || "").trim().slice(0, 120) ||
      `Discord import ${new Date(sourceMessage.createdTimestamp).toISOString()}`,
    description: description || (sourceMessage.content || "").trim().slice(0, 1000) || undefined,
    imageUrl,
    tags: defaultTags,
    category: defaultCategory,
    source: "Discord",
    sref,
    externalId,
    sourceType: "discord",
    sourceUrl: sourceUrl || buildMessagePermalink(sourceMessage),
  };

  logStructured("info", "discord_ingest_dispatch", {
    targetUserId: fallbackUserId || null,
    actorUserId: actorUser.id,
    actorUserTag: actorUser.tag,
    sourceMessageId: sourceMessage.id,
    channelId: sourceMessage.channelId,
    guildId: sourceMessage.guildId || "dm",
    externalId,
    imageUrl,
    sourceUrl: body.sourceUrl,
    sref: sref || null,
    ingestEndpoint,
  });

  return fetchJsonWithRetry({
    url: ingestEndpoint,
    operation: "discord_ingest",
    context: {
      targetUserId: fallbackUserId || null,
      actorUserId: actorUser.id,
      actorUserTag: actorUser.tag,
      sourceMessageId: sourceMessage.id,
      channelId: sourceMessage.channelId,
      guildId: sourceMessage.guildId || "dm",
      externalId,
      imageUrl,
      sourceUrl: body.sourceUrl,
      sref: sref || null,
    },
    options: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ingestApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  });
}

function truncateText(value, limit = 350) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function buildModerationCustomId(action, imageId) {
  return `${MOD_ACTION_PREFIX}:${action}:${imageId}`;
}

function parseModerationCustomId(customId) {
  if (!customId?.startsWith(`${MOD_ACTION_PREFIX}:`)) return null;
  const [, action, imageId] = customId.split(":");
  if (!action || !imageId) return null;
  if (!["approve", "reject", "generate"].includes(action)) return null;
  return { action, imageId };
}

function buildVariationCustomId(mode, imageId) {
  return `${VAR_ACTION_PREFIX}:${mode}:${imageId}`;
}

function parseVariationCustomId(customId) {
  if (!customId?.startsWith(`${VAR_ACTION_PREFIX}:`)) return null;
  const [, mode, imageId] = customId.split(":");
  if (!mode || !imageId) return null;
  if (!VARIATION_MODE_OPTIONS.some((item) => item.mode === mode)) return null;
  return { mode, imageId };
}

function buildVariationRows(imageId) {
  const firstRow = new ActionRowBuilder().addComponents(
    ...VARIATION_MODE_OPTIONS.slice(0, 5).map((item) =>
      new ButtonBuilder()
        .setCustomId(buildVariationCustomId(item.mode, imageId))
        .setLabel(item.label)
        .setStyle(ButtonStyle.Secondary)
    )
  );
  const secondRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildVariationCustomId(VARIATION_MODE_OPTIONS[5].mode, imageId))
      .setLabel(VARIATION_MODE_OPTIONS[5].label)
      .setStyle(ButtonStyle.Secondary)
  );
  return [firstRow, secondRow];
}

function extractStatusEventAndImageId(messageContent) {
  const text = String(messageContent || "");
  const eventMatch = text.match(/Event:\s*([a-z_]+)/i);
  const imageIdMatch = text.match(/Image ID:\s*([^\s`]+)/i);
  return {
    event: eventMatch?.[1]?.toLowerCase(),
    imageId: imageIdMatch?.[1],
  };
}

function buildModerationRow(imageId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildModerationCustomId("approve", imageId))
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(buildModerationCustomId("reject", imageId))
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(buildModerationCustomId("generate", imageId))
      .setLabel("Generate")
      .setStyle(ButtonStyle.Primary)
  );
}

function buildDiscordQueueEmbed(item) {
  const embed = new EmbedBuilder()
    .setTitle(truncateText(item.title || "Untitled", 250))
    .setDescription(truncateText(item.description || "", 600) || "No description")
    .addFields(
      { name: "Image ID", value: `\`${item._id}\``, inline: false },
      {
        name: "Status",
        value: `${item.status || "unknown"} / ${item.aiStatus || "n/a"}`,
        inline: true,
      },
      { name: "sref", value: item.sref ? `\`${item.sref}\`` : "n/a", inline: true }
    )
    .setFooter({ text: item.parentImageId ? `Parent: ${item.parentImageId}` : "Discord Queue" });

  if (item.imageUrl) {
    embed.setImage(item.imageUrl);
  }
  if (item.sourceUrl) {
    embed.setURL(item.sourceUrl);
  }
  return embed;
}

async function fetchDiscordQueue({
  queueEndpoint,
  ingestApiKey,
  userId,
  limit,
  imageId,
}) {
  if (!queueEndpoint || !ingestApiKey || !userId) {
    throw new Error(
      "Queue endpoint not configured. Set PINDECK_USER_ID, INGEST_API_KEY, and queue endpoint."
    );
  }

  const data = await fetchJsonWithRetry({
    url: queueEndpoint,
    operation: "discord_queue_fetch",
    context: {
      userId,
      limit: limit || DEFAULT_QUEUE_REVIEW_LIMIT,
      imageId: imageId || null,
    },
    options: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ingestApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId,
        limit: limit || DEFAULT_QUEUE_REVIEW_LIMIT,
        imageId: imageId || undefined,
      }),
    },
  });
  return Array.isArray(data?.items) ? data.items : [];
}

async function moderateDiscordImage({
  moderationEndpoint,
  ingestApiKey,
  userId,
  imageId,
  action,
  variationCount,
  modificationMode,
  variationDetail,
}) {
  if (!moderationEndpoint || !ingestApiKey || !userId) {
    throw new Error(
      "Moderation endpoint not configured. Set PINDECK_USER_ID, INGEST_API_KEY, and moderation endpoint."
    );
  }

  return fetchJsonWithRetry({
    url: moderationEndpoint,
    operation: "discord_moderation",
    context: {
      userId,
      imageId,
      action,
      variationCount: variationCount ?? null,
      modificationMode: modificationMode ?? null,
    },
    options: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ingestApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId,
        imageId,
        action,
        variationCount,
        modificationMode,
        variationDetail,
      }),
    },
  });
}

function printStartupChecklist({
  guildId,
  images,
  ingestEndpoint,
  queueEndpoint,
  moderationEndpoint,
  ingestTriggers,
  fallbackUserId,
  usingSamplePresets,
  ingestFetchExternal,
  ingestMaxImagesPerPost,
}) {
  console.log("Discord bot configuration summary");
  console.log(`- Guild scope: ${guildId || "Global"}`);
  console.log(`- Presets loaded: ${images.length}`);
  if (usingSamplePresets) {
    console.log("- Preset source: DISCORD_IMAGES_JSON missing, using placeholder samples");
  }
  if (images.length > MAX_MENU_ITEMS) {
    console.log(`- Note: only first ${MAX_MENU_ITEMS} presets are available in slash choices/menu`);
  }
  console.log("- Recommended command: /images menu");
  console.log("- Optional fallback: /images panel + emoji reactions");
  console.log("- Discord queue review command: /images review");
  console.log(`- Ingest endpoint: ${ingestEndpoint || "disabled"}`);
  console.log(`- Queue endpoint: ${queueEndpoint || "disabled"}`);
  console.log(`- Moderation endpoint: ${moderationEndpoint || "disabled"}`);
  console.log(
    `- Ingest reaction triggers: ${ingestTriggers.length ? ingestTriggers.map((i) => i.raw).join(", ") : "none"}`
  );
  console.log(`- Ingest target userId: ${fallbackUserId || "none (set PINDECK_USER_ID)"}`);
  console.log(`- Ingest external post parsing: ${ingestFetchExternal ? "enabled" : "disabled"}`);
  console.log(`- Ingest max images per trigger: ${ingestMaxImagesPerPost}`);
  console.log(`- Auto variation buttons on approved status: ${postVariationButtonsOnApproved ? "enabled" : "disabled"}`);
}

loadLocalEnv();

const token = process.env.DISCORD_TOKEN;
const clientId =
  process.env.DISCORD_CLIENT_ID ||
  process.env.DISCORD_APPLICATION_ID ||
  process.env.DISCORD_APP_ID ||
  deriveClientIdFromToken(process.env.DISCORD_TOKEN);
const guildId = process.env.DISCORD_GUILD_ID;
const dryRun = process.env.DISCORD_DRY_RUN === "1";
const ingestApiKey = process.env.INGEST_API_KEY;
const ingestEndpoint = deriveIngestEndpoint();
const queueEndpoint = deriveDiscordQueueEndpoint(ingestEndpoint);
const moderationEndpoint = deriveDiscordModerationEndpoint(ingestEndpoint);
const ingestTriggers = parseEmojiTriggers(process.env.DISCORD_INGEST_EMOJIS);
const fallbackIngestUserId =
  process.env.PINDECK_USER_ID || process.env.DISCORD_DEFAULT_PINDECK_USER_ID || null;
const ingestDefaultTags = parseCsv(process.env.DISCORD_INGEST_DEFAULT_TAGS || "discord,imported");
const ingestDefaultCategory = process.env.DISCORD_INGEST_DEFAULT_CATEGORY || "General";
const ingestConfirmations = process.env.DISCORD_INGEST_CONFIRMATIONS !== "0";
const ingestFetchExternal = process.env.DISCORD_INGEST_FETCH_EXTERNAL !== "0";
const ingestMaxImagesPerPost = Math.min(
  HARD_MAX_IMPORTED_IMAGES_PER_MESSAGE,
  parsePositiveInt(process.env.DISCORD_INGEST_MAX_IMAGES_PER_POST, 1)
);
const discordGenerateDefaultCount = Math.min(
  12,
  parsePositiveInt(process.env.DISCORD_GENERATE_DEFAULT_COUNT, 2)
);
const discordGenerateDefaultMode =
  process.env.DISCORD_GENERATE_DEFAULT_MODE || "shot-variation";
const postVariationButtonsOnApproved = process.env.DISCORD_APPROVED_VARIATION_BUTTONS !== "0";
const usingSamplePresets = !process.env.DISCORD_IMAGES_JSON;

let images;
try {
  images = parseImagesFromEnv(process.env.DISCORD_IMAGES_JSON);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (!token) {
  console.error("Missing DISCORD_TOKEN");
  process.exit(1);
}

if (!clientId) {
  console.error("Missing DISCORD_CLIENT_ID (or DISCORD_APPLICATION_ID)");
  process.exit(1);
}

const imagesById = new Map(images.map((img) => [img.id, { ...img, emojiKeys: emojiMatchKeys(img.emoji) }]));

const commands = buildCommands(images);

if (dryRun) {
  printStartupChecklist({
    guildId,
    images,
    ingestEndpoint,
    queueEndpoint,
    moderationEndpoint,
    ingestTriggers,
    fallbackUserId: fallbackIngestUserId,
    usingSamplePresets,
    ingestFetchExternal,
    ingestMaxImagesPerPost,
  });
  registerCommands({ token, clientId, guildId, commands })
    .then(() => {
      console.log("Dry run complete.");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Dry run failed:", error.message);
      process.exit(1);
    });
} else {
  // Health endpoint for Docker / monitoring (GET / or GET /health)
  const healthPort = Number(process.env.HEALTH_PORT) || 8080;
  const healthPayload = JSON.stringify({ ok: true, service: "pindeck-discord-bot" });
  http
    .createServer((req, res) => {
      if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(healthPayload);
      } else {
        res.writeHead(404).end();
      }
    })
    .listen(healthPort, "0.0.0.0", () => {
      console.log(`Health check: http://0.0.0.0:${healthPort}/health`);
    });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      await registerCommands({ token, clientId, guildId, commands });
      printStartupChecklist({
        guildId,
        images,
        ingestEndpoint,
        queueEndpoint,
        moderationEndpoint,
        ingestTriggers,
        fallbackUserId: fallbackIngestUserId,
        usingSamplePresets,
        ingestFetchExternal,
        ingestMaxImagesPerPost,
      });
      console.log(`Logged in as ${readyClient.user.tag}`);
    } catch (error) {
      console.error("Failed to register slash commands:", error);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName !== "images") return;

        const subcommand = interaction.options.getSubcommand();
        let extraPermissions = [];
        if (subcommand === "send" || subcommand === "menu" || subcommand === "review") {
          extraPermissions = [...MESSAGE_POST_PERMISSIONS];
        } else if (subcommand === "panel") {
          extraPermissions = [...MESSAGE_POST_PERMISSIONS, PermissionFlagsBits.AddReactions];
        }
        const permissionCheck = checkChannelPermissions(interaction.channel, extraPermissions);
        if (!permissionCheck.ok) {
          await interaction.reply({
            content: `I can't run this here yet. Missing: ${permissionCheck.missing.join(", ")}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (subcommand === "send") {
          const preset = interaction.options.getString("preset", true);
          const image = imagesById.get(preset);
          if (!image) {
            await interaction.reply({ content: "Preset not found.", flags: MessageFlags.Ephemeral });
            return;
          }

          await interaction.channel.send({ embeds: [buildImageEmbed(image, interaction.user.tag)] });
          await interaction.reply({ content: `Posted **${image.label}**.`, flags: MessageFlags.Ephemeral });
          return;
        }

        if (subcommand === "menu") {
          await interaction.channel.send({
            content: "Choose an image from the menu below:",
            components: [buildMenuRow(images)],
          });
          await interaction.reply({ content: "Image menu posted.", flags: MessageFlags.Ephemeral });
          return;
        }

        if (subcommand === "panel") {
          const description = buildReactionPanelDescription(images);
          const panel = await interaction.channel.send({
            content: `${PANEL_MARKER_PREFIX}`,
            embeds: [
              new EmbedBuilder()
                .setTitle("Image Reaction Panel")
                .setDescription(description)
                .setFooter({ text: "React to post an image" }),
            ],
          });

          for (const image of images) {
            if (!image.emoji) continue;
            try {
              await panel.react(image.emoji);
            } catch (error) {
              console.warn(`Unable to add reaction ${image.emoji}:`, error.message);
            }
          }

          await interaction.reply({ content: "Reaction panel posted.", flags: MessageFlags.Ephemeral });
          return;
        }

        if (subcommand === "import") {
          if (!ingestEndpoint || !ingestApiKey) {
            await interaction.reply({
              content:
                "Ingest is not configured. Set PINDECK_INGEST_URL (or CONVEX_SITE_URL) and INGEST_API_KEY in .env.local.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          try {
            const messageLink = interaction.options.getString("message_link");
            const targetMessage = await resolveMessageForImport(interaction, messageLink);
            const postMeta = extractPostMetadataFromMessage(targetMessage);
            const imageLinks = (
              await collectImageLinksForImport(
                targetMessage,
                postMeta.sourcePostUrl,
                ingestFetchExternal
              )
            ).slice(0, ingestMaxImagesPerPost);
            const tagsForImport = [...new Set([
              ...ingestDefaultTags,
              postMeta.sref ? `sref:${postMeta.sref}` : "",
            ].filter(Boolean))];

            if (!imageLinks.length) {
              await interaction.reply({
                content: "No image URLs found in that message.",
                flags: MessageFlags.Ephemeral,
              });
              return;
            }

            let imported = 0;
            let failures = 0;
            for (let i = 0; i < imageLinks.length; i += 1) {
              const imageUrl = imageLinks[i];
              const externalId = buildImportExternalId({
                sourceMessage: targetMessage,
                imageUrl,
                pindeckUserId: fallbackIngestUserId,
              });
              try {
                await ingestIntoPindeck({
                  ingestEndpoint,
                  ingestApiKey,
                  fallbackUserId: fallbackIngestUserId,
                  defaultTags: tagsForImport,
                  defaultCategory: ingestDefaultCategory,
                  actorUser: interaction.user,
                  sourceMessage: targetMessage,
                  imageUrl,
                  externalId,
                  title: postMeta.title,
                  description: postMeta.description,
                  sourceUrl: postMeta.sourcePostUrl,
                  sref: postMeta.sref,
                });
                imported += 1;
              } catch (error) {
                failures += 1;
                console.error("Slash import failed:", error.message);
              }
            }

            const permalink = buildMessagePermalink(targetMessage) || "selected message";
            await interaction.reply({
              content: `Imported ${imported}/${imageLinks.length} image(s) from ${permalink}.${postMeta.sref ? ` Parsed sref: ${postMeta.sref}.` : ""}${failures ? ` ${failures} failed.` : ""}`,
              flags: MessageFlags.Ephemeral,
            });
          } catch (error) {
            await interaction.reply({
              content: `Import failed: ${error.message}`,
              flags: MessageFlags.Ephemeral,
            });
          }
        }

        if (subcommand === "review") {
          if (!queueEndpoint || !ingestApiKey || !fallbackIngestUserId) {
            await interaction.reply({
              content:
                "Discord queue review is not configured. Set PINDECK_USER_ID, INGEST_API_KEY, and a queue endpoint.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const imageId = interaction.options.getString("image_id");
            const limit =
              interaction.options.getInteger("limit") || DEFAULT_QUEUE_REVIEW_LIMIT;
            const queueItems = await fetchDiscordQueue({
              queueEndpoint,
              ingestApiKey,
              userId: fallbackIngestUserId,
              limit,
              imageId,
            });

            if (!queueItems.length) {
              await interaction.editReply(
                imageId
                  ? `No pending Discord queue item found for image ID \`${imageId}\`.`
                  : "No pending Discord queue items found."
              );
              return;
            }

            for (const item of queueItems) {
              await interaction.channel.send({
                embeds: [buildDiscordQueueEmbed(item)],
                components: [buildModerationRow(String(item._id))],
              });
            }

            await interaction.editReply(
              `Posted ${queueItems.length} queue item${queueItems.length !== 1 ? "s" : ""} with moderation buttons.`
            );
          } catch (error) {
            await interaction.editReply(`Queue review failed: ${error.message}`);
          }
          return;
        }

        if (subcommand === "approve" || subcommand === "reject" || subcommand === "generate") {
          if (!moderationEndpoint || !ingestApiKey || !fallbackIngestUserId) {
            await interaction.reply({
              content:
                "Discord moderation is not configured. Set PINDECK_USER_ID, INGEST_API_KEY, and a moderation endpoint.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const imageId = interaction.options.getString("image_id", true);
          const action = subcommand === "approve" ? "approve" : subcommand === "reject" ? "reject" : "generate";
          const variationCount =
            subcommand === "generate"
              ? interaction.options.getInteger("count") || discordGenerateDefaultCount
              : undefined;
          const modificationMode =
            subcommand === "generate"
              ? interaction.options.getString("mode") || discordGenerateDefaultMode
              : undefined;
          const variationDetail =
            subcommand === "generate" ? interaction.options.getString("detail") || undefined : undefined;

          try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const result = await moderateDiscordImage({
              moderationEndpoint,
              ingestApiKey,
              userId: fallbackIngestUserId,
              imageId,
              action,
              variationCount,
              modificationMode,
              variationDetail,
            });
            await interaction.editReply(
              `${action.toUpperCase()} OK for \`${imageId}\`${result?.message ? ` - ${result.message}` : ""}`
            );
          } catch (error) {
            await interaction.editReply(`${action.toUpperCase()} failed for \`${imageId}\`: ${error.message}`);
          }
          return;
        }

        return;
      }

      if (interaction.isButton()) {
        const parsed = parseModerationCustomId(interaction.customId);
        const parsedVariation = parseVariationCustomId(interaction.customId);
        if (!parsed && !parsedVariation) return;

        if (!moderationEndpoint || !ingestApiKey || !fallbackIngestUserId) {
          await interaction.reply({
            content:
              "Discord moderation is not configured. Set PINDECK_USER_ID, INGEST_API_KEY, and a moderation endpoint.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (parsedVariation) {
          try {
            const result = await moderateDiscordImage({
              moderationEndpoint,
              ingestApiKey,
              userId: fallbackIngestUserId,
              imageId: parsedVariation.imageId,
              action: "generate",
              variationCount: discordGenerateDefaultCount,
              modificationMode: parsedVariation.mode,
            });

            await interaction.reply({
              content: `GENERATE OK for \`${parsedVariation.imageId}\` (${parsedVariation.mode}, x${discordGenerateDefaultCount})${result?.message ? ` - ${result.message}` : ""}`,
              flags: MessageFlags.Ephemeral,
            });
          } catch (error) {
            await interaction.reply({
              content: `GENERATE failed for \`${parsedVariation.imageId}\` (${parsedVariation.mode}): ${error.message}`,
              flags: MessageFlags.Ephemeral,
            });
          }
          return;
        }

        try {
          const variationCount =
            parsed.action === "generate" ? discordGenerateDefaultCount : undefined;
          const modificationMode =
            parsed.action === "generate" ? discordGenerateDefaultMode : undefined;
          const result = await moderateDiscordImage({
            moderationEndpoint,
            ingestApiKey,
            userId: fallbackIngestUserId,
            imageId: parsed.imageId,
            action: parsed.action,
            variationCount,
            modificationMode,
          });

          await interaction.reply({
            content: `${parsed.action.toUpperCase()} OK for \`${parsed.imageId}\`${result?.message ? ` - ${result.message}` : ""}`,
            flags: MessageFlags.Ephemeral,
          });
        } catch (error) {
          await interaction.reply({
            content: `${parsed.action.toUpperCase()} failed for \`${parsed.imageId}\`: ${error.message}`,
            flags: MessageFlags.Ephemeral,
          });
        }
        return;
      }

      if (interaction.isStringSelectMenu() && interaction.customId === "pindeck_image_picker") {
        const preset = interaction.values[0];
        const image = imagesById.get(preset);
        if (!image) {
          await interaction.reply({ content: "Preset not found.", flags: MessageFlags.Ephemeral });
          return;
        }

        const permissionCheck = checkChannelPermissions(interaction.channel, MESSAGE_POST_PERMISSIONS);
        if (!permissionCheck.ok) {
          await interaction.reply({
            content: `I can't post in this channel yet. Missing: ${permissionCheck.missing.join(", ")}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.channel.send({ embeds: [buildImageEmbed(image, interaction.user.tag)] });
        await interaction.reply({ content: `Posted **${image.label}**.`, flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      console.error("Interaction error:", error);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Something went wrong processing that action.", flags: MessageFlags.Ephemeral });
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!postVariationButtonsOnApproved) return;
    if (!message.guildId || !message.webhookId) return;
    if (message.author?.id === client.user.id) return;
    if (!moderationEndpoint || !ingestApiKey || !fallbackIngestUserId) return;

    try {
      const { event, imageId } = extractStatusEventAndImageId(message.content || "");
      if (event !== "approved" || !imageId) return;

      const permissionCheck = checkChannelPermissions(message.channel, [PermissionFlagsBits.SendMessages]);
      if (!permissionCheck.ok) {
        console.warn(
          `Cannot post variation buttons in channel ${message.channelId}:`,
          permissionCheck.missing.join(", ")
        );
        return;
      }

      await message.channel.send({
        content: `Variations for \`${imageId}\` (default x${discordGenerateDefaultCount})`,
        components: buildVariationRows(imageId),
      });
    } catch (error) {
      console.error("Approved-status variation controls error:", error.message);
    }
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (user.bot) return;

    try {
      if (reaction.partial) await reaction.fetch();
      if (reaction.message?.partial) await reaction.message.fetch();

      const message = reaction.message;
      if (!message) return;

      // Existing image panel behavior
      if (message.author?.id === client.user.id && message.content?.startsWith(PANEL_MARKER_PREFIX)) {
        const keys = reactionKeys(reaction);
        const image = images.find((img) => [...img.emojiKeys].some((key) => keys.has(key)));
        if (image) {
          const permissionCheck = checkChannelPermissions(message.channel, MESSAGE_POST_PERMISSIONS);
          if (!permissionCheck.ok) {
            console.warn(
              `Cannot post from panel reaction in channel ${message.channelId}:`,
              permissionCheck.missing.join(", ")
            );
            return;
          }
          await message.channel.send({ embeds: [buildImageEmbed(image, user.tag)] });
        }
      }

      // New ingest behavior: custom reaction on any image message imports into Pindeck
      if (!isReactionIngestTrigger(reaction, ingestTriggers)) return;
      if (!ingestEndpoint || !ingestApiKey) {
        logStructured("warn", "reaction_ingest_skipped_not_configured", {
          reaction: describeReaction(reaction),
          messageId: message.id,
          channelId: message.channelId,
          guildId: message.guildId || "dm",
        });
        return;
      }

      const postMeta = extractPostMetadataFromMessage(message);
      const imageLinks = (
        await collectImageLinksForImport(message, postMeta.sourcePostUrl, ingestFetchExternal)
      ).slice(0, ingestMaxImagesPerPost);
      logStructured("info", "reaction_ingest_triggered", {
        reaction: describeReaction(reaction),
        actorUserId: user.id,
        actorUserTag: user.tag,
        targetUserId: fallbackIngestUserId || null,
        messageId: message.id,
        channelId: message.channelId,
        guildId: message.guildId || "dm",
        sourceUrl: postMeta.sourcePostUrl || null,
        sref: postMeta.sref || null,
        extractedImageCount: imageLinks.length,
        imageUrls: imageLinks.slice(0, 3),
      });
      if (!imageLinks.length) return;
      const tagsForImport = [...new Set([
        ...ingestDefaultTags,
        postMeta.sref ? `sref:${postMeta.sref}` : "",
      ].filter(Boolean))];

      let imported = 0;
      for (let i = 0; i < imageLinks.length; i += 1) {
        const imageUrl = imageLinks[i];
        const externalId = buildImportExternalId({
          sourceMessage: message,
          imageUrl,
          pindeckUserId: fallbackIngestUserId,
        });
        try {
          await ingestIntoPindeck({
            ingestEndpoint,
            ingestApiKey,
            fallbackUserId: fallbackIngestUserId,
            defaultTags: tagsForImport,
            defaultCategory: ingestDefaultCategory,
            actorUser: user,
            sourceMessage: message,
            imageUrl,
            externalId,
            title: postMeta.title,
            description: postMeta.description,
            sourceUrl: postMeta.sourcePostUrl,
            sref: postMeta.sref,
          });
          imported += 1;
        } catch (error) {
          logStructured("error", "reaction_ingest_failed", {
            reaction: describeReaction(reaction),
            actorUserId: user.id,
            actorUserTag: user.tag,
            targetUserId: fallbackIngestUserId || null,
            messageId: message.id,
            channelId: message.channelId,
            guildId: message.guildId || "dm",
            sourceUrl: postMeta.sourcePostUrl || null,
            externalId,
            imageUrl,
            message: error?.message || String(error),
          });
        }
      }

      if (imported > 0 && ingestConfirmations) {
        const permissionCheck = checkChannelPermissions(message.channel, [PermissionFlagsBits.SendMessages]);
        if (permissionCheck.ok) {
          await message.channel.send(
            `Imported ${imported} image(s) from message ${message.id} into Pindeck for <@${user.id}>.${postMeta.sref ? ` sref: ${postMeta.sref}.` : ""}`
          );
        }
      }
    } catch (error) {
      console.error("Reaction handler error:", error.message);
    }
  });

  client.login(token).catch((error) => {
    console.error("Discord login failed:", error.message);
    process.exit(1);
  });
}
