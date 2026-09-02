import { searchBoardPapers } from '@/lib/retrieval/tool'
import { tenureAndSkillsImpact } from '@/lib/analytics/tenure'
import { upcomingUnprepared } from '@/lib/analytics/upcoming'
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
/**
 * Everything the router may choose from. The two below are separate from
 * ANALYTICS_TOOLS because neither is a pure computation: paper retrieval
 * answers from prose, and the tenure tool has to read a term limit out of a
 * paper before it can compute anything. Both are async and both may refuse.
 */
export const TOOLS: ToolDefinition[] = [
  ...ANALYTICS_TOOLS,
  searchBoardPapers,
  tenureAndSkillsImpact,
  upcomingUnprepared,
]

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

export function getTool(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name)
}
