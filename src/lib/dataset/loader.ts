import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ActionsFile,
  AttendanceFile,
  BoardPaper,
  Dataset,
  SkillsRow,
} from '@/lib/types'

// Loads the dataset from disk. Nothing here is specific to any one organisation:
// skill columns, committee names, director ids and risk references are all read
// from the files rather than hard-coded, so a second dataset loads unchanged.

const FIXED_SKILL_COLUMNS = ['director_id', 'director_name', 'role', 'tenure_years']

function datasetDir(): string {
  return process.env.DATASET_PATH ?? join(process.cwd(), 'dataset')
}

/** Minimal RFC-4180 line splitter: handles quoted fields containing commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else inQuotes = false
      } else cur += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

function parseSkills(csv: string): { rows: SkillsRow[]; skillNames: string[] } {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length < 2) throw new Error('skills-audit.csv has no data rows')

  const header = splitCsvLine(lines[0])
  for (const col of FIXED_SKILL_COLUMNS) {
    if (!header.includes(col)) {
      throw new Error(`skills-audit.csv is missing the "${col}" column`)
    }
  }
  // Everything that is not an identity column is a skill. Read, never assumed.
  const skillNames = header.filter((h) => !FIXED_SKILL_COLUMNS.includes(h))
  if (skillNames.length === 0) throw new Error('skills-audit.csv has no skill columns')

  const rows: SkillsRow[] = lines.slice(1).map((line, i) => {
    const cells = splitCsvLine(line)
    if (cells.length !== header.length) {
      throw new Error(
        `skills-audit.csv row ${i + 2} has ${cells.length} cells, expected ${header.length}`,
      )
    }
    const get = (col: string) => cells[header.indexOf(col)]
    const scores: Record<string, number> = {}
    for (const skill of skillNames) {
      const raw = get(skill)
      const n = Number(raw)
      if (!Number.isFinite(n)) {
        throw new Error(`skills-audit.csv row ${i + 2}: "${skill}" is not a number ("${raw}")`)
      }
      scores[skill] = n
    }
    const tenure = Number(get('tenure_years'))
    if (!Number.isFinite(tenure)) {
      throw new Error(`skills-audit.csv row ${i + 2}: tenure_years is not a number`)
    }
    return {
      director_id: get('director_id'),
      director_name: get('director_name'),
      role: get('role'),
      tenure_years: tenure,
      scores,
    }
  })

  return { rows, skillNames }
}

function parsePapers(files: DatasetFiles): BoardPaper[] {
  return Object.keys(files)
    .filter((f) => f.startsWith('paper-') && f.endsWith('.md'))
    .sort()
    .map((filename) => {
      const body = files[filename]
      // First markdown heading is the title; fall back to the filename.
      const m = body.match(/^#\s+(.+)$/m)
      return {
        id: filename.replace(/\.md$/, ''),
        filename,
        title: m ? m[1].trim() : filename.replace(/\.md$/, ''),
        body,
      }
    })
}

/**
 * A dataset as a set of named files, which is the form both sources produce:
 * read off disk in development, or unpacked from an uploaded archive.
 */
export type DatasetFiles = Record<string, string>

/** The files a dataset cannot do without. Papers are matched by prefix. */
export const REQUIRED_FILES = ['attendance.json', 'actions.json', 'skills-audit.csv']

/** Asserts a parsed file is an object carrying the arrays the tools read. */
function requireRecords(value: unknown, label: string, arrays: string[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object, not ${Array.isArray(value) ? 'an array' : typeof value}.`)
  }
  const record = value as Record<string, unknown>
  for (const key of arrays) {
    if (!Array.isArray(record[key])) {
      throw new Error(`${label} is missing its "${key}" array.`)
    }
  }
}

function parseJson<T>(files: DatasetFiles, label: string): T {
  const raw = files[label]
  if (raw === undefined) throw new Error(`The dataset is missing ${label}.`)
  try {
    return JSON.parse(raw) as T
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${(e as Error).message}`)
  }
}

/**
 * Builds a dataset from already-read files.
 *
 * Parsing is separated from reading so that an uploaded archive and the local
 * directory go through exactly the same code. If they did not, an upload could
 * be accepted that the app then could not answer from — and the failure would
 * appear later, as a broken question rather than a rejected file.
 */
