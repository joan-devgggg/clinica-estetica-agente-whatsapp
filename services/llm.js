const openai = require('./providers/openai');

async function getChatbotResponse(history, partialData, intent, citaConfirmada = false, summary = null) {
    return openai.getChatbotResponse(history, partialData, intent, citaConfirmada, summary);
}

module.exports = { getChatbotResponse };
