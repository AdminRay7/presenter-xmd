"use strict";

// Config loads dotenv internally
const cfg = require("./config");
const makeWASocket = require("@whiskeysockets/baileys").default;
const { Browsers, makeCacheableSignalKeyStore, fetchLatestWaWebVersion, DisconnectReason } = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");
const { useMongoDBAuthState } = require("./lib/mongo-auth");
const { fancy } = require("./lib/font");
const pino = require("pino");
const http = require("http");
const express = require("express");
const path = require("path");

// ============================================================
//   GLOBAL STATE
// ============================================================
global.sessions = new Map();
global.mongoClient = null;

// ============================================================
//   PAIRING QUEUE
// ============================================================
let pairingQueue = Promise.resolve();
function enqueuePairing(fn) {
    const next = pairingQueue.then(fn, fn);
    pairingQueue = next.catch(() => {});
    return next;
}

// ============================================================
//   MONGO (auth collection)
// ============================================================
let _mongoPromise = null;
function initMongo() {
    _mongoPromise ??= (async () => {
        if (!cfg.mongo.uri || typeof cfg.mongo.uri !== "string") {
            console.error(`\n❌ CRITICAL ERROR: MONGODB_URI is missing or invalid in your .env file!`);
            console.error(`Please make sure your .env file exists in the project root and contains:\nMONGODB_URI=mongodb://...\n`);
            process.exit(1);
        }

        const client = new MongoClient(cfg.mongo.uri);
        await client.connect();
        global.mongoClient = client;
        console.log(`✅ MongoDB (${fancy("auth")}) connected`);
        return client.db(cfg.mongo.db).collection(cfg.mongo.authCollection);
    })();
    return _mongoPromise;
}

// ============================================================
//   SOCKET BOOT
// ============================================================
async function bootSocket(sessionId, session) {
    session.id = sessionId;

    const collection = await initMongo();
    const { state, saveCreds } = await useMongoDBAuthState(collection, sessionId);

    // --- Force latest WhatsApp Web version ---
    let version;
    try {
        const v = await fetchLatestWaWebVersion();
        version = v.version;
        console.log(`[${sessionId}] ${fancy("WA version")}: ${JSON.stringify(version)}`);
    } catch (e) {
        console.error(`[${sessionId}] Failed to fetch latest version:`, e.message);
        throw new Error("Cannot fetch WA version");
    }

    const conn = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
        },
        logger: pino({ level: "silent" }),
        // Ubuntu/Chrome is better for cloud hosting like Heroku
        browser: Browsers.ubuntu("Chrome"), 
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 60000,
        retryRequestDelayMs: 2000,
        fireInitQueries: false,
        emitOwnEvents: false
    });

    session.conn = conn;
    conn.ev.on("creds.update", saveCreds);

    conn.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "connecting") {
            session.socketReady = true;
            console.log(`🔌 [${sessionId}] ${fancy("socket ready")}`);
        }

        if (connection === "open") {
            session.socketReady = true;
            session.pairing = null;
            session.pairingNumber = null;
            console.log(`✅ [${sessionId}] ${fancy("connected as")} ${conn.user?.id}`);

            try {
                await collection.updateOne(
                    { _id: `${sessionId}:meta` },
                    { $set: { value: { jid: conn.user?.id, linkedAt: Date.now() } } },
                    { upsert: true }
                );
            } catch {}

            try {
                const { SessionSettings } = require("./database/models");
                const realPhone = conn.user?.id?.split(":")[0]?.split("@")[0] || null;
                if (realPhone) {
                    await SessionSettings.updateOne(
                        { sessionId },
                        { $set: { phoneNumber: realPhone, jid: conn.user?.id, updatedAt: Date.now() } },
                        { upsert: true }
                    );
                }
            } catch (e) { console.error(`[${sessionId}] ${fancy("phone save error")}:`, e.message); }
        }

        if (connection === "close") {
            session.socketReady = false;
            session.pairing = null;
            session.pairingNumber = null;
            
            const code = lastDisconnect?.error?.output?.statusCode;
            const reason = Object.keys(DisconnectReason).find(key => DisconnectReason[key] === code) || "unknown";
            
            console.log(`❌ [${sessionId}] ${fancy("closed")} (Code: ${code} - ${reason})`);

            if (session._paused) return;
            if (code === DisconnectReason.loggedOut) { 
                console.log(`[${sessionId}] Logged out. Clearing DB...`);
                await logoutSession(sessionId); 
                return; 
            }
            if (code === DisconnectReason.connectionReplaced) return;

            setTimeout(() => {
                if (!global.sessions.has(sessionId)) return;
                if (session._paused) return;
                console.log(`🔄 [${sessionId}] Reconnecting...`);
                bootSocket(sessionId, session).catch(e =>
                    console.error(`Reconnect ${sessionId}:`, e.message));
            }, 5000);
        }
    });

    conn.ev.on("messages.upsert", (m) => {
        Promise.resolve()
            .then(() => require("./presenter")(conn, m, sessionId))
            .catch(err => console.error(`[${sessionId}] presenter:`, err));
    });

    return conn;
}

