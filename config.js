"use strict";
require("dotenv").config();

module.exports = {
    name: process.env.BOT_NAME || "303-XMD",
    tagline: process.env.BOT_TAGLINE || "The Last Key",
    version: process.env.BOT_VERSION || "2.0.0",
    prefix: process.env.PREFIX || ".",

    owner: {
        name: process.env.OWNER_NAME || "Mr Presenter",
        number: process.env.OWNER_NUMBER || "254794376595",
        email: process.env.ADMIN_EMAIL || "ryanobanga243@gmail.com"
    },

    links: {
        channel: process.env.CHANNEL_LINK || "",
        newsletter: process.env.NEWSLETTER_JID || ""
    },

    mongo: {
        uri: process.env.MONGODB_URI,
        db: process.env.DB_NAME || "xmd303",
        authCollection: process.env.AUTH_COLLECTION || "authState"
    },

    api: {
        botKey: process.env.BOT_API_KEY,
        huggingface: process.env.HUGGINGFACE_TOKEN,
        modelslab: process.env.MODELSLAB_KEY
    },

    ai: {
        provider: process.env.AI_PROVIDER || "openai",
        model: process.env.AI_MODEL || "openai/gpt-oss-20b",
        baseUrl: process.env.AI_BASE_URL || "https://api.groq.com/openai/v1",
        apiKey: process.env.GROQ_API_KEY
    },

    rapidapi: {
        key: process.env.RAPIDAPI_KEY,
        host: process.env.RAPIDAPI_HOST,
        searchHost: process.env.SEARCH_API_HOST
    },

    payments: {
        paystack: process.env.PAYSTACK_SECRET_KEY || "",
        stripe: process.env.STRIPE_SECRET_KEY || ""
    },

    server: {
        port: Number(process.env.PORT) || 3000,
        maxSessions: Number(process.env.MAX_SESSIONS) || 12
    }
};