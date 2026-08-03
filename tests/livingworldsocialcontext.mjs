import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationSystemPrompt,
  fallbackChatReply,
  fallbackDialogue,
} from '../src/livingworld.mjs';

function context(social) {
  return {
    npc: { id: 'npc:wren:porter', name: 'Maren Bell', role: 'porter' },
    station: { id: 'wren', name: 'Wren Halt' },
    targets: [{ id: 'wren', name: 'Wren Halt', kind: 'station' }],
    weather: 'clear',
    timeOfDay: 'this morning',
    memory: null,
    journey: null,
    social,
  };
}

test('authored fallback can state a concrete active commitment without a model', () => {
  const reply = fallbackChatReply(context({
    activeCommitment: {
      kind: 'delivery', targetId: 'npc:ash:keeper', targetName: 'Alder Reed',
    },
    recentOutcomes: [],
  }), 'What are you delivering?');
  assert.match(reply.text, /letter/i);
  assert.match(reply.text, /Alder Reed/);
});

test('authored opening exposes a persistent delivery outcome', () => {
  const dialogue = fallbackDialogue(context({
    activeCommitment: null,
    recentOutcomes: [{
      kind: 'delivery', targetName: 'Alder Reed',
      outcome: { status: 'succeeded', code: 'delivered', atHour: 4 },
    }],
  }));
  assert.match(dialogue.text, /has been delivered/i);
  assert.match(dialogue.text, /Alder Reed/);
});

test('model prompt treats commitments as authoritative and social memory as sourced data', () => {
  const prompt = conversationSystemPrompt(context({
    activeCommitment: {
      kind: 'visit', targetId: 'npc:ash:keeper', targetName: 'Alder Reed',
    },
    memories: [{
      statement: 'Alder reached Ash Gate.', provenance: 'told', sourceName: 'Alder Reed',
    }],
  }));
  assert.match(prompt, /activeCommitment.*authoritative/s);
  assert.match(prompt, /Never substitute another person/i);
  assert.match(prompt, /provenance.*told/s);
  assert.match(prompt, /Do not return or alter socialMemories/i);
});
