"use strict";

module.exports = {
    name: "ping",
    help: "Check bot latency",
    run: async ({ conn, m, reply }) => {
        const t = Date.now();
        await reply(conn, m, `🏓 Pong! ${Date.now() - t}ms`);
    }
};