'use strict';

const express = require('express');
const router = express.Router();

const VOICE_ID = process.env.ELEVENLABS_NOTIFICATION_VOICE_ID || 'xPnmQf6Ow3GGYWWURFPi';
const API_KEY = () => process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_LABS_API_KEY || process.env.ELEVENLABS_API;

router.post('/speech', async (req, res) => {
  try {
    const apiKey = API_KEY();
    if (!apiKey) {
      return res.status(503).json({ error: 'ElevenLabs não está configurada no servidor.' });
    }

    const text = String(req.body?.text || '').replace(/[<>]/g, '').trim().slice(0, 320);
    if (!text) return res.status(400).json({ error: 'Texto do aviso não informado.' });

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.58, similarity_boost: 0.78, style: 0.18, use_speaker_boost: true }
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('[notification-voice] ElevenLabs:', response.status, detail.slice(0, 400));
      return res.status(502).json({ error: 'Não foi possível gerar o áudio agora.' });
    }

    const audio = Buffer.from(await response.arrayBuffer());
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audio.length,
      'Cache-Control': 'no-store'
    });
    return res.send(audio);
  } catch (error) {
    console.error('[notification-voice] Erro:', error.message);
    return res.status(500).json({ error: 'Falha ao gerar aviso de voz.' });
  }
});

module.exports = router;
