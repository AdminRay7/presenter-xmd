require("dotenv").config();
const dns = require("dns");
dns.setServers(['8.8.8.8', '8.8.4.4']);

// ============================================
//   Silence Baileys' known log spam
// ============================================
const _origConsoleError = console.error.bind(console);
const _SILENCED_PATTERNS = ['Bad MAC', 'Bad RSA', 'Session error:Error: Bad MAC', 'unpadRandomMax16'];
console.error = (...args) => {
    for (const arg of args) {
        if (typeof arg === 'string' && _SILENCED_PATTERNS.some(p => arg.includes(p))) return;
    }
    _origConsoleError(...args);
};

const makeWASocket = require("@whiskeysockets/baileys").default;
const { Browsers, makeCacheableSignalKeyStore, fetchLatestWaWebVersion, DisconnectReason } = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");
const { useMongoDBAuthState } = require("./lib/mongoAuthState");
const pino = require("pino");
const chalk = require("chalk");
const express = require("express");
const path = require("path");
const https = require("https");
const http = require("http");
const fs = require("fs");

// Try to load Mongoose (if you have database models)
let mongoose;
try {
    mongoose = require("mongoose");
    const { Account, SessionSettings, MessageLog, LiveEvent } = require("./database/models");
    global.models = { Account, SessionSettings, MessageLog, LiveEvent };
} catch (e) {
    console.log(chalk.yellow("⚠️ Mongoose or database models not found. Dashboard features limited."));
}

// Cache handler / presenter resolution once (avoids fs.existsSync per message)
let _messageHandler = null;
let _messageHandlerResolved = false;
function getMessageHandler() {
    if (_messageHandlerResolved) return _messageHandler;
    _messageHandlerResolved = true;
    try {
        if (fs.existsSync("./handler.js")) {
            _messageHandler = require("./handler");
        } else {
            _messageHandler = require("./presenter.js").presenter;
        }
    } catch (e) {
        console.error(chalk.red(`[-] Failed to load message handler: ${e.message}`));
        _messageHandler = null;
    }
    return _messageHandler;
}

// ============================================================
//   WHATSAPP CONNECTION STRINGS
// ============================================================
const WA = {
    DB_URI: process.env.MONGO_URI,
    DB_NAME: "xmd303",
    AUTH_COLLECTION: "authState",
    BROWSER: Browsers.macOS("Safari"),
    SOCKET_OPTIONS: {
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 60000,
        retryRequestDelayMs: 2000,
        fireInitQueries: false,
        emitOwnEvents: false
    },
    PAIRING_TIMEOUT_MS: 30000,
    RECONNECT_DELAY_MS: 5000,
    PAIR_COOLDOWN_MS: 60000,
    MAX_SESSIONS: 12
};

const FALLBACK_WA_VERSION = [2, 3000, 1023223821];

if (!WA.DB_URI) {
    console.error(chalk.red("❌ FATAL: MONGO_URI is missing from .env file!"));
    process.exit(1);
}

// ============================================================
//   GLOBAL STATE
// ============================================================
global.sessions = new Map();
global.mongoClient = null;
global.__bootLocks = new Map();
global.__pairCooldown = new Map();

let pairingQueue = Promise.resolve();
function enqueuePairing(fn) {
    const run = () => fn();
    const next = pairingQueue.then(run, run);
    pairingQueue = next.catch(() => {});
    return next;
}

function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toJid(input) {
    if (!input || typeof input !== "string") return null;
    if (input.includes("@")) return input;
    const digits = input.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) return null;
    return digits + "@s.whatsapp.net";
}

// ============================================================
//   MONGO INIT
// ============================================================
async function initMongo() {
    if (!global.mongoClient) {
        global.mongoClient = new MongoClient(WA.DB_URI, { serverSelectionTimeoutMS: 15000 });
        await global.mongoClient.connect();
        console.log(chalk.green("✅ MongoDB connected"));
    }

    if (mongoose && mongoose.connection.readyState === 0) {
        await mongoose.connect(WA.DB_URI, { dbName: WA.DB_NAME }).catch(e => console.error("Mongoose error:", e.message));
    }

    return global.mongoClient.db(WA.DB_NAME).collection(WA.AUTH_COLLECTION);
}

