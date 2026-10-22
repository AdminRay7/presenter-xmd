"use strict";

const { MongoClient } = require("mongodb");
const cfg = require("../config");
const { fancy } = require("../lib/font");

// ============================================================
//   CONNECTION
// ============================================================
let _client = null;
let _db = null;
let _promise = null;

async function getDB() {
    if (_db) return _db;
    _promise ??= (async () => {
        _client = new MongoClient(cfg.mongo.uri);
        await _client.connect();
        _db = _client.db(cfg.mongo.db);

        // --- indexes (idempotent) ---
        try {
            await _db.collection("session_settings").createIndex({ sessionId: 1 }, { unique: true });
            await _db.collection("session_settings").createIndex({ phoneNumber: 1 });
            await _db.collection("session_settings").createIndex({ jid: 1 });

            await _db.collection("group_settings").createIndex({ groupJid: 1 }, { unique: true });

            await _db.collection("users").createIndex({ jid: 1 }, { unique: true });

            await _db.collection("payments").createIndex({ reference: 1 }, { unique: true });
            await _db.collection("payments").createIndex({ userJid: 1 });
            await _db.collection("payments").createIndex({ createdAt: -1 });

            await _db.collection("stats").createIndex({ key: 1 }, { unique: true });
        } catch (e) {
            console.error(`⚠️ ${fancy("index creation")}:`, e.message);
        }

        console.log(`✅ MongoDB (${fancy("models")}) connected`);
        return _db;
    })();
    return _promise;
}

async function getCollection(name) {
    const db = await getDB();
    return db.collection(name);
}

// ============================================================
//   SESSION SETTINGS
// ============================================================
const SessionSettings = {
    async updateOne(filter, update, opts) {
        return (await getCollection("session_settings")).updateOne(filter, update, opts);
    },
    async findOne(filter) {
        return (await getCollection("session_settings")).findOne(filter);
    },
    async find(filter = {}, opts = {}) {
        return (await getCollection("session_settings")).find(filter, opts).toArray();
    },
    async deleteOne(filter) {
        return (await getCollection("session_settings")).deleteOne(filter);
    },
    async deleteMany(filter) {
        return (await getCollection("session_settings")).deleteMany(filter);
    },
    async count(filter = {}) {
        return (await getCollection("session_settings")).countDocuments(filter);
    }
};

// ============================================================
//   GROUP SETTINGS
// ============================================================
const GroupSettings = {
    async updateOne(filter, update, opts) {
        return (await getCollection("group_settings")).updateOne(filter, update, opts);
    },
    async findOne(filter) {
        return (await getCollection("group_settings")).findOne(filter);
    },
    async find(filter = {}) {
        return (await getCollection("group_settings")).find(filter).toArray();
    },
    async deleteOne(filter) {
        return (await getCollection("group_settings")).deleteOne(filter);
    },
    async count(filter = {}) {
        return (await getCollection("group_settings")).countDocuments(filter);
    }
};

// ============================================================
//   USERS
// ============================================================
const Users = {
    async updateOne(filter, update, opts) {
        return (await getCollection("users")).updateOne(filter, update, opts);
    },
    async findOne(filter) {
        return (await getCollection("users")).findOne(filter);
    },
    async find(filter = {}) {
        return (await getCollection("users")).find(filter).toArray();
    },
    async deleteOne(filter) {
        return (await getCollection("users")).deleteOne(filter);
    },
    async count(filter = {}) {
        return (await getCollection("users")).countDocuments(filter);
    }
};

// ============================================================
//   PAYMENTS (Paystack / Stripe)
// ============================================================
const Payments = {
    async create(doc) {
        return (await getCollection("payments")).insertOne({
            ...doc,
            createdAt: doc.createdAt || Date.now()
        });
    },
    async updateOne(filter, update, opts) {
        return (await getCollection("payments")).updateOne(filter, update, opts);
    },
    async findOne(filter) {
        return (await getCollection("payments")).findOne(filter);
    },
    async find(filter = {}) {
        return (await getCollection("payments")).find(filter).sort({ createdAt: -1 }).toArray();
    },
    async count(filter = {}) {
        return (await getCollection("payments")).countDocuments(filter);
    }
};

// ============================================================
//   STATS (simple counter store)
// ============================================================
const Stats = {
    async increment(key, by = 1) {
        return (await getCollection("stats")).updateOne(
            { key },
            { $inc: { value: by }, $set: { updatedAt: Date.now() } },
            { upsert: true }
        );
    },
    async get(key) {
        const doc = await (await getCollection("stats")).findOne({ key });
        return doc?.value || 0;
    },
    async all() {
        return (await getCollection("stats")).find({}).toArray();
    }
};

// ============================================================
//   HEALTH / UTILITY
// ============================================================
async function ping() {
    try {
        const db = await getDB();
        await db.command({ ping: 1 });
        return true;
    } catch {
        return false;
    }
}

async function stats() {
    const [sessions, groups, users, payments] = await Promise.all([
        SessionSettings.count(),
        GroupSettings.count(),
        Users.count(),
        Payments.count()
    ]);
    return { sessions, groups, users, payments };
}

async function closeDB() {
    if (_client) await _client.close();
    _client = null;
    _db = null;
    _promise = null;
}

// ============================================================
//   EXPORTS
// ============================================================
module.exports = {
    getDB,
    getCollection,
    SessionSettings,
    GroupSettings,
    Users,
    Payments,
    Stats,
    ping,
    stats,
    closeDB
};