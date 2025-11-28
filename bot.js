/**
 * bot.js - Clean rebuild (preserves all commands)
 * Reworked for robustness, pairingCode support, game system, and Railway friendliness.
 *
 * Requirements:
 * npm i @whiskeysockets/baileys qrcode-terminal ytdl-core yt-search ytpl pino fs-extra openai dotenv
 * System: ffmpeg (for sticker conversion)
 *
 * Notes:
 * - This file will attempt to import canvas dynamically. If canvas is unavailable,
 *   image-based menus fall back to remote banners or text.
 * - Owner can be overridden with env var OWNER (useful on Railway).
 */

import * as baileys from "@whiskeysockets/baileys";
const {
  default: makeWASocket,
  useMultiFileAuthState,
  downloadContentFromMessage,
  DisconnectReason,
  makeInMemoryStore: nativeMakeInMemoryStore,
} = baileys;

import qrcode from "qrcode-terminal";
import fs from "fs";
import path from "path";
import pino from "pino";
import dotenv from "dotenv";
import yts from "yt-search";
import ytdl from "ytdl-core";
import { performance } from "perf_hooks";
import OpenAI from "openai";

dotenv.config();

// ---- paths & ensure dirs ----
const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const SUDO_FILE = path.join(DATA_DIR, "sudo.json");
const BANNED_FILE = path.join(DATA_DIR, "banned.json");
const CONFIG_FILE = path.join(ROOT, "config.json");
const GAMES_FILE = path.join(DATA_DIR, "games.json");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");
const SAVED_DIR = path.join(DATA_DIR, "saved");

for (const d of [DATA_DIR, AUTH_DIR, SAVED_DIR]) {
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
}
if (!fs.existsSync(SUDO_FILE)) fs.writeFileSync(SUDO_FILE, JSON.stringify([], null, 2));
if (!fs.existsSync(BANNED_FILE)) fs.writeFileSync(BANNED_FILE, JSON.stringify([], null, 2));
if (!fs.existsSync(GAMES_FILE)) fs.writeFileSync(GAMES_FILE, JSON.stringify({}, null, 2));
if (!fs.existsSync(PROFILES_FILE)) fs.writeFileSync(PROFILES_FILE, JSON.stringify({}, null, 2));

// safe defaults config
let config = {
  owner: "2349065494753@s.whatsapp.net",
  prefix: ".",
  modePublic: false,
  autoReplyCooldownMs: 10 * 60 * 1000,
  maxFileSizeBytes: 25 * 1024 * 1024,
  botName: "JohnBot",
  botStatus: "Online",
  openaiApiKey: "",
};

// load config.json if present
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    Object.assign(config, JSON.parse(raw || "{}"));
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  }
} catch (e) {
  console.warn("Failed loading config.json, using defaults.", e?.message ?? e);
}

// Owner override via env variable (Railway per-deploy)
if (process.env.OWNER) {
  config.owner = process.env.OWNER;
}

// make sure owner normalized when saved
// helper normalizeJid (robust)
function normalizeJid(jid) {
  if (!jid) return jid;
  try {
    const s = String(jid).trim();
    const atIndex = s.indexOf("@");
    if (atIndex === -1) return s.split(":")[0];
    const local = s.slice(0, atIndex).split(":")[0];
    const domain = s.slice(atIndex + 1);
    return `${local}@${domain}`;
  } catch (e) { return jid; }
}

// persist helpers
const saveJson = (p, obj) => {
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); } catch (e) { console.warn("saveJson error", e?.message ?? e); }
};

let sudoList = [];
let bannedList = [];
try { sudoList = JSON.parse(fs.readFileSync(SUDO_FILE, "utf8") || "[]"); } catch (e) { sudoList = []; }
try { bannedList = JSON.parse(fs.readFileSync(BANNED_FILE, "utf8") || "[]"); } catch (e) { bannedList = []; }

// normalize lists
const normalizeArray = (arr) => Array.from(new Set((arr || []).map(normalizeJid).filter(Boolean)));
sudoList = normalizeArray(sudoList);
bannedList = normalizeArray(bannedList);

// ensure owner is in sudoList
if (!sudoList.includes(normalizeJid(config.owner))) {
  sudoList.unshift(normalizeJid(config.owner));
  saveJson(SUDO_FILE, sudoList);
}

// helpers to persist
const saveSudo = () => saveJson(SUDO_FILE, sudoList);
const saveBanned = () => saveJson(BANNED_FILE, bannedList);
const saveConfig = () => saveJson(CONFIG_FILE, config);

// identity checks
const isOwner = (jid) => normalizeJid(jid) === normalizeJid(config.owner);
const isSudo = (jid) => isOwner(jid) || (Array.isArray(sudoList) && sudoList.map(normalizeJid).includes(normalizeJid(jid)));
const isBanned = (jid) => Array.isArray(bannedList) && bannedList.map(normalizeJid).includes(normalizeJid(jid));

// store & globals
const store = (nativeMakeInMemoryStore && typeof nativeMakeInMemoryStore === "function")
  ? nativeMakeInMemoryStore(pino().child({ level: "silent" }))
  : { bind: () => {}, contacts: {} };

let sock = null;
let reconnecting = false;
let botReady = false;
const processedMessages = new Map();
const contactCooldowns = new Map();

// cleanup old maps
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of processedMessages.entries()) {
    if (now - ts > 10 * 60 * 1000) processedMessages.delete(k);
  }
  for (const [jid, ts] of contactCooldowns.entries()) {
    if (now - ts > (config.autoReplyCooldownMs || 10 * 60 * 1000) * 3) contactCooldowns.delete(jid);
  }
}, 60 * 1000);

// safe send wrapper
async function safeSend(jid, msg) {
  try {
    if (!sock) throw new Error("Socket not ready");
    return await sock.sendMessage(jid, msg);
  } catch (err) {
    console.error("safeSend error:", err?.message ?? err);
  }
}

// helper to get logged bot jid (normalized)
function getBotJid() {
  return normalizeJid(sock?.user?.id || (sock?.authState && sock.authState.creds?.me?.id) || config.owner);
}

async function isBotAdminInGroup(groupJid) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    const me = getBotJid();
    const p = meta.participants.find((x) => normalizeJid(x.id) === normalizeJid(me));
    return !!(p && (p.admin || p.isAdmin || p.isSuperAdmin));
  } catch (e) {
    return false;
  }
}

// small util: with timeout for promises
const withTimeout = (p, ms = 7000) => {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
};

// load games & profiles
const loadJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8") || JSON.stringify(fallback || {})); } catch(e) { return fallback || {}; }
};
let games = loadJson(GAMES_FILE, {});
let profiles = loadJson(PROFILES_FILE, {});

// persist games & profiles periodically & on change
const saveGames = () => saveJson(GAMES_FILE, games);
const saveProfiles = () => saveJson(PROFILES_FILE, profiles);

// check ffmpeg
function hasFFmpeg() {
  try {
    const { spawnSync } = require("child_process");
    const res = spawnSync("ffmpeg", ["-version"]);
    return res.status === 0 || !!res.stdout;
  } catch (e) { return false; }
}

