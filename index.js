require("dotenv").config();
const dns = require("dns");
// Use a private resolver so we don't rewrite DNS for Mongo SRV / outbound HTTP.
const resolver = new dns.promises.Resolver();
resolver.setServers(['8.8.8.8', '8.8.4.4']);

// ============================================
//   Silence Baileys' known log spam (but keep it visible at debug level)
// ============================================
const _origConsoleError = console.error.bind(console);
const _origConsoleDebug = console.debug ? console.debug.bind(console) : console.log.bind(console);
const _SILENCED_PATTERNS = ['Bad MAC', 'Bad RSA', 'Session error:Error: Bad MAC', 'unpadRandomMax16'];
console.error = (...args) => {
    if (typeof args[0] === 'string' && _SILENCED_PATTERNS.some(p => args[0].includes(p))) {
        if (process.env.DEBUG_SILENCED) _origConsoleDebug(...args);
        return;
    }
    _origConsoleError(...args);
};

// ============================================
//   Crash protection — do not let one bad message kill the process
// ============================================
process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection]', err?.stack || err);
});
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err?.stack || err);
});

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

// Optional Mongoose models
let mongoose;
try {
    mongoose = require("mongoose");
    const { Account, SessionSettings, MessageLog, LiveEvent } = require("./database/models");
    global.models = { Account, SessionSettings, MessageLog, LiveEvent };
} catch (e) {
    console.log(chalk.yellow("⚠️ Mongoose or database models not found. Dashboard features limited."));
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
    PAIRING_POLL_MS: 300,
    PAIRING_COOLDOWN_MS: 15000,
    RECONNECT_DELAY_MS: 5000,
    RECONNECT_MAX_DELAY_MS: 60000,
    MAX_SESSIONS: 12,
    SESSION_ID_REGEX: /^[a-zA-Z0-9_-]{1,64}$/
};

if (!WA.DB_URI) {
    console.error(chalk.red("❌ FATAL: MONGO_URI is missing from .env file!"));
    process.exit(1);
}

// ============================================================
//   GLOBAL STATE
// ============================================================
global.sessions = new Map();          // sessionId -> session
global.mongoClient = null;
global.__bootLocks = new Map();       // sessionId -> Promise
global.__pairCooldown = new Map();    // phoneNumber -> timestamp

// ============================================================
//   HELPERS
// ============================================================
function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isValidSessionId(id) {
    return typeof id === 'string' && WA.SESSION_ID_REGEX.test(id);
}

function toJid(input) {
    if (!input || typeof input !== "string") return null;
    if (input.includes("@")) return input;
    const digits = input.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) return null;
    return digits + "@s.whatsapp.net";
}