// ============================================================
//   EMERGENCY SESSION CLEAR
// ============================================================
async function checkEmergencyClear() {
    const sessionToClear = process.env.CLEAR_SESSION;
    if (sessionToClear) {
        console.log(chalk.yellow(`[!] EMERGENCY CLEAR: Removing session ${sessionToClear}`));
        try {
            const collection = await initMongo();
            const safeId = escapeRegex(sessionToClear);
            const res = await collection.deleteMany({ _id: { $regex: `^${safeId}:` } });
            console.log(chalk.green(`✅ Deleted ${res.deletedCount} documents for ${sessionToClear}`));
            console.log(chalk.yellow(`⚠️ REMINDER: Please remove CLEAR_SESSION from Heroku Config Vars!`));
        } catch (e) {
            console.error("Failed to clear session:", e.message);
        }
    }
}

// ============================================================
//   LIVE FEED CAPTURE
// ============================================================
const SKIP_CAPTURE_TYPES = new Set([
    "protocolMessage",
    "messageContextInfo",
    "reactionMessage",
    "senderKeyDistributionMessage"
]);

async function captureIncomingMedia(conn, msg, sessionId) {
    try {
        if (!global.models?.LiveEvent) return;

        const from = msg.key?.remoteJid;
        if (!from || from.endsWith("@newsletter")) return;

        let inner = msg.message || {};
        let guard = 0;
        while (guard++ < 5) {
            if (inner.ephemeralMessage?.message) { inner = inner.ephemeralMessage.message; continue; }
            if (inner.viewOnceMessage?.message)  { inner = inner.viewOnceMessage.message; continue; }
            if (inner.viewOnceMessageV2?.message) { inner = inner.viewOnceMessageV2.message; continue; }
            if (inner.editedMessage?.message)    { inner = inner.editedMessage.message; continue; }
            break;
        }

        // FIX: pick first non-infrastructure key instead of blindly [0]
        const type = Object.keys(inner).find(k => !SKIP_CAPTURE_TYPES.has(k));
        if (!type) return;

        let text = inner.conversation
            || inner.extendedTextMessage?.text
            || inner.imageMessage?.caption
            || inner.videoMessage?.caption
            || "";

        await global.models.LiveEvent.create({
            sessionId,
            type: "message",
            chatJid: from,
            senderJid: msg.key.participant || from,
            senderName: msg.pushName || from.split("@")[0],
            fromMe: false,
            text: text || `[${type}]`,
            timestamp: new Date()
        });
    } catch (e) {
        // Ignore capture errors to prevent crashes
    }
}

// ============================================================
//   SOCKET BOOT
// ============================================================
async function bootSocket(sessionId, session) {
    if (global.__bootLocks.has(sessionId)) {
        return global.__bootLocks.get(sessionId);
    }

    const p = (async () => {
        session.id = sessionId;
        if (session._paused === undefined) session._paused = false;

        if (session.conn) {
            try {
                session.conn.ev.removeAllListeners();
                session.conn.ws?.close();
            } catch {}
            session.conn = null;
            session.socketReady = false;
        }

        const collection = await initMongo();
        const { state, saveCreds } = await useMongoDBAuthState(collection, sessionId);

        // FIX: fetchLatestWaWebVersion returns array in 6.x, object in some builds
        let version = FALLBACK_WA_VERSION;
        try {
            const result = await fetchLatestWaWebVersion();
            const candidate = Array.isArray(result) ? result : result?.version;
            if (Array.isArray(candidate) && candidate.length >= 3) {
                version = candidate;
            }
        } catch {
            version = FALLBACK_WA_VERSION;
        }

        console.log(chalk.cyan(`[${sessionId}] WA version: ${JSON.stringify(version)}`));

        const conn = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
            },
            logger: pino({ level: "silent" }),
            browser: WA.BROWSER,
            ...WA.SOCKET_OPTIONS
        });

        session.conn = conn;
        conn.ev.on("creds.update", saveCreds);

        conn.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === "connecting") {
                session.socketReady = true;
                console.log(chalk.cyan(`🔌 [${sessionId}] socket ready`));
            }

            if (connection === "open") {
                session.socketReady = true;
                session.pairing = null;
                session.pairingNumber = null;
                console.log(chalk.green(`✅ [${sessionId}] connected as ${conn.user?.id}`));

                try {
                    await collection.updateOne(
                        { _id: `${sessionId}:meta` },
                        { $set: { value: { jid: conn.user?.id, linkedAt: Date.now() } } },
                        { upsert: true }
                    );
                } catch {}

                if (global.models?.SessionSettings) {
                    try {
                        const realPhone = conn.user?.id?.split(":")[0]?.split("@")[0] || null;
                        if (realPhone) {
                            await global.models.SessionSettings.updateOne(
                                { sessionId },
                                { $set: { phoneNumber: realPhone } },
                                { upsert: true }
                            );
                        }
                    } catch (e) {
                        console.error(`[${sessionId}] phone save error:`, e.message);
                    }
                }
            }

            if (connection === "close") {
                session.socketReady = false;
                session.pairing = null;
                session.pairingNumber = null;
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log(chalk.red(`❌ [${sessionId}] closed (${code})`));

                if (session._paused) return;

                if (code === 401 || code === 428 || code === DisconnectReason.loggedOut) {
                    console.log(chalk.red(`🛑 [${sessionId}] Blocked or logged out. Clearing session.`));
                    await logoutSession(sessionId);
                    return;
                }
                if (code === 440) {
                    console.log(chalk.yellow(`⚠️ [${sessionId}] Conflict (440) — another instance is using this session.`));
                    global.sessions.delete(sessionId);
                    return;
                }

                setTimeout(() => {
                    if (!global.sessions.has(sessionId)) return;
                    if (session._paused) return;
                    bootSocket(sessionId, session).catch(e => console.error(`Reconnect ${sessionId}:`, e.message));
                }, WA.RECONNECT_DELAY_MS);
            }
        });

        conn.ev.on("messages.upsert", async (m) => {
            try {
                // FIX: iterate all messages, not just [0]
                for (const msg of m.messages || []) {
                    if (!msg.key?.fromMe) {
                        await captureIncomingMedia(conn, msg, sessionId);
                    }
                }

                // FIX: cached handler lookup instead of fs.existsSync per message
                const handler = getMessageHandler();
                if (handler) {
                    await handler(conn, m, sessionId);
                }
            } catch (err) {
                console.error(`[${sessionId}] message error:`, err);
            }
        });

        return conn;
    })();

    global.__bootLocks.set(sessionId, p);
    p.finally(() => global.__bootLocks.delete(sessionId));
    return p;
}

