"use strict";

const { MongoClient } = require("mongodb");
const cfg = require("../lib/config");

let _client = null;
let _db = null;
let _promise = null;

async function getDB() {
    if (_db) return _db;
    _promise ??= (async () => {
        _client = new MongoClient(cfg.mongo.uri);
        await _client.connect();
        _db = _client.db(cfg.mongo.db);
        console.log("✅ MongoDB (models) connected");
        return _db;
    })();
    return _promise;
}

async function getCollection(name) {
    const db = await getDB();
    return db.collection(name);
}

const SessionSettings = {
    async updateOne(filter, update, opts) {
        return (await getCollection("session_settings")).updateOne(filter, update, opts);
    },
    async findOne(filter) {
        return (await getCollection("session_settings")).findOne(filter);
    },
    async find(filter = {}) {
        return (await getCollection("session_settings")).find(filter).toArray();
    },
    async deleteOne(filter) {
        return (await getCollection("session_settings")).deleteOne(filter);
    }
};

const GroupSettings = {
    async updateOne(filter, update, opts) {
        return (await getCollection("group_settings")).updateOne(filter, update, opts);
    },
    async findOne(filter) {
        return (await getCollection("group_settings")).findOne(filter);
    }
};

const Users = {
    async updateOne(filter, update, opts) {
        return (await getCollection("users")).updateOne(filter, update, opts);
    },
    async findOne(filter) {
        return (await getCollection("users")).findOne(filter);
    }
};

async function closeDB() {
    if (_client) await _client.close();
    _client = null; _db = null; _promise = null;
}

module.exports = { getDB, getCollection, SessionSettings, GroupSettings, Users, closeDB };