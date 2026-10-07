# NPC speech performance

NPC faces blink while idle and approximate lip sync using 20 ms RMS windows from the actual Gemini PCM audio. The mouth rests in silence, while audio downloads, after playback, and when a reply is cancelled. This is syllable-energy animation rather than phoneme or viseme alignment.

`npcexpression.mjs` contains the small procedural gesture library: nod, shake-head, shrug, open-hand, hand-on-chest, thoughtful, wave, bow, and directional point. These clips add head and upper-body rotations to the existing locomotion rig. They preserve foot contacts and avoid arms already owned by pointing, work, or carried items.

Qwen receives the library in `NPC_DELIVERY_INSTRUCTIONS`. For example:

```json
{"segments":[
  {"text":"<gesture:nod> Yes, that sounds sensible.","style":"warm, agreeable"},
  {"text":"<gesture:point> Harrow Mill is down that lane.","style":"helpful"}
]}
```

The parser allows at most two gesture markers per reply and starts a new speech phrase at each marker. Gesture markers are removed before speech synthesis and chat display. Gemini vocal tags such as `<chuckle>` remain in the audio input. Original dialogue evidence is retained; memory synthesis receives the visible spoken text.

A cue begins when its audio buffer starts, using the Web Audio playback clock. The following phrase is prefetched to reduce gaps; later phrases remain bounded to one ahead. Full sentences are preferable to fragmented clauses, because each phrase is synthesized separately.

Directional pointing reuses the existing world-space pointing animation. It resolves a known place named in the spoken phrase or an earlier phrase of that utterance, so “Harrow Mill … over there” still points at the mill. An unknown or ambiguous reference never invents a coordinate. Closing, muting, or interrupting speech clears its pointing reference and releases its animation.

Station residents, settlement residents, visiting replicas, and regional walker faces use the shared avatar face implementation. Both station and settlement animation paths receive the active NPC's speech performance. With speech unavailable, the existing text-only delivery gestures remain available.

The Gemini TTS API documents audio-only output, without a word-alignment field in its TTS guide. Phrase boundaries provide reliable cue timing without a second transcription request. See [Google's speech generation guide](https://ai.google.dev/gemini-api/docs/speech-generation) and [the Web Audio playback clock](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/currentTime).

Validation covers idle blink variation, speech/silence mouth envelopes, cue stripping and phrase boundaries, cancellation, preserved foot contacts, occupied hands, actual segment-start timing, and directional-point world bearings. The browser preview exercises the production avatar, Qwen gateway, Gemini speech player, and pointing methods together.