// ============================================================
//   PAIRING CODE PATH
// ============================================================
async function requestPairingCodeForSession(sessionId, phoneNumber) {
    return enqueuePairing(async () => {
        await initMongo();

        let session = global.sessions.get(sessionId);
        if (session?.conn?.user) throw new Error("Session already paired");
        if (session?.pairing && session.pairingNumber === phoneNumber) return session.pairing;

        if (!session) {
            if (global.sessions.size >= WA.MAX_SESSIONS) {
                throw new Error(`Server at capacity (${WA.MAX_SESSIONS})`);
            }
            session = {
                conn: null,
                socketReady: false,
                pairing: null,
                pairingNumber: null,
                startedAt: Date.now(),
                welcomed: false,
                _paused: false
            };
            global.sessions.set(sessionId, session);
            await bootSocket(sessionId, session);
        } else if (!session.conn) {
            await bootSocket(sessionId, session);
        }

        const deadline = Date.now() + WA.PAIRING_TIMEOUT_MS;
        while (!session.socketReady && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 500));
        }
        if (!session.socketReady) throw new Error("Socket not ready, try again");

        let code;
        try {
            code = await session.conn.requestPairingCode(phoneNumber);
        } catch {
            await new Promise(r => setTimeout(r, 2000));
            code = await session.conn.requestPairingCode(phoneNumber);
        }

        const formatted = code.match(/.{1,4}/g)?.join("-") || code;
        session.pairing = formatted;
        session.pairingNumber = phoneNumber;
        console.log(chalk.green(`✅ [${sessionId}] pairing code: ${formatted}`));
        return formatted;
    });
}

// ============================================================
//   LOGOUT
// ============================================================
async function logoutSession(sessionId) {
    const s = global.sessions.get(sessionId);
    if (s) {
        try {
            s._paused = true;
            s.conn?.ev.removeAllListeners();
            s.conn?.ws?.close();
        } catch {}
        global.sessions.delete(sessionId);
    }
    // FIX: cleanup cooldown/bootlock maps
    global.__pairCooldown.delete(sessionId);
    global.__bootLocks.delete(sessionId);
    try {
        const collection = await initMongo();
        const safeId = escapeRegex(sessionId);
        await collection.deleteMany({ _id: { $regex: `^${safeId}:` } });
    } catch {}
}

