"use strict";

require("dotenv").config();
const cfg = require("./config");
const makeWASocket = require("@whiskeysockets/baileys").default;
const { Browsers, makeCacheableSignalKeyStore, fetchLatestWaWebVersion, DisconnectReason } = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");
const { useMongoDBAuthState } = require("./lib/mongo-auth");
const { fancy } = require("./lib/font");
const { HttpsProxyAgent } = require("https-proxy-agent");
const pino = require("pino");
const http = require("http");
const express = require("express");
const path = require("path");

// ============================================================
//   PROXY CONFIG (OPTIONAL)
// ============================================================
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
let proxyAgent = null;
if (PROXY_URL) {
    proxyAgent = new HttpsProxyAgent(PROXY_URL);
    console.log(`🌐 Using Proxy: ${PROXY_URL.replace(/\/\/.*@/, "//***@")}`);
}

// ============================================================
//   GLOBAL STATE
// ============================================================
global.sessions = new Map();
global.mongoClient = null;

// ============================================================
//   HELPERS
// ============================================================
function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isValidSessionId(id) {
    return typeof id === "string" && id.length > 0 && id.length <= 64 && /^[\w-]+$/.test(id);
}

function maskJid(jid) {
    if (!jid) return "unknown";
    const [num, server] = jid.split("@");
    if (!num) return jid;
    const visible = num.slice(0, 4) + "***" + num.slice(-3);
    return `${visible}@${server || "s.whatsapp.net"}`;
}

// ============================================================
//   PER-SESSION LOCK
// ============================================================
const sessionLocks = new Map();
async function withSessionLock(sessionId, fn) {
    while (sessionLocks.get(sessionId)) {
        await sessionLocks.get(sessionId).catch(() => {});
    }
    let release;
    const gate = new Promise((r) => (release = r));
    sessionLocks.set(sessionId, gate);
    try {
        return await fn();
    } finally {
        sessionLocks.delete(sessionId);
        release();
    }
}

// ============================================================
//   MONGO
// ============================================================
let _mongoPromise = null;
function initMongo() {
    _mongoPromise ??= (async () => {
        if (!cfg.mongo.uri) throw new Error("MONGODB_URI missing");
        const client = new MongoClient(cfg.mongo.uri);
        await client.connect();
        global.mongoClient = client;
        console.log(`✅ MongoDB (${fancy("auth")}) connected`);
        return client.db(cfg.mongo.db).collection(cfg.mongo.authCollection);
    })();
    return _mongoPromise;
}

// ============================================================
//   WELCOME MESSAGE
// ============================================================
async function sendWelcomeMessage(sessionId, session, conn) {
    if (session.welcomed) return;
    try {
        const collection = await initMongo();
        const meta = await collection.findOne({ _id: `${sessionId}:meta` });
        if (meta?.value?.welcomed) {
            session.welcomed = true;
            return;
        }

        const jid = conn.user?.id;
        if (!jid) return;
        const userJid = jid.split(":")[0] + "@s.whatsapp.net";

        const text = `👋 *Welcome to ${cfg.name}!*\n\nHi there! I'm your personal assistant — I'm now connected to your WhatsApp account.\n\nType *!help* to see all available commands.`;

        await new Promise((r) => setTimeout(r, 1500));
        await conn.sendMessage(userJid, { text });

        await collection.updateOne(
            { _id: `${sessionId}:meta` },
            { $set: { "value.welcomed": true, "value.welcomedAt": Date.now() } },
            { upsert: true }
        );

        session.welcomed = true;
        console.log(`👋 [${sessionId}] ${fancy("welcome message sent")}`);
    } catch (e) {
        console.error(`[${sessionId}] welcome message failed:`, e.message);
    }
}

