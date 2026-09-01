// Shared contracts. Everything in the app speaks these types.
//
// The governing rule: TOOLS COMPUTE, THE MODEL NARRATES. Every number that
// reaches the screen is produced here, by deterministic code, from the dataset.
// The language model chooses which tool to run and with what arguments. It never
// produces a figure, and it never writes the headline.

// ---------------------------------------------------------------- dataset

export type AttendanceStatus = 'present' | 'apologies' | 'absent'

export interface Meeting {
  meeting_id: string
  body: string
  type: 'Board' | 'Committee'
  date: string
}

export interface AttendanceRecord {
  meeting_id: string
  body: string
  date: string
  director_id: string
  director_name: string
  status: AttendanceStatus
  joined_late_minutes?: number
  attended_remotely?: boolean
}

export interface DirectorSummary {
  director_id: string
  director_name: string
  board_meetings_eligible: number
  board_meetings_attended: number
  board_attendance_pct: number
  all_meetings_eligible: number
  all_meetings_attended: number
  overall_attendance_pct: number
}

export interface AttendanceFile {
  organisation: string
  period: string
  generated: string
  notes: string
  meetings: Meeting[]
  records: AttendanceRecord[]
  director_summary: DirectorSummary[]
}

export type ActionStatus = 'complete' | 'in progress' | 'overdue' | 'not started'
export type OwnerType = 'executive' | 'trustee' | 'non-executive'

export interface BoardAction {
  action_id: string
  raised_at_meeting: string
  raised_date: string
  description: string
  owner: string
  owner_type: OwnerType
  committee_or_board: string
  due_date: string
  status: ActionStatus
  completed_date: string | null
  times_deferred: number
  priority: 'high' | 'medium' | 'low'
  linked_risk: string | null
}

export interface ActionsFile {
  organisation: string
  period: string
  generated: string
  as_at: string
  notes: string
  actions: BoardAction[]
}

export interface SkillsRow {
  director_id: string
  director_name: string
  role: string
  tenure_years: number
  /** skill name -> self-assessed score 1..5 */
  scores: Record<string, number>
}

export interface BoardPaper {
  id: string
  filename: string
  title: string
  body: string
}

export interface Dataset {
  organisation: string
  /** The as-at date, taken from the data. NEVER from the system clock. */
  asAt: string
  attendance: AttendanceFile
  actions: ActionsFile
  skills: SkillsRow[]
  /** Skill column names, in file order. Not hard-coded anywhere. */
  skillNames: string[]
  papers: BoardPaper[]
}

// ---------------------------------------------------------------- charts

export type ChartKind = 'bar' | 'line'
export type Unit = 'percent' | 'count' | 'days' | 'score'

export interface DataPoint {
  label: string
  value: number
  /** Optional second series, e.g. recorded-overdue behind derived-overdue. */
  value2?: number
  /** Draws attention to this point in the UI (below threshold, worst case). */
  highlight?: boolean
  /** Shown in the tooltip. Free-form, e.g. "3 of 10 meetings". */
  detail?: string
}

export interface ChartSpec {
  kind: ChartKind
  title: string
  xLabel: string
  yLabel: string
  unit: Unit
  points: DataPoint[]
  /** Name of the first series, for the legend. */
  seriesLabel?: string
  /** Name of the optional second series. */
  series2Label?: string
  /** A horizontal rule, e.g. the attendance threshold. */
  reference?: { value: number; label: string }
}

export interface TableSpec {
  columns: string[]
  rows: (string | number | null)[][]
}

// ---------------------------------------------------------------- tools

export interface Provenance {
  /** The as-at date used, echoed so the user can see it came from the data. */
  asAt: string
  /** Which dataset files this answer touched. */
  sources: string[]
  /** How many rows were considered before aggregation. */
  rowsConsidered: number
  /** Plain-English statement of how the figure was derived. */
  derivation: string
}

export interface ToolResult {
  tool: string
  /**
   * The one-sentence insight. Says the NOTABLE THING, not what the axes are.
   * "Three directors are below 80% attendance, all of them on Audit" —
   * not "this chart shows attendance by director".
   *
   * Written deterministically by the tool, from the numbers it just computed,
   * so it can never disagree with the chart.
   */
  headline: string
  chart: ChartSpec | null
  table: TableSpec | null
  /** Choices the tool had to make that the data did not settle, e.g. the threshold. */
  assumptions: string[]
  /** Caveats the user needs to read the number honestly, e.g. small sample size. */
  caveats: string[]
  provenance: Provenance
}

export interface RefusalResult {
  tool: 'refusal'
  headline: string
  /** Why the data cannot answer it. Specific, not a shrug. */
  reason: string
  /** What the data CAN offer instead, if anything. */
  alternative?: string
}

export type AnswerResult = ToolResult | RefusalResult

export function isRefusal(r: AnswerResult): r is RefusalResult {
  return r.tool === 'refusal'
}

// ---------------------------------------------------------------- tool registry

/** JSON-Schema-ish parameter description, passed to the model for tool calling. */
export interface ToolParam {
  type: 'string' | 'number' | 'boolean'
  description: string
  enum?: string[]
  default?: string | number | boolean
  /**
   * Inclusive bounds for a number. The model will happily emit a threshold of
   * 0, which is not a smaller threshold but a meaningless one — nobody is below
   * 0% attendance — and the same question then answers differently run to run.
   * A value outside these bounds is discarded in favour of the default.
   */
  min?: number
  max?: number
}

export interface ToolDefinition {
  name: string
  /** Written for the model: says when to pick this tool. */
  description: string
  parameters: Record<string, ToolParam>
  required: string[]
  run: (dataset: Dataset, args: Record<string, unknown>) => ToolResult
}