// Serialize pairing requests so two phones can't race each other.
let pairingQueue = Promise.resolve();
function enqueuePairing(fn) {
    const next = pairingQueue.then(() => fn(), () => fn());
    pairingQueue = next.catch(() => {});
    return next;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================
//   MONGO INIT
// ============================================================
let _mongoInitPromise = null;
async function initMongo() {
    if (!_mongoInitPromise) {
        _mongoInitPromise = (async () => {
            if (!global.mongoClient) {
                global.mongoClient = new MongoClient(WA.DB_URI, { serverSelectionTimeoutMS: 15000 });
                await global.mongoClient.connect();
                console.log(chalk.green("✅ MongoDB connected"));
            }
            if (mongoose && mongoose.connection.readyState === 0) {
                await mongoose.connect(WA.DB_URI, { dbName: WA.DB_NAME })
                    .catch(e => console.error("Mongoose error:", e.message));
            }
            return global.mongoClient.db(WA.DB_NAME).collection(WA.AUTH_COLLECTION);
        })().catch(e => { _mongoInitPromise = null; throw e; });
    }
    return _mongoInitPromise;
}

function authCollection() {
    return global.mongoClient.db(WA.DB_NAME).collection(WA.AUTH_COLLECTION);
}

// ============================================================
//   EMERGENCY SESSION CLEAR
// ============================================================
async function checkEmergencyClear() {
    const sessionToClear = process.env.CLEAR_SESSION;
    if (!sessionToClear) return;

    console.log(chalk.yellow(`[!] EMERGENCY CLEAR: Removing session ${sessionToClear}`));
    try {
        // Stop any live socket FIRST so the reconnect loop can't recreate creds.
        const live = global.sessions.get(sessionToClear);
        if (live) {
            live._paused = true;
            try { live.conn?.ev.removeAllListeners(); } catch {}
            try { live.conn?.ws?.close(); } catch {}
            try { live.conn?.end(undefined); } catch {}
            global.sessions.delete(sessionToClear);
        }

        await initMongo();
        const safeId = escapeRegex(sessionToClear);
        const res = await authCollection().deleteMany({ _id: { $regex: `^${safeId}:` } });
        console.log(chalk.green(`✅ Deleted ${res.deletedCount} documents for ${sessionToClear}`));
        console.log(chalk.yellow(`⚠️ REMINDER: Please remove CLEAR_SESSION from config vars!`));
    } catch (e) {
        console.error("Failed to clear session:", e.message);
    }
}

// ============================================================
//   LIVE FEED CAPTURE
// ============================================================
async function captureIncomingMedia(conn, msg, sessionId) {
    try {
        if (!global.models?.LiveEvent) return;
        if (!msg?.key) return;

        const from = msg.key.remoteJid;
        if (!from) return;
        if (from.endsWith("@newsletter") || from === "status@broadcast") return;

        let inner = msg.message || {};
        let guard = 0;
        while (guard++ < 5) {
            if (inner.ephemeralMessage?.message) { inner = inner.ephemeralMessage.message; continue; }
            if (inner.viewOnceMessage?.message)  { inner = inner.viewOnceMessage.message; continue; }
            if (inner.viewOnceMessageV2?.message) { inner = inner.viewOnceMessageV2.message; continue; }
            if (inner.editedMessage?.message)    { inner = inner.editedMessage.message; continue; }
            break;
        }

        const type = Object.keys(inner)[0];
        if (!type) return;
        if (["protocolMessage", "messageContextInfo", "reactionMessage"].includes(type)) return;

        const text = inner.conversation
            || inner.extendedTextMessage?.text
            || inner.imageMessage?.caption
            || inner.videoMessage?.caption
            || "";

        await global.models.LiveEvent.create({
            sessionId,
            type: "message",
            chatJid: from,
            senderJid: msg.key.participant || from,
            senderName: msg.pushName || String(from).split("@")[0],
            fromMe: false,
            text: text || `[${type}]`,
            timestamp: new Date()
        });
    } catch (e) {
        // Ignore capture errors — never crash the socket over the dashboard.
    }
}

// ============================================================
//   SAFE SESSION TEARDOWN
// ============================================================
function teardownSocket(session) {
    if (!session) return;
    session.socketReady = false;
    session.connecting = false;
    try { session.conn?.ev.removeAllListeners(); } catch {}
    try { session.conn?.ws?.close(); } catch {}
    try { session.conn?.end(undefined); } catch {}
    session.conn = null;
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

        // Clear any previous socket without killing the session object.
        if (session.conn) teardownSocket(session);

        const collection = await initMongo();
        const { state, saveCreds } = await useMongoDBAuthState(collection, sessionId);

        let version;
        try {
            ({ version } = await fetchLatestWaWebVersion());
        } catch (e) {
            version = null;
        }
        if (!Array.isArray(version) || version.length !== 3) {
            // Known-good recent fallback. Update when Baileys adds newer versions.
            version = [2, 3000, 1023223821];
            console.warn(chalk.yellow(`[${sessionId}] using fallback WA version ${JSON.stringify(version)}`));
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
        session.connecting = true;
        conn.ev.on("creds.update", saveCreds);

        conn.ev.on("connection.update", async (update) => {
            try {
                const { connection, lastDisconnect } = update;

                if (connection === "connecting") {
                    session.connecting = true;
                    console.log(chalk.cyan(`🔌 [${sessionId}] connecting...`));
                }

                if (connection === "open") {
                    session.socketReady = true;
                    session.connecting = false;
                    session.pairing = null;
                    session.pairingNumber = null;
                    session.reconnectAttempts = 0;
                    console.log(chalk.green(`✅ [${sessionId}] connected as ${conn.user?.id}`));

                    try {
                        await collection.updateOne(
                            { _id: `${sessionId}:meta` },
                            { $set: { value: { jid: conn.user?.id, linkedAt: Date.now() } } },
                            { upsert: true }
                        );
                    } catch (e) {
                        console.error(`[${sessionId}] meta save error:`, e.message);
                    }

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
                    session.connecting = false;
                    const code = lastDisconnect?.error?.output?.statusCode;
                    console.log(chalk.red(`❌ [${sessionId}] closed (${code})`));

                    if (session._paused) {
                        teardownSocket(session);
                        return;
                    }

                    // Logged out / banned / IP-blocked → wipe creds.
                    if (code === 401 || code === 428 || code === DisconnectReason.loggedOut) {
                        console.log(chalk.red(`🛑 [${sessionId}] Blocked or logged out. Clearing session.`));
                        session._paused = true;
                        teardownSocket(session);
                        await logoutSession(sessionId);
                        return;
                    }

                    // Replaced by another session / connection.
                    if (code === 440) {
                        global.sessions.delete(sessionId);
                        teardownSocket(session);
                        return;
                    }

                    // Exponential backoff.
                    const attempts = (session.reconnectAttempts = (session.reconnectAttempts || 0) + 1);
                    const delay = Math.min(
                        WA.RECONNECT_DELAY_MS * Math.pow(2, attempts - 1),
                        WA.RECONNECT_MAX_DELAY_MS
                    );
                    console.log(chalk.yellow(`⏳ [${sessionId}] reconnecting in ${delay}ms (attempt ${attempts})`));

                    session.reconnectTimer = setTimeout(() => {
                        session.reconnectTimer = null;
                        if (!global.sessions.has(sessionId)) return;
                        if (session._paused) return;
                        bootSocket(sessionId, session).catch(e =>
                            console.error(`Reconnect ${sessionId}:`, e.message)
                        );
                    }, delay);
                }
            } catch (e) {
                console.error(`[${sessionId}] connection.update handler error:`, e);
            }
        });

        conn.ev.on("messages.upsert", async (m) => {
            try {
                const first = m?.messages?.[0];
                if (first && !first.key?.fromMe) {
                    // Do not await: dashboard capture must not block command handling.
                    captureIncomingMedia(conn, first, sessionId).catch(() => {});
                }

                if (fs.existsSync("./handler.js")) {
                    await require("./handler")(conn, m, sessionId);
                } else {
                    const { presenter } = require("./presenter.js");
                    await presenter(conn, m);
                }
            } catch (err) {
                console.error(`[${sessionId}] message error:`, err);
            }
        });

        return conn;
    })();

    global.__bootLocks.set(sessionId, p);
    // Attach cleanup without creating an unhandled rejection.
    p.catch(() => {}).finally(() => global.__bootLocks.delete(sessionId));
    return p;
}

