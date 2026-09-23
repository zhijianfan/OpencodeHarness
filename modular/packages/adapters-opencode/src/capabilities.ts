export const capabilities = {
  officialSourcePackages: true,
  nativeNodeReplacement: true,
  atomicFacadeAdmission: true,
  atomicManagedReplay: true,
  privateProjectionProofFormat: true,
  privateHistoryAdapter: true,
  privateCompactionAdapter: true,
  allAdmissionEntrypoints: false,
  privateProviderReconstruction: false,
  privateCompaction: false,
  atomicPrivateReplay: false,
  currentForkMigration: false,
  supportedHostMatrix: false,
} as const

export class FullParityUnavailable extends Error {
  readonly missing = Object.entries(capabilities).filter(([, available]) => !available).map(([name]) => name)

  constructor() {
    super("Full-parity mode is unavailable; native-context, migration and host gates have not passed")
    this.name = "FullParityUnavailable"
  }
}

export function requireFullParity(): never {
  throw new FullParityUnavailable()
}
