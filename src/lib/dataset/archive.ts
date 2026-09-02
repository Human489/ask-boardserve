import { unzipSync } from 'fflate'
import { REQUIRED_FILES, type DatasetFiles } from '@/lib/dataset/loader'

// Turns an uploaded .zip into the file map the parser takes.
//
// An archive is hostile input even when it comes from a colleague. Three things
// are guarded here, none of which the dataset parser can defend itself against:
//
//   PATH TRAVERSAL  entry names are attacker-controlled and may contain ".."
//                   or absolute paths. Only the basename is ever used, and
//                   nothing is written to disk at any point.
//   DECOMPRESSION   a small archive can expand to gigabytes. Entries are
//                   filtered on their declared size BEFORE being decompressed,
//                   and the running total is capped.
//   SHAPE           only the files a dataset is made of are extracted; anything
//                   else in the archive is ignored rather than trusted.

/** Generous for a dataset of a few hundred KB, far below anything dangerous. */
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 24 * 1024 * 1024
const MAX_ENTRIES = 200

export class ArchiveError extends Error {}

function basename(path: string): string {
  const cleaned = path.replace(/\\/g, '/')
  return cleaned.slice(cleaned.lastIndexOf('/') + 1)
}

function wanted(name: string): boolean {
  return REQUIRED_FILES.includes(name) || (name.startsWith('paper-') && name.endsWith('.md'))
}

/**
 * Extracts a dataset's files from a zip archive.
 *
 * Entries are matched on basename, so an archive that wraps everything in a
 * folder — which is what zipping a directory produces — works without the
 * uploader having to know that.
 */
export function filesFromZip(archive: Uint8Array): DatasetFiles {
  let entries = 0
  let total = 0

  let unpacked: Record<string, Uint8Array>
  try {
    unpacked = unzipSync(archive, {
      filter: (file) => {
        if (file.name.endsWith('/')) return false
        const name = basename(file.name)
        if (!wanted(name)) return false
        if (++entries > MAX_ENTRIES) {
          throw new ArchiveError('That archive contains too many files.')
        }
        if (file.originalSize !== undefined) {
          if (file.originalSize > MAX_FILE_BYTES) {
            throw new ArchiveError(`${name} is too large to read.`)
          }
          total += file.originalSize
          if (total > MAX_TOTAL_BYTES) {
            throw new ArchiveError('That archive expands to more data than can be read.')
          }
        }
        return true
      },
    })
  } catch (e) {
    if (e instanceof ArchiveError) throw e
    throw new ArchiveError('That file could not be read as a .zip archive.')
  }

  const decoder = new TextDecoder('utf-8')
  const files: DatasetFiles = {}
  for (const [path, bytes] of Object.entries(unpacked)) {
    const name = basename(path)
    if (!wanted(name)) continue
    // Two files with the same name in different folders would silently
    // overwrite one another, and the reader could not tell which won.
    if (files[name] !== undefined) {
      throw new ArchiveError(`The archive contains more than one ${name}.`)
    }
    files[name] = decoder.decode(bytes)
  }

  const missing = REQUIRED_FILES.filter((f) => files[f] === undefined)
  if (missing.length > 0) {
    throw new ArchiveError(
      `The archive is missing ${missing.join(', ')}. A dataset needs ` +
        `${REQUIRED_FILES.join(', ')} and at least one paper-*.md.`,
    )
  }
  return files
}