// ============================================================
//   PAIRING
// ============================================================
async function requestPairingCodeForSession(sessionId, phoneNumber) {
    return enqueuePairing(async () => {
        await initMongo();

        let session = global.sessions.get(sessionId);
        if (session?.conn?.user) throw new Error("Session already paired");
        if (session?.pairing && session.pairingNumber === phoneNumber) return session.pairing;

        if (!session) {
            if (global.sessions.size >= cfg.server.maxSessions) {
                throw new Error(`Server at capacity (${cfg.server.maxSessions})`);
            }
            session = {
                conn: null, socketReady: false, pairing: null, pairingNumber: null,
                startedAt: Date.now(), welcomed: false
            };
            global.sessions.set(sessionId, session);
            await bootSocket(sessionId, session);
        }

        const deadline = Date.now() + 30000;
        while (!session.socketReady && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 500));
        }
        if (!session.socketReady) throw new Error("Socket not ready, try again");

        let code;
        try {
            code = await session.conn.requestPairingCode(phoneNumber);
        } catch (e) {
            console.log(`⚠️ First pairing attempt failed (${e.message}). Retrying...`);
            await new Promise(r => setTimeout(r, 2000));
            code = await session.conn.requestPairingCode(phoneNumber);
        }

        const formatted = code.match(/.{1,4}/g)?.join("-") || code;
        session.pairing = formatted;
        session.pairingNumber = phoneNumber;
        console.log(`✅ [${sessionId}] ${fancy("pairing code")}: ${formatted}`);
        return formatted;
    });
}

// ============================================================
//   LOGOUT
// ============================================================
async function logoutSession(sessionId) {
    const s = global.sessions.get(sessionId);
    if (s) {
        try { s.conn?.ev.removeAllListeners(); s.conn?.ws?.close(); } catch {}
        global.sessions.delete(sessionId);
    }
    try {
        const collection = await initMongo();
        await collection.deleteMany({ _id: { $regex: `^${sessionId}:` } });
    } catch {}
}

// ============================================================
//   RESUME
// ============================================================
async function resumeAllSessions() {
    const collection = await initMongo();
    const metas = await collection.find({ _id: { $regex: ":meta$" } }).toArray();
    console.log(`🔄 ${fancy("Resuming")} ${metas.length} ${fancy("session(s)")}...`);

    for (const meta of metas) {
        const sessionId = meta._id.replace(/:meta$/, "");
        if (global.sessions.has(sessionId)) continue;
        if (global.sessions.size >= cfg.server.maxSessions) break;

        const session = {
            conn: null, socketReady: false, pairing: null, pairingNumber: null,
            startedAt: Date.now(), welcomed: false
        };
        global.sessions.set(sessionId, session);
        try { await bootSocket(sessionId, session); }
        catch (e) { console.error(`Resume ${sessionId}:`, e.message); }
        await new Promise(r => setTimeout(r, 1500));
    }
}

// ============================================================
//   EXPRESS DASHBOARD
// ============================================================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", async (_req, res) => {
    const { ping } = require("./database/models");
    res.json({
        ok: true,
        db: await ping(),
        bot: cfg.name,
        tagline: cfg.tagline,
        version: cfg.version,
        sessions: global.sessions.size,
        uptime: process.uptime()
    });
});

app.get("/sessions", (_req, res) => {
    const list = [...global.sessions.entries()].map(([id, s]) => ({
        id,
        paired: !!s.conn?.user,
        jid: s.conn?.user?.id || null,
        pairing: s.pairing || null,
        startedAt: s.startedAt
    }));
    res.json(list);
});

app.post("/pair", async (req, res) => {
    try {
        const { sessionId, phone } = req.body || {};
        if (!sessionId || !phone) return res.status(400).json({ error: "sessionId and phone required" });
        const code = await requestPairingCodeForSession(sessionId, String(phone).replace(/\D/g, ""));
        res.json({ ok: true, code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/logout/:sessionId", async (req, res) => {
    try {
        await logoutSession(req.params.sessionId);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================
//   GRACEFUL SHUTDOWN
// ============================================================
async function shutdown() {
    console.log(`🛑 ${fancy("Shutting down")}...`);
    for (const s of global.sessions.values()) {
        try { s.conn?.ws?.close(); } catch {}
    }
    try { await global.mongoClient?.close(); } catch {}
    try { await require("./database/models").closeDB(); } catch {}
    process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ============================================================
//   BOOT
// ============================================================
(async () => {
    await initMongo();
    await resumeAllSessions();

    http.createServer(app).listen(cfg.server.port, () => {
        console.log(`🌐 ${fancy("Dashboard")}: http://localhost:${cfg.server.port}`);
        console.log(`🤖 ${fancy(cfg.name)} v${cfg.version} — ${fancy(cfg.tagline)}`);
    });
})();

// ============================================================
//   EXPORTS
// ============================================================
module.exports = {
    bootSocket,
    requestPairingCodeForSession,
    logoutSession,
    resumeAllSessions,
    initMongo
};