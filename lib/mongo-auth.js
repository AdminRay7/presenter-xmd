"use strict";

const { initAuthCreds, BufferJSON, proto } = require("@whiskeysockets/baileys");

async function useMongoDBAuthState(collection, sessionId) {
    const writeData = async (data, id) => {
        const value = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        await collection.updateOne(
            { _id: `${sessionId}:${id}` },
            { $set: { value } },
            { upsert: true }
        );
    };

    const readData = async (id) => {
        try {
            const doc = await collection.findOne({ _id: `${sessionId}:${id}` });
            if (!doc) return null;
            return JSON.parse(JSON.stringify(doc.value), BufferJSON.reviver);
        } catch { return null; }
    };

    const removeData = async (id) => {
        try { await collection.deleteOne({ _id: `${sessionId}:${id}` }); } catch {}
    };

    const creds = (await readData("creds")) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === "app-state-sync-key" && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) tasks.push(writeData(value, key));
                            else tasks.push(removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, "creds")
    };
}

module.exports = { useMongoDBAuthState };