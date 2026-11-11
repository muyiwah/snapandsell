// Central configuration. Every secret comes from environment variables.
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  baseUrl: (env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),

  paypal: {
    clientId: env.PAYPAL_CLIENT_ID || '',
    clientSecret: env.PAYPAL_CLIENT_SECRET || '',
    // Sandbox only for the hackathon. Never point this at live without review.
    apiBase: env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com',
    currency: env.STORE_CURRENCY || 'USD',
    // From developer.paypal.com > your app > Webhooks. Needed to verify webhook signatures.
    webhookId: env.PAYPAL_WEBHOOK_ID || '',
  },

  ai: {
    apiKey: env.META_API_KEY || env.MODEL_API_KEY || '',
    baseUrl: (env.META_BASE_URL || 'https://api.meta.ai/v1').replace(/\/$/, ''),
    model: env.META_MODEL || 'muse-spark-1.3',
    timeoutMs: Number(env.AI_TIMEOUT_MS || 45000),
  },

  store: {
    name: env.STORE_NAME || 'Snap & Sell',
    // Hard cap on any single order an AI agent can start. Buyer still approves on PayPal.
    agentMaxOrderUsd: Number(env.AGENT_MAX_ORDER_USD || 250),
    // Default lowest price a seller's haggling agent may accept, as a share of the list price.
    defaultFloorRatio: Number(env.DEFAULT_FLOOR_RATIO || 0.85),
    // Max rounds of offers in one negotiation, and how long an agreed deal stays valid.
    haggleMaxRounds: Number(env.HAGGLE_MAX_ROUNDS || 4),
    dealTtlMs: Number(env.DEAL_TTL_MIN || 30) * 60_000,
    dataFile: env.DATA_FILE || 'data/db.json',
  },
};

// Mock modes let the app run end to end without keys (for local testing and judges
// who want to look around). The UI shows a clear banner whenever a mock is active.
export const modes = {
  paypalMock: !(config.paypal.clientId && config.paypal.clientSecret) || env.PAYPAL_MOCK === 'true',
  aiMock: !config.ai.apiKey || env.AI_MOCK === 'true',
};
