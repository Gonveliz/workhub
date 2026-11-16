import { join } from 'node:path'
import { utilityProcess } from 'electron'
import { TranscriptReader } from './transcript-reader'

/** The transcript reader of the app: its worker in a utility process (out/main/transcript-worker.js). */
export function createTranscriptReader(log: (message: string) => void): TranscriptReader {
  return new TranscriptReader({
    log,
    spawn: () => {
      const child = utilityProcess.fork(join(__dirname, 'transcript-worker.js'), [], { serviceName: 'Workhub transcripts', stdio: 'ignore' })
      return {
        post: (m) => child.postMessage(m),
        onMessage: (fn) => child.on('message', fn),
        onExit: (fn) => child.on('exit', (code) => fn(code)),
        kill: () => child.kill()
      }
    }
  })
}
