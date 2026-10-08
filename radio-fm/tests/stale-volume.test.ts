import { expect, mock, test } from 'claude-code/testing'

// A radio-browser answer: the one feed's two stations.
const LOUNGE = [
  { name: 'Nightline', tags: '', url_resolved: 'https://radio.example.com/nightline' },
  { name: 'Driftwood', tags: '', url_resolved: 'https://radio.example.com/driftwood' },
]
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

// Found by review: a set aimed at the VLC being replaced failed, and its catch
// gave the value up for the new VLC too.
test('a failed set on the VLC being replaced still sets the new VLC', async ($, on) => {
  const clock = mock.clock(on)
  const store: Record<string, unknown> = { volume: 30 }
  const busctl: string[][] = []
  const toasts: string[] = []
  const alive = new Set<number>()
  let nextPid = 5001
  let holdList = true
  let releaseList: (() => void) | undefined
  on('store.get', (_$, e) => ({ value: store[e.key] }))
  on('store.set', (_$, e) => { store[e.key] = e.value; return { value: undefined } })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  const feeds = JSON.stringify({ feeds: [{ name: 'Lounge', source: 'radio-browser', url: 'https://dir.example.com/lounge' }] })
  on('fs.exists', (_$, e) => ({ value: e.path.endsWith('/feeds.default.json') }))
  on('fs.read', () => ({ value: feeds }))
  on('http.fetch', (_$, e) => ({
    value: { status: 200, ok: true, headers: {}, text: JSON.stringify(LOUNGE) },
  }))
  on('process.spawn', async function* () {
    const pid = nextPid++
    // tune() SIGTERMs the previous VLC just before spawning this one.
    alive.clear()
    alive.add(pid)
    try {
      yield { stream: 'stdout' as const, text: `pid ${pid}\n` }
      yield { stream: 'stderr' as const, text: 'main input debug: Buffering 0%\n' }
      while (true) await new Promise<void>(() => {})
    } finally {
      alive.delete(pid)
    }
  })
  on('process.run', async (_$, e) => {
    busctl.push([...e.argv])
    if (e.argv[2] === 'list') {
      // Snapshot of the bus as the call starts; the first one is slow.
      const lines = [...alive].map(p => `org.mpris.MediaPlayer2.vlc.instance${p} ${p} vlc george :1.${p} user@1000.service - -`)
      if (holdList) {
        holdList = false
        await new Promise<void>(resume => { releaseList = resume })
      }
      return { value: { exitCode: 0, stdout: lines.join('\n'), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const pid = Number(/instance(\d+)/.exec(e.argv[3] ?? '')?.[1])
    const ok = alive.has(pid)
    return { value: { exitCode: ok ? 0 : 1, stdout: '', stderr: ok ? '' : `Failed to set property Volume: The name ${e.argv[3]} was not provided by any .service files`, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000) // VLC A (5001) starts; its Buffering line starts a sync whose bus listing is slow
  await $.command.run({ command: 'radio-fm', args: 'nightline', ...RUN })
  await clock.advance(1000) // tune to B (5002): A is killed, appliedVolume reset
  releaseList?.() // A's listing returns; the set lands on A, now gone
  await clock.advance(1000)
  await clock.advance(1000)
  await clock.advance(1000)

  const sets = busctl.filter(a => a[2] === 'set-property').map(a => [a[3], a[a.length - 1]])
  // B (5002) gets the saved 30%, though the set aimed at A failed.
  expect(sets).toContainEqual(['org.mpris.MediaPlayer2.vlc.instance5002', '0.3'])
})
