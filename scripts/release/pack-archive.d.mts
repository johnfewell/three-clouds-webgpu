import type { PackProvenance } from './pack-provenance.mjs'

export interface PackReceipt {
  schemaVersion: number
  archive: string
  archiveSha256: string
  package: PackProvenance['package']
  contentSha256: string
  groups: PackProvenance['groups']
  navigation: {
    documents: number
    localLinks: number
    requiredFiles: number
  }
  qualification: string
}
export function verifyArchive(tarball: string): PackReceipt