// ============================================================
//   RESUME ALL SESSIONS
// ============================================================
async function resumeAllSessions() {
    const collection = await initMongo();
    const metas = await collection.find({ _id: { $regex: ":meta$" } }).toArray();
    console.log(chalk.cyan(`🔄 Resuming ${metas.length} session(s)...`));

    for (const meta of metas) {
        const sessionId = meta._id.replace(/:meta$/, "");
        if (global.sessions.has(sessionId)) continue;
        if (global.sessions.size >= WA.MAX_SESSIONS) break;

        const session = {
            conn: null,
            socketReady: false,
            pairing: null,
            pairingNumber: null,
            startedAt: Date.now(),
            welcomed: false,
            _paused: false
        };
        global.sessions.set(sessionId, session);
        try {
            await bootSocket(sessionId, session);
        } catch (e) {
            console.error(`Resume ${sessionId}:`, e.message);
        }
        await new Promise(r => setTimeout(r, 1500));
    }
}

// ============================================================
//   EXPRESS SERVER SETUP
// ============================================================
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use("/Assets", express.static(path.join(__dirname, "Assets")));

// Health Check
app.get("/health", (_req, res) => {
    res.json({ ok: true, sessions: global.sessions.size, uptime: process.uptime() });
});

app.get("/api/status", (_req, res) => {
    let active = 0;
    for (const [, s] of global.sessions) if (s.conn?.user) active++;
    res.json({ connected: active > 0, sessions: global.sessions.size, maxSessions: WA.MAX_SESSIONS });
});

app.get("/api/stats", async (_req, res) => {
    try {
        let users = 0;
        if (global.models?.Account) {
            users = await global.models.Account.countDocuments();
        }
        let active = 0;
        for (const [, s] of global.sessions) if (s.conn?.user) active++;
        res.json({ accounts: users, totalSessions: global.sessions.size, activeSessions: active });
    } catch (e) {
        console.error("stats error:", e.message);
        res.json({ accounts: 0, totalSessions: global.sessions.size, activeSessions: 0 });
    }
});

// FIX: rate-limit /pair using __pairCooldown
app.post(["/api/pair", "/pair"], async (req, res) => {
    const sessionId = String(req.body?.sessionId || "sess_" + Math.random().toString(36).slice(2, 8)).trim();
    const num = String(req.body?.num || "").replace(/\D/g, "");

    if (!num || num.length < 10 || num.length > 15) {
        return res.status(400).json({ error: "Invalid phone number" });
    }

    const now = Date.now();
    const last = global.__pairCooldown.get(num) || 0;
    if (now - last < WA.PAIR_COOLDOWN_MS) {
        const wait = Math.ceil((WA.PAIR_COOLDOWN_MS - (now - last)) / 1000);
        return res.status(429).json({ error: `Please wait ${wait}s before requesting another code` });
    }
    global.__pairCooldown.set(num, now);

    try {
        const code = await requestPairingCodeForSession(sessionId, num);

        if (global.models?.SessionSettings) {
            await global.models.SessionSettings.updateOne(
                { sessionId },
                { $set: { phoneNumber: num, updatedAt: new Date() } },
                { upsert: true }
            );
        }

        res.json({ success: true, sessionId, code });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
//   LAUNCH SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', async () => {
    console.log(chalk.cyan(`[+] Web Dashboard running on port ${PORT}`));

    try {
        await initMongo();
        await checkEmergencyClear();
        await resumeAllSessions();
    } catch (e) {
        console.log(chalk.red(`[-] Failed to auto-start bot: ${e.message}`));
    }
});

// ============================================================
//   GRACEFUL SHUTDOWN & KEEP-ALIVE
// ============================================================
const appName = process.env.HEROKU_APP_NAME || "lastkey";
let keepAliveInterval = null;

if (process.env.BASE_URL || process.env.HEROKU_APP_NAME) {
    const selfUrl = process.env.BASE_URL || `https://${appName}.herokuapp.com`;
    const client = selfUrl.startsWith('https:') ? https : http;

    keepAliveInterval = setInterval(() => {
        const req = client.get(`${selfUrl}/health`, (res) => {
            res.on('data', () => {});
            res.on('end', () => {});
        });
        req.on('error', () => {});
        req.setTimeout(15000, () => req.destroy());
    }, 10 * 60 * 1000);
}

async function shutdown(signal) {
    console.log(chalk.yellow(`\n[!] ${signal} received, shutting down...`));
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
    await new Promise(r => server.close(r));
    for (const [, sess] of global.sessions) {
        try { sess.conn?.end(undefined); } catch {}
    }
    try { await global.mongoClient?.close(); } catch {}
    if (mongoose) await mongoose.disconnect().catch(() => {});
    process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));