# NPC voices and delivery

WANDER uses Gemini 3.8 Flash TTS. Regional library voices and designed voices
run through the configured Google project. OpenRouter presets remain a fallback.
The LLM remains Qwen on OpenRouter by
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
The server cast combines selected regional library voices with designed voices
for missing regions and age combinations. Studio presets alone do not guarantee
regional accents or age. Voices are not recreated or forced through a long
style prompt on every line. See the
[cast setup](../services/ai-worker/README.md#regional-voice-cast).

## Character profiles and generated dialogue

`npcSpeechProfile` supplies deterministic profiles for station residents,
travellers, household residents and legacy/remote characters. Each includes
personality, tone, accent, speaking style, baseline delivery, gender, age band,
background story, a preset fallback and a stable cast slot. Numeric appearance
presentation selects the matching gender; youth/adult/elder age survives compact
chat and multiplayer descriptors. Version-one generated profiles are migrated
so their previous male presets and arbitrary accents do not override identity.

Most households have everyday English regional backgrounds, with Scottish,
Irish and Welsh communities mixed in. Cultivated London upbringing is more
likely among business families in towns. French/Spanish English-speaking visitors
are rare and have an explicit matching origin story. Household members share
regional upbringing, while individual voices vary in texture. Changing current
occupation does not change the voice. Canonical household backgrounds persist
in world state, and the dialogue generator receives the same story used for
voice selection.

Authors can set `voiceBackground` with `accentId`, `originCountry`, `story`,
`settlementKind`, `businessFamily` and `visitor`, or explicitly set `voiceGender`.
Accent IDs are `yorkshire`, `lancashire`, `midlands`, `westcountry`, `london`,
`southern`, `posh`, `scottish`, `irish`, `welsh`, `french` and `spanish`.
Partial `speech` profiles can override tone, personality, speaking style and
preset voice. The regional cast has two textures per accent/gender/age combination
(144 reusable slots), rather than creating a new Google voice for every NPC.
Library choices are matched by regional accent, gender and the closest suitable
adult age/pitch. Youth characters use youthful adult actor voices; Google's
safety filter rejected explicit minor voice designs during setup. This keeps
their NPC ages and family roles intact without claiming literal child recordings.

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
styles become [OpenRouter's Gemini provider options](https://openrouter.ai/docs/guides/overview/multimodal/tts#google-gemini-tts)
or Google's native `speech_metadata` for designed voices.
Original transcripts remain available for exact narrative evidence. Delivery
metadata is not stored as a fact, and provisional memories omit vocal tags.
Multiplayer events carry bounded delivery metadata that can speak only the
host-accepted text; transcript redraws and old snapshots do not replay speech.

Speech cancels when the listener closes the conversation or sends the next
message. Text remains usable if audio is unavailable. The OpenRouter preset path
has been checked with live browser playback. Regional synthesis is also checked
through the configured Google project. Automated tests
verify demographics, cast distribution, background consistency, formatting,
playback, cancellation and both providers' limits.
