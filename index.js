"use strict";

// Load config and dependencies
require("dotenv").config();
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
//   SOCKET BOOT (Using exact logic from working bot)
// ============================================================
async function bootSocket(sessionId, session) {
    session.id = sessionId;

    const collection = await initMongo();
    const { state, saveCreds } = await useMongoDBAuthState(collection, sessionId);
    
    // Fetch version exactly like the working bot
    let version;
    try {
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
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
        },
        logger: pino({ level: "silent" }),
        // REVERTED TO SAFARI: The working bot uses Safari, which WhatsApp trusts more
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
        }

        if (connection === "close") {
            session.socketReady = false;
            session.pairing = null;
            session.pairingNumber = null;
            
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ [${sessionId}] ${fancy("closed")} (Code: ${code})`);

            if (session._paused) return;
            if (code === 401 || code === DisconnectReason.loggedOut) { 
                await logoutSession(sessionId); 
                return; 
            }
            if (code === 440) return;

            setTimeout(() => {
                if (!global.sessions.has(sessionId)) return;
                if (session._paused) return;
                bootSocket(sessionId, session).catch(e => console.error(`Reconnect ${sessionId}:`, e.message));
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

        if (!session) {
            session = {
                conn: null, socketReady: false, pairing: null, pairingNumber: null,
                startedAt: Date.now(), welcomed: false
            };
            global.sessions.set(sessionId, session);
            await bootSocket(sessionId, session);
        }

        // Wait for socket to be ready before pairing
        const deadline = Date.now() + 30000;
        while (!session.socketReady && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 500));
        }
        if (!session.socketReady) throw new Error("Socket not ready, try again");

        let code;
        try {
            code = await session.conn.requestPairingCode(phoneNumber);
        } catch (e) {
            await new Promise(r => setTimeout(r, 2000));
            code = await session.conn.requestPairingCode(phoneNumber);
        }

        const formatted = code.match(/.{1,4}/g)?.join("-") || code;
        session.pairing = formatted;
        session.pairingNumber = phoneNumber;
        
        // Write to session_settings so it shows up in MongoDB
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
        await collection.deleteMany({ _id: { $regex: `^${sessionId}:` } });
    } catch {}
}

async function resumeAllSessions() {
    try {
        const collection = await initMongo();
        const metas = await collection.find({ _id: { $regex: ":meta$" } }).toArray();
        console.log(`🔄 ${fancy("Resuming")} ${metas.length} ${fancy("session(s)")}...`);

        for (const meta of metas) {
            const sessionId = meta._id.replace(/:meta$/, "");
            if (global.sessions.has(sessionId)) continue;
            
            const session = {
                conn: null, socketReady: false, pairing: null, pairingNumber: null,
                startedAt: Date.now(), welcomed: false
            };
            global.sessions.set(sessionId, session);
            try { await bootSocket(sessionId, session); }
            catch (e) { console.error(`Resume ${sessionId}:`, e.message); }
            await new Promise(r => setTimeout(r, 1500));
        }
    } catch (e) { console.error("Resume error:", e.message); }
}

// ============================================================
//   EXPRESS DASHBOARD
// ============================================================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

app.get("/api/status", (req, res) => {
    const list = [...global.sessions.entries()].map(([id, s]) => ({
        id, paired: !!s.conn?.user, jid: s.conn?.user?.id || null
    }));
    res.json({ ok: true, sessions: list });
});

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