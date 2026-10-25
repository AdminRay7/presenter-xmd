require("dotenv").config();
const dns = require("dns");
dns.setServers(['8.8.8.8', '8.8.4.4']);

const makeWASocket = require("@whiskeysockets/baileys").default;
const { Browsers, makeCacheableSignalKeyStore, fetchLatestWaWebVersion } = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");
const { useMongoDBAuthState } = require("./lib/mongoAuthState"); 
const pino = require("pino");
const chalk = require("chalk");
const express = require("express");
const path = require("path");
const https = require("https");
const http = require("http");
const fs = require("fs");

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
    MAX_SESSIONS: 12
};

if (!WA.DB_URI) {
    console.error(chalk.red("❌ FATAL: MONGO_URI is missing from .env file!"));
    process.exit(1);
}

// ============================================================
//   GLOBAL STATE
// ============================================================
global.sessions = new Map();
global.mongoClient = null;
global.__bootLocks = new Map(); // Prevent double sockets

let pairingQueue = Promise.resolve();
function enqueuePairing(fn) {
    const next = pairingQueue.then(fn, fn);
    pairingQueue = next.catch(() => {});
    return next;
}

function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    return global.mongoClient.db(WA.DB_NAME).collection(WA.AUTH_COLLECTION);
}

// ============================================================
//   EMERGENCY SESSION CLEAR (For Heroku)
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
//   SOCKET BOOT
// ============================================================
async function bootSocket(sessionId, session) {
    if (global.__bootLocks.has(sessionId)) {
        return global.__bootLocks.get(sessionId);
    }

    const p = (async () => {
        session.id = sessionId;

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

        let version;
        try {
            ({ version } = await fetchLatestWaWebVersion());
        } catch (e) {
            version = [2, 3000, 1023223821]; // Fallback
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

                try {
                    const realPhone = conn.user?.id?.split(":")[0]?.split("@")[0] || null;
                    if (realPhone) {
                        const db = global.mongoClient.db(WA.DB_NAME);
                        await db.collection("SessionSettings").updateOne({ sessionId }, { $set: { phoneNumber: realPhone } }, { upsert: true });
                    }
                } catch (e) { console.error(`[${sessionId}] phone save error:`, e.message); }
            }

            if (connection === "close") {
                session.socketReady = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log(chalk.red(`❌ [${sessionId}] closed (${code})`));

                if (session._paused) return;

                if (code === 401) {
                    await logoutSession(sessionId);
                    return;
                }
                if (code === 440) {
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
                if (fs.existsSync("./handler.js")) {
                    require("./handler")(conn, m, sessionId);
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
                welcomed: false
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
            s.conn?.ev.removeAllListeners();
            s.conn?.ws?.close();
        } catch {}
        global.sessions.delete(sessionId);
    }
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
            welcomed: false
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
app.use(express.static(path.join(__dirname, 'public')));

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
        const db = global.mongoClient.db(WA.DB_NAME);
        const users = await db.collection("accounts").countDocuments();
        let active = 0;
        for (const [, s] of global.sessions) if (s.conn?.user) active++;
        res.json({ accounts: users, totalSessions: global.sessions.size, activeSessions: active });
    } catch {
        res.json({ accounts: 0, totalSessions: 0, activeSessions: 0 });
    }
});

app.post("/api/pair", async (req, res) => {
    const sessionId = String(req.body?.sessionId || "main").trim();
    const num = String(req.body?.num || "").replace(/\D/g, "");

    if (!num || num.length < 10 || num.length > 15) {
        return res.status(400).json({ error: "Invalid phone number" });
    }

    try {
        const code = await requestPairingCodeForSession(sessionId, num);

        const db = global.mongoClient.db(WA.DB_NAME);
        await db.collection('SessionSettings').updateOne(
            { sessionId },
            { $set: { phoneNumber: num, updatedAt: new Date() } },
            { upsert: true }
        );

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
        await checkEmergencyClear(); // Run emergency clear on boot
        await resumeAllSessions();
    } catch (e) {
        console.log(chalk.red(`[-] Failed to auto-start bot: ${e.message}`));
    }
});

// ============================================================
//   GRACEFUL SHUTDOWN & KEEP-ALIVE
// ============================================================
async function shutdown(signal) {
    console.log(chalk.yellow(`\n[!] ${signal} received, shutting down...`));
    server.close();
    for (const [, sess] of global.sessions) {
        try { sess.conn?.end(undefined); } catch {}
    }
    try { await global.mongoClient?.close(); } catch {}
    process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const appName = process.env.HEROKU_APP_NAME || "lastkey";
if (process.env.BASE_URL || process.env.HEROKU_APP_NAME) {
    const selfUrl = process.env.BASE_URL || `https://${appName}.herokuapp.com`;
    const client = selfUrl.startsWith('https:') ? https : http;

    setInterval(() => {
        const req = client.get(`${selfUrl}/health`, (res) => {
            res.on('data', () => {});
            res.on('end', () => {});
        });
        req.on('error', () => {});
        req.setTimeout(15000, () => req.destroy());
    }, 10 * 60 * 1000); 
}