// ============================================================
//   SOCKET BOOT
// ============================================================
async function bootSocket(sessionId, session) {
    session.id = sessionId;

    const collection = await initMongo();
    const { state, saveCreds } = await useMongoDBAuthState(collection, sessionId);

    let version;
    try {
        // FIX 405: Use WaWebVersion
        const v = await fetchLatestWaWebVersion();
        version = v.version;
        console.log(`[${sessionId}] ${fancy("WA version")}: ${JSON.stringify(version)}`);
    } catch (e) {
        console.error(`[${sessionId}] Failed to fetch version:`, e.message);
        throw new Error("Cannot fetch WA version");
    }

    const conn = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu("Chrome"),
        agent: proxyAgent,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 60000,
        retryRequestDelayMs: 2000,
        fireInitQueries: true, 
        emitOwnEvents: false,
    });

    session.conn = conn;

    conn.ev.on("creds.update", () => {
        saveCreds().catch((e) => console.error(`[${sessionId}] saveCreds:`, e.message));
    });

    conn.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "connecting") {
            session.socketConnecting = true;
        }

        if (connection === "open") {
            session.socketReady = true;
            session.socketConnecting = false;
            session.pairing = null;
            session.pairingNumber = null;
            console.log(`✅ [${sessionId}] ${fancy("connected as")} ${maskJid(conn.user?.id)}`);

            try {
                await collection.updateOne(
                    { _id: `${sessionId}:meta` },
                    { $set: { "value.jid": conn.user?.id, "value.linkedAt": Date.now() } },
                    { upsert: true }
                );
            } catch {}

            sendWelcomeMessage(sessionId, session, conn).catch((e) =>
                console.error(`[${sessionId}] welcome:`, e.message)
            );
        }

        if (connection === "close") {
            session.socketReady = false;
            session.socketConnecting = false;
            session.pairing = null;
            session.pairingNumber = null;

            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ [${sessionId}] ${fancy("closed")} (Code: ${code})`);

            if (session._paused) return;

            if (code === 401 || code === DisconnectReason.loggedOut) {
                try { await logoutSession(sessionId); } catch {}
                return;
            }

            if (code === 440) return;

            setTimeout(() => {
                if (!global.sessions.has(sessionId)) return;
                if (session._paused) return;
                bootSocket(sessionId, session).catch((e) => console.error(`Reconnect ${sessionId}:`, e.message));
            }, 5000);
        }
    });

    conn.ev.on("messages.upsert", (m) => {
        Promise.resolve()
            .then(() => require("./presenter")(conn, m, sessionId))
            .catch((err) => console.error(`[${sessionId}] presenter:`, err));
    });

    return conn;
}

// ============================================================
//   PAIRING (QR EVENT TRIGGER)
// ============================================================
async function requestPairingCodeForSession(sessionId, phoneNumber) {
    if (!isValidSessionId(sessionId)) throw new Error("Invalid sessionId");

    return withSessionLock(sessionId, async () => {
        await initMongo();

        let session = global.sessions.get(sessionId);
        if (session?.conn?.user) throw new Error("Session already paired");

        if (!session) {
            session = {
                conn: null, socketReady: false, socketConnecting: false,
                pairing: null, pairingNumber: null, startedAt: Date.now(), welcomed: false,
            };
            global.sessions.set(sessionId, session);
            try {
                await bootSocket(sessionId, session);
            } catch (e) {
                global.sessions.delete(sessionId);
                throw e;
            }
        }

        // FIX: Wait for the 'qr' event to ensure Baileys is fully ready
        const code = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Socket timeout")), 25000);
            
            const onUpdate = async (update) => {
                if (update.qr) {
                    clearTimeout(timeout);
                    session.conn.ev.off('connection.update', onUpdate);
                    try {
                        const raw = await session.conn.requestPairingCode(phoneNumber);
                        resolve(raw);
                    } catch (e) { reject(e); }
                }
            };
            session.conn.ev.on('connection.update', onUpdate);
        });

        const formatted = code.match(/.{1,4}/g)?.join("-") || code;
        session.pairing = formatted;
        session.pairingNumber = phoneNumber;

        try {
            const { SessionSettings } = require("./database/models");
            await SessionSettings.updateOne(
                { sessionId },
                { $set: { phoneNumber, updatedAt: Date.now() } },
                { upsert: true }
            );
        } catch (e) {}

        console.log(`✅ [${sessionId}] ${fancy("pairing code")}: ${formatted}`);
        return formatted;
    });
}

// ============================================================
//   LOGOUT & RESUME
// ============================================================
async function logoutSession(sessionId) {
    const s = global.sessions.get(sessionId);
    if (s) {
        try { s.conn?.ev.removeAllListeners(); s.conn?.ws?.close(); } catch {}
        global.sessions.delete(sessionId);
    }
    try {
        const collection = await initMongo();
        const escaped = escapeRegex(sessionId);
        await collection.deleteMany({ _id: { $regex: `^${escaped}:` } });
    } catch (e) {
        console.error(`[${sessionId}] logout cleanup:`, e.message);
    }
}

async function resumeAllSessions() {
    try {
        const collection = await initMongo();
        const metas = await collection.find({ _id: { $regex: ":meta$" } }).toArray();
        console.log(`🔄 ${fancy("Resuming")} ${metas.length} ${fancy("session(s)")}...`);

        for (const meta of metas) {
            const sessionId = meta._id.replace(/:meta$/, "");
            if (!isValidSessionId(sessionId)) continue;
            if (global.sessions.has(sessionId)) continue;

            const session = {
                conn: null, socketReady: false, socketConnecting: false,
                pairing: null, pairingNumber: null, startedAt: Date.now(),
                welcomed: !!meta?.value?.welcomed,
            };
            global.sessions.set(sessionId, session);
            try {
                await bootSocket(sessionId, session);
            } catch (e) {
                global.sessions.delete(sessionId);
                console.error(`Resume ${sessionId}:`, e.message);
            }
            await new Promise((r) => setTimeout(r, 1500));
        }
    } catch (e) {
        console.error("Resume error:", e.message);
    }
}

// ============================================================
//   EXPRESS DASHBOARD & API
// ============================================================
const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.post("/pair", async (req, res) => {
    try {
        const { sessionId, phone } = req.body || {};
        if (!isValidSessionId(sessionId)) {
            return res.status(400).json({ error: "invalid sessionId" });
        }
        const digits = String(phone || "").replace(/\D/g, "");
        if (digits.length < 7 || digits.length > 15) {
            return res.status(400).json({ error: "invalid phone number" });
        }

        // FIX: Run in background to prevent Heroku H12 Timeout
        requestPairingCodeForSession(sessionId, digits)
            .catch(err => console.error(`[${sessionId}] Pairing failed:`, err.message));

        res.json({ ok: true, message: "Generating code..." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/logout", async (req, res) => {
    try {
        const { sessionId } = req.body || {};
        if (!isValidSessionId(sessionId)) {
            return res.status(400).json({ error: "invalid sessionId" });
        }
        await logoutSession(sessionId);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/status", (req, res) => {
    const list = [...global.sessions.entries()].map(([id, s]) => ({
        id,
        paired: !!s.conn?.user,
        jid: s.conn?.user?.id || null,
        pairing: s.pairing || null,
        welcomed: !!s.welcomed,
    }));
    res.json({ ok: true, sessions: list });
});

// ============================================================
//   GRACEFUL SHUTDOWN
// ============================================================
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n🛑 ${signal} received — shutting down...`);

    for (const [id, s] of global.sessions) {
        try {
            s._paused = true;
            s.conn?.ev.removeAllListeners();
            s.conn?.ws?.close();
            console.log(`  closed ${id}`);
        } catch {}
    }
    global.sessions.clear();

    try {
        await global.mongoClient?.close();
        console.log("  mongo closed");
    } catch {}

    process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (err) => {
    console.error("unhandledRejection:", err?.message || err);
});
process.on("uncaughtException", (err) => {
    console.error("uncaughtException:", err?.message || err);
});

// ============================================================
//   BOOT
// ============================================================
(async () => {
    try {
        await initMongo();
        await resumeAllSessions();

        http.createServer(app).listen(cfg.server.port, () => {
            console.log(`🌐 ${fancy("Dashboard")}: http://localhost:${cfg.server.port}`);
            console.log(`🤖 ${fancy(cfg.name)} v${cfg.version} — ${fancy(cfg.tagline)}`);
        });
    } catch (e) {
        console.error("❌ Boot failed:", e.message);
        process.exit(1);
    }
})();