// ============================================================
//   PAIRING CODE PATH
// ============================================================
async function requestPairingCodeForSession(sessionId, phoneNumber) {
    if (!isValidSessionId(sessionId)) {
        throw new Error("Invalid sessionId (a-z, A-Z, 0-9, _ and - only, max 64 chars)");
    }
    if (!phoneNumber || typeof phoneNumber !== "string" || phoneNumber.length < 10 || phoneNumber.length > 15) {
        throw new Error("Invalid phone number");
    }

    // Per-number cooldown to prevent spamming WA servers.
    const last = global.__pairCooldown.get(phoneNumber) || 0;
    if (Date.now() - last < WA.PAIRING_COOLDOWN_MS) {
        const wait = Math.ceil((WA.PAIRING_COOLDOWN_MS - (Date.now() - last)) / 1000);
        throw new Error(`Please wait ${wait}s before requesting another code for this number`);
    }

    return enqueuePairing(async () => {
        await initMongo();

        let session = global.sessions.get(sessionId);
        if (session?.conn?.user) throw new Error("Session already paired");

        if (!session) {
            if (global.sessions.size >= WA.MAX_SESSIONS) {
                throw new Error(`Server at capacity (${WA.MAX_SESSIONS})`);
            }
            session = {
                conn: null,
                socketReady: false,
                connecting: false,
                pairing: null,
                pairingNumber: null,
                startedAt: Date.now(),
                welcomed: false,
                _paused: false
            };
            global.sessions.set(sessionId, session);
            await bootSocket(sessionId, session);
        } else if (!session.conn) {
            session._paused = false;
            await bootSocket(sessionId, session);
        } else if (session.pairing && session.pairingNumber === phoneNumber) {
            // Return cached code only if the socket is genuinely still alive.
            return session.pairing;
        }

        // Wait for *connecting* to flip false; we specifically need an active WS
        // so that requestPairingCode doesn't throw "Connection Closed".
        const deadline = Date.now() + WA.PAIRING_TIMEOUT_MS;
        while ((!session.conn || (session.connecting && !session.socketReady)) && Date.now() < deadline) {
            if (!global.sessions.has(sessionId)) throw new Error("Session closed");
            await sleep(WA.PAIRING_POLL_MS);
        }
        if (!session.conn || (session.connecting && !session.socketReady)) {
            throw new Error("Socket not ready, try again in a few seconds");
        }

        let code;
        try {
            code = await session.conn.requestPairingCode(phoneNumber);
        } catch (firstErr) {
            // One retry — some WASocket variants throw on transient init races.
            await sleep(2000);
            try {
                code = await session.conn.requestPairingCode(phoneNumber);
            } catch (secondErr) {
                throw new Error(`Pairing failed: ${secondErr.message || firstErr.message}`);
            }
        }

        const formatted = String(code).match(/.{1,4}/g)?.join("-") || code;
        session.pairing = formatted;
        session.pairingNumber = phoneNumber;
        global.__pairCooldown.set(phoneNumber, Date.now());
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
        s._paused = true;
        if (s.reconnectTimer) {
            clearTimeout(s.reconnectTimer);
            s.reconnectTimer = null;
        }
        teardownSocket(s);
        global.sessions.delete(sessionId);
    }
    try {
        await initMongo();
        const safeId = escapeRegex(sessionId);
        await authCollection().deleteMany({ _id: { $regex: `^${safeId}:` } });
    } catch (e) {
        console.error(`[${sessionId}] logout cleanup error:`, e.message);
    }
}

// ============================================================
//   RESUME ALL SESSIONS
// ============================================================
async function resumeAllSessions() {
    const collection = await initMongo();
    const metas = await collection.find({ _id: { $regex: ":meta$" } }).toArray();
    console.log(chalk.cyan(`🔄 Resuming ${metas.length} session(s)...`));

    for (const meta of metas) {
        const sessionId = String(meta._id).replace(/:meta$/, "");
        if (!isValidSessionId(sessionId)) continue;
        if (global.sessions.has(sessionId)) continue;
        if (global.sessions.size >= WA.MAX_SESSIONS) {
            console.warn(chalk.yellow(`⚠️ Skipping ${sessionId}: max sessions (${WA.MAX_SESSIONS}) reached`));
            continue;
        }

        const session = {
            conn: null,
            socketReady: false,
            connecting: false,
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
        await sleep(1500);
    }
}

// ============================================================
//   EXPRESS SERVER SETUP
// ============================================================
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// --- API routes BEFORE static so a file named `health` can't shadow them.
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
        if (global.models?.Account) users = await global.models.Account.countDocuments();
        let active = 0;
        for (const [, s] of global.sessions) if (s.conn?.user) active++;
        res.json({ accounts: users, totalSessions: global.sessions.size, activeSessions: active });
    } catch {
        res.json({ accounts: 0, totalSessions: 0, activeSessions: 0 });
    }
});

