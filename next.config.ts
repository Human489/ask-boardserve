import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  serverExternalPackages: [],

  // THE COMMITTED DATASET HAS TO BE TRACED IN EXPLICITLY, or the deployed app
  // has no default dataset at all and the commit that added it achieves
  // nothing.
  //
  // Next works out which files a serverless function needs by following its
  // imports. The loader does not import the dataset — it calls readdirSync and
  // readFileSync on `join(process.cwd(), 'dataset')` at request time, which is
  // a runtime string and invisible to that analysis. The files are in the repo
  // and simply would not be in the bundle: locally everything passes, and the
  // deployment answers 409 needsDataset for every question.
  //
  // Keyed on every route rather than the three that read a dataset today,
  // because the failure is silent and a new route that loads one would inherit
  // it. 100 kB across the function set is not worth being clever about.
  outputFileTracingIncludes: {
    '/**': ['./dataset/**'],
  },
}

export default nextConfig
