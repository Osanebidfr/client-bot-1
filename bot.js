/**
 * bot.js
 * Full-featured WhatsApp bot (Baileys) — cleaned and consolidated.
 * Keep your ./data/ and ./data/auth (multi-file auth) directories.
 *
 * Requirements (install if not present):
 * npm install @whiskeysockets/baileys qrcode-terminal ytdl-core yt-search ytpl pino fs-extra openai dotenv
 *
 * Start with: node bot.js
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
import fse from "fs-extra";
import path from "path";
import { performance } from "perf_hooks";
import ytdl from "ytdl-core";
import yts from "yt-search";
import ytpl from "ytpl";
import pino from "pino";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

// fallback in-memory store if library doesn't export one
const makeInMemoryStore =
  nativeMakeInMemoryStore ||
  ((logger) => {
    const contacts = {};
    return {
      contacts,
      bind: (ev) => {
        if (!ev || typeof ev.on !== "function") return;
        ev.on("contacts.upsert", (upd) => {
          try {
            for (const u of upd) {
              if (u?.id) contacts[u.id] = u;
            }
          } catch (e) {}
        });
        ev.on("contacts.update", (upd) => {
          try {
            for (const u of upd) {
              if (u?.id) contacts[u.id] = { ...(contacts[u.id] || {}), ...u };
            }
          } catch (e) {}
        });
      },
    };
  });

// ---- paths ----
const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const SUDO_FILE = path.join(DATA_DIR, "sudo.json");
const BANNED_FILE = path.join(DATA_DIR, "banned.json");
const CONFIG_FILE = path.join(ROOT, "config.json");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");

// ensure directories/files
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
if (!fs.existsSync(SUDO_FILE)) fs.writeFileSync(SUDO_FILE, JSON.stringify([], null, 2));
if (!fs.existsSync(BANNED_FILE)) fs.writeFileSync(BANNED_FILE, JSON.stringify([], null, 2));
if (!fs.existsSync(CONFIG_FILE)) {
  // safe default config if missing
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify(
      {
        owner: "2349065494753@s.whatsapp.net",
        prefix: ".",
        modePublic: false, // private by default (only owner/sudo can use commands)
        autoReplyCooldownMs: 10 * 60 * 1000, // kept for compatibility but auto-reply removed
        maxFileSizeBytes: 25 * 1024 * 1024,
        botName: "JohnBot",
        botStatus: "Online",
        openaiApiKey: "", // optional fallback
      },
      null,
      2
    )
  );
}

// ---- load config & data (safe) ----
let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
} catch (e) {
  console.error("Failed to load config.json, creating defaults.", e?.message ?? e);
  config = {
    owner: "2349065494753@s.whatsapp.net",
    prefix: ".",
    modePublic: false,
    autoReplyCooldownMs: 10 * 60 * 1000,
    maxFileSizeBytes: 25 * 1024 * 1024,
    botName: "JohnBot",
    botStatus: "Online",
    openaiApiKey: "",
  };
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (_) {}
}

// load profiles (persistent user info)
let profiles = {};
try {
  if (fs.existsSync(PROFILES_FILE)) {
    profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8") || "{}");
    if (!profiles || typeof profiles !== "object") profiles = {};
  } else {
    fs.writeFileSync(PROFILES_FILE, JSON.stringify({}, null, 2));
    profiles = {};
  }
} catch (e) {
  profiles = {};
}

// helper to persist profiles
const saveProfiles = () => {
  try {
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
  } catch (e) {
    console.warn("Failed to save profiles.json:", e?.message ?? e);
  }
};

// auto-reload config.json when changed (useful)
try {
  fs.watchFile(CONFIG_FILE, (curr, prev) => {
    try {
      const newConfig = JSON.parse(fs.readFileSync(CONFIG_FILE));
      config = newConfig;
      console.log("♻️  config.json reloaded.");
    } catch (err) {
      console.error("⚠️ Failed to reload config.json:", err.message);
    }
  });
} catch (e) { /* ignore watch errors */ }

let sudoList = [];
let bannedList = [];
try {
  sudoList = JSON.parse(fs.readFileSync(SUDO_FILE, "utf8"));
  if (!Array.isArray(sudoList)) sudoList = [];
} catch (e) {
  sudoList = [];
}
try {
  bannedList = JSON.parse(fs.readFileSync(BANNED_FILE, "utf8"));
  if (!Array.isArray(bannedList)) bannedList = [];
} catch (e) {
  bannedList = [];
}

// --------------------- Normalization & identity helpers (REPLACEMENT) ---------------------

// normalization helper — removes device/resource suffix like ":61" while preserving domain
function normalizeJid(jid) {
  if (!jid) return jid;
  try {
    const s = String(jid).trim();
    const atIndex = s.indexOf("@");
    if (atIndex === -1) {
      // no domain part, just drop any suffix after colon
      return s.split(":")[0];
    }
    // Split local part and domain; remove device suffix from local part only
    const localPart = s.slice(0, atIndex).split(":")[0];
    const domain = s.slice(atIndex + 1);
    return `${localPart}@${domain}`;
  } catch (e) {
    return jid;
  }
}

// helpers to persist (kept here so replacements are self-contained)
const saveSudo = () => {
  try {
    fs.writeFileSync(SUDO_FILE, JSON.stringify(sudoList, null, 2));
  } catch (e) {
    console.warn("Failed to save sudo.json:", e?.message ?? e);
  }
};
const saveBanned = () => {
  try {
    fs.writeFileSync(BANNED_FILE, JSON.stringify(bannedList, null, 2));
  } catch (e) {
    console.warn("Failed to save banned.json:", e?.message ?? e);
  }
};
const saveConfig = () => {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    console.warn("Failed to save config.json:", e?.message ?? e);
  }
};

// Normalize config.owner in-memory and persist (so owner checks are stable)
if (config && config.owner) {
  const normalizedOwner = normalizeJid(config.owner);
  if (config.owner !== normalizedOwner) {
    config.owner = normalizedOwner;
    try { saveConfig(); } catch (e) { /* non-fatal */ }
  }
}

