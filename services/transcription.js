require('dotenv').config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Límite Whisper: 25 MB

async function transcribeAudio(base64Data, mimeType) {
    if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY no configurada');

    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.byteLength > MAX_AUDIO_BYTES) throw new Error('Audio demasiado grande');

    const ext = mimeType?.includes('ogg') ? 'ogg'
              : mimeType?.includes('mp4') ? 'mp4'
              : mimeType?.includes('mpeg') ? 'mp3'
              : mimeType?.includes('webm') ? 'webm'
              : 'ogg';

    const formData = new FormData();
    formData.append('file', new Blob([buffer], { type: mimeType || 'audio/ogg' }), `audio.${ext}`);
    formData.append('model', 'whisper-1');
    formData.append('language', 'es');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: formData
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Whisper ${response.status}: ${err}`);
    }

    const result = await response.json();
    return result.text?.trim() || null;
}

module.exports = { transcribeAudio };
