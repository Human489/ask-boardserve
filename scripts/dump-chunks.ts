// Prints the chunked board papers as JSON on stdout.
//
// Exists so ingest-papers.mjs can reuse the app's dataset loader and chunker
// rather than reimplementing either. Kept as a file rather than `tsx -e`
// because the path aliases in tsconfig do not resolve for inline scripts.

import { loadDataset } from '@/lib/dataset/loader'
import { chunkPapers } from '@/lib/retrieval/chunk'

const dataset = loadDataset()
process.stdout.write(
  JSON.stringify({
    datasetId: dataset.organisation,
    asAt: dataset.asAt,
    papers: dataset.papers.length,
    chunks: chunkPapers(dataset.papers),
  }),
)