// Normalize and deduplicate sudoList and bannedList, persist if changed
(() => {
  try {
    // normalize and unique
    const origSudos = Array.isArray(sudoList) ? sudoList.slice() : [];
    const normalizedSudos = Array.from(new Set(origSudos.map(normalizeJid).filter(Boolean)));

    // ensure owner is present in sudoList (at front)
    if (!normalizedSudos.includes(normalizeJid(config.owner))) {
      normalizedSudos.unshift(normalizeJid(config.owner));
    }

    // update only if changed
    if (JSON.stringify(normalizedSudos) !== JSON.stringify(sudoList)) {
      sudoList = normalizedSudos;
      saveSudo();
    }
  } catch (e) {
    console.warn("Failed to normalize sudoList:", e?.message ?? e);
  }

  try {
    const origBanned = Array.isArray(bannedList) ? bannedList.slice() : [];
    const normalizedBanned = Array.from(new Set(origBanned.map(normalizeJid).filter(Boolean)));
    if (JSON.stringify(normalizedBanned) !== JSON.stringify(bannedList)) {
      bannedList = normalizedBanned;
      saveBanned();
    }
  } catch (e) {
    console.warn("Failed to normalize bannedList:", e?.message ?? e);
  }
})();

// identity checks (use normalized comparison)
const isOwner = (jid) => normalizeJid(jid) === normalizeJid(config.owner);
const isSudo = (jid) => {
  const norm = normalizeJid(jid);
  return (Array.isArray(sudoList) && sudoList.map(normalizeJid).includes(norm)) || isOwner(jid);
};
const isBanned = (jid) => {
  const norm = normalizeJid(jid);
  return Array.isArray(bannedList) && bannedList.map(normalizeJid).includes(norm);
};

// jid formatting helper (unchanged)
const jidFromNumber = (num) => {
  if (!num) return null;
  const digits = ("" + num).replace(/[^\d+]/g, "");
  let n = digits;
  if (n.startsWith("+")) n = n.slice(1);
  if (n.length === 11 && n.startsWith("0")) n = "234" + n.slice(1);
  return `${n}@s.whatsapp.net`;
};
// Allow overriding the configured owner via env var (useful for Railway per-project owner)
if (process.env.OWNER) {
  config.owner = normalizeJid(process.env.OWNER);
} else {
  config.owner = normalizeJid(config.owner || "");
}
// ensure env OWNER is included in sudoList at runtime
try {
  const envOwner = normalizeJid(config.owner || "");
  if (envOwner) {
    sudoList = Array.isArray(sudoList) ? sudoList.map(normalizeJid) : [];
    if (!sudoList.includes(envOwner)) {
      sudoList.unshift(envOwner);
      saveSudo(); // optional: persists to sudo.json
    }
  }
} catch (e) {
  console.warn("Could not ensure env OWNER in sudoList:", e?.message ?? e);
}
// -----------------------------------------------------------------------------------------
// store & globals
const store = makeInMemoryStore(pino().child({ level: "silent" }));
let sock = null;
let reconnecting = false;
let botReady = false;
const processedMessages = new Map();

// cleanup intervals
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of processedMessages.entries()) {
    if (now - ts > 10 * 60 * 1000) processedMessages.delete(k);
  }
}, 60 * 1000);

// safe sender
async function safeSend(jid, msg) {
  try {
    if (!sock) throw new Error("Socket not ready");
    return await sock.sendMessage(jid, msg);
  } catch (err) {
    console.error("safeSend error:", err?.message ?? err);
  }
}

function getBotJid() {
  return sock?.user?.id || (sock?.authState && sock.authState.creds?.me?.id) || config.owner;
}

async function isBotAdminInGroup(groupJid) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    const me = getBotJid();
    const p = meta.participants.find((x) => normalizeJid(x.id) === normalizeJid(me));
    return !!(p && (p.admin || p.isAdmin || p.isSuperAdmin));
  } catch (e) {
    console.warn("isBotAdminInGroup error:", e?.message ?? e);
    return false;
  }
}

function friendlyDate(ts) {
  try {
    if (!ts) return "—";
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return "—";
    return d.toISOString();
  } catch (e) {
    return "—";
  }
}

// Start
async function startBot() {
  // avoid multiples
  if (sock && sock?.ws?.readyState && sock.ws.readyState !== 2 && sock.ws.readyState !== 3) {
    console.log("Socket already active; skipping new start.");
    return;
  }

  reconnecting = false;
  botReady = false;

  // auth
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    logger: pino({ level: "silent" }),
    auth: state,
    browser: [config.botName || "JohnBot", "Chrome", "1.0"],
    printQRInTerminal: false,
  });

  store.bind(sock.ev);
  sock.ev.on("creds.update", saveCreds);

 // connection.update (QR + Pairing Code support)
