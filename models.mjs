export const modelDefaults = {
  'gpt-6-astra': {
    name: 'GPT-6 Astra',
    limit: { context: 1050000, input: 922000, output: 128000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    reasoning: true,
    tool_call: true,
    attachment: true,
    variants: { low: {}, medium: {}, high: {}, xhigh: {}, max: {} },
  },
  'claude-opus-5-5': {
    name: 'Claude Opus 5.5',
    limit: { context: 1000000, output: 128000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    reasoning: true,
    tool_call: true,
    attachment: true,
    variants: { low: {}, medium: {}, high: {}, xhigh: {}, max: {} },
  },
};
