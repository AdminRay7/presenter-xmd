// lib/mongoAuthState.js
const { initAuthCreds, BufferJSON, proto } = require("@whiskeysockets/baileys");

const useMongoDBAuthState = async (collection, sessionId) => {
    const writeData = async (data, id) => {
        try {
            const informationToStore = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
            const update = { $set: { ...informationToStore } };
            await collection.updateOne({ _id: `${sessionId}:${id}` }, update, { upsert: true });
        } catch (error) {
            console.error("Error writing auth state to MongoDB:", error);
        }
    };

    const readData = async (id) => {
        try {
            const data = await collection.findOne({ _id: `${sessionId}:${id}` });
            if (data) {
                const { _id, ...rest } = data;
                return JSON.parse(JSON.stringify(rest), BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            console.error("Error reading auth state from MongoDB:", error);
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await collection.deleteOne({ _id: `${sessionId}:${id}` });
        } catch (error) {
            console.error("Error removing auth state from MongoDB:", error);
        }
    };

    const creds = (await readData("creds")) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === "app-state-sync-key" && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: async () => {
            await writeData(creds, "creds");
        },
    };
};

module.exports = { useMongoDBAuthState };