// Shared-secret middleware for pairing (set PAIR_SECRET in env to enable).
function requirePairSecret(req, res, next) {
    const expected = process.env.PAIR_SECRET;
    if (!expected) return next(); // Not configured → open (documented risk).
    const provided = req.headers["x-pair-secret"] || req.body?.secret;
    if (provided !== expected) return res.status(401).json({ error: "Unauthorized" });
    next();
}

app.post(["/api/pair", "/pair"], requirePairSecret, async (req, res) => {
    const rawSessionId = req.body?.sessionId;
    const sessionId = rawSessionId
        ? String(rawSessionId).trim()
        : "sess_" + Math.random().toString(36).slice(2, 10);

    if (!isValidSessionId(sessionId)) {
        return res.status(400).json({ error: "Invalid sessionId" });
    }

    const num = String(req.body?.num || "").replace(/\D/g, "");
    if (!num || num.length < 10 || num.length > 15) {
        return res.status(400).json({ error: "Invalid phone number" });
    }

    try {
        const code = await requestPairingCodeForSession(sessionId, num);

        if (global.models?.SessionSettings) {
            await global.models.SessionSettings.updateOne(
                { sessionId },
                { $set: { phoneNumber: num, updatedAt: new Date() } },
                { upsert: true }
            ).catch(e => console.error(`[${sessionId}] SessionSettings save error:`, e.message));
        }

        res.json({ success: true, sessionId, code });
    } catch (error) {
        console.error(`[pair:${sessionId}]`, error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post(["/api/logout", "/logout"], requirePairSecret, async (req, res) => {
    const sessionId = String(req.body?.sessionId || "").trim();
    if (!isValidSessionId(sessionId)) {
        return res.status(400).json({ error: "Invalid sessionId" });
    }
    try {
        await logoutSession(sessionId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Static AFTER API.
app.use(express.static(path.join(__dirname, "public")));
app.use("/Assets", express.static(path.join(__dirname, "Assets")));

// ============================================================
//   LAUNCH SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, "0.0.0.0", async () => {
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
let keepAliveTimer = null;
let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(chalk.yellow(`\n[!] ${signal} received, shutting down...`));

    if (keepAliveTimer) clearInterval(keepAliveTimer);
    try { server.close(); } catch {}

    for (const [, sess] of global.sessions) {
        sess._paused = true;
        if (sess.reconnectTimer) clearTimeout(sess.reconnectTimer);
        teardownSocket(sess);
    }
    global.sessions.clear();

    try { await global.mongoClient?.close(); } catch {}
    if (mongoose) await mongoose.disconnect().catch(() => {});

    process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Keep-alive ping (only when BASE_URL / HEROKU_APP_NAME is configured).
if (process.env.BASE_URL || process.env.HEROKU_APP_NAME) {
    const appName = process.env.HEROKU_APP_NAME || "lastkey";
    const selfUrl = process.env.BASE_URL || `https://${appName}.herokuapp.com`;
    const client = selfUrl.startsWith("https:") ? https : http;

    keepAliveTimer = setInterval(() => {
        const req = client.get(`${selfUrl}/health`, (res) => {
            res.on("data", () => {});
            res.on("end", () => {});
        });
        req.on("error", () => {});
        req.setTimeout(15000, () => req.destroy());
    }, 10 * 60 * 1000);
}