sock.ev.on("connection.update", async (update) => {
  try {
    const { connection, lastDisconnect, qr, pairingCode } = update;

    // Show QR code in terminal & external link
    if (qr) {
      console.log("\n===== QR CODE AVAILABLE =====");
      qrcode.generate(qr, { small: true });
      console.log("Scan QR via phone camera OR use link:");
      console.log("https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qr));
    }

    // Show 8-digit pairing code (works on phones where QR scan fails)
    if (pairingCode) {
      console.log("\n===== PAIRING CODE AVAILABLE =====");
      console.log("Enter this code on WhatsApp:");
      console.log("👉  " + pairingCode.join("-"));
      console.log("This works even without scanning QR.\n");
    }

    // Connection OPEN
    if (connection === "open") {
      console.log("✅ WhatsApp connection OPEN");

      const loggedInJid =
        sock?.user?.id ||
        (sock?.authState?.creds?.me?.id) ||
        null;

      console.log("Logged in as:", loggedInJid);
      console.log("Configured owner:", config.owner);

      // owner verification
      if (loggedInJid && config.owner) {
        const cleanLogged = normalizeJid(loggedInJid);
        const cleanOwner = normalizeJid(config.owner);
        if (cleanLogged !== cleanOwner) {
          console.warn(
            "⚠️ Owner mismatch detected.\n" +
            "Logged-in account ≠ config.owner.\n" +
            "If this login is for a new user (client), update `config.owner` or set OWNER env var."
          );
        } else {
          console.log("✅ Owner verified.");
        }
      }

      // notify owner or logged-in user once
      if (!botReady) {
        botReady = true;
        try {
          const notifyTarget =
            (loggedInJid && normalizeJid(loggedInJid) === normalizeJid(config.owner))
              ? config.owner
              : (loggedInJid || config.owner);

          await safeSend(notifyTarget, {
            text: `🤖 ${config.botName || "JohnBot"} is online and ready!`
          });
        } catch (e) {
          console.warn("Owner notify failed:", e?.message ?? e);
        }
      }

      return;
    }

    // Connection CLOSED
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = reason === DisconnectReason.loggedOut || reason === 401;

      console.warn("Connection closed.", { reason, loggedOut });
      botReady = false;

      if (loggedOut) {
        console.error("Logged out. Delete ./data/auth & rescan.");
        try {
          await safeSend(config.owner, {
            text: "❌ Bot logged out. Please rescan QR / pairing code."
          });
        } catch (_) {}
        return;
      }

      // attempt auto reconnect
      if (!reconnecting) {
        reconnecting = true;
        console.log("Reconnecting in 3s...");
        setTimeout(async () => {
          try {
            try { sock.ev.removeAllListeners(); } catch (_) {}
            sock = null;
            await startBot();
          } catch (e) {
            console.error("Reconnect error:", e?.message ?? e);
          } finally {
            reconnecting = false;
          }
        }, 3000);
      }

      return;
    }

  } catch (e) {
    console.error("connection.update error:", e?.message ?? e);
  }
});


  // messages.upsert
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages?.[0];
      if (!msg || !msg.message) return;
      if (!msg.key || !msg.key.remoteJid) return;

      const remoteJid = msg.key.remoteJid; // chat where message appeared
      const isGroup = remoteJid.endsWith("@g.us");

      // Derive author/sender and normalized forms robustly
      const rawAuthor = msg.key.participant || msg.key.remoteJid;
      const authorJid = normalizeJid(rawAuthor);
      const chatJid = normalizeJid(remoteJid);
      const loggedInJid = normalizeJid(sock?.user?.id || (sock?.authState && sock.authState.creds?.me?.id) || "");

      // Prevent loops: if message from this socket and this logged-in account is NOT configured owner, ignore
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

      // Small debug log to confirm owner/sudo recognition
      console.log("Debug owner check -> author:", authorJid, "isOwner:", isOwner(authorJid), "isSudo:", isSudo(authorJid));

      // banned check
      if (isBanned(authorJid)) {
        console.log("Sender banned:", authorJid);
        return;
      }

      // --- IMPORTANT: auto-reply code REMOVED as requested ---
      // (No auto-reply behavior remains in this handler.)

      // view-once automatic saving (send to chat + copy to owner DM)
      const viewOnceMessage =
        msg.message.viewOnceMessageV2 ??
        msg.message.viewOnceMessageV2Extension ??
        msg.message.viewOnceMessage;

      if (viewOnceMessage) {
        try {
          const inner = viewOnceMessage.message ?? viewOnceMessage;
          const typeKey = Object.keys(inner)[0];
          const contentType = typeKey.replace("Message", "").toLowerCase(); // e.g. "image", "video"

          const stream = await downloadContentFromMessage(inner[typeKey], contentType);
          const parts = [];
          for await (const chunk of stream) parts.push(chunk);

          const ext = contentType.includes("image")
            ? "jpg"
            : contentType.includes("video")
            ? "mp4"
            : "bin";
          const filename = path.join(DATA_DIR, `viewonce_auto_${Date.now()}.${ext}`);
          fs.writeFileSync(filename, Buffer.concat(parts));

          console.log("✅ Saved view-once as", filename);

          // Determine send targets
          const sendTarget = isGroup ? remoteJid : authorJid;
          const ownerJid = normalizeJid(config.owner);

          const chatCaption = "✅ View-once media recovered";
          const ownerCaption = `📥 Copied for owner — from ${isGroup ? "group" : "private chat"} (${sendTarget})`;

          // Send recovered file to chat
          try {
            if (contentType.includes("image")) {
              await safeSend(sendTarget, {
                image: fs.createReadStream(filename),
                caption: chatCaption,
              });
            } else if (contentType.includes("video")) {
              await safeSend(sendTarget, {
                video: fs.createReadStream(filename),
                caption: chatCaption,
              });
            } else {
              await safeSend(sendTarget, {
                document: fs.createReadStream(filename),
                fileName: `viewonce_${Date.now()}.${ext}`,
                caption: chatCaption,
              });
            }
          } catch (err) {
            console.error("❌ Failed to send recovered media to chat:", err?.message ?? err);
            try {
              await safeSend(ownerJid, {
                text: `⚠️ Failed to send recovered view-once media to chat ${sendTarget}: ${String(err).slice(0, 300)}`,
              });
            } catch {}
          }

          // Also DM a copy to the owner
          try {
            if (contentType.includes("image")) {
              await safeSend(ownerJid, {
                image: fs.createReadStream(filename),
                caption: ownerCaption,
              });
            } else if (contentType.includes("video")) {
              await safeSend(ownerJid, {
                video: fs.createReadStream(filename),
                caption: ownerCaption,
              });
            } else {
              await safeSend(ownerJid, {
                document: fs.createReadStream(filename),
                fileName: `viewonce_${Date.now()}.${ext}`,
                caption: ownerCaption,
              });
            }
          } catch (err) {
            console.error("❌ Failed to send copy to owner DM:", err?.message ?? err);
            try {
              await safeSend(ownerJid, {
                text: `⚠️ Could not DM recovered media from ${sendTarget}. Error: ${String(err).slice(0, 300)}`,
              });
            } catch {}
          }

          // Delete saved file after 1 minute to avoid large accumulation (this is only the auto-captured copy)
          setTimeout(() => {
            try {
              fs.unlinkSync(filename);
            } catch {}
          }, 60 * 1000);
        } catch (err) {
          console.error("view-once save error:", err?.message ?? err);
        }
      }

      // --- Command parsing ---
      const prefix = (config.prefix || ".").toString();
      if (!text || !text.trim().startsWith(prefix)) return;

      const args = text.trim().slice(prefix.length).trim().split(/\s+/);
      const cmd = (args.shift() || "").toLowerCase();
      const argStr = args.join(" ").trim();

      // permission check (authorJid is canonical user) — use normalized authorJid
      const allowed = config.modePublic ? true : (isOwner(authorJid) || isSudo(authorJid));
      if (!allowed) return; // silent ignore if private and unauthorized

      // helper require functions (use authorJid)
      const requireOwner = async () => {
        if (!isOwner(authorJid)) { await safeSend(remoteJid, { text: "⚠️ Owner-only command." }); throw new Error("not_owner"); }
      };
      const requireSudo = async () => {
        if (!isSudo(authorJid)) { await safeSend(remoteJid, { text: "⚠️ Sudo-only command." }); throw new Error("not_sudo"); }
      };

      // ---------------- COMMANDS (preserved & enhanced) ----------------

      // PING
      if (cmd === "ping") {
        try {
          const t0 = performance.now();
          await safeSend(remoteJid, { text: "🏓 Pinging..." });
          const t1 = performance.now();
          const latency = (t1 - t0).toFixed(2);
          await safeSend(remoteJid, { text: `✅ Pong! Response time: ${latency} ms` });
        } catch (e) {
          console.error("ping error", e);
        }
        return;
      }

      // MENU - enhanced (sends a colorful banner + caption) [unchanged core behavior]
      if (cmd === "menu") {
        try {
          const target = msg.message.extendedTextMessage?.contextInfo?.participant || authorJid;
          const contact = (store.contacts && (store.contacts[target] || store.contacts[normalizeJid(target)])) || {};
          const displayName = contact?.name || contact?.notify || "Unknown";

          // try to get a profile pic
          let profilePicUrl = null;
          try { profilePicUrl = await sock.profilePictureUrl(target).catch(() => null); } catch (e) {}

          let joined = "—";
          if (isGroup) {
            try {
              const meta = await sock.groupMetadata(remoteJid);
              const participant = meta.participants.find((p) => normalizeJid(p.id) === normalizeJid(target));
              if (participant?.joinedTimestamp) joined = new Date(participant.joinedTimestamp).toLocaleString("en-GB", { timeZone: "Africa/Lagos" });
            } catch (e) {}
          }

          const header = "════════════════════════\n";
          const menuText = [
            `*🤖 ${config.botName || "JohnBot"} — Menu*`,
            "",
            `*👤 Name:* ${displayName}`,
            `*🆔 JID:* ${target}`,
            `*🏷 Group:* ${isGroup ? "Yes" : "No"}`,
            `*📅 Joined:* ${joined}`,
            `*🔒 Mode:* ${config.modePublic ? "Public" : "Private"}`,
            "",
            `*Commands*`,
            `${prefix}ping — check latency`,
            `${prefix}menu — show this menu`,
            `${prefix}download — reply to media to save and resend`,
            `${prefix}song <query> — download YouTube audio`,
            `${prefix}view — retrieve view-once media`,
            `${prefix}gpt <prompt> — ChatGPT/Images`,
            `${prefix}sticker — reply to image/video to create a sticker`,
            "",
            `*Owner:* ${config.owner}`,
            header,
            `_Powered by ${config.botName}_`,
          ].join("\n");

          // a colorful background image (public unsplash image) as banner - if remote loading fails, just send text
          const bannerUrl = "https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=1200&q=80";

          if (profilePicUrl) {
            // if we can fetch profile pic, show that plus menu
            try {
              await safeSend(remoteJid, { image: { url: profilePicUrl }, caption: menuText });
              return;
            } catch (e) {
              // fallback to banner
            }
          }

          try {
            await safeSend(remoteJid, { image: { url: bannerUrl }, caption: menuText });
            return;
          } catch (e) {
            // fallback to text-only menu
          }

          await safeSend(remoteJid, { text: menuText });
        } catch (e) {
          console.error("menu error", e);
          await safeSend(remoteJid, { text: "⚠️ Failed to fetch user menu." });
        }
        return;
      }

      // ---------------------------
      // .menu user  (profile submenu) - enhanced to include persisted profile data
      // ---------------------------
      if (cmd === "menu" && (argStr.startsWith("user") || argStr === "profile" || argStr === "submenu" || argStr.startsWith("user "))) {
        try {
          // determine target JID (priority: replied message participant, mentioned, numeric arg, author)
          const ctx = msg.message.extendedTextMessage?.contextInfo;
          const quoted = ctx?.quotedMessage;
          let target = null;

          // If replying to a message, prefer that participant (works in groups)
          if (ctx?.participant && quoted) {
            target = normalizeJid(ctx.participant);
          }

          // If args provided after .menu
          if (!target && args.length > 0) {
            // strip the initial 'user' if present
            let maybe = argStr;
            if (maybe.toLowerCase().startsWith("user")) {
              maybe = maybe.slice(4).trim();
            }
            if (maybe) {
              // if mention like @12345 or direct number
              const firstToken = maybe.split(/\s+/)[0].replace(/^@/, "");
              if (/^\+?\d+$/.test(firstToken) || /^\d+$/.test(firstToken)) {
                target = jidFromNumber(firstToken);
              } else if (firstToken.includes("@")) {
                target = normalizeJid(firstToken);
              } else {
                // try mentions array if present
                const mentions = ctx?.mentionedJid || [];
                if (mentions.length) target = normalizeJid(mentions[0]);
              }
            }
          }

          // If still no target, and message has mentions (Baileys vX mention format)
          if (!target && ctx?.mentionedJid && ctx.mentionedJid.length) {
            target = normalizeJid(ctx.mentionedJid[0]);
          }

          // fallback to the message author
          if (!target) target = authorJid;

          // normalize final target
          target = normalizeJid(target);

          // gather contact info
          const contactEntry = (store.contacts && (store.contacts[target] || store.contacts[normalizeJid(target)])) || {};
          const displayName = contactEntry?.name || contactEntry?.notify || "Unknown";
          const isSaved = !!(contactEntry?.name || contactEntry?.notify);
          let joined = "—";
          let role = "Member";

          if (isGroup) {
            try {
              const meta = await sock.groupMetadata(remoteJid);
              const participant = meta.participants.find((p) => normalizeJid(p.id) === normalizeJid(target));
              if (participant) {
                if (participant?.joinedTimestamp) joined = new Date(participant.joinedTimestamp).toLocaleString("en-GB", { timeZone: "Africa/Lagos" });
                if (participant?.admin || participant?.isAdmin || participant?.isSuperAdmin) role = "Admin";
              }
            } catch (e) {
              // ignore metadata errors
            }
          }

          // try fetch profile picture URL
          let ppUrl = null;
          try { ppUrl = await sock.profilePictureUrl(target).catch(() => null); } catch (e) { ppUrl = null; }

          // include persisted profile fields if present
          const userProfile = profiles[target] || {};
          const bio = userProfile.bio || "";
          const savedRole = userProfile.role || "";

          // Attempt to generate a colourful profile card image using canvas
          let sent = false;
          try {
            const { createCanvas, loadImage } = await import("canvas");
            const width = 900, height = 450;
            const canvas = createCanvas(width, height);
            const ctx2 = canvas.getContext("2d");

            // Gradient background
            const g = ctx2.createLinearGradient(0, 0, width, height);
            g.addColorStop(0, "#ff7eb3"); // pink
            g.addColorStop(0.5, "#7ac7ff"); // light blue
            g.addColorStop(1, "#9d7aff"); // violet
            ctx2.fillStyle = g;
            ctx2.fillRect(0, 0, width, height);

            // subtle rounded card overlay
            ctx2.fillStyle = "rgba(255,255,255,0.06)";
            const cardX = 30, cardY = 30, cardW = width - 60, cardH = height - 60, rad = 20;
            ctx2.beginPath();
            ctx2.moveTo(cardX + rad, cardY);
            ctx2.arcTo(cardX + cardW, cardY, cardX + cardW, cardY + cardH, rad);
            ctx2.arcTo(cardX + cardW, cardY + cardH, cardX, cardY + cardH, rad);
            ctx2.arcTo(cardX, cardY + cardH, cardX, cardY, rad);
            ctx2.arcTo(cardX, cardY, cardX + cardW, cardY, rad);
            ctx2.closePath();
            ctx2.fill();

            // profile picture circle
            const avatarSize = 180;
            const avatarX = cardX + 40, avatarY = cardY + 40;

            if (ppUrl) {
              try {
                const img = await loadImage(ppUrl);
                // circular clip
                ctx2.save();
                ctx2.beginPath();
                ctx2.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
                ctx2.closePath();
                ctx2.clip();
                ctx2.drawImage(img, avatarX, avatarY, avatarSize, avatarSize);
                ctx2.restore();

                // thin neon border
                ctx2.beginPath();
                ctx2.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2 + 4, 0, Math.PI * 2);
                ctx2.lineWidth = 6;
                ctx2.strokeStyle = "rgba(255,255,255,0.18)";
                ctx2.stroke();
              } catch (e) {
                // fallback placeholder
                ctx2.fillStyle = "#ffffff22";
                ctx2.beginPath();
                ctx2.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
                ctx2.fill();
              }
            } else {
              // placeholder circle with initials
              ctx2.fillStyle = "#ffffff22";
              ctx2.beginPath();
              ctx2.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
              ctx2.fill();
              // initials
              ctx2.fillStyle = "#fff";
              ctx2.font = "bold 48px Sans-serif";
              const initials = (displayName.split(" ").map(s => s[0]).slice(0,2).join("") || displayName.slice(0,2)).toUpperCase();
              ctx2.textAlign = "center";
              ctx2.fillText(initials, avatarX + avatarSize/2, avatarY + avatarSize/2 + 16);
            }

            // Name & number
            ctx2.fillStyle = "#fff";
            ctx2.font = "bold 34px Sans-serif";
            ctx2.textAlign = "left";
            ctx2.fillText(displayName, avatarX + avatarSize + 30, avatarY + 60);

            ctx2.font = "20px Sans-serif";
            ctx2.fillStyle = "#f3f3f3";
            ctx2.fillText(`JID: ${target}`, avatarX + avatarSize + 30, avatarY + 100);

            // saved contact & role
            ctx2.fillText(`Saved contact: ${isSaved ? "Yes" : "No"}`, avatarX + avatarSize + 30, avatarY + 140);
            ctx2.fillText(`Role: ${savedRole || role}`, avatarX + avatarSize + 30, avatarY + 170);

            // joined (group only)
            ctx2.fillText(`Joined: ${isGroup ? joined : "Private Chat"}`, avatarX + avatarSize + 30, avatarY + 200);

            // bio block
            ctx2.fillStyle = "rgba(255,255,255,0.06)";
            ctx2.fillRect(width - 420, cardY + 40, 340, 200);
            ctx2.fillStyle = "#fff";
            ctx2.font = "18px Sans-serif";
            ctx2.fillText("Bio", width - 270, cardY + 75);
            ctx2.font = "14px Sans-serif";
            const bioText = bio ? bio : "No bio set. Use .setbio <text> to add.";
            // wrap bio to fit box (very simple)
            const wrap = (text, x, y, maxWidth, lineHeight) => {
              const words = text.split(" ");
              let line = "";
              for (let n = 0; n < words.length; n++) {
                const testLine = line + words[n] + " ";
                const metrics = ctx2.measureText(testLine);
                if (metrics.width > maxWidth && n > 0) {
                  ctx2.fillText(line, x, y);
                  line = words[n] + " ";
                  y += lineHeight;
                } else {
                  line = testLine;
                }
              }
              ctx2.fillText(line, x, y);
            };
            ctx2.fillStyle = "#f5f5f5";
            wrap(bioText, width - 410, cardY + 105, 320, 20);

            // footer
            ctx2.font = "14px Sans-serif";
            ctx2.fillStyle = "rgba(255,255,255,0.9)";
            ctx2.textAlign = "center";
            ctx2.fillText(`${config.botName || "JohnBot"} • ${new Date().toLocaleString("en-GB",{timeZone:"Africa/Lagos"})}`, width/2, height - 20);

            // write file and send
            const outPath = path.join(DATA_DIR, `menu_user_${Date.now()}.png`);
            const buffer = canvas.toBuffer("image/png");
            fs.writeFileSync(outPath, buffer);

            await safeSend(remoteJid, { image: fs.createReadStream(outPath), caption: `🔎 Profile — ${displayName}` });

            setTimeout(() => { try { fs.unlinkSync(outPath); } catch (e) {} }, 30*1000);
            sent = true;
          } catch (canvasErr) {
            console.warn("canvas generation failed or canvas module not installed:", canvasErr?.message ?? canvasErr);
            // fallthrough to fallback below
          }

          // Fallbacks if canvas unavailable/fails:
          if (!sent) {
            if (ppUrl) {
              try {
                await safeSend(remoteJid, { image: { url: ppUrl }, caption:
                  `🔎 Profile — ${displayName}\nJID: ${target}\nSaved contact: ${isSaved ? "Yes" : "No"}\nRole: ${savedRole || role}\nJoined: ${isGroup ? joined : "Private Chat"}${bio ? `\n\nBio: ${bio}` : ""}`
                });
                sent = true;
              } catch (e) { /* ignore */ }
            }
          }

          if (!sent) {
            // final fallback: text summary
            const summary = [
              `🔎 Profile — ${displayName}`,
              `JID: ${target}`,
              `Saved contact: ${isSaved ? "Yes" : "No"}`,
              `Role: ${savedRole || role}`,
              `Joined: ${isGroup ? joined : "Private Chat"}`,
              bio ? `Bio: ${bio}` : "",
            ].filter(Boolean).join("\n");
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
          "",
          `${prefix}ping — latency`,
          `${prefix}menu — user info`,
          `${prefix}tag / ${prefix}tagall — mention everyone in group`,
          `${prefix}kick <num> / reply with ${prefix}kick — remove member (bot admin required)`,
          `${prefix}invite <num> — add user to group (bot admin required)`,
          `${prefix}download — reply to media to save and resend`,
          `${prefix}song <query> — download YouTube audio (may be limited by file size)`,
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
// safe helper: calls an async fn but rejects after timeoutMs
async function withTimeout(promiseFactory, timeoutMs = 5000) {
  return await Promise.race([
    (async () => { return await promiseFactory(); })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
  ]);
}
// TAGALL - Single message full list with ❤️
if ((cmd === "tag" || cmd === "tagall") && isGroup) {
  try {
    // fetch metadata quickly (timeout safe)
    let meta = null;
    try {
      meta = await withTimeout(() => sock.groupMetadata(remoteJid), 7000);
    } catch (err) {
      console.warn("groupMetadata failed:", err?.message ?? err);
      const storeChat = store?.chats?.get(remoteJid);
      meta = { participants: (storeChat?.participants || []).map((p) => ({ id: p })) || [] };
    }

    const participants = (meta?.participants || [])
      .map((p) => normalizeJid(p.id || p))
      .filter(Boolean);

    if (!participants.length) {
      await safeSend(remoteJid, { text: "⚠️ No members found to tag." });
      return;
    }

    // Build single huge message
    let msg = "❤️ *Tagging everyone:* ❤️\n\n";
    for (const jid of participants) {
      msg += `❤️ @${jid.split("@")[0]}\n`;
    }

    // Send ONE single message
    await sock.sendMessage(remoteJid, {
      text: msg,
      mentions: participants
    });

  } catch (e) {
    console.error("tag error:", e);
    await safeSend(remoteJid, { text: "❌ Unable to tag all members in a single message (too large)." });
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
          const filename = path.join(DATA_DIR, `download_${Date.now()}.${ext}`);
          fs.writeFileSync(filename, Buffer.concat(parts));
          if (ext === "jpg") await safeSend(remoteJid, { image: fs.createReadStream(filename), caption: `✅ Downloaded: ${path.basename(filename)}` });
          else if (ext === "mp4") await safeSend(remoteJid, { video: fs.createReadStream(filename), caption: `✅ Downloaded: ${path.basename(filename)}` });
          else await safeSend(remoteJid, { document: fs.createReadStream(filename), fileName: path.basename(filename) });
          setTimeout(() => { try { fs.unlinkSync(filename); } catch (e) {} }, 60 * 1000);
        } catch (e) { console.error("download error", e); await safeSend(remoteJid, { text: `⚠️ Download failed: ${e?.message ?? e}` }); }
        return;
      }

      // SONG - YouTube audio
      if (cmd === "song") {
        if (!argStr) { await safeSend(remoteJid, { text: `Usage: ${prefix}song <search terms>` }); return; }
        try {
          await safeSend(remoteJid, { text: `🔎 Searching YouTube for "${argStr}"...` });
          const r = await yts(argStr);
          const v = r?.videos?.[0];
          if (!v) { await safeSend(remoteJid, { text: "No results found." }); return; }
          const url = v.url;
          const titleSafe = v.title.replace(/[^\w\s-]/g, "").slice(0, 64).replace(/\s+/g, "_");
          const filename = path.join(DATA_DIR, `song_${Date.now()}_${titleSafe}.mp3`);

          // Try ytdl download with robust error handling
          try {
            const stream = ytdl(url, { filter: "audioonly", quality: "highestaudio" });
            const ws = fs.createWriteStream(filename);
            stream.pipe(ws);

            stream.on("error", async (e) => {
              console.error("ytdl stream error:", e?.message ?? e);
            });

            ws.on("finish", async () => {
              try {
                const stats = fs.statSync(filename);
                if (stats.size > (config.maxFileSizeBytes || 25 * 1024 * 1024)) {
                  fs.unlinkSync(filename);
                  await safeSend(remoteJid, { text: `⚠️ File too large to send (${(stats.size/1024/1024).toFixed(2)} MB).` });
                  return;
                }
                await safeSend(remoteJid, { audio: fs.createReadStream(filename) });
              } catch (e) {
                console.error("song send error", e);
                await safeSend(remoteJid, { text: "⚠️ Failed to send song." });
              } finally {
                try { fs.unlinkSync(filename); } catch (e) {}
              }
            });

            ws.on("error", async (e) => {
              console.error("fs write error:", e);
              await safeSend(remoteJid, { text: "⚠️ Failed to download audio (write error)." });
              try { if (fs.existsSync(filename)) fs.unlinkSync(filename); } catch (e) {}
            });
          } catch (e) {
            console.error("ytdl general error:", e);
            // fallback: send direct YouTube link if download fails
            await safeSend(remoteJid, { text: `⚠️ Could not download audio. Here's the link instead:\n${url}` });
          }
        } catch (e) {
          console.error("song error", e);
          await safeSend(remoteJid, { text: `⚠️ Song error: ${e?.message ?? e}` });
        }
        return;
      }

      // SUDO management
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

      // NEW: .sudo command - show admin/sudo commands (sudo-only)
      if (cmd === "sudo") {
        try {
          await requireSudo();
        } catch { return; }
        const adminCmds = (config.permissions && config.permissions.sudo) || ["ban", "unban", "tagall", "promote", "demote"];
        await safeSend(remoteJid, { text: `🛡️ Admin/Sudo commands:\n\n${adminCmds.map(c => `${prefix}${c}`).join("\n")}` });
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
          setTimeout(() => { try { fs.unlinkSync(file); } catch (e) {} }, 60 * 1000);
        } catch (e) { console.error("setppbot error", e); await safeSend(remoteJid, { text: "⚠️ Failed to set profile picture." }); }
        return;
      }

      // NEW: STICKER (reply to an image or video to convert to webp sticker)
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

          // convert with ffmpeg (ffmpeg must be installed on the system)
          try {
            const { spawn } = await import("child_process");
            // ffmpeg options: scale/pad to 512x512 preserving aspect, create webp
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
              try { if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile); } catch (e) {}
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
          console.error("sticker error", e);
          await safeSend(remoteJid, { text: "⚠️ Sticker failed." });
        }
        return;
      }

      // restart / shutdown
      if (cmd === "restart") { try { await requireOwner(); } catch { return; } await safeSend(remoteJid, { text: "♻️ Restarting bot..." }); console.log("Owner requested restart. Exiting process."); process.exit(0); }
      if (cmd === "shutdown") { try { await requireOwner(); } catch { return; } await safeSend(remoteJid, { text: "⏹️ Shutting down..." }); console.log("Owner requested shutdown. Exiting."); process.exit(0); }

      // eval
      if (cmd === "eval") { try { await requireOwner(); } catch { return; } if (!argStr) { await safeSend(remoteJid, { text: "Usage: .eval <js>" }); return; } try { const output = eval(argStr); await safeSend(remoteJid, { text: `✅ Eval result:\n${String(output).slice(0, 1500)}` }); } catch (e) { await safeSend(remoteJid, { text: `⚠️ Eval error: ${e.message || e}` }); } return; }

      // exec
      if (cmd === "exec") { try { await requireOwner(); } catch { return; } if (!argStr) { await safeSend(remoteJid, { text: "Usage: .exec <cmd>" }); return; } try { const { exec } = await import("child_process"); exec(argStr, { timeout: 30_000 }, async (err, stdout, stderr) => { if (err) { await safeSend(remoteJid, { text: `⚠️ Exec error: ${err.message}` }); return; } const out = (stdout || stderr || "—").slice(0, 1500); await safeSend(remoteJid, { text: `📤 Output:\n${out}` }); }); } catch (e) { await safeSend(remoteJid, { text: `⚠️ Exec failed: ${e.message || e}` }); } return; }

      // VIEW (manual retrieval) - robust download + persistent save in data/saved/
      if (cmd === "view") {
        try {
          const ctx = msg.message.extendedTextMessage?.contextInfo;
          const quoted = ctx?.quotedMessage;

          // ensure saved folder exists
          const SAVED_DIR = path.join(DATA_DIR, "saved");
          try { if (!fs.existsSync(SAVED_DIR)) fs.mkdirSync(SAVED_DIR, { recursive: true }); } catch (e) {}

          // helper: extract media object/contentType and stream from a quoted message or stored message
          const extractAndStream = async (maybeMsgObject) => {
            if (!maybeMsgObject) return null;

            // Determine top-level key (e.g. imageMessage, videoMessage, viewOnceMessage, etc.)
            const topKey = Object.keys(maybeMsgObject)[0];
            const topVal = maybeMsgObject[topKey];

            // If top-level is view-once wrapper, dive into its inner message
            if (
              topKey.toLowerCase().includes("viewonce") ||
              topVal?.viewOnceMessage ||
              topVal?.viewOnceMessageV2 ||
              topVal?.viewOnceMessageV2Extension
            ) {
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

            // If topVal already is a media message (imageMessage/videoMessage/documentMessage)
            if (topKey && topVal) {
              const contentType = topKey.replace("Message", "").toLowerCase();
              // For some structures, topVal is the object to pass to downloadContentFromMessage
              const stream = await downloadContentFromMessage(topVal, contentType);
              return { stream, contentType, filenameKey: topKey };
            }

            return null;
          };

          // helper: save stream into file permanently under data/saved and return filepath + ext
          const saveStreamToFile = async (streamIterator, contentType) => {
            const parts = [];
            for await (const chunk of streamIterator) parts.push(chunk);
            const ext = contentType.includes("image") ? "jpg" : contentType.includes("video") ? "mp4" : (contentType.includes("audio") ? "mp3" : "bin");
            const fname = `view_saved_${Date.now()}.${ext}`;
            const filepath = path.join(SAVED_DIR, fname);
            fs.writeFileSync(filepath, Buffer.concat(parts));
            return { filepath, ext };
          };

          // helper: send recovered file to chat + DM owner (persistent save)
          const sendAndPreserve = async (filepath, ext, sourceInfo = {}) => {
            const chatCaption = `✅ Recovered media (${sourceInfo.note || "manual view"})${sourceInfo.sender ? ` • Sender: ${sourceInfo.sender}` : ""}`;
            const ownerCaption = `📥 Copied for owner — from ${isGroup ? "group" : "private chat"} (${remoteJid})${sourceInfo.sender ? ` • Sender: ${sourceInfo.sender}` : ""}`;

            // send to chat
            try {
              if (ext === "jpg") await safeSend(remoteJid, { image: fs.createReadStream(filepath), caption: chatCaption });
              else if (ext === "mp4") await safeSend(remoteJid, { video: fs.createReadStream(filepath), caption: chatCaption });
              else await safeSend(remoteJid, { document: fs.createReadStream(filepath), fileName: path.basename(filepath), caption: chatCaption });
            } catch (err) {
              console.error("Failed to send recovered media to chat:", err?.message ?? err);
              try { await safeSend(normalizeJid(config.owner), { text: `⚠️ Failed to send recovered media to chat ${remoteJid}: ${String(err).slice(0,300)}` }); } catch {}
            }

            // DM owner a copy
            try {
              const ownerJ = normalizeJid(config.owner);
              if (ext === "jpg") await safeSend(ownerJ, { image: fs.createReadStream(filepath), caption: ownerCaption });
              else if (ext === "mp4") await safeSend(ownerJ, { video: fs.createReadStream(filepath), caption: ownerCaption });
              else await safeSend(ownerJ, { document: fs.createReadStream(filepath), fileName: path.basename(filepath), caption: ownerCaption });
            } catch (err) {
              console.error("Failed to send copy to owner DM:", err?.message ?? err);
              try { await safeSend(normalizeJid(config.owner), { text: `⚠️ Could not DM recovered media from ${remoteJid}. Error: ${String(err).slice(0,300)}` }); } catch {}
            }

            // NOTE: file is intentionally preserved in data/saved/ for manual inspection and download.
            console.log("Saved recovered media permanently at:", filepath);
          };

          // If reply exists -> download quoted media
          if (quoted) {
            try {
              // Extract media (handles view-once wrappers)
              const extracted = await extractAndStream(quoted);
              if (!extracted) { await safeSend(remoteJid, { text: "⚠️ No downloadable media found in the replied message." }); return; }

              const { stream, contentType } = extracted;
              const { filepath, ext } = await saveStreamToFile(stream, contentType);

              // try to find sender info (participant) when available
              let senderInfo = null;
              try { if (ctx?.participant) senderInfo = normalizeJid(ctx.participant); } catch (e) {}

              await sendAndPreserve(filepath, ext, { note: "reply", sender: senderInfo });
            } catch (err) {
              console.error("view download error (reply):", err?.message ?? err);
              await safeSend(remoteJid, { text: "⚠️ Failed to download quoted media. If this keeps failing, ask the sender to resend." });
            }
            return;
          }

          // Else: try to accept a message id as argument (e.g. .view <messageId>)
          if (args[0]) {
            const lookupId = args[0];
            try {
              // attempt to find message in local store
              let found = null;
              try {
                for (const [k, v] of (store?.messages || new Map()).entries?.() || []) {
                  if (!v || !v.key) continue;
                  if (v.key.id === lookupId || v.key.id?.endsWith(lookupId) || (v.key.remoteJid === remoteJid && v.key.id === lookupId)) { found = v; break; }
                }
              } catch (innerErr) {
                // store/messages shape might differ; ignore
              }

              if (!found) { await safeSend(remoteJid, { text: "⚠️ Could not find that message in local store." }); return; }

              const quoted2 = found.message;
              const extracted2 = await extractAndStream(quoted2);
              if (!extracted2) { await safeSend(remoteJid, { text: "⚠️ Found message but no downloadable media." }); return; }

              const { stream: stream2, contentType: contentType2 } = extracted2;
              const { filepath: filepath2, ext: ext2 } = await saveStreamToFile(stream2, contentType2);

              // Attempt to get sender info from the stored message's key.participant if present
              let senderInfo2 = null;
              try { if (found.key?.participant) senderInfo2 = normalizeJid(found.key.participant); } catch (e) {}

              await sendAndPreserve(filepath2, ext2, { note: "store lookup", sender: senderInfo2 });
            } catch (err) {
              console.error("view lookup error:", err?.message ?? err);
              await safeSend(remoteJid, { text: "⚠️ Failed to retrieve message from store." });
            }
            return;
          }

          // nothing to do
          await safeSend(remoteJid, { text: `Usage: Reply to the view-once message with ${prefix}view OR use ${prefix}view <messageId>` });
        } catch (err) {
          console.error("view command error:", err?.message ?? err);
          await safeSend(remoteJid, { text: "⚠️ Failed to run view command." });
        }
        return;
      }

   
      // NEW: .setbio <text> - set your profile bio (persists)
      if (cmd === "setbio") {
        try {
          if (!argStr) { await safeSend(remoteJid, { text: `Usage: ${prefix}setbio <your bio>` }); return; }
          const who = authorJid;
          if (!profiles[who]) profiles[who] = {};
          profiles[who].bio = argStr.slice(0, 512);
          saveProfiles();
          await safeSend(remoteJid, { text: "✅ Bio saved." });
        } catch (e) {
          console.error(".setbio error", e);
          await safeSend(remoteJid, { text: "⚠️ Could not save bio." });
        }
        return;
      }

      // NEW: .setrole <text> - set a role for your profile (optional)
      if (cmd === "setrole") {
        try {
          if (!argStr) { await safeSend(remoteJid, { text: `Usage: ${prefix}setrole <role>` }); return; }
          const who = authorJid;
          if (!profiles[who]) profiles[who] = {};
          profiles[who].role = argStr.slice(0, 64);
          saveProfiles();
          await safeSend(remoteJid, { text: "✅ Role saved." });
        } catch (e) {
          console.error(".setrole error", e);
          await safeSend(remoteJid, { text: "⚠️ Could not save role." });
        }
        return;
      }

      // SUDO management commands already present above...

      // unknown
      await safeSend(remoteJid, { text: `❓ Unknown command "${cmd}". Type ${prefix}help` });

    } catch (e) {
      console.error("messages.upsert error:", e);
      try { await safeSend(normalizeJid(config.owner), { text: `⚠️ Handler error: ${String(e).slice(0, 1000)}` }); } catch (_) {}
    }
  }); // end messages.upsert

  console.log("Bot started — waiting for messages.");
} // end startBot

// Start
startBot().catch((err) => {
  console.error("Fatal start error:", err);
  process.exit(1);
});
