const openai = require('./providers/openai');

async function getChatbotResponse(orgId, history, partialData, intent, reservaConfirmada = false, summary = null) {
    return openai.getChatbotResponse(orgId, history, partialData, intent, reservaConfirmada, summary);
}

module.exports = { getChatbotResponse };
