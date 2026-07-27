export const POKE_ACTIONS = Object.freeze([
  'approve',
  'pending',
  'list',
  'status',
  'stop',
  'output_cycle',
  'none',
])

/** 循环顺序：detail → simple → collapsed → summary → silence */
export const OUTPUT_LEVELS = Object.freeze(['detail', 'simple', 'collapsed', 'summary', 'silence'])

export function normalizePokeAction(value) {
  const action = String(value || '').trim().toLowerCase()
  return POKE_ACTIONS.includes(action) ? action : 'approve'
}

export function nextOutputLevel(value) {
  const index = OUTPUT_LEVELS.indexOf(String(value || '').trim().toLowerCase())
  return OUTPUT_LEVELS[(index + 1 + OUTPUT_LEVELS.length) % OUTPUT_LEVELS.length]
}