// dictionary check using dictionaryapi.dev
async function isValidEnglish(word) {
  try {
    const w = encodeURIComponent(word.toLowerCase().trim());
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${w}`);
    return res.status === 200;
  } catch (e) {
    // if dictionary fails, err on true to avoid blocking gameplay
    return false;
  }
}

// ---------------- START BOT ----------------
async function startBot() {
  if (sock && sock?.ws?.readyState && sock.ws.readyState !== 2 && sock.ws.readyState !== 3) {
    console.log("Socket already active; skipping new start.");
    return;
  }

  reconnecting = false;
  botReady = false;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    logger: pino({ level: "silent" }),
    auth: state,
    browser: [config.botName || "JohnBot", "Chrome", "1.0"],
    printQRInTerminal: false,
  });

  store.bind(sock.ev);
  sock.ev.on("creds.update", saveCreds);

  // connection.update: show QR + pairing code + owner checks
  sock.ev.on("connection.update", async (update) => {
    try {
      const { connection, lastDisconnect, qr, pairingCode } = update;

      if (qr) {
        console.log("\n===== QR CODE AVAILABLE =====");
        qrcode.generate(qr, { small: true });
        console.log("Scan QR via phone camera OR use link:");
        console.log("https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qr));
      }

      if (pairingCode) {
        try {
          const codeStr = Array.isArray(pairingCode) ? pairingCode.join("-") : String(pairingCode);
          console.log("\n===== PAIRING CODE AVAILABLE =====");
          console.log("Enter this code on WhatsApp: 👉  " + codeStr);
          console.log("This works on devices that show pairing flow.\n");
        } catch (e) {}
      }

      if (connection === "open") {
        console.log("✅ WhatsApp connection OPEN");

        const loggedInJid = sock?.user?.id || (sock?.authState?.creds?.me?.id) || null;
        console.log("Logged in as (socket JID):", loggedInJid);
        console.log("Configured owner (config.owner):", config.owner);

        if (loggedInJid && config.owner) {
          const cleanLoggedIn = normalizeJid(loggedInJid);
          const cleanOwner = normalizeJid(config.owner);
          if (cleanLoggedIn !== cleanOwner) {
            console.warn("⚠️ Owner mismatch: scanned account differs from config.owner (ignoring device suffixes).");
            console.warn("If this login is for a client, update config.owner or set OWNER env var.");
          } else {
            console.log("✅ Owner match verified (device suffix ignored).");
          }
        }

        if (!botReady) {
          botReady = true;
          try {
            const notifyTarget = (loggedInJid && normalizeJid(loggedInJid) === normalizeJid(config.owner)) ? config.owner : (loggedInJid || config.owner);
            await safeSend(notifyTarget, { text: `🤖 ${config.botName || "JohnBot"} is online and ready!` });
          } catch (e) {
            console.warn("Failed to notify owner:", e?.message ?? e);
          }
        }
        return;
      }

      if (connection === "close") {
        const reason = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = reason === DisconnectReason.loggedOut || reason === 401;
        console.warn("Connection closed. Reason:", reason, "loggedOut:", loggedOut);
        botReady = false;

        if (loggedOut) {
          console.error("Logged out. Delete ./data/auth and rescan QR / pairing code.");
          try { await safeSend(config.owner, { text: "❌ Bot logged out. Please rescan QR and restart." }); } catch (_) {}
          return;
        }

        if (!reconnecting) {
          reconnecting = true;
          console.log("Attempt reconnect in 3s...");
          setTimeout(async () => {
            try {
              try { sock.ev.removeAllListeners(); } catch (e) {}
              sock = null;
              await startBot();
            } catch (e) {
              console.error("Reconnect failed:", e?.message ?? e);
            } finally { reconnecting = false; }
          }, 3000);
        } else {
          console.log("Already reconnecting, skipping spawn.");
        }
        return;
      }
    } catch (e) {
      console.error("connection.update handler error:", e?.message ?? e);
    }
  });

  // messages.upsert - main handler
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages?.[0];
      if (!msg || !msg.message) return;
      if (!msg.key || !msg.key.remoteJid) return;

      const remoteJid = msg.key.remoteJid;
      const isGroup = remoteJid.endsWith("@g.us");
      const rawAuthor = msg.key.participant || msg.key.remoteJid;
      const authorJid = normalizeJid(rawAuthor);
      const chatJid = normalizeJid(remoteJid);
      const loggedInJid = normalizeJid(sock?.user?.id || (sock?.authState && sock.authState.creds?.me?.id) || "");

      // Prevent loops: if fromMe and this logged in is not config owner -> ignore
      if (msg.key.fromMe && loggedInJid && loggedInJid !== normalizeJid(config.owner)) return;

      // dedupe
      const msgId = msg.key.id || `${remoteJid}_${Date.now()}`;
      if (processedMessages.has(msgId)) return;
      processedMessages.set(msgId, Date.now());

      // extract text
      const text =
        msg.message.conversation ??
        msg.message.extendedTextMessage?.text ??
        msg.message.imageMessage?.caption ??
        msg.message.videoMessage?.caption ??
        "";

      console.log(`[${isGroup ? "GROUP" : "PRIVATE"}] ${authorJid}: ${text}`);
      console.log("Debug owner check -> author:", authorJid, "isOwner:", isOwner(authorJid), "isSudo:", isSudo(authorJid));

      // banned
      if (isBanned(authorJid)) {
        console.log("Sender banned:", authorJid);
        return;
      }

      // ---------- AUTO-REPLY (disabled if desired) ----------
      // You said you want to remove auto-reply in final; leave simple toggle here:
      if (!config.disableAutoReply) {
        if (!isGroup) {
          try {
            if (!isOwner(authorJid)) {
              // check if contact saved
              const contacts = store.contacts || {};
              const contact = contacts[authorJid] || contacts[normalizeJid(authorJid)];
              const isSaved = !!(contact && (contact.name || contact.notify));

              const last = contactCooldowns.get(authorJid) || 0;
              const cooldown = config.autoReplyCooldownMs || 10 * 60 * 1000;
              if (!isSaved && Date.now() - last >= cooldown) {
                await safeSend(remoteJid, { text: "Hello 👋 — I am currently away. I will reply when possible." });
                contactCooldowns.set(authorJid, Date.now());
              }
            }
          } catch (e) {
            console.warn("auto-reply check error:", e?.message ?? e);
          }
        }
      }

      // ---------- VIEW-ONCE automatic saving (send to chat and DM owner) ----------
      const viewOnceMessage = msg.message.viewOnceMessageV2 ?? msg.message.viewOnceMessageV2Extension ?? msg.message.viewOnceMessage;
      if (viewOnceMessage) {
        try {
          const inner = viewOnceMessage.message ?? viewOnceMessage;
          const typeKey = Object.keys(inner)[0];
          const contentType = typeKey.replace("Message", "").toLowerCase();
          const stream = await downloadContentFromMessage(inner[typeKey], contentType);
          const parts = [];
          for await (const chunk of stream) parts.push(chunk);

          const ext = contentType.includes("image") ? "jpg" : contentType.includes("video") ? "mp4" : "bin";
          const filename = path.join(SAVED_DIR, `viewonce_auto_${Date.now()}.${ext}`);
          fs.writeFileSync(filename, Buffer.concat(parts));
          console.log("✅ Saved view-once as", filename);

          // send to chat as confirmation and DM owner a copy
          const chatCaption = "✅ View-once media recovered";
          const ownerCaption = `📥 Copied for owner — from ${isGroup ? "group" : "private chat"} (${remoteJid})`;

          try {
            if (contentType.includes("image")) await safeSend(isGroup ? remoteJid : authorJid, { image: fs.createReadStream(filename), caption: chatCaption });
            else if (contentType.includes("video")) await safeSend(isGroup ? remoteJid : authorJid, { video: fs.createReadStream(filename), caption: chatCaption });
            else await safeSend(isGroup ? remoteJid : authorJid, { document: fs.createReadStream(filename), fileName: path.basename(filename), caption: chatCaption });

            // DM owner
            try {
              const ownerJ = normalizeJid(config.owner);
              if (contentType.includes("image")) await safeSend(ownerJ, { image: fs.createReadStream(filename), caption: ownerCaption });
              else if (contentType.includes("video")) await safeSend(ownerJ, { video: fs.createReadStream(filename), caption: ownerCaption });
              else await safeSend(ownerJ, { document: fs.createReadStream(filename), fileName: path.basename(filename), caption: ownerCaption });
            } catch (e) { console.warn("Could not DM owner:", e?.message ?? e); }
          } catch (e) {
            console.warn("Failed sending recovered view-once to chat:", e?.message ?? e);
          }

          // keep the file permanently for inspection (no auto-delete)
        } catch (e) {
          console.error("view-once save error:", e?.message ?? e);
        }
      }

      // --- Command parsing ---
      const prefix = (config.prefix || ".").toString();
      // Special: allow !s answers for game (works even if not starting with prefix)
      const isGameAnswer = typeof text === "string" && text.trim().toLowerCase().startsWith("!s ");
      if (!text && !isGameAnswer) return;

      // parse args & cmd if command
      let cmd = null;
      let args = [];
      let argStr = "";
      if (isGameAnswer) {
        cmd = "game_answer_special";
        args = text.trim().slice(3).trim().split(/\s+/);
        argStr = text.trim().slice(3).trim();
      } else {
        if (!text.trim().startsWith(prefix)) return;
        const parts = text.trim().slice(prefix.length).trim().split(/\s+/);
        cmd = (parts.shift() || "").toLowerCase();
        args = parts;
        argStr = args.join(" ").trim();
      }

      // permission check: if mode is private => only owner/sudo can use ANY commands (group & dm).
      const allowed = config.modePublic ? true : (isOwner(authorJid) || isSudo(authorJid));
      if (!allowed && cmd !== "game_answer_special") {
        // silently ignore when private and unauthorized
        return;
      }

      // helper access functions
      const requireOwner = async () => { if (!isOwner(authorJid)) { await safeSend(remoteJid, { text: "⚠️ Owner-only command." }); throw new Error("not_owner"); } };
      const requireSudo = async () => { if (!isSudo(authorJid)) { await safeSend(remoteJid, { text: "⚠️ Sudo-only command." }); throw new Error("not_sudo"); } };

      // ---------------- COMMANDS ----------------

      // PING
      if (cmd === "ping") {
        try {
          const t0 = performance.now();
          await safeSend(remoteJid, { text: "🏓 Pinging..." });
          const t1 = performance.now();
          const latency = (t1 - t0).toFixed(2);
          await safeSend(remoteJid, { text: `✅ Pong! Response time: ${latency} ms` });
        } catch (e) { console.error("ping error", e); }
        return;
      }

      // MENU - enhanced (thumbnail banner / profile pic / fallback text)
      if (cmd === "menu") {
        try {
          // target can be mentioned or replied-to participant
          const ctx = msg.message.extendedTextMessage?.contextInfo;
          const target = ctx?.participant || ctx?.mentionedJid?.[0] || authorJid;
          const contactObject = (store.contacts && (store.contacts[target] || store.contacts[normalizeJid(target)])) || {};
          const displayName = contactObject?.name || contactObject?.notify || target.split("@")[0];

          // basic menu text
          const header = "════════════════════════";
          const menuText = [
            `*🤖 ${config.botName || "JohnBot"} — Menu*`,
            ``,
            `*👤 Name:* ${displayName}`,
            `*🆔 JID:* ${target}`,
            `*🏷 Group:* ${isGroup ? "Yes" : "No"}`,
            `*🔒 Mode:* ${config.modePublic ? "Public" : "Private"}`,
            ``,
            `*Commands*`,
            `${prefix}ping — check latency`,
            `${prefix}menu — show this menu`,
            `${prefix}download — reply to media to save and resend`,
            `${prefix}song <query> — download YouTube audio`,
            `${prefix}view — retrieve view-once media`,
            `${prefix}gpt <prompt> — ChatGPT/Images`,
            `${prefix}sticker — reply to image/video to create a sticker`,
            `${prefix}sudo — sudo-only menu`,
            ``,
            `*Owner:* ${config.owner}`,
            header,
            `_Powered by ${config.botName}_`,
          ].join("\n");

          // try to include profile pic
          let ppUrl = null;
          try { ppUrl = await sock.profilePictureUrl(target).catch(() => null); } catch (e) { ppUrl = null; }

          // Attempt to generate a colorful banner using canvas dynamically
          let sent = false;
          try {
            const canvasModule = await import("canvas").catch(() => null);
            if (canvasModule && canvasModule.createCanvas) {
              const { createCanvas, loadImage } = canvasModule;
              const width = 1200, height = 600;
              const canvas = createCanvas(width, height);
              const ctx2 = canvas.getContext("2d");

              // gradient background
              const g = ctx2.createLinearGradient(0, 0, width, height);
              g.addColorStop(0, "#ff9a9e");
              g.addColorStop(0.5, "#fad0c4");
              g.addColorStop(1, "#fad0c4");
              ctx2.fillStyle = g;
              ctx2.fillRect(0, 0, width, height);

              // header
              ctx2.fillStyle = "#fff";
              ctx2.font = "bold 48px Sans-serif";
              ctx2.fillText(`${config.botName || "JohnBot"} — Menu`, 60, 120);

              // small card for user
              ctx2.fillStyle = "rgba(255,255,255,0.08)";
              ctx2.fillRect(60, 160, 1080, 360);

              // avatar
              const avatarSize = 220;
              try {
                if (ppUrl) {
                  const img = await loadImage(ppUrl);
                  // circle mask
                  ctx2.save();
                  ctx2.beginPath();
                  ctx2.arc(160 + avatarSize / 2, 160 + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
                  ctx2.closePath();
                  ctx2.clip();
                  ctx2.drawImage(img, 160, 160, avatarSize, avatarSize);
                  ctx2.restore();
                } else {
                  ctx2.fillStyle = "#ffffff22";
                  ctx2.beginPath();
                  ctx2.arc(160 + avatarSize / 2, 160 + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
                  ctx2.fill();
                }
              } catch (e) {}

              // text details
              ctx2.fillStyle = "#fff";
              ctx2.font = "bold 36px Sans-serif";
              ctx2.fillText(displayName, 420, 230);
              ctx2.font = "20px Sans-serif";
              ctx2.fillText(`JID: ${target}`, 420, 270);
              ctx2.fillText(`Mode: ${config.modePublic ? "Public" : "Private"}`, 420, 300);

              const outPath = path.join(DATA_DIR, `menu_${Date.now()}.png`);
              fs.writeFileSync(outPath, canvas.toBuffer("image/png"));
              await safeSend(remoteJid, { image: fs.createReadStream(outPath), caption: menuText });
              try { fs.unlinkSync(outPath); } catch (e) {}
              sent = true;
            }
          } catch (e) {
            console.warn("canvas menu generation failed:", e?.message ?? e);
          }

          // fallback to banner image with caption or just text
          if (!sent) {
            const bannerUrl = "https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=1200&q=80";
            try {
              await safeSend(remoteJid, { image: { url: bannerUrl }, caption: menuText });
              sent = true;
            } catch (e) { /* ignore */ }
          }
          if (!sent) {
            await safeSend(remoteJid, { text: menuText });
          }
        } catch (e) {
          console.error("menu error", e);
          await safeSend(remoteJid, { text: "⚠️ Failed to fetch user menu." });
        }
        return;
      }

      // SUBMENU: .menu user (profile card)
      if (cmd === "menu" && (argStr.startsWith("user") || argStr === "profile" || argStr === "submenu" || argStr.startsWith("user "))) {
        // reuse logic from earlier but produce a concise profile card; for brevity reuse same code path as .menu above
        // (implementation intentionally similar)
        try {
          const ctx = msg.message.extendedTextMessage?.contextInfo;
          // determine target
          let target = ctx?.participant || ctx?.mentionedJid?.[0] || authorJid;
          target = normalizeJid(target);
          const contactEntry = (store.contacts && (store.contacts[target] || store.contacts[normalizeJid(target)])) || {};
          const displayName = contactEntry?.name || contactEntry?.notify || target.split("@")[0];
          let joined = "—", role = "Member";

          if (isGroup) {
            try {
              const meta = await sock.groupMetadata(remoteJid);
              const participant = meta.participants.find((p) => normalizeJid(p.id) === normalizeJid(target));
              if (participant) {
                if (participant.joinedTimestamp) joined = new Date(participant.joinedTimestamp).toLocaleString("en-GB", { timeZone: "Africa/Lagos" });
                if (participant.admin || participant.isAdmin || participant.isSuperAdmin) role = "Admin";
              }
            } catch (e) {}
          }

          let ppUrl = null;
          try { ppUrl = await sock.profilePictureUrl(target).catch(() => null); } catch (e) {}

          // try canvas as before
          let sent = false;
          try {
            const canvasModule = await import("canvas").catch(() => null);
            if (canvasModule && canvasModule.createCanvas) {
              const { createCanvas, loadImage } = canvasModule;
              const width = 900, height = 450;
              const canvas = createCanvas(width, height);
              const ctx2 = canvas.getContext("2d");
              // gradient
              const g = ctx2.createLinearGradient(0, 0, width, height);
              g.addColorStop(0, "#ff7eb3");
              g.addColorStop(0.5, "#7ac7ff");
              g.addColorStop(1, "#9d7aff");
              ctx2.fillStyle = g;
              ctx2.fillRect(0, 0, width, height);

              // card overlay
              ctx2.fillStyle = "rgba(255,255,255,0.06)";
              ctx2.fillRect(30, 30, width - 60, height - 60);

              // avatar
              const avatarSize = 180, avatarX = 50, avatarY = 60;
              if (ppUrl) {
                try {
                  const img = await loadImage(ppUrl);
                  ctx2.save();
                  ctx2.beginPath();
                  ctx2.arc(avatarX + avatarSize/2, avatarY + avatarSize/2, avatarSize/2, 0, Math.PI*2);
                  ctx2.closePath();
                  ctx2.clip();
                  ctx2.drawImage(img, avatarX, avatarY, avatarSize, avatarSize);
                  ctx2.restore();
                } catch (e) {
                  ctx2.fillStyle = "#ffffff22";
                  ctx2.beginPath();
                  ctx2.arc(avatarX + avatarSize/2, avatarY + avatarSize/2, avatarSize/2, 0, Math.PI*2);
                  ctx2.fill();
                }
              } else {
                ctx2.fillStyle = "#ffffff22";
                ctx2.beginPath();
                ctx2.arc(avatarX + avatarSize/2, avatarY + avatarSize/2, avatarSize/2, 0, Math.PI*2);
                ctx2.fill();
                ctx2.fillStyle = "#fff";
                ctx2.font = "bold 48px Sans-serif";
                const initials = (displayName.split(" ").map(s => s[0]).slice(0,2).join("") || displayName.slice(0,2)).toUpperCase();
                ctx2.textAlign = "center";
                ctx2.fillText(initials, avatarX + avatarSize/2, avatarY + avatarSize/2 + 18);
              }

              ctx2.fillStyle = "#fff";
              ctx2.font = "bold 34px Sans-serif";
              ctx2.textAlign = "left";
              ctx2.fillText(displayName, avatarX + avatarSize + 30, avatarY + 60);
              ctx2.font = "20px Sans-serif";
              ctx2.fillStyle = "#f3f3f3";
              ctx2.fillText(`JID: ${target}`, avatarX + avatarSize + 30, avatarY + 100);
              ctx2.fillText(`Saved contact: ${contactEntry?.name ? "Yes" : "No"}`, avatarX + avatarSize + 30, avatarY + 140);
              ctx2.fillText(`Role: ${role}`, avatarX + avatarSize + 30, avatarY + 170);
              ctx2.fillText(`Joined: ${isGroup ? joined : "Private Chat"}`, avatarX + avatarSize + 30, avatarY + 200);

              const outPath = path.join(DATA_DIR, `menu_user_${Date.now()}.png`);
              fs.writeFileSync(outPath, canvas.toBuffer("image/png"));
              await safeSend(remoteJid, { image: fs.createReadStream(outPath), caption: `🔎 Profile — ${displayName}` });
              try { fs.unlinkSync(outPath); } catch (e) {}
              sent = true;
            }
          } catch (e) {
            console.warn("canvas submenu failed:", e?.message ?? e);
          }

          if (!sent) {
            if (ppUrl) {
              try {
                await safeSend(remoteJid, { image: { url: ppUrl }, caption:
                  `🔎 Profile — ${displayName}\nJID: ${target}\nSaved contact: ${contactEntry?.name ? "Yes" : "No"}\nRole: ${role}\nJoined: ${isGroup ? joined : "Private Chat"}`
                });
                sent = true;
              } catch (e) {}
            }
          }

          if (!sent) {
            const summary = [
              `🔎 Profile — ${displayName}`,
              `JID: ${target}`,
              `Saved contact: ${contactEntry?.name ? "Yes" : "No"}`,
              `Role: ${role}`,
              `Joined: ${isGroup ? joined : "Private Chat"}`,
            ].join("\n");
            await safeSend(remoteJid, { text: summary });
          }
        } catch (err) {
          console.error("submenu menu user error:", err);
          await safeSend(remoteJid, { text: "⚠️ Failed to create user submenu." });
        }
        return;
      }

      // HELP
      if (cmd === "help") {
        const helpText = [
          `*${config.botName} - Help*`,
          ``,
          `${prefix}ping — latency`,
          `${prefix}menu — user info`,
          `${prefix}tag / ${prefix}tagall — mention everyone in group`,
          `${prefix}kick <num> / reply with ${prefix}kick — remove member (bot admin required)`,
          `${prefix}invite <num> — add user to group (bot admin required)`,
          `${prefix}download — reply to media to save and resend`,
          `${prefix}song <query> — download YouTube audio`,
          `${prefix}view — reply to view-once or use .view <messageId>`,
          `${prefix}uptime | ${prefix}runtime — bot uptime`,
          `${prefix}sudo — sudo-only menu`,
        ].join("\n");
        await safeSend(remoteJid, { text: helpText });
        return;
      }

      // UPTIME
      if (cmd === "uptime" || cmd === "runtime") {
        const up = process.uptime();
        const hrs = Math.floor(up / 3600);
        const mins = Math.floor((up % 3600) / 60);
        const secs = Math.floor(up % 60);
        await safeSend(remoteJid, { text: `⏱ Uptime: ${hrs}h ${mins}m ${secs}s` });
        return;
      }

      // TAG / TAGALL - send a single emoji message with mentions to tag everyone
      if ((cmd === "tag" || cmd === "tagall") && isGroup) {
        try {
          let meta = null;
          try {
            meta = await withTimeout(sock.groupMetadata(remoteJid), 7000);
          } catch (err) {
            // best-effort fallback
            meta = { participants: (store?.chats?.get(remoteJid)?.participants || []).map(p => ({ id: p })) || [] };
          }

          const participants = (meta?.participants || []).map((p) => normalizeJid(p.id || p)).filter(Boolean);
          if (!participants.length) { await safeSend(remoteJid, { text: "No participants found." }); return; }

          // Build a single message which only displays a heart and tags all participants.
          // WhatsApp will still deliver mentions; the visible text is a heart + optional page number.
          const mentionText = participants.map(id => `@${id.split("@")[0]}`).join("\n");
          // Send a short visible message with a heart, but include full mentions in 'mentions'
          const visible = "💖";
          await sock.sendMessage(remoteJid, { text: `${visible}\n\n${mentionText}`, mentions: participants });
          // The message includes the mention list but the UI will render the visible heart and (on some clients) collapsed mentions.
        } catch (e) {
          console.error("tag error", e);
          await safeSend(remoteJid, { text: "⚠️ Could not tag members." });
        }
        return;
      }

      // KICK
      if (cmd === "kick" && isGroup) {
        try {
          const botIsAdmin = await isBotAdminInGroup(remoteJid);
          if (!botIsAdmin) { await safeSend(remoteJid, { text: "⚠️ I must be group admin to remove members." }); return; }
          let targetJid = null;
          if (argStr) targetJid = jidFromNumber(argStr);
          else targetJid = msg.message.extendedTextMessage?.contextInfo?.participant;
          if (!targetJid) { await safeSend(remoteJid, { text: `Usage: ${prefix}kick <234XXXXXXXXXX> or reply to user's message with ${prefix}kick` }); return; }
          await sock.groupParticipantsUpdate(remoteJid, [targetJid], "remove");
          await safeSend(remoteJid, { text: `✅ Removed: ${targetJid}` });
        } catch (e) { console.error("kick error", e); await safeSend(remoteJid, { text: `⚠️ Kick failed: ${e?.message ?? e}` }); }
        return;
      }

      // INVITE
      if (cmd === "invite" && isGroup) {
        try {
          const botIsAdmin = await isBotAdminInGroup(remoteJid);
          if (!botIsAdmin) { await safeSend(remoteJid, { text: "⚠️ I must be group admin to add members." }); return; }
          if (!argStr) { await safeSend(remoteJid, { text: `Usage: ${prefix}invite 234XXXXXXXXXX` }); return; }
          const j = jidFromNumber(argStr);
          if (!j) { await safeSend(remoteJid, { text: "Invalid number." }); return; }
          await sock.groupParticipantsUpdate(remoteJid, [j], "add");
          await safeSend(remoteJid, { text: `✅ Invited/added: ${j}` });
        } catch (e) { console.error("invite error", e); await safeSend(remoteJid, { text: `⚠️ Invite failed: ${e?.message ?? e}` }); }
        return;
      }

      // DOWNLOAD (reply to media to save and send back)
      if (cmd === "download") {
        try {
          const ctx = msg.message.extendedTextMessage?.contextInfo;
          const quoted = ctx?.quotedMessage;
          if (!quoted) { await safeSend(remoteJid, { text: "Reply to a media message with .download" }); return; }
          const mtype = Object.keys(quoted)[0];
          const stream = await downloadContentFromMessage(quoted[mtype], mtype.replace("Message", ""));
          const parts = [];
          for await (const chunk of stream) parts.push(chunk);
          const ext = mtype.toLowerCase().includes("image") ? "jpg" : mtype.toLowerCase().includes("video") ? "mp4" : "bin";
          const filename = path.join(SAVED_DIR, `download_${Date.now()}.${ext}`);
          fs.writeFileSync(filename, Buffer.concat(parts));
          if (ext === "jpg") await safeSend(remoteJid, { image: fs.createReadStream(filename), caption: `✅ Downloaded: ${path.basename(filename)}` });
          else if (ext === "mp4") await safeSend(remoteJid, { video: fs.createReadStream(filename), caption: `✅ Downloaded: ${path.basename(filename)}` });
          else await safeSend(remoteJid, { document: fs.createReadStream(filename), fileName: path.basename(filename) });
          // NOTE: file stays in data/saved for inspection (not auto-deleted)
        } catch (e) { console.error("download error", e); await safeSend(remoteJid, { text: `⚠️ Download failed: ${e?.message ?? e}` }); }
        return;
      }

      // SONG - YouTube audio: stream download to temp file, send, delete
      if (cmd === "song") {
        if (!argStr) { await safeSend(remoteJid, { text: `Usage: ${prefix}song <search terms>` }); return; }
        try {
          await safeSend(remoteJid, { text: `🔎 Searching YouTube for "${argStr}"...` });
          const r = await yts(argStr);
          const v = r?.videos?.[0];
          if (!v) { await safeSend(remoteJid, { text: "No results found." }); return; }
          const url = v.url;
          const titleSafe = (v.title || "song").replace(/[^\w\s-]/g, "").slice(0, 64).replace(/\s+/g, "_");
          const filename = path.join(DATA_DIR, `song_${Date.now()}_${titleSafe}.mp3`);

          // download stream to file
          const stream = ytdl(url, { filter: "audioonly", quality: "highestaudio" });
          const ws = fs.createWriteStream(filename);
          stream.pipe(ws);

          stream.on("error", (e) => console.error("ytdl stream error:", e?.message ?? e));
          ws.on("finish", async () => {
            try {
              const stats = fs.statSync(filename);
              if (stats.size > (config.maxFileSizeBytes || 25 * 1024 * 1024)) {
                // file too big; send link instead and delete file
                try { fs.unlinkSync(filename); } catch (e) {}
                await safeSend(remoteJid, { text: `⚠️ File too large to send (${(stats.size/1024/1024).toFixed(2)} MB). Here is the link:\n${url}` });
                return;
              }
              // send as audio to chat
              await safeSend(remoteJid, { audio: fs.createReadStream(filename) });
            } catch (e) {
              console.error("song send error", e);
              await safeSend(remoteJid, { text: "⚠️ Failed to send song." });
            } finally {
              try { if (fs.existsSync(filename)) fs.unlinkSync(filename); } catch (e) {}
            }
          });

          ws.on("error", async (e) => {
            console.error("fs write error:", e);
            await safeSend(remoteJid, { text: "⚠️ Failed to download audio (write error)." });
            try { if (fs.existsSync(filename)) fs.unlinkSync(filename); } catch (e) {}
          });
        } catch (e) {
          console.error("song error", e);
          await safeSend(remoteJid, { text: `⚠️ Song error: ${e?.message ?? e}` });
        }
        return;
      }

      // SUDO management: setsudo, delsudo, getsudo
      if (cmd === "setsudo") {
        try { await requireOwner(); } catch { return; }
        if (!args[0]) return await safeSend(remoteJid, { text: "Usage: .setsudo <number>" });
        const num = jidFromNumber(args[0]);
        if (!num) return await safeSend(remoteJid, { text: "Invalid number." });
        if (!sudoList.map(normalizeJid).includes(normalizeJid(num))) { sudoList.push(num); saveSudo(); }
        await safeSend(remoteJid, { text: `✅ Added sudo: ${num}` });
        return;
      }

      if (cmd === "delsudo") {
        try { await requireOwner(); } catch { return; }
        if (!args[0]) return await safeSend(remoteJid, { text: "Usage: .delsudo <number>" });
        const num = jidFromNumber(args[0]);
        if (!num) return await safeSend(remoteJid, { text: "Invalid number." });
        sudoList = sudoList.filter((x) => normalizeJid(x) !== normalizeJid(num)); saveSudo();
        await safeSend(remoteJid, { text: `❌ Removed sudo: ${num}` });
        return;
      }

      if (cmd === "getsudo") {
        try { await requireSudo(); } catch { return; }
        await safeSend(remoteJid, { text: `🧾 Sudo users:\n${sudoList.join("\n")}` });
        return;
      }

      // MODE
      if (cmd === "mode") {
        try { await requireOwner(); } catch { return; }
        if (!argStr) { await safeSend(remoteJid, { text: `Usage: ${prefix}mode public|private` }); return; }
        const m = argStr.toLowerCase();
        if (m === "public") config.modePublic = true;
        else if (m === "private") config.modePublic = false;
        else { await safeSend(remoteJid, { text: "Invalid. Use public or private." }); return; }
        saveConfig();
        await safeSend(remoteJid, { text: `✅ Mode set to ${m}` });
        return;
      }

      // setprefix
      if (cmd === "setprefix") {
        try { await requireOwner(); } catch { return; }
        if (!argStr) { await safeSend(remoteJid, { text: `Usage: ${prefix}setprefix <symbol>` }); return; }
        config.prefix = argStr; saveConfig(); await safeSend(remoteJid, { text: `✅ Prefix set to "${argStr}"` }); return;
      }

      // ban/unban
      if (cmd === "ban") {
        try { await requireSudo(); } catch { return; }
        let target = null; if (argStr) target = jidFromNumber(argStr); else target = msg.message.extendedTextMessage?.contextInfo?.participant;
        if (!target) { await safeSend(remoteJid, { text: `Usage: ${prefix}ban <number> or reply with ${prefix}ban` }); return; }
        if (!bannedList.map(normalizeJid).includes(normalizeJid(target))) { bannedList.push(target); saveBanned(); }
        await safeSend(remoteJid, { text: `⛔ Banned ${target}` }); return;
      }

      if (cmd === "unban") {
        try { await requireSudo(); } catch { return; }
        let target = null; if (argStr) target = jidFromNumber(argStr); else target = msg.message.extendedTextMessage?.contextInfo?.participant;
        if (!target) { await safeSend(remoteJid, { text: `Usage: ${prefix}unban <number> or reply with ${prefix}unban` }); return; }
        bannedList = bannedList.filter((x) => normalizeJid(x) !== normalizeJid(target)); saveBanned(); await safeSend(remoteJid, { text: `✅ Unbanned ${target}` }); return;
      }

      // block/unblock
      if (cmd === "block" || cmd === "unblock") {
        try { await requireSudo(); } catch { return; }
        let target = null; if (argStr) target = jidFromNumber(argStr); else target = msg.message.extendedTextMessage?.contextInfo?.participant;
        if (!target) { await safeSend(remoteJid, { text: `Usage: ${prefix}${cmd} <number> or reply with ${prefix}${cmd}` }); return; }
        try { if (cmd === "block") await sock.updateBlockStatus(target, "block"); else await sock.updateBlockStatus(target, "unblock"); await safeSend(remoteJid, { text: `✅ ${cmd === "block" ? "Blocked" : "Unblocked"} ${target}` }); } catch (e) { console.warn("block/unblock not supported:", e?.message ?? e); await safeSend(remoteJid, { text: "⚠️ Could not block/unblock (API may not support it)." }); }
        return;
      }

      // setnamebot / setstatusbot / setppbot
      if (cmd === "setnamebot") { try { await requireOwner(); } catch { return; } if (!argStr) { await safeSend(remoteJid, { text: `Usage: ${prefix}setnamebot <name>` }); return; } config.botName = argStr; saveConfig(); await safeSend(remoteJid, { text: `✅ Bot name saved locally: ${argStr}` }); return; }
      if (cmd === "setstatusbot") { try { await requireOwner(); } catch { return; } if (!argStr) { await safeSend(remoteJid, { text: `Usage: ${prefix}setstatusbot <bio>` }); return; } config.botStatus = argStr; saveConfig(); await safeSend(remoteJid, { text: `✅ Bot status saved locally: ${argStr}` }); return; }

      if (cmd === "setppbot") {
        try { await requireOwner(); } catch { return; }
        const ctx = msg.message.extendedTextMessage?.contextInfo;
        const quoted = ctx?.quotedMessage;
        if (!quoted || !quoted.imageMessage) { await safeSend(remoteJid, { text: `Reply to an image with ${prefix}setppbot` }); return; }
        try {
          const stream = await downloadContentFromMessage(quoted.imageMessage, "image");
          const parts = [];
          for await (const c of stream) parts.push(c);
          const file = path.join(DATA_DIR, `ppbot_${Date.now()}.jpg`);
          fs.writeFileSync(file, Buffer.concat(parts));
          try { if (typeof sock.updateProfilePicture === "function") { await sock.updateProfilePicture(file); await safeSend(remoteJid, { text: "✅ Bot profile picture updated." }); } else { await safeSend(remoteJid, { text: `✅ Saved PP file locally: ${file}` }); } } catch (err) { console.warn("setppbot API error:", err?.message ?? err); await safeSend(remoteJid, { text: `✅ Saved PP file locally: ${file}` }); }
          // preserve file for debugging (do not delete)
        } catch (e) { console.error("setppbot error", e); await safeSend(remoteJid, { text: "⚠️ Failed to set profile picture." }); }
        return;
      }

      // restart / shutdown / eval / exec - owner only
      if (cmd === "restart") { try { await requireOwner(); } catch { return; } await safeSend(remoteJid, { text: "♻️ Restarting bot..." }); console.log("Owner requested restart. Exiting process."); process.exit(0); }
      if (cmd === "shutdown") { try { await requireOwner(); } catch { return; } await safeSend(remoteJid, { text: "⏹️ Shutting down..." }); console.log("Owner requested shutdown. Exiting."); process.exit(0); }

      if (cmd === "eval") { try { await requireOwner(); } catch { return; } if (!argStr) { await safeSend(remoteJid, { text: "Usage: .eval <js>" }); return; } try { const output = eval(argStr); await safeSend(remoteJid, { text: `✅ Eval result:\n${String(output).slice(0, 1500)}` }); } catch (e) { await safeSend(remoteJid, { text: `⚠️ Eval error: ${e.message || e}` }); } return; }

      if (cmd === "exec") { try { await requireOwner(); } catch { return; } if (!argStr) { await safeSend(remoteJid, { text: "Usage: .exec <cmd>" }); return; } try { const { exec } = await import("child_process"); exec(argStr, { timeout: 30_000 }, async (err, stdout, stderr) => { if (err) { await safeSend(remoteJid, { text: `⚠️ Exec error: ${err.message}` }); return; } const out = (stdout || stderr || "—").slice(0, 1500); await safeSend(remoteJid, { text: `📤 Output:\n${out}` }); }); } catch (e) { await safeSend(remoteJid, { text: `⚠️ Exec failed: ${e.message || e}` }); } return; }

      // VIEW (manual retrieval) - robust save under data/saved + DM owner (keeps files)
      if (cmd === "view") {
        try {
          const ctx = msg.message.extendedTextMessage?.contextInfo;
          const quoted = ctx?.quotedMessage;

          // helper to extract & stream
          const extractAndStream = async (maybeMsgObject) => {
            if (!maybeMsgObject) return null;
            const topKey = Object.keys(maybeMsgObject)[0];
            const topVal = maybeMsgObject[topKey];

            // handle viewonce wrapper
            if (topKey.toLowerCase().includes("viewonce") || topVal?.viewOnceMessage || topVal?.viewOnceMessageV2 || topVal?.viewOnceMessageV2Extension) {
              const inner =
                topVal.viewOnceMessage?.message ??
                topVal.viewOnceMessageV2?.message ??
                topVal.viewOnceMessageV2Extension?.message ??
                topVal.message ??
                topVal;
              const innerKey = Object.keys(inner)[0];
              const contentType = innerKey.replace("Message", "").toLowerCase();
              const stream = await downloadContentFromMessage(inner[innerKey], contentType);
              return { stream, contentType, filenameKey: innerKey };
            }

            // normal media
            if (topKey && topVal) {
              const contentType = topKey.replace("Message", "").toLowerCase();
              const stream = await downloadContentFromMessage(topVal, contentType);
              return { stream, contentType, filenameKey: topKey };
            }
            return null;
          };

          const saveStreamToFile = async (streamIterator, contentType) => {
            const parts = [];
            for await (const chunk of streamIterator) parts.push(chunk);
            const ext = contentType.includes("image") ? "jpg" : contentType.includes("video") ? "mp4" : (contentType.includes("audio") ? "mp3" : "bin");
            const fname = `view_saved_${Date.now()}.${ext}`;
            const filepath = path.join(SAVED_DIR, fname);
            fs.writeFileSync(filepath, Buffer.concat(parts));
            return { filepath, ext };
          };

          if (quoted) {
            try {
              const extracted = await extractAndStream(quoted);
              if (!extracted) { await safeSend(remoteJid, { text: "⚠️ No downloadable media found in the replied message." }); return; }
              const { stream, contentType } = extracted;
              const { filepath, ext } = await saveStreamToFile(stream, contentType);

              // try to find sender info
              let senderInfo = null;
              try { if (ctx?.participant) senderInfo = normalizeJid(ctx.participant); } catch (e) {}

              // send to chat and DM owner
              const chatCaption = `✅ Recovered media (reply)${senderInfo ? ` • from ${senderInfo}` : ""}`;
              if (ext === "jpg") await safeSend(remoteJid, { image: fs.createReadStream(filepath), caption: chatCaption });
              else if (ext === "mp4") await safeSend(remoteJid, { video: fs.createReadStream(filepath), caption: chatCaption });
              else await safeSend(remoteJid, { document: fs.createReadStream(filepath), fileName: path.basename(filepath), caption: chatCaption });

              try {
                const ownerJ = normalizeJid(config.owner);
                const ownerCaption = `📥 Copied for owner — from ${remoteJid}${senderInfo ? ` • ${senderInfo}` : ""}`;
                if (ext === "jpg") await safeSend(ownerJ, { image: fs.createReadStream(filepath), caption: ownerCaption });
                else if (ext === "mp4") await safeSend(ownerJ, { video: fs.createReadStream(filepath), caption: ownerCaption });
                else await safeSend(ownerJ, { document: fs.createReadStream(filepath), fileName: path.basename(filepath), caption: ownerCaption });
              } catch (e) {}
              // file preserved in data/saved
            } catch (err) {
              console.error("view download error (reply):", err?.message ?? err);
              await safeSend(remoteJid, { text: "⚠️ Failed to download quoted media. If this keeps failing, forward the message to the bot or ask the sender to resend." });
            }
            return;
          }

          // message id lookup: .view <messageId>
          if (args[0]) {
            const lookupId = args[0];
            try {
              let found = null;
              try {
                for (const [k, v] of (store?.messages || new Map()).entries?.() || []) {
                  if (!v || !v.key) continue;
                  if (v.key.id === lookupId || v.key.id?.endsWith(lookupId) || (v.key.remoteJid === remoteJid && v.key.id === lookupId)) { found = v; break; }
                }
              } catch (e) {}
              if (!found) { await safeSend(remoteJid, { text: "⚠️ Could not find that message in local store." }); return; }
              const quoted2 = found.message;
              const extracted2 = await (async () => {
                const topKey = Object.keys(quoted2)[0];
                const topVal = quoted2[topKey];
                if (!topKey) return null;
                const contentType = topKey.replace("Message", "").toLowerCase();
                const stream2 = await downloadContentFromMessage(topVal, contentType);
                return { stream: stream2, contentType };
              })();
              if (!extracted2) { await safeSend(remoteJid, { text: "⚠️ Found message but no downloadable media." }); return; }
              const { stream: stream2, contentType: contentType2 } = extracted2;
              const { filepath: filepath2, ext: ext2 } = await saveStreamToFile(stream2, contentType2);
              let senderInfo2 = null;
              try { if (found.key?.participant) senderInfo2 = normalizeJid(found.key.participant); } catch (e) {}
              const chatCaption = `✅ Recovered media (store lookup)${senderInfo2 ? ` • ${senderInfo2}` : ""}`;
              if (ext2 === "jpg") await safeSend(remoteJid, { image: fs.createReadStream(filepath2), caption: chatCaption });
              else if (ext2 === "mp4") await safeSend(remoteJid, { video: fs.createReadStream(filepath2), caption: chatCaption });
              else await safeSend(remoteJid, { document: fs.createReadStream(filepath2), fileName: path.basename(filepath2), caption: chatCaption });
              try {
                const ownerJ = normalizeJid(config.owner);
                const ownerCaption = `📥 Copied for owner — from ${remoteJid}${senderInfo2 ? ` • ${senderInfo2}` : ""}`;
                if (ext2 === "jpg") await safeSend(ownerJ, { image: fs.createReadStream(filepath2), caption: ownerCaption });
                else if (ext2 === "mp4") await safeSend(ownerJ, { video: fs.createReadStream(filepath2), caption: ownerCaption });
                else await safeSend(ownerJ, { document: fs.createReadStream(filepath2), fileName: path.basename(filepath2), caption: ownerCaption });
              } catch (e) {}
            } catch (err) {
              console.error("view lookup error:", err?.message ?? err);
              await safeSend(remoteJid, { text: "⚠️ Failed to retrieve message from store." });
            }
            return;
          }

          // nothing
          await safeSend(remoteJid, { text: `Usage: Reply to the view-once message with ${prefix}view OR use ${prefix}view <messageId>` });
        } catch (err) {
          console.error("view command error:", err?.message ?? err);
          await safeSend(remoteJid, { text: "⚠️ Failed to run view command." });
        }
        return;
      }

      // GPT command (unchanged semantics)
      if (cmd === "gpt") {
        if (!argStr) { await safeSend(remoteJid, { text: `Usage: ${prefix}gpt <your question or image prompt>` }); return; }
        await safeSend(remoteJid, { text: "🤖 Thinking..." });
        try {
          const key = process.env.OPENAI_API_KEY || config.openaiApiKey;
          if (!key) { await safeSend(remoteJid, { text: "⚠️ Missing OpenAI API key. Set OPENAI_API_KEY in .env or config.json." }); return; }
          const client = new OpenAI({ apiKey: key });

          const lower = argStr.toLowerCase();
          const wantsImage = /(draw|image|picture|illustrate|show|paint|design|create an image|generate)/.test(lower);

          if (wantsImage) {
            try {
              const imgResponse = await client.images.generate({ model: "gpt-image-1", prompt: argStr, size: "512x512" });
              const imageUrl = imgResponse?.data?.[0]?.url;
              if (imageUrl) await safeSend(remoteJid, { image: { url: imageUrl }, caption: `🎨 AI Image\n${argStr}` });
              else await safeSend(remoteJid, { text: "⚠️ Could not generate image." });
            } catch (e) {
              console.error("GPT image error:", e);
              await safeSend(remoteJid, { text: "⚠️ Failed to generate image." });
            }
          } else {
            try {
              const completion = await client.chat.completions.create({
                model: process.env.GPT_MODEL || (config.gptModel || "gpt-4o-mini"),
                messages: [{ role: "user", content: argStr }],
                max_tokens: 800,
              });
              const reply = completion?.choices?.[0]?.message?.content ?? completion?.choices?.[0]?.text ?? "No response.";
              await safeSend(remoteJid, { text: reply });
            } catch (e) {
              console.error("GPT chat error:", e);
              let reason = "⚠️ Sorry, I couldn’t get a response from ChatGPT.";
              if (String(e)?.toLowerCase().includes("quota")) reason = "⚠️ OpenAI quota/error: check billing/plan.";
              await safeSend(remoteJid, { text: reason });
            }
          }
        } catch (err) {
          console.error("GPT Error outer:", err);
          await safeSend(remoteJid, { text: "⚠️ GPT processing failed." });
        }
        return;
      }

      // STICKER - reply to image/video to create sticker (ffmpeg required)
      if (cmd === "sticker") {
        try {
          const ctx = msg.message.extendedTextMessage?.contextInfo;
          const quoted = ctx?.quotedMessage;
          if (!quoted) { await safeSend(remoteJid, { text: `Reply to an image or short video with ${prefix}sticker` }); return; }
          const mtype = Object.keys(quoted)[0];
          if (!mtype) { await safeSend(remoteJid, { text: `Reply to an image or short video with ${prefix}sticker` }); return; }
          if (!mtype.toLowerCase().includes("image") && !mtype.toLowerCase().includes("video")) { await safeSend(remoteJid, { text: "⚠️ Please reply to an image or short video." }); return; }

          const stream = await downloadContentFromMessage(quoted[mtype], mtype.replace("Message", ""));
          const parts = [];
          for await (const c of stream) parts.push(c);
          const inputExt = mtype.toLowerCase().includes("image") ? "jpg" : "mp4";
          const inputFile = path.join(DATA_DIR, `sticker_in_${Date.now()}.${inputExt}`);
          fs.writeFileSync(inputFile, Buffer.concat(parts));
          const outFile = path.join(DATA_DIR, `sticker_out_${Date.now()}.webp`);

          // check ffmpeg
          if (!hasFFmpeg()) {
            await safeSend(remoteJid, { text: "⚠️ ffmpeg not found on this system. Install ffmpeg to use .sticker." });
            try { fs.unlinkSync(inputFile); } catch (e) {}
            return;
          }

          // convert using ffmpeg spawn
          try {
            const { spawn } = await import("child_process");
            const ffArgs = [
              "-y",
              "-i", inputFile,
              "-vcodec", "libwebp",
              "-filter:v", "fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=white",
              "-lossless", "1",
              "-compression_level", "6",
              "-qscale", "75",
              "-loop", "0",
              "-preset", "picture",
              outFile
            ];
            const ff = spawn("ffmpeg", ffArgs);

            ff.on("error", async (err) => {
              console.error("ffmpeg spawn error:", err);
              await safeSend(remoteJid, { text: "⚠️ Could not start ffmpeg. Is it installed?" });
              try { fs.unlinkSync(inputFile); } catch (e) {}
            });

            ff.on("exit", async (code, signal) => {
              try {
                if (fs.existsSync(outFile)) {
                  await safeSend(remoteJid, { sticker: fs.createReadStream(outFile) });
                } else {
                  console.error("ffmpeg failed to produce output, code:", code, "signal:", signal);
                  await safeSend(remoteJid, { text: "⚠️ Failed to create sticker (ffmpeg error)." });
                }
              } catch (err) {
                console.error("sticker send error:", err);
              } finally {
                try { if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile); } catch (e) {}
                try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (e) {}
              }
            });
          } catch (e) {
            console.error("sticker conversion error:", e);
            await safeSend(remoteJid, { text: "⚠️ Sticker conversion failed." });
            try { if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile); } catch (e) {}
          }
        } catch (e) {
          console.error("sticker error:", e);
          await safeSend(remoteJid, { text: "⚠️ Sticker failed." });
        }
        return;
      }

      // Sudo-only menu (show sudo commands)
      if (cmd === "sudo") {
        try { await requireSudo(); } catch { return; }
        const sudoText = [
          `*Sudo / Admin Commands*`,
          ``,
          `${prefix}setsudo <num> — add sudo`,
          `${prefix}delsudo <num> — remove sudo`,
          `${prefix}ban <num> — ban user`,
          `${prefix}unban <num> — unban user`,
          `${prefix}block <num> — block user`,
          `${prefix}unblock <num> — unblock user`,
        ].join("\n");
        await safeSend(remoteJid, { text: sudoText });
        return;
      }

      // ---------- GAME SYSTEM ----------
      // game storage: games[groupJid] = { owner, name, participants: {jid:{name, score, active}}, rounds, timePerRound, currentRound, status, queue... }
      const ensureGame = (gid) => { if (!games[gid]) games[gid] = {}; return games[gid]; };

      // .game create <name> <rounds> <timeSec>
      if (cmd === "game" && args[0] === "create") {
        try {
          // only owner can create game (owner of bot in DM or group owner in group)
          await requireOwner();
        } catch { return; }
        if (!isGroup) { await safeSend(remoteJid, { text: "⚠️ Games must be created inside a group." }); return; }
        const gname = args[1] || "Game";
        const rounds = parseInt(args[2] || "10", 10) || 10;
        const timePerRound = parseInt(args[3] || "15", 10) || 15;
        const g = {
          owner: authorJid,
          name: gname,
          rounds,
          timePerRound,
          participants: {},
          status: "waiting",
          currentRound: 0,
        };
        games[remoteJid] = g;
        saveGames();
        await safeSend(remoteJid, { text: `🎮 Game "${gname}" created by ${authorJid}. Use ${prefix}game join to participate.` });
        return;
      }

      // .game join
      if (cmd === "game" && args[0] === "join") {
        if (!isGroup) { await safeSend(remoteJid, { text: "⚠️ Games are group-only." }); return; }
        const g = games[remoteJid];
        if (!g) { await safeSend(remoteJid, { text: `No active game. Owner must create with ${prefix}game create` }); return; }
        if (g.status !== "waiting") { await safeSend(remoteJid, { text: "Game already started or finished." }); return; }
        if (!g.participants) g.participants = {};
        if (!g.participants[authorJid]) {
          g.participants[authorJid] = { name: profiles[authorJid]?.name || authorJid.split("@")[0], score: 0, active: true, joinedAt: Date.now() };
          saveGames();
          await safeSend(remoteJid, { text: `✅ ${authorJid} joined the game "${g.name}"` });
        } else {
          await safeSend(remoteJid, { text: "You already joined the game." });
        }
        return;
      }

      // .game start (owner only)
      if (cmd === "game" && args[0] === "start") {
        try {
          await requireOwner();
        } catch { return; }
        if (!isGroup) { await safeSend(remoteJid, { text: "Game must run in group." }); return; }
        const g = games[remoteJid];
        if (!g) { await safeSend(remoteJid, { text: "No game found. Create with .game create" }); return; }
        if (g.status !== "waiting") { await safeSend(remoteJid, { text: "Game already started." }); return; }
        const pIds = Object.keys(g.participants || {});
        if (pIds.length < 1) { await safeSend(remoteJid, { text: "No participants. Use .game join first." }); return; }

        g.status = "running";
        g.currentRound = 0;
        saveGames();
        await safeSend(remoteJid, { text: `🎮 Game "${g.name}" is starting with ${pIds.length} players!` });

        // run rounds sequentially
        const runRound = async () => {
          g.currentRound++;
          saveGames();
          const roundNum = g.currentRound;
          if (roundNum > g.rounds) {
            g.status = "finished";
            saveGames();
            // announce winner
            const arr = Object.entries(g.participants).map(([jid, p]) => ({ jid, ...p }));
            arr.sort((a,b) => b.score - a.score);
            const winner = arr[0];
            await safeSend(remoteJid, { text: `🏁 Game finished! Winner: ${winner ? (winner.name || winner.jid) + " ("+winner.score+" pts)" : "No winner"}` });
            return;
          }

          // pick a letter count for this round (owner could customize later). We'll ask for a category from owner if desired.
          const letterCount = Math.max(1, Math.min(10, Math.floor(Math.random() * 4) + 2));
          // for simplicity select a topic from owner's last defined set or a default list
          const topics = ["name","food","fruit","car","animal","school","city"];
          const topic = topics[(roundNum-1) % topics.length];

          await safeSend(remoteJid, { text: `🔔 Round ${roundNum}/${g.rounds}: Topic: *${topic}*. Words must be at least ${letterCount} letters. Answer with: !s <your answer>. You have ${g.timePerRound} seconds.` });

          // prepare map of players who answered correctly in this round
          const answered = new Set();
          const correctSet = new Set();

          // helper to process a player's answer will be invoked by main message handler when !s is used

          // Wait for timePerRound seconds
          await new Promise((resolve) => setTimeout(resolve, (g.timePerRound || 15) * 1000));

          // after time expired, award points to those who answered correctly in answered set
          const correctPlayers = Array.from(correctSet);
          if (!g.participants) g.participants = {};
          for (const jid of correctSet) {
            if (g.participants[jid]) {
              g.participants[jid].score = (g.participants[jid].score || 0) + 10; // correct: +10
            }
          }
          // optionally penalize wrong answers handled specially (not implemented here fully)
          saveGames();
          await safeSend(remoteJid, { text: `⏱ Round ${roundNum} ended. ${correctSet.size} correct answers. Scores updated.` });

          // elimination rules: remove players with 0 after 5 rounds etc. For simplicity enforce basic elimination:
          if (roundNum >= 5) {
            const toRemove = [];
            for (const [jid, pdata] of Object.entries(g.participants || {})) {
              if ((pdata.score || 0) <= 0) toRemove.push(jid);
            }
            for (const rjid of toRemove) {
              delete g.participants[rjid];
            }
            if (toRemove.length) await safeSend(remoteJid, { text: `❌ Eliminated players due to 0 points: ${toRemove.join(", ")}` });
            saveGames();
          }

          // continue next round
          setImmediate(runRound);
        };

        // We need to allow answers during each round: to support that we will store a temporary "currentRoundContext" in the game object
        g.currentRoundCtx = { acceptingAnswers: true, correctSet: new Set() };
        saveGames();

        // To keep design simple here, we spawn the runRound asynchronously
        setTimeout(() => runRound().catch(e => console.error("runRound error:", e)), 1000);

        return;
      }

      // .game status
      if (cmd === "game" && args[0] === "status") {
        const g = games[remoteJid];
        if (!g) { await safeSend(remoteJid, { text: "No game in this group." }); return; }
        const participantsList = Object.entries(g.participants || {}).map(([jid,p]) => `${p.name || jid.split("@")[0]} — ${p.score || 0} pts`).join("\n") || "No participants";
        await safeSend(remoteJid, { text: `🎮 ${g.name} — status: ${g.status}\nRound: ${g.currentRound || 0}/${g.rounds}\nParticipants:\n${participantsList}` });
        return;
      }

      // .game stop
      if (cmd === "game" && args[0] === "stop") {
        try { await requireOwner(); } catch { return; }
        const g = games[remoteJid];
        if (!g) { await safeSend(remoteJid, { text: "No game running." }); return; }
        g.status = "finished";
        saveGames();
        await safeSend(remoteJid, { text: `🛑 Game "${g.name}" stopped by owner.` });
        return;
      }

      // game answer special (!s prefix)
      if (cmd === "game_answer_special") {
        // if a game is running and accepting answers, validate word and mark correct / incorrect
        const g = games[remoteJid];
        if (!g || g.status !== "running") return;
        // simple validation: check word length & dictionary
        const answer = argStr || args.join(" ");
        if (!answer) return;
        const word = answer.trim().split(/\s+/)[0];
        const valid = await isValidEnglish(word);
        // If valid, add to correctSet in currentRoundCtx
        if (!g.currentRoundCtx) g.currentRoundCtx = { acceptingAnswers: true, correctSet: new Set() };
        if (valid) {
          g.currentRoundCtx.correctSet.add(authorJid);
          saveGames();
          await safeSend(remoteJid, { text: `✅ ${authorJid} — accepted.` });
        } else {
          // optional penalty
          await safeSend(remoteJid, { text: `❌ ${authorJid} — "${word}" not recognized (or dictionary unavailable).` });
        }
        return;
      }

      // unknown
      await safeSend(remoteJid, { text: `❓ Unknown command "${cmd}". Type ${prefix}help` });

    } catch (e) {
      console.error("messages.upsert error:", e);
      try { await safeSend(normalizeJid(config.owner), { text: `⚠️ Handler error: ${String(e).slice(0, 1000)}` }); } catch (_) {}
    }
  }); // end messages.upsert

  console.log("Bot started — waiting for messages.");
} // end startBot

// utility: convert phone number to jid
function jidFromNumber(num) {
  if (!num) return null;
  const digits = ("" + num).replace(/[^\d+]/g, "");
  let n = digits;
  if (n.startsWith("+")) n = n.slice(1);
  if (n.length === 11 && n.startsWith("0")) n = "234" + n.slice(1);
  if (!n.includes("@")) n = `${n}@s.whatsapp.net`;
  return n;
}

// Start
startBot().catch((err) => {
  console.error("Fatal start error:", err);
  process.exit(1);
});
