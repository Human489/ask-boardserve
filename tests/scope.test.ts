import test from 'node:test'
import assert from 'node:assert/strict'
import { loadDataset } from '../src/lib/dataset/loader'
import { checkClockAnchored, checkPapersScope, structuredVocabulary } from '../src/lib/retrieval/scope'

// The papers tool became a catch-all: "who has the weakest Estates and assets
// skill" was sent to the board papers, which do not hold the skills audit, and
// came back as "the passages do not mention it" — the wrong source, and a
// refusal implying the data does not exist.
//
// Telling the model not to do it did not stop it. This is the check.

const dataset = loadDataset()

const STRUCTURED = [
  'Who has the weakest Estates and assets skill?',
  'What is the average finance and audit skill score?',
  'Are any actions linked to risk R01 overdue?',
  'How many directors self-rate 4 or above in Digital and data?',
  "What is Malcolm Whitbourne's attendance?",
  'Which actions has SAH-A014 been deferred past?',
]

const DOCUMENTARY = [
  'What do the board papers say about the Ashcombe day therapy unit?',
  'Why is the hospice closing the Ashcombe day therapy unit?',
  'How much are we spending on agency nursing?',
  'What did the Ashcombe unit cost per attendance?',
  'What concerns or themes recur across recent board papers?',
]

for (const question of STRUCTURED) {
  test(`recognised as structured: ${question.slice(0, 48)}`, () => {
    const scope = checkPapersScope(question, dataset)
    assert.equal(
      scope.belongsToStructuredData,
      true,
      'this names something the structured files hold, so the papers are the wrong source',
    )
    assert.ok(scope.matched.length > 0, 'the deciding term should be reported')
  })
}

for (const question of DOCUMENTARY) {
  test(`left to the papers: ${question.slice(0, 48)}`, () => {
    const scope = checkPapersScope(question, dataset)
    assert.equal(scope.belongsToStructuredData, false, `wrongly blocked by ${scope.matched.join(', ')}`)
  })
}

test('a question that explicitly asks about the papers is never blocked', () => {
  // The opposite mistake: "what do the papers say about digital and data" names
  // a skill column but is plainly a documents question.
  const skill = dataset.skillNames[0]
  const scope = checkPapersScope(`What do the board papers say about ${skill}?`, dataset)
  assert.equal(scope.belongsToStructuredData, false)
})

test('the vocabulary is read from the dataset, not written down', () => {
  const vocab = structuredVocabulary(dataset)
  // Every skill column in the loaded file must be present, whatever it is called.
  for (const skill of dataset.skillNames) {
    assert.ok(
      vocab.includes(skill.toLowerCase()),
      `${skill} is a column in this dataset but is not in the vocabulary`,
    )
  }
  // Director names too, so a second organisation's directors are recognised.
  assert.ok(vocab.includes(dataset.skills[0].director_name.toLowerCase()))
})

test('words too common to mean anything are excluded, unless they name a column', () => {
  const vocab = structuredVocabulary(dataset)
  // "board" is a body name and "risk" is half of a column name; on their own
  // they appear in almost every question and prove nothing.
  for (const word of ['board', 'risk']) {
    assert.ok(!vocab.includes(word), `"${word}" is too common to be evidence`)
  }
  // A column keeps its name even when the name is an everyday word. A question
  // that genuinely wants the papers escapes before this check runs.
  const columns = dataset.skillNames.map((s) => s.toLowerCase())
  for (const column of columns) {
    assert.ok(vocab.includes(column), `${column} is a column and must be recognised`)
  }
})

// A dated snapshot cannot answer a question anchored to the reader's calendar.
// "What was attendance like at yesterday's meeting" previously returned a
// full-year trend: a real chart, correct figures, and the false premise passed
// without comment.
for (const question of [
  "What was attendance like at yesterday's meeting?",
]) {
  test(`clock-anchored, so unanswerable: ${question.slice(0, 44)}`, () => {
    assert.equal(checkClockAnchored(question).anchored, true)
  })
}

// Relative to the DATA, not the calendar — these are answerable and must not be
// caught.
// Forward-looking questions ARE answerable: due dates run past the as-at date,
// and the tool that reads them says it counts from that date, not from today.
for (const question of [
  'What is coming next quarter that we have not started preparing for?',
  'What is due soon?',
  'Which meetings had unusually low attendance, and when?',
  'What did we decide in the last three meetings?',
  'What are the most recent overdue actions?',
  'Which committee met most often this year?',
]) {
  test(`relative to the data, so answerable: ${question.slice(0, 44)}`, () => {
    assert.equal(
      checkClockAnchored(question).anchored,
      false,
      'this is relative to the dataset, not to today',
    )
  })
}
