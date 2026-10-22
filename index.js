"use strict";
require("dotenv").config();

const makeWASocket = require("@whiskeysockets/baileys").default;
const { Browsers, makeCacheableSignalKeyStore, fetchLatestWaWebVersion } = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");
const { useMongoDBAuthState } = require("./lib/mongo-auth");
const pino = require("pino");
const http = require("http");
const express = require("express");
const path = require("path");

const cfg = require("./lib/config");

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
        const client = new MongoClient(cfg.mongo.uri);
        await client.connect();
        global.mongoClient = client;
        console.log("✅ MongoDB (auth) connected");
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

    let version = [2, 3000, 1023223821];
    try {
        const v = await fetchLatestWaWebVersion();
        if (v?.version) version = v.version;
    } catch {}
    console.log(`[${sessionId}] WA version: ${JSON.stringify(version)}`);

    const conn = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
        },
        logger: pino({ level: "silent" }),
        browser: Browsers.macOS("Safari"),
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
            console.log(`🔌 [${sessionId}] socket ready`);
        }

        if (connection === "open") {
            session.socketReady = true;
            session.pairing = null;
            session.pairingNumber = null;
            console.log(`✅ [${sessionId}] connected as ${conn.user?.id}`);

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
            } catch (e) { console.error(`[${sessionId}] phone save error:`, e.message); }
        }

        if (connection === "close") {
            session.socketReady = false;
            session.pairing = null;
            session.pairingNumber = null;
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ [${sessionId}] closed (${code})`);

            if (session._paused) return;
            if (code === 401) { await logoutSession(sessionId); return; }
            if (code === 440) return;

            setTimeout(() => {
                if (!global.sessions.has(sessionId)) return;
                if (session._paused) return;
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
        } catch {
            await new Promise(r => setTimeout(r, 2000));
            code = await session.conn.requestPairingCode(phoneNumber);
        }

        const formatted = code.match(/.{1,4}/g)?.join("-") || code;
        session.pairing = formatted;
        session.pairingNumber = phoneNumber;
        console.log(`✅ [${sessionId}] pairing code: ${formatted}`);
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
    console.log(`🔄 Resuming ${metas.length} session(s)...`);

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

app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        bot: cfg.name,
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
    console.log("🛑 Shutting down...");
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
        console.log(`🌐 Dashboard: http://localhost:${cfg.server.port}`);
        console.log(`🤖 ${cfg.name} v${cfg.version} — ${cfg.tagline}`);
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