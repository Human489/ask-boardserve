import { searchBoardPapers } from '@/lib/retrieval/tool'
import type { ToolDefinition } from '@/lib/types'
import { ATTENDANCE_TOOLS } from '@/lib/analytics/attendance'
import { ACTION_TOOLS } from '@/lib/analytics/actions'
import { SKILLS_TOOLS } from '@/lib/analytics/skills'

/**
 * The deterministic tools: they compute from files already in memory, are
 * synchronous, and never refuse — a computation with nothing to report is a
 * caveated nil result, not a refusal. Every figure the product shows comes
 * from one of these.
 */
export const ANALYTICS_TOOLS: ToolDefinition[] = [
  ...ATTENDANCE_TOOLS,
  ...ACTION_TOOLS,
  ...SKILLS_TOOLS,
]

/**
 * Everything the router may choose from. Paper retrieval is separate above
 * because it is async, returns prose rather than a chart, and is the one tool
 * allowed to conclude that the sources do not answer the question.
 */
export const TOOLS: ToolDefinition[] = [...ANALYTICS_TOOLS, searchBoardPapers]

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

export function getTool(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name)
}