export function buildDataset(files: DatasetFiles): Dataset {
  for (const name of REQUIRED_FILES) {
    if (files[name] === undefined) throw new Error(`The dataset is missing ${name}.`)
  }

  const attendance = parseJson<AttendanceFile>(files, 'attendance.json')
  const actions = parseJson<ActionsFile>(files, 'actions.json')

  // Valid JSON is not the same as a dataset. An attendance file shaped as an
  // array parses cleanly, then every field reads as undefined and the first
  // tool to touch `records` throws — a 500 at question time rather than a
  // rejection at upload time.
  requireRecords(attendance, 'attendance.json', ['records', 'meetings'])
  requireRecords(actions, 'actions.json', ['actions'])
  const { rows: skills, skillNames } = parseSkills(files['skills-audit.csv'])

  const papers = parsePapers(files)
  if (papers.length === 0) {
    throw new Error('The dataset contains no board papers (expected paper-*.md).')
  }

  // The as-at date comes from the data, never from the system clock. Taking it
  // from the clock makes every date-dependent test rot as the month turns.
  const asAt: unknown = actions.as_at ?? actions.generated ?? attendance.generated
  if (!asAt) throw new Error('No as_at or generated date found in the dataset.')

  // Every date in this product is compared as a STRING: overdue is
  // `due_date < asAt`. An as-at date written unquoted in JSON arrives as a
  // number, and comparing a string to a number is false for every row — so a
  // dataset with nine overdue actions reported none of them, as a finished
  // sentence, against a date reading "20260831". A malformed date has to be
  // refused here, where the person holding the file can fix it, rather than
  // become a confident wrong answer later.
  if (typeof asAt !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(asAt)) {
    throw new Error(
      `The as-at date must be a quoted ISO date such as "2026-08-31"; found ${JSON.stringify(
        asAt,
      )}. Dates are compared as text, so any other form silently matches nothing.`,
    )
  }

  const organisation = attendance.organisation ?? actions.organisation
  if (!organisation) throw new Error('No organisation name found in the dataset.')

  return { organisation, asAt, attendance, actions, skills, skillNames, papers }
}

let cached: Dataset | null = null

/** True when a dataset directory is present on disk. */
export function localDatasetExists(): boolean {
  try {
    const dir = datasetDir()
    const names = readdirSync(dir)
    return REQUIRED_FILES.every((f) => names.includes(f))
  } catch {
    return false
  }
}

/** Reads the local directory into the same file map an upload produces. */
function readLocalFiles(): DatasetFiles {
  const dir = datasetDir()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    throw new Error(
      `Could not read the dataset at ${dir}. The dataset is gitignored — ` +
        `place it at ./dataset, set DATASET_PATH, or upload one.`,
    )
  }
  const files: DatasetFiles = {}
  for (const name of names) {
    if (REQUIRED_FILES.includes(name) || (name.startsWith('paper-') && name.endsWith('.md'))) {
      files[name] = readFileSync(join(dir, name), 'utf8')
    }
  }
  return files
}

/**
 * The dataset on local disk. Still synchronous, because development and the
 * whole test suite depend on it being so; uploaded datasets are resolved
 * separately and asynchronously.
 */
export function loadDataset(): Dataset {
  if (cached) return cached
  cached = buildDataset(readLocalFiles())
  return cached
}

/** Test seam: drop the cache so a test can point DATASET_PATH somewhere else. */
export function resetDatasetCache(): void {
  cached = null
}

// ------------------------------------------------------------ shared helpers
// Used by more than one analytics module, so they live with the loader.

/** Inclusive day count between two ISO dates. Pure, timezone-free. */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(
    Number(fromIso.slice(0, 4)),
    Number(fromIso.slice(5, 7)) - 1,
    Number(fromIso.slice(8, 10)),
  )
  const b = Date.UTC(
    Number(toIso.slice(0, 4)),
    Number(toIso.slice(5, 7)) - 1,
    Number(toIso.slice(8, 10)),
  )
  return Math.round((b - a) / 86_400_000)
}

/**
 * Committee membership is NOT a stated field anywhere in the dataset. It is
 * inferred from eligibility: a director has a record row for a committee
 * meeting only if they are a member of that committee. Any tool that reports
 * membership must carry this as a caveat.
 */
export function committeesOf(dataset: Dataset, directorName: string): string[] {
  const bodies = new Set<string>()
  for (const r of dataset.attendance.records) {
    if (r.director_name === directorName) bodies.add(r.body)
  }
  return [...bodies].sort()
}

export function membersOf(dataset: Dataset, body: string): string[] {
  const names = new Set<string>()
  for (const r of dataset.attendance.records) {
    if (r.body === body) names.add(r.director_name)
  }
  return [...names].sort()
}

export function allBodies(dataset: Dataset): string[] {
  return [...new Set(dataset.attendance.meetings.map((m) => m.body))].sort()
}

/** Rounds to one decimal place, avoiding 88.99999999 in the UI. */
export function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0
  return Math.round((numerator / denominator) * 1000) / 10
}
