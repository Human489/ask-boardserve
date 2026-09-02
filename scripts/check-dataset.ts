// check-dataset.ts — will this dataset load, without telling you what is in it?
//
//   npx tsx scripts/check-dataset.ts path/to/dataset-b.zip
//   npx tsx scripts/check-dataset.ts path/to/dataset-folder
//
// Why this exists, and why it is careful about what it prints.
//
// The second dataset is meant to be loaded for the first time in front of an
// audience, and that demonstration is only worth anything if the code was never
// tuned to its contents. But "we never looked at it" and "we have no idea
// whether it will even open" are different risks, and only the first one is
// worth carrying.
//
// So this reports whether the files parse, and NOTHING else. No organisation
// name, no counts, no dates, no director or committee names, no figures. If it
// fails, it prints the parser's own message, which names a file and a syntax
// problem rather than any content.
//
// Running this does not compromise the test. Nothing here is fed back into the
// code, and knowing that an archive is well-formed cannot hard-code anything to
// what it says.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { filesFromZip } from '../src/lib/dataset/archive'
import { buildDataset, REQUIRED_FILES, type DatasetFiles } from '../src/lib/dataset/loader'

const target = process.argv[2]

if (!target) {
  console.error('Usage: npx tsx scripts/check-dataset.ts <dataset.zip | dataset-folder>')
  process.exit(2)
}

function filesFromFolder(dir: string): DatasetFiles {
  const wanted = (n: string) =>
    REQUIRED_FILES.includes(n) || (n.startsWith('paper-') && n.endsWith('.md'))
  const files: DatasetFiles = {}
  for (const name of readdirSync(dir).filter(wanted)) {
    files[name] = readFileSync(join(dir, name), 'utf8')
  }
  return files
}

let files: DatasetFiles
try {
  files = statSync(target).isDirectory()
    ? filesFromFolder(target)
    : filesFromZip(new Uint8Array(readFileSync(target)))
} catch (e) {
  console.log('FAILS TO OPEN')
  console.log(`  ${(e as Error).message}`)
  process.exit(1)
}

try {
  // Built and thrown away. Deliberately not inspected, printed or returned.
  buildDataset(files)
} catch (e) {
  console.log('OPENS, BUT DOES NOT PARSE AS A DATASET')
  console.log(`  ${(e as Error).message}`)
  process.exit(1)
}

// The file names are the schema, not the contents, so listing them tells you
// nothing about the organisation. Sorted so the output is stable.
const names = Object.keys(files).sort()
console.log('PARSES — this dataset will load.')
console.log(`  ${names.length} files: ${names.join(', ')}`)
console.log('  No contents were reported, so the load test is still blind.')
