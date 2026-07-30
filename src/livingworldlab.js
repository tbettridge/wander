import {
  LivingWorldAI,
  fallbackQuest,
  validateQuest,
} from './livingworld.mjs';

const facts = {
  biome: 'misty upland forest',
  weather: 'light rain after a storm',
  timeOfDay: 'late afternoon',
  playerHistory: 'The player arrived by train and lit the station lantern.',
  targets: [
    { id: 'station_wren', name: 'Wren Halt', kind: 'station', distanceM: 120 },
    { id: 'trail_north', name: 'the north ridge trail', kind: 'trail', distanceM: 460 },
    { id: 'cave_fern', name: 'Fernmouth Cave', kind: 'cave', distanceM: 730 },
  ],
};

const statusNode = document.querySelector('#model-status');
const detailNode = document.querySelector('#model-detail');
const outputNode = document.querySelector('#quest-output');
const initializeButton = document.querySelector('#initialize-model');
const generateButton = document.querySelector('#generate-quest');
const fallbackButton = document.querySelector('#fallback-quest');

function renderStatus({ state, progress }) {
  const labels = {
    idle: 'Not initialized',
    initializing: 'Starting model…',
    downloading: `Downloading model… ${Math.round((progress || 0) * 100)}%`,
    ready: 'On-device model ready',
    generating: 'Planning quest…',
  };
  statusNode.textContent = labels[state] || state;
  statusNode.dataset.state = state;
  generateButton.disabled = state !== 'ready';
}

function renderQuest(quest, source) {
  validateQuest(quest, facts.targets);
  outputNode.innerHTML = '';

  const sourceNode = document.createElement('div');
  sourceNode.className = 'source';
  sourceNode.textContent = source;

  const title = document.createElement('h2');
  title.textContent = quest.title;

  const dialogue = document.createElement('blockquote');
  dialogue.textContent = quest.speakerText;

  const steps = document.createElement('ol');
  for (const step of quest.steps) {
    const target = facts.targets.find((candidate) => candidate.id === step.targetId);
    const item = document.createElement('li');
    item.textContent = `${step.action} — ${target.name}`;
    steps.appendChild(item);
  }

  outputNode.append(sourceNode, title, dialogue, steps);
}

const ai = new LivingWorldAI({ onStatus: renderStatus });

async function inspectAvailability() {
  try {
    const availability = await ai.availability();
    detailNode.textContent = availability === 'unsupported'
      ? 'The LanguageModel API is not present. Use a supported desktop Chrome version or try the deterministic fallback.'
      : `Chrome reports the model as “${availability}”. Initialization may start a download.`;
    initializeButton.disabled = availability === 'unsupported' || availability === 'unavailable';
  } catch (error) {
    detailNode.textContent = `Availability check failed: ${error.message}`;
  }
}

initializeButton.addEventListener('click', async () => {
  initializeButton.disabled = true;
  try {
    await ai.initialize();
  } catch (error) {
    renderStatus({ state: 'idle' });
    detailNode.textContent = `Model initialization failed: ${error.message}`;
    initializeButton.disabled = false;
  }
});

generateButton.addEventListener('click', async () => {
  try {
    const quest = await ai.generateQuest(facts);
    renderQuest(quest, 'Generated locally by Chrome and validated by the game');
  } catch (error) {
    renderStatus({ state: 'ready' });
    detailNode.textContent = `Generation failed: ${error.message}`;
  }
});

fallbackButton.addEventListener('click', () => {
  renderQuest(fallbackQuest(facts), 'Deterministic fallback — no model used');
});

renderStatus({ state: 'idle' });
renderQuest(fallbackQuest(facts), 'Deterministic fallback — no model used');
inspectAvailability();
