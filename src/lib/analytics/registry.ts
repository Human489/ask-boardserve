import type { ToolDefinition } from '@/lib/types'
import { ATTENDANCE_TOOLS } from '@/lib/analytics/attendance'
import { ACTION_TOOLS } from '@/lib/analytics/actions'
import { SKILLS_TOOLS } from '@/lib/analytics/skills'

/** Every deterministic tool the router may choose from. */
export const TOOLS: ToolDefinition[] = [
  ...ATTENDANCE_TOOLS,
  ...ACTION_TOOLS,
  ...SKILLS_TOOLS,
]

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

export function getTool(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name)
}
