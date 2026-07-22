const CLAUDE_MODELS = ['default', 'sonnet', 'sonnet[1m]', 'opus', 'opus[1m]', 'fable', 'fable[1m]']

const PROFILES = Object.freeze({
  claude: profile({
    permissionModes: ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'],
    model: { create: 'static', session: 'static', values: CLAUDE_MODELS },
    effort: { route: 'effort', values: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] },
    plan: 'permission',
  }),
  codex: profile({
    permissionModes: ['default', 'read-only', 'safe-yolo', 'yolo'],
    model: { create: 'dynamic', session: 'dynamic' },
    effort: {
      route: 'model-reasoning-effort',
      values: ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    },
    plan: 'collaboration',
    fast: true,
  }),
  cursor: profile({
    permissionModes: ['default', 'plan', 'ask', 'debug', 'autoReview', 'yolo'],
    model: { create: 'dynamic', session: 'dynamic' },
    plan: 'permission',
  }),
  grok: profile({
    permissionModes: ['default', 'auto', 'plan', 'bypassPermissions'],
    model: { create: 'dynamic', session: 'dynamic' },
    effort: { route: 'effort', values: ['default', 'low', 'medium', 'high', 'xhigh'] },
    plan: 'permission',
  }),
  kimi: profile({
    permissionModes: ['default', 'read-only', 'safe-yolo', 'yolo'],
    model: { create: 'freeform', session: 'freeform' },
  }),
  opencode: profile({
    permissionModes: ['default', 'plan', 'yolo'],
    model: { create: 'dynamic', session: 'dynamic' },
    effort: {
      route: 'model-reasoning-effort',
      values: ['default', 'low', 'medium', 'high', 'max'],
    },
    plan: 'permission',
  }),
  pi: profile({
    permissionModes: [],
    model: { create: 'freeform', session: 'dynamic' },
    effort: { route: 'effort', values: ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
  }),
})

function profile(value) {
  return Object.freeze({
    permissionModes: Object.freeze(value.permissionModes || []),
    model: value.model ? Object.freeze(value.model) : null,
    effort: value.effort ? Object.freeze(value.effort) : null,
    plan: value.plan || null,
    fast: value.fast === true,
  })
}

export const FLAVOR_PROFILES = PROFILES
export const CREATABLE_FLAVORS = Object.freeze(Object.keys(PROFILES))
export const CLAUDE_MODEL_MODES = Object.freeze(CLAUDE_MODELS)

export function normalizeFlavor(value) {
  return String(value || '').trim().toLowerCase()
}

export function getFlavorProfile(value) {
  return PROFILES[normalizeFlavor(value)] || null
}

export function getFlavorDisplay(value) {
  const flavor = normalizeFlavor(value)
  return PROFILES[flavor] ? flavor : 'unknown'
}

export function isCreatableFlavor(value) {
  return Boolean(getFlavorProfile(value))
}

export function getPermissionModes(value) {
  return getFlavorProfile(value)?.permissionModes || []
}

export function getEffortValues(value) {
  return getFlavorProfile(value)?.effort?.values || []
}

export function supportsModel(value) {
  return Boolean(getFlavorProfile(value)?.model)
}

export function supportsEffort(value) {
  return Boolean(getFlavorProfile(value)?.effort)
}

export function supportsPlan(value) {
  return Boolean(getFlavorProfile(value)?.plan)
}

export function supportsFast(value) {
  return getFlavorProfile(value)?.fast === true
}
