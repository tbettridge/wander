# NPC voices and delivery

WANDER uses OpenRouter's `google/gemini-3.8-flash-tts`. The LLM remains Qwen by
default, with local Chrome Nano available in debug settings. NPC voices can be
disabled independently. Live inference requires the configured, deployed
[AI gateway](../services/ai-worker/README.md).

## Google guidance

[Google's TTS prompting guide](https://ai.google.dev/gemini-api/docs/speech-generation#prompting-guide)
separates spoken words, per-turn performance, and permanent voice identity:

- Put short situational directions in `speech_metadata.style`: for example,
  “scared, trembling, speaking through clenched teeth.” Split a reply into
  separate segments when the delivery changes.
- Put human vocal events at their exact position in the transcript using native
  tags such as `<chuckle>`, `<sigh>`, `<gasp>`, or `<short pause>`. Do not use
  square-bracket directions or invent sound-effect tags. Tags remain English
  even when the spoken language changes.
- Use natural spoken phrasing and punctuation; add directions only when needed.
  Long repeated persona instructions and attempts to change a permanent accent
  in the style field can cause voice drift.

[Google's Voice Design guidance](https://ai.google.dev/gemini-api/docs/voice-design#prompting-best-practices-for-voice-design)
recommends a concise one- or two-sentence description of age, vocal texture,
accent and baseline delivery, created once and reused through a `voice_...` ID.
Prebuilt voices are the working default here. A character's intended accent is
recorded in its design description; exact custom accents require designed voices
accessible to the configured OpenRouter Google provider. They are not recreated
or forced through a long style prompt on every line.

## Character profiles and generated dialogue

`npcSpeechProfile` supplies deterministic profiles for station residents,
travellers, household residents and legacy/remote characters. Each includes
personality, tone, accent, speaking style, baseline delivery, a preset voice and
a reusable voice-design prompt. Authors can override these fields on the NPC's
`speech` profile. Changing current occupation does not change the voice.

The dialogue generator returns validated JSON such as:

```json
{
  "segments": [
    { "text": "Stay close. I heard it again.", "style": "scared, trembling, speaking through clenched teeth" },
    { "text": "<chuckle> Perhaps it was only the wind.", "style": "quietly reassuring" },
    { "text": "<sigh> I miss those evenings.", "style": "wistful, longing" }
  ]
}
```

Chat shows only the words. Native vocal tags stay in the speech transcript;
styles become [OpenRouter's Gemini provider options](https://openrouter.ai/docs/guides/overview/multimodal/tts#google-gemini-tts).
Original transcripts remain available for exact narrative evidence. Delivery
metadata is not stored as a fact, and provisional memories omit vocal tags.
Multiplayer events carry bounded delivery metadata that can speak only the
host-accepted text; transcript redraws and old snapshots do not replay speech.

Speech cancels when the listener closes the conversation or sends the next
message. Text remains usable if audio is unavailable. Live voice quality and
latency still need auditioning with a configured OpenRouter key; automated tests
verify formatting, playback, cancellation and server limits using fake audio.
