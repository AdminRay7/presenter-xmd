"use strict";

const fs = require("fs");
const path = require("path");
const cfg = require("./lib/config");
const { jidNormalizedUser } = require("@whiskeysockets/baileys");

// ============================================================
//   SHARED HELPERS (available to every command)
// ============================================================
const helpers = {
    isOwner: (jid) => jidNormalizedUser(jid || "").startsWith(cfg.owner.number),

    reply: (conn, m, text) =>
        conn.sendMessage(m.key.remoteJid, { text }, { quoted: m }),

    sendImage: (conn, m, url, caption) =>
        conn.sendMessage(m.key.remoteJid, { image: { url }, caption }, { quoted: m }),

    async getText(m) {
        const msg = m.message;
        if (!msg) return "";
        return (
            msg.conversation ||
            msg.extendedTextMessage?.text ||
            msg.imageMessage?.caption ||
            msg.videoMessage?.caption ||
            ""
        ).trim();
    }
};

// ============================================================
//   AUTO LOADER
// ============================================================
const commands = new Map();
const COMMANDS_DIR = path.join(__dirname, "commands");

function loadCommands(dir = COMMANDS_DIR) {
    if (!fs.existsSync(dir)) {
        console.warn(`⚠️ No commands folder at ${dir}`);
        return;
    }

    const walk = (folder) => {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            const full = path.join(folder, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith(".js")) continue;

            try {
                delete require.cache[require.resolve(full)];
                const mod = require(full);
                const list = Array.isArray(mod) ? mod : [mod];

                for (const c of list) {
                    if (!c || typeof c !== "object" || !c.name || typeof c.run !== "function") {
                        console.warn(`⚠️ Skipping invalid command: ${full}`);
                        continue;
                    }
                    const names = Array.isArray(c.name) ? c.name : [c.name];
                    for (const n of names) {
                        const key = n.toLowerCase();
                        commands.set(key, {
                            ...c,
                            name: key,
                            category: c.category || path.basename(path.dirname(full)),
                            file: full
                        });
                    }
                }
            } catch (e) {
                console.error(`❌ Failed to load ${full}:`, e.message);
            }
        }
    };

    walk(dir);
    console.log(`✅ Loaded ${commands.size} command(s)`);
}

loadCommands();

// ============================================================
//   HANDLER
// ============================================================
module.exports = async function handler(conn, m, sessionId) {
    try {
        if (!m.message) return;
        if (m.key.fromMe) return;
        if (m.key.remoteJid === "status@broadcast") return;

        const text = await helpers.getText(m);
        if (!text.startsWith(cfg.prefix)) return;

        const parts = text.slice(cfg.prefix.length).trim().split(/\s+/);
        const name = parts.shift().toLowerCase();
        const args = parts;

        const found = commands.get(name);
        if (!found) return;

        if (found.owner && !helpers.isOwner(m.key.participant || m.key.remoteJid)) {
            return helpers.reply(conn, m, "❌ Owner only.");
        }

        const ctx = { conn, m, args, text, sessionId, cfg, commands, ...helpers };

        await Promise.resolve(found.run(ctx)).catch((e) => {
            console.error(`[${sessionId}] cmd "${name}" error:`, e);
            helpers.reply(conn, m, "❌ " + e.message).catch(() => {});
        });
    } catch (e) {
        console.error("handler error:", e);
    }
};

module.exports.commands = commands;
module.exports.reload = () => {
    commands.clear();
    loadCommands();
    return commands.size;
};