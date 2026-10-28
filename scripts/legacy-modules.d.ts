// The macOS and Linux packagers are still plain .mjs until their aria2/FFmpeg
// payloads are removed; declaring their surface keeps the TS dispatcher strict.
declare module '*.mjs' {
  export const buildDarwin: (options: {
    repoRoot: string
    target: string
    bin?: string
    stageOnly: boolean
    out?: string
    clean: boolean
  }) => Promise<void>
  export const buildLinux: (options: {
    repoRoot: string
    target: string
    bin?: string
    stageOnly: boolean
    out?: string
    clean: boolean
  }) => Promise<void>
}
