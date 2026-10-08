import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'


// A radio-browser answer for the Lounge feed, most played first.
const LOUNGE_URL = 'https://dir.example.com/json/stations/search?tag=lounge'
const LOUNGE = [
  { name: 'Driftwood', tags: '', url_resolved: 'https://radio.example.com/driftwood' },
  { name: 'Nightline', tags: '', url_resolved: 'https://radio.example.com/nightline' },
]

// radio-browser's answer: the last two are one stream under two names.
const GREEK = [
  { name: 'Zeppelin 106.7', tags: 'alternative rock,classic rock,', url_resolved: 'https://radio.example.gr/zeppelin' },
  { name: 'Ρυθμός 89.2', tags: 'greek,pop', url_resolved: 'http://s4.onweb.gr:8892/stream' },
  { name: 'sfera', tags: 'pop', url_resolved: 'https://sfera.live24.gr/sfera4132' },
  { name: 'Sfera 102.2', tags: 'greek,pop', url_resolved: 'http://sfera.live24.gr/sfera4132' },
  // Slugs to a Lounge id.
  { name: 'Nightline', tags: '', url_resolved: 'https://radio.example.gr/nightline' },
  // The directory's name for Πρώτο Κανάλι, one of the feed's own stations.
  { name: 'Kanali news', tags: 'news', url_resolved: 'https://radio.example.gr/kanali-1' },
]

// What a cvlc that plays writes: buffering done.
const PLAYS = [['main input debug: Stream buffering done (1 ms in 1 ms)\n']]

// A defaults file for the tests: the shape of the tracked feeds.default.json
// (the kit imports code only, so it is not read from there).
const DEFAULT_FEEDS = {
  feeds: [
    { name: 'Lounge', source: 'radio-browser', url: LOUNGE_URL },
    {
      name: 'Greek',
      source: 'radio-browser',
      url: 'https://dir.example.com/json/stations/search?countrycode=GR',
      stations: [
        { id: 'kanali-1', title: 'Πρώτο Κανάλι', genre: 'news, talk', url: 'https://radio.example.gr/kanali-1' },
        { id: 'kanali-2', title: 'Δεύτερο Κανάλι', genre: 'greek music', url: 'https://radio.example.gr/kanali-2' },
        { id: 'kanali-3', title: 'Τρίτο Κανάλι', genre: 'classical, culture', url: 'https://radio.example.gr/kanali-3' },
      ],
    },
  ],
}

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

const PANE_PROPS = {
  title: 'Radio',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

// The world beneath the plugin: Lounge, radio-browser, cvlc, and the UI calls.
// `isStreaming` keeps each cvlc alive until it is killed, writing a piece on
// each `pump()`; `loungeFetchesOk` makes every Lounge call after that many throw;
// `isGreekDown` fails radio-browser; `isRegisterRefused` refuses the slash
// command, as a built-in name is; `lounge` replaces the Lounge answer; `output` is
// what each cvlc writes to stderr: its first batch at once, each next one on a
// `pump()`;
// `position(child, read)` is the MPRIS Position (microseconds) the nth cvlc
// reports on its nth read, undefined for a failed read. Every cvlc is pid 4242, and another VLC (pid 111) holds the plain
// MPRIS name; `busctl` calls land in `busctl`. `stored` is what $.store holds
// from earlier sessions.
// `files` is the mod's folder as the plugin reads it (file name to text; a test
// edits it in place); `fsPaths` records each path it asked about.
const world = (
  on: On,
  {
    isStreaming = false,
    loungeFetchesOk = Infinity,
    isGreekDown = false,
    isRegisterRefused = false,
    lounge = LOUNGE,
    surfaces = ['terminal'] as string[],
    position = ((_child: number, read: number) => read * 1_000_000) as (child: number, read: number) => number | undefined,
    output = [] as string[][],
    stored = {} as Record<string, unknown>,
    files = {} as Record<string, string>,
  } = {},
) => {
  const spawned: string[][] = []
  const killed: string[] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const busctl: string[][] = []
  let waiting: (() => void)[] = []
  const pump = () => {
    const due = waiting
    waiting = []
    due.forEach(resume => resume())
  }
  let loungeFetches = 0
  const fetched: string[] = []
  const clock = mock.clock(on)
  const store = { ...stored }
  const fsPaths: string[] = []
  // The tracked defaults are on disk unless a test says otherwise.
  const disk: Record<string, string> = { 'feeds.default.json': JSON.stringify(DEFAULT_FEEDS), ...files }
  const fileOf = (path: string) => {
    fsPaths.push(path)

    return disk[path.split('/').pop() ?? '']
  }
  on('fs.exists', (_$, e) => ({ value: fileOf(e.path) !== undefined }))
  on('fs.read', (_$, e) => {
    const text = fileOf(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)

    return { value: text }
  })
  on('store.get', (_$, e) => ({ value: store[e.key] }))
  on('store.set', (_$, e) => {
    store[e.key] = e.value

    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    delete store[e.key]

    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('command.register', (_$, e) =>
    isRegisterRefused ? { deny: `"/${e.name}" refused: it is a built-in` } : { value: { command: e.name } },
  )
  on('http.fetch', (_$, e) => {
    fetched.push(e.url)
    const isLounge = e.url === LOUNGE_URL
    if (isLounge) loungeFetches += 1
    if (isLounge ? loungeFetches > loungeFetchesOk : isGreekDown) throw new Error('offline')

    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(isLounge ? lounge : GREEK) } }
  })
  on('process.spawn', async function* (_$, e) {
    const url = e.argv[e.argv.length - 1] ?? ''
    spawned.push([...e.argv])
    try {
      yield { stream: 'stdout' as const, text: 'pid 4242\n' }
      for (const [index, batch] of output.entries()) {
        if (index > 0) await new Promise<void>(resume => waiting.push(resume))
        for (const text of batch) yield { stream: 'stderr' as const, text }
      }
      while (isStreaming) {
        yield { stream: 'stdout' as const, text: 'tick\n' }
        await new Promise<void>(resume => waiting.push(resume))
      }
    } finally {
      if (isStreaming) killed.push(url)
    }

    return { value: { code: 0, signal: null } }
  })
  const positionReads = new Map<number, number>()
  on('process.run', (_$, e) => {
    busctl.push([...e.argv])
    if (e.argv[2] === 'get-property') {
      const child = spawned.length
      const read = (positionReads.get(child) ?? 0) + 1
      positionReads.set(child, read)
      const micros = position(child, read)

      return micros === undefined
        ? { value: { exitCode: 1, stdout: '', stderr: 'no such property', isStdoutTruncated: false, isStderrTruncated: false } }
        : { value: { exitCode: 0, stdout: `x ${micros}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const stdout =
      e.argv[2] === 'list'
        ? [
            'org.mpris.MediaPlayer2.vlc              111 vlc george :1.20 user@1000.service - -',
            'org.mpris.MediaPlayer2.vlc.instance4242 4242 vlc george :1.21 user@1000.service - -',
          ].join('\n')
        : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // The panes the engine has up; a test deletes one to stand for the person
  // closing it, which the kit cannot raise.
  const panes = new Set<string>()
  on('ui.open', (_$, e) => {
    panes.add(e.id)

    return { value: { isPlaced: true } }
  })
  // What draws the session: [] stands for a `claude -p` run.
  on('session.surfaces', () => ({ value: surfaces as ('terminal' | 'desktop' | 'vscode' | 'mobile')[] }))
  on('ui.panes', () => ({
    value: [...panes].map(id => ({ id, title: 'Radio', isShown: true, isFocused: false, isPlaced: true })),
  }))
  // Claude Code's own band, standing beneath the mini-player.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: 'engine band' }))

  on('ui.status', (_$, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  return { clock, pump, spawned, killed, toasts, statuses, busctl, store, panes, files: disk, fsPaths, fetched }
}

test('/radio-fm <station> starts cvlc on its playlist, and a stream that ends turns it off', async ($, on) => {
  const { clock, spawned, toasts } = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ran = await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  expect(ran.text).toBe('Tuning to Driftwood.')

  await clock.advance(1000)
  expect(spawned).toEqual([
    ['sh', '-c', 'echo "pid $$"; exec cvlc -vv --no-video --play-and-exit "$0"', 'https://radio.example.com/driftwood'],
  ])
  expect(toasts).toEqual(['radio: the stream ended'])

  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: 'Radio off' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '○ OFF' })).toBeDefined()
})

test('/radio-fm with an unknown station lists the real ones', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ran = await $.command.run({ command: 'radio-fm', args: 'polka', ...RUN })
  expect(ran.text).toBe(
    'No station "polka". Stations: driftwood, nightline, kanali-1, kanali-2, kanali-3, zeppelin-106-7, ρυθμος-89-2, sfera, nightline-greek',
  )
})

test('the pane picks a station, shows it live, and Stop clears it', async ($, on) => {
  const { clock } = world(on, { isStreaming: true, output: PLAYS })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'radio',
      surface,
      component: 'Pane',
      requestId: 'radio',
      props: PANE_PROPS,
    })
    expect(await ui.find({ key: 'stop' })).toBeUndefined()

    await ui.press({ key: 'station-lounge' })
    await ui.press({ key: 'pick-nightline' })
    // Starting until this module's cvlc plays it; then live.
    expect(await ui.find({ type: 'Text', text: '◌ 0%' })).toBeDefined()
    await clock.advance(1000)
    expect(await ui.find({ type: 'Text', text: '● LIVE' })).toBeDefined()

    await ui.press({ key: 'stop' })
    await clock.advance(1000)
    expect(await ui.find({ key: 'stop' })).toBeUndefined()
    await ui.unmount()
  }
})

test('switching stations kills the old cvlc and starts the new one', async ($, on) => {
  const { clock, pump, spawned, killed, toasts } = world(on, { isStreaming: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)
  await $.command.run({ command: 'radio-fm', args: 'nightline', ...RUN })
  await clock.advance(1000)
  pump()
  await clock.advance(1000)

  expect(spawned.map(argv => argv[argv.length - 1])).toEqual([
    'https://radio.example.com/driftwood',
    'https://radio.example.com/nightline',
  ])
  expect(killed).toEqual(['https://radio.example.com/driftwood'])
  expect(toasts).toEqual([])

  await $.command.run({ command: 'radio-fm', args: 'stop', ...RUN })
  await clock.advance(1000)
  pump()
  await clock.advance(1000)
  expect(killed).toEqual(['https://radio.example.com/driftwood', 'https://radio.example.com/nightline'])
  expect(toasts).toEqual([])
})

test('a refused command registration still leaves the player running', async ($, on) => {
  const { clock, spawned } = world(on, { isRegisterRefused: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })

  await clock.advance(1000)
  expect(spawned).toHaveLength(1)
})

test('/radio-fm plays a Greek station by its id or by its accented name', async ($, on) => {
  const { clock, spawned } = world(on, { isStreaming: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await $.command.run({ command: 'radio-fm', args: 'Ρυθμός 89.2', ...RUN })).text).toBe('Tuning to Ρυθμός 89.2.')
  await clock.advance(1000)
  expect((await $.command.run({ command: 'radio-fm', args: 'zeppelin-106-7', ...RUN })).text).toBe('Tuning to Zeppelin 106.7.')
  await clock.advance(1000)

  expect(spawned.map(argv => argv[argv.length - 1])).toEqual([
    'http://s4.onweb.gr:8892/stream',
    'https://radio.example.gr/zeppelin',
  ])

  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: 'Greek · alternative rock, classic rock' })).toBeDefined()
})

test('the Greek directory being down still leaves the Lounge stations', async ($, on) => {
  world(on, { isGreekDown: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ran = await $.command.run({ command: 'radio-fm', args: 'polka', ...RUN })
  expect(ran.text).toBe('No station "polka". Stations: driftwood, nightline, kanali-1, kanali-2, kanali-3')
})

test('a source with 80 stations draws, its list open or closed', async ($, on) => {
  const many = Array.from({ length: 80 }, (_, i) => ({ name: `Channel ${i}`, tags: '', url_resolved: `https://radio.example.com/ch${i}` }))
  world(on, { lounge: many })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'radio', surface, component: 'Pane', requestId: 'radio', props: PANE_PROPS })
    await ui.drawn()
    expect(await ui.find({ key: 'station-lounge' })).toBeDefined()
    expect(await ui.find({ key: 'station-greek' })).toBeDefined()
    // Left open by the surface before, the list must not be toggled shut.
    if ((await ui.find({ key: 'close-lounge' })) === undefined) await ui.press({ key: 'station-lounge' })
    expect(keysOf(await ui.drawn()).filter(key => key.startsWith('pick-ch'))).toHaveLength(80)
    await ui.unmount()
  }
})

test('the pane and status line show buffering until VLC says the audio started', async ($, on) => {
  const { clock, pump, statuses } = world(on, {
    isStreaming: true,
    output: [
      // A line VLC wrote in two pieces still counts.
      ['main input debug: Buffer', 'ing 40%\nmain input debug: Buffering 60%\n'],
      ['main input debug: Stream buffering done (1018 ms in 157 ms)\n'],
    ],
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)
  await clock.advance(1000)

  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: 'Buffering ▰▰▰▰▰▰▱▱▱▱ 60%' })).toBeDefined()
  expect(statuses).toContain('♪ Driftwood · buffering 60%')

  pump()
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: /Buffering/ })).toBeUndefined()
  expect(statuses.at(-1)).toBe('♪ Driftwood')
})

test('a stream that fails says why, in VLC\'s words', async ($, on) => {
  const { clock, toasts } = world(on, {
    output: [["main input error: VLC is unable to open the MRL 'x'. Check the log for details.\nmain libvlc debug: exiting\n"]],
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)

  expect(toasts).toEqual(["radio: VLC is unable to open the MRL 'x'. Check the log for details."])
})

const volumeSets = (busctl: string[][]) =>
  busctl.filter(argv => argv[2] === 'set-property').map(argv => [argv[3], argv[argv.length - 1]])

test('volume reaches our own VLC by its pid, live, from the buttons and /radio-fm vol', async ($, on) => {
  const { clock, busctl, spawned } = world(on, {
    isStreaming: true,
    output: [['main input debug: Buffering 0%\n']],
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)
  await clock.advance(1000)
  // Set as soon as VLC is up, on its own bus name, not the other VLC's.
  expect(volumeSets(busctl)).toEqual([['org.mpris.MediaPlayer2.vlc.instance4242', '1']])

  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  await ui.press({ key: 'quieter' })
  await ui.press({ key: 'quieter' })
  expect(await ui.find({ type: 'Text', text: /Vol ▰▰▰▰▰▰▰▰▱▱\s+80%/ })).toBeDefined()
  await clock.advance(1000)
  expect(volumeSets(busctl).at(-1)).toEqual(['org.mpris.MediaPlayer2.vlc.instance4242', '0.8'])

  expect((await $.command.run({ command: 'radio-fm', args: 'vol 35', ...RUN })).text).toBe('Volume 35%.')
  await clock.advance(1000)
  expect(volumeSets(busctl).at(-1)).toEqual(['org.mpris.MediaPlayer2.vlc.instance4242', '0.35'])

  // A volume change never restarts the stream.
  expect(spawned).toHaveLength(1)
  // Nothing is sent while the volume stands still.
  const sent = volumeSets(busctl).length
  await clock.advance(3000)
  expect(volumeSets(busctl)).toHaveLength(sent)
})

test('/radio-fm vol reports the level, and clamps past 100', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await $.command.run({ command: 'radio-fm', args: 'vol 250', ...RUN })).text).toBe('Volume 100%.')
  expect((await $.command.run({ command: 'radio-fm', args: 'volume 40', ...RUN })).text).toBe('Volume 40%.')
  expect((await $.command.run({ command: 'radio-fm', args: 'vol', ...RUN })).text).toBe('Volume 40%. Set it with /radio-fm vol 0-100.')
})

test('the volume is saved as it changes and comes back in the next session', async ($, on) => {
  const { store } = world(on, { stored: { volume: 30 } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'radio-fm', args: 'vol', ...RUN })).text).toBe('Volume 30%. Set it with /radio-fm vol 0-100.')

  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  await ui.press({ key: 'louder' })
  expect(store.volume).toBe(40)

  await $.command.run({ command: 'radio-fm', args: 'vol 70', ...RUN })
  expect(store.volume).toBe(70)

  // A hot reload (session.start again) keeps this session's volume, not the saved one.
  store.volume = 10
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'radio-fm', args: 'vol', ...RUN })).text).toBe('Volume 70%. Set it with /radio-fm vol 0-100.')
})

test('a fresh install with nothing saved starts at 100%', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await $.command.run({ command: 'radio-fm', args: 'vol', ...RUN })).text).toBe('Volume 100%. Set it with /radio-fm vol 0-100.')
})

test('mute silences VLC but keeps the level; unmute restores it', async ($, on) => {
  const { clock, pump, busctl, statuses, store } = world(on, {
    isStreaming: true,
    output: [['main input debug: Buffering 0%\n'], ['main input debug: Stream buffering done (1 ms in 1 ms)\n']],
    stored: { volume: 60 },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)
  pump()
  await clock.advance(1000)
  expect(volumeSets(busctl).at(-1)).toEqual(['org.mpris.MediaPlayer2.vlc.instance4242', '0.6'])

  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  await ui.press({ key: 'mute' })
  expect(await ui.find({ type: 'Text', text: /Vol ▱▱▱▱▱▱▱▱▱▱ muted \(60%\)/ })).toBeDefined()
  expect((await ui.find({ key: 'mute' }))?.text).toBe('Unmute')
  await clock.advance(1000)
  expect(volumeSets(busctl).at(-1)).toEqual(['org.mpris.MediaPlayer2.vlc.instance4242', '0'])
  expect(statuses.at(-1)).toBe('♪ Driftwood · muted')

  await ui.press({ key: 'mute' })
  await clock.advance(1000)
  expect(volumeSets(busctl).at(-1)).toEqual(['org.mpris.MediaPlayer2.vlc.instance4242', '0.6'])
  expect(statuses.at(-1)).toBe('♪ Driftwood')
  // Muting never touched the saved level.
  expect(store.volume).toBe(60)
})

test('a volume change while muted unmutes; /radio-fm mute and /radio-fm unmute say what they did', async ($, on) => {
  const { clock, busctl } = world(on, { isStreaming: true, output: [['main input debug: Buffering 0%\n']] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)

  expect((await $.command.run({ command: 'radio-fm', args: 'mute', ...RUN })).text).toBe('Muted.')
  await clock.advance(1000)
  expect(volumeSets(busctl).at(-1)?.[1]).toBe('0')

  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  await ui.press({ key: 'quieter' })
  await clock.advance(1000)
  expect(volumeSets(busctl).at(-1)?.[1]).toBe('0.9')
  expect((await ui.find({ key: 'mute' }))?.text).toBe('Mute')

  await $.command.run({ command: 'radio-fm', args: 'mute', ...RUN })
  expect((await $.command.run({ command: 'radio-fm', args: 'unmute', ...RUN })).text).toBe('Unmuted, at 90%.')
})

test('picking the same station again right after its stream ended plays it again', async ($, on) => {
  const { clock, spawned, toasts } = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)
  expect(toasts).toEqual(['radio: the stream ended'])

  // Before any further tick.
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)
  expect(spawned).toHaveLength(2)
})

test('a missing cvlc says so instead of "the stream ended"', async ($, on) => {
  const { clock, toasts } = world(on, { output: [['sh: 1: exec: cvlc: not found\n']] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)

  expect(toasts).toEqual(['radio: sh: 1: exec: cvlc: not found'])
})

test('control characters in station data never cost the pane', async ($, on) => {
  const dirty = [{ ...LOUNGE[0]!, name: 'Drift\u0007wood', tags: '\u001b[31mchill' }]
  world(on, { lounge: dirty })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })

  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  await ui.drawn()
  expect(await ui.find({ type: 'Text', text: '♪ Driftwood' })).toBeDefined()
})

test('a Greek station named like a Lounge channel stays reachable', async ($, on) => {
  const { clock, spawned } = world(on, { isStreaming: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await $.command.run({ command: 'radio-fm', args: 'nightline-greek', ...RUN })).text).toBe('Tuning to Nightline.')
  await clock.advance(1000)
  expect(spawned.at(-1)?.at(-1)).toBe('https://radio.example.gr/nightline')
})

test('the playing station stays in the pane when a refresh no longer lists it', async ($, on) => {
  const { clock, spawned, files } = world(on, { isStreaming: true, files: { 'feeds.json': JSON.stringify(DEFAULT_FEEDS) } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)
  // Its feed edited away; the next refresh reads the file again.
  files['feeds.json'] = JSON.stringify({ feeds: [DEFAULT_FEEDS.feeds[1]] })
  await clock.advance(31_000)
  await clock.advance(1000)

  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: '♪ Driftwood' })).toBeDefined()
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  expect(spawned).toHaveLength(1)
})

const listen = async (clock: { advance: (ms: number) => Promise<void> }, seconds: number) => {
  for (let i = 0; i < seconds; i++) await clock.advance(1000)
}

test('a silent stall reconnects, and the recovered stream is left alone', async ($, on) => {
  const { clock, spawned, toasts } = world(on, {
    isStreaming: true,
    // The first cvlc plays 3 s and freezes; the second plays on.
    position: (child, read) => (child === 1 ? Math.min(read, 3) : read) * 1_000_000,
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })

  await listen(clock, 60)
  expect(spawned).toHaveLength(2)
  expect(toasts).toEqual(['radio: Driftwood stalled; reconnecting'])

  await listen(clock, 120)
  expect(spawned).toHaveLength(2)
})

test('a station that never starts playing is retried, then stopped after three reconnects', async ($, on) => {
  const { clock, spawned, toasts } = world(on, { isStreaming: true, position: () => 0 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })

  await listen(clock, 150)
  expect(spawned).toHaveLength(4)
  expect(toasts).toEqual([
    'radio: Driftwood stalled; reconnecting',
    'radio: Driftwood stalled; reconnecting',
    'radio: Driftwood stalled; reconnecting',
    'radio: Driftwood keeps stalling; stopped it',
  ])

  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: 'Radio off' })).toBeDefined()
  await listen(clock, 60)
  expect(spawned).toHaveLength(4)
})

test('the watchdog never reconnects on a position it cannot read', async ($, on) => {
  const { clock, spawned, toasts } = world(on, { isStreaming: true, position: () => undefined })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })

  await listen(clock, 120)
  expect(spawned).toHaveLength(1)
  expect(toasts).toEqual([])
})

test('picking another station resets the reconnect count', async ($, on) => {
  const { clock, toasts } = world(on, { isStreaming: true, position: () => 0 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await listen(clock, 35)
  expect(toasts).toEqual(['radio: Driftwood stalled; reconnecting'])

  // Nightline gets its own three reconnects, not what Driftwood left over.
  await $.command.run({ command: 'radio-fm', args: 'nightline', ...RUN })
  await listen(clock, 150)
  expect(toasts.filter(text => text.startsWith('radio: Nightline'))).toEqual([
    'radio: Nightline stalled; reconnecting',
    'radio: Nightline stalled; reconnecting',
    'radio: Nightline stalled; reconnecting',
    'radio: Nightline keeps stalling; stopped it',
  ])
})

test('a feed\'s own stations head its dropdown and play even with its directory down', async ($, on) => {
  const { clock, spawned } = world(on, { isStreaming: true, isGreekDown: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await $.command.run({ command: 'radio-fm', args: 'kanali-3', ...RUN })).text).toBe('Tuning to Τρίτο Κανάλι.')
  await clock.advance(1000)
  expect(spawned.at(-1)?.at(-1)).toBe('https://radio.example.gr/kanali-3')

  // By its full name too.
  expect((await $.command.run({ command: 'radio-fm', args: 'Πρώτο Κανάλι', ...RUN })).text).toBe(
    'Tuning to Πρώτο Κανάλι.',
  )

  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  // Πρώτο Κανάλι plays, so the Greek row shows it rather than "Pick a station…".
  expect(await findKey(ui.drawn(), 'station-greek')).toMatchObject({
    props: { label: 'Greek  ▾ Πρώτο Κανάλι (Greek · news, talk)' },
  })
  await ui.press({ key: 'station-greek' })
  expect(keysOf(await ui.drawn()).filter(key => key.startsWith('pick-')).slice(0, 3)).toEqual([
    'pick-kanali-1',
    'pick-kanali-2',
    'pick-kanali-3',
  ])
})

// The element keyed `key` in a drawn tree, as plain data.
const findKey = (tree: unknown, key: string): unknown =>
  tree instanceof Promise ? tree.then(drawn => findIn(drawn, key)) : findIn(tree, key)

// Every key in a drawn tree, in document order.
const keysOf = (node: unknown): string[] => {
  if (typeof node !== 'object' || node === null) return []
  const element = node as { props?: { key?: string }; children?: unknown[] }

  return [...(element.props?.key === undefined ? [] : [element.props.key]), ...(element.children ?? []).flatMap(keysOf)]
}

const findIn = (node: unknown, key: string): unknown => {
  if (typeof node !== 'object' || node === null) return undefined
  const element = node as { props?: { key?: string }; children?: unknown[] }
  if (element.props?.key === key) return element

  return (element.children ?? []).map(child => findIn(child, key)).find(Boolean)
}

test('the pane draws every state on every surface, narrow and wide, with the right badge', async ($, on) => {
  const { clock, pump } = world(on, {
    isStreaming: true,
    output: [['main input debug: Buffering 60%\n'], ['main input debug: Stream buffering done (1 ms in 1 ms)\n']],
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })

  const drawAll = async (badge: string) => {
    for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
      for (const [bodyColumns, isFocused] of [[24, false], [120, true]] as const) {
        const ui = await $.ui.mount({
          plugin: 'radio', surface, component: 'Pane', requestId: 'radio',
          props: { ...PANE_PROPS, bodyColumns, isFocused },
        })
        await ui.drawn()
        expect(await ui.find({ type: 'Text', text: badge })).toBeDefined()
        // The wide hint and the compact one ("Focus the pane for the keys.").
        expect(await ui.find({ type: 'Text', text: /pane has focus|Focus the pane/ })).toEqual(
          isFocused ? undefined : expect.anything(),
        )
        await ui.unmount()
      }
    }
  }

  await drawAll('○ OFF')
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)
  await drawAll('◌ 60%')
  pump()
  await clock.advance(1000)
  await drawAll('● LIVE')
  await $.command.run({ command: 'radio-fm', args: 'mute', ...RUN })
  await drawAll('● MUTED')
})

test('the controls show their hotkeys, and Stop only while a station plays', async ($, on) => {
  const { clock } = world(on, { isStreaming: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })

  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  const button = (key: string) => findKey(ui.drawn(), key)
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  for (const [key, hotkey] of [['quieter', '9'], ['louder', '0'], ['mute', 'm']] as const) {
    expect(await button(key)).toMatchObject({ props: { plain: true, hotkey } })
  }

  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)
  expect(await button('stop')).toMatchObject({ props: { plain: true, hotkey: 's', label: 'Stop' } })
})

test('the equalizer moves while audio flows and lies flat otherwise', async ($, on) => {
  const { clock, pump } = world(on, {
    isStreaming: true,
    output: [['main input debug: Buffering 60%\n'], ['main input debug: Stream buffering done (1 ms in 1 ms)\n']],
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  const bars = async () => (await ui.find({ type: 'Text', in: 'equalizer' }))?.text

  // Off: no equalizer at all.
  expect(await ui.find({ key: 'equalizer' })).toBeUndefined()

  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)
  // Buffering: flat.
  expect(await bars()).toBe('▁▁▁▁▁▁▁')
  await ui.advance(360)
  expect(await bars()).toBe('▁▁▁▁▁▁▁')

  pump()
  await clock.advance(1000)
  // Live: seven bars that change from frame to frame.
  const frames = new Set<string | undefined>()
  for (let i = 0; i < 5; i++) {
    const frame = await bars()
    expect(frame).toMatch(/^[▁▂▃▄▅▆▇█]{7}$/)
    frames.add(frame)
    await ui.advance(120)
  }
  expect(frames.size).toBeGreaterThan(1)

  // Muted: flat again.
  await $.command.run({ command: 'radio-fm', args: 'mute', ...RUN })
  await ui.advance(360)
  expect(await bars()).toBe('▁▁▁▁▁▁▁')
})

test('VS Code, which draws no Client, gets the bars standing still', async ($, on) => {
  const { clock } = world(on, { isStreaming: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)

  const ui = await $.ui.mount({ plugin: 'radio', surface: 'vscode', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  await ui.drawn()
  expect(await ui.find({ key: 'equalizer' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '▁▁▁▁▁▁▁' })).toBeDefined()
})

const recentIds = (store: Record<string, unknown>) => (store.recent as { id: string }[] | undefined)?.map(c => c.id)

test('a station joins Recent once it actually plays: newest first, five at most, saved', async ($, on) => {
  const { clock, store } = world(on, { isStreaming: true, output: PLAYS })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const id of ['driftwood', 'nightline', 'zeppelin-106-7', 'ρυθμος-89-2', 'sfera', 'kanali-1']) {
    await $.command.run({ command: 'radio-fm', args: id, ...RUN })
    await clock.advance(1000)
  }
  expect(recentIds(store)).toEqual(['kanali-1', 'sfera', 'ρυθμος-89-2', 'zeppelin-106-7', 'nightline'])

  // Playing one again moves it to the front instead of listing it twice.
  await $.command.run({ command: 'radio-fm', args: 'zeppelin-106-7', ...RUN })
  await clock.advance(1000)
  expect(recentIds(store)).toEqual(['zeppelin-106-7', 'kanali-1', 'sfera', 'ρυθμος-89-2', 'nightline'])
})

test('a station that never played stays out of Recent', async ($, on) => {
  const { clock, store } = world(on, {
    output: [["main input error: VLC is unable to open the MRL 'x'. Check the log for details.\n"]],
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)

  expect(store.recent).toBeUndefined()
})

test('Recent sits above the pickers with hotkeys 1-5, marks what plays, and replays on a press', async ($, on) => {
  const { clock, spawned } = world(on, { isStreaming: true, output: PLAYS })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const id of ['driftwood', 'nightline']) {
    await $.command.run({ command: 'radio-fm', args: id, ...RUN })
    await clock.advance(1000)
  }
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })

  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  expect(await findKey(ui.drawn(), 'recent-1')).toMatchObject({
    props: { plain: true, hotkey: '1', dimColor: true, label: '♪ Nightline (Lounge)' },
  })
  expect(await findKey(ui.drawn(), 'recent-2')).toMatchObject({
    props: { plain: true, hotkey: '2', dimColor: false, label: 'Driftwood (Lounge)' },
  })
  // Recent comes before the pickers.
  const order = JSON.stringify(await ui.drawn())
  expect(order.indexOf('recent-1')).toBeLessThan(order.indexOf('station-lounge'))

  await ui.press({ key: 'recent-2' })
  await clock.advance(1000)
  expect(spawned.at(-1)?.at(-1)).toBe('https://radio.example.com/driftwood')
})

test('Recent comes back in a new session and still plays a station its source dropped', async ($, on) => {
  const gone = {
    id: 'old-favourite', title: 'Old Favourite 99.9', genre: 'Greek · laika', listeners: null,
    nowPlaying: '', url: 'https://radio.example.gr/old', source: 'greek',
  }
  const { clock, spawned } = world(on, { isStreaming: true, stored: { recent: [gone] } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })

  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  expect(await findKey(ui.drawn(), 'recent-1')).toMatchObject({ props: { label: 'Old Favourite 99.9 (Greek · laika)' } })

  expect((await $.command.run({ command: 'radio-fm', args: 'old-favourite', ...RUN })).text).toBe('Tuning to Old Favourite 99.9.')
  await clock.advance(1000)
  expect(spawned.at(-1)?.at(-1)).toBe('https://radio.example.gr/old')
  expect(await ui.find({ type: 'Text', text: '♪ Old Favourite 99.9' })).toBeDefined()
})

test('a narrow sidebar gets the compact layout; 48 columns and up keep the card', async ($, on) => {
  const longName = 'The Very Long Name Of A Station That Never Ends'
  const lounge = { name: 'Lounge', stations: [
    { id: 'driftwood', title: longName, url: LOUNGE[0]!.url_resolved },
    { id: 'nightline', title: 'Nightline', url: LOUNGE[1]!.url_resolved },
  ] }
  const { clock } = world(on, { isStreaming: true, output: PLAYS, files: { 'feeds.json': JSON.stringify({ feeds: [lounge, DEFAULT_FEEDS.feeds[1]] }) } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })

  const mount = (bodyColumns: number) =>
    $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: { ...PANE_PROPS, bodyColumns } })

  const narrow = await mount(30)
  expect(await findKey(narrow.drawn(), 'card')).not.toMatchObject({ props: { borderStyle: expect.anything() } })
  expect(await findKey(narrow.drawn(), 'title-row')).toMatchObject({ props: { flexDirection: 'column' } })
  expect(await narrow.find({ type: 'Text', text: /^Vol ▰▰▰▰▰ 100%$/ })).toBeDefined()
  // Recent: no genre, cut to the 25 columns left beside "1: " and " ✕".
  const recentLabel = ((await findKey(narrow.drawn(), 'recent-1')) as { props: { label: string } }).props.label
  expect(recentLabel).toBe(`♪ ${longName}`.slice(0, 24) + '…')
  await narrow.press({ key: 'station-lounge' })
  const pickLabel = async (key: string) => ((await findKey(narrow.drawn(), key)) as { props: { label: string } }).props.label
  // No genre; cut to the 28 columns left beside the list's indent.
  expect(await pickLabel('pick-driftwood')).toBe(`♪ ${longName}`.slice(0, 27) + '…')
  expect(await pickLabel('pick-nightline')).toBe('Nightline')
  await narrow.unmount()

  const wide = await mount(60)
  expect(await findKey(wide.drawn(), 'card')).toMatchObject({ props: { borderStyle: 'round' } })
  expect(await findKey(wide.drawn(), 'title-row')).toMatchObject({ props: { flexDirection: 'row' } })
  expect(await wide.find({ type: 'Text', text: /^Vol ▰▰▰▰▰▰▰▰▰▰ 100%$/ })).toBeDefined()
  await wide.unmount()

  for (const [bodyColumns, border] of [[47, undefined], [48, 'round']] as const) {
    const ui = await mount(bodyColumns)
    expect(((await findKey(ui.drawn(), 'card')) as { props: { borderStyle?: string } }).props.borderStyle).toBe(border)
    await ui.unmount()
  }
})

test('the ✕ beside a recent station removes it, saved, and the rest move up', async ($, on) => {
  const { clock, store, spawned } = world(on, { isStreaming: true, output: PLAYS })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const id of ['driftwood', 'nightline', 'zeppelin-106-7']) {
    await $.command.run({ command: 'radio-fm', args: id, ...RUN })
    await clock.advance(1000)
  }
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  expect(await findKey(ui.drawn(), 'forget-2')).toMatchObject({ props: { plain: true, label: '✕' } })

  await ui.press({ key: 'forget-2' })
  expect(recentIds(store)).toEqual(['zeppelin-106-7', 'driftwood'])
  expect(await findKey(ui.drawn(), 'recent-2')).toMatchObject({ props: { label: 'Driftwood (Lounge)' } })
  expect(await findKey(ui.drawn(), 'recent-3')).toBeUndefined()

  // Removing the playing station leaves it playing.
  await ui.press({ key: 'forget-1' })
  await clock.advance(1000)
  expect(recentIds(store)).toEqual(['driftwood'])
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  expect(spawned).toHaveLength(3)
})

test('/radio-fm forget removes by id or name, and says when there is nothing to remove', async ($, on) => {
  const { clock, store } = world(on, { isStreaming: true, output: PLAYS })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const id of ['driftwood', 'kanali-3']) {
    await $.command.run({ command: 'radio-fm', args: id, ...RUN })
    await clock.advance(1000)
  }

  const run = async (args: string) => (await $.command.run({ command: 'radio-fm', args, ...RUN })).text
  expect(await run('forget')).toBe('Forget which? Recent: kanali-3, driftwood. Or /radio-fm forget all.')
  expect(await run('forget Τρίτο Κανάλι')).toBe('Removed Τρίτο Κανάλι from Recent.')
  expect(await run('forget polka')).toBe('"polka" isn\'t in Recent (driftwood).')
  expect(await run('forget driftwood')).toBe('Removed Driftwood from Recent.')
  expect(recentIds(store)).toEqual([])
  expect(await run('forget')).toBe('Forget which? Recent: nothing yet. Or /radio-fm forget all.')
})

test('a rebuffer mid-play never puts a removed station back', async ($, on) => {
  const { clock, pump, store } = world(on, {
    isStreaming: true,
    output: [
      ['main input debug: Stream buffering done (1 ms in 1 ms)\n'],
      ['main input debug: Buffering 30%\nmain input debug: Stream buffering done (1 ms in 1 ms)\n'],
    ],
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)
  expect(recentIds(store)).toEqual(['driftwood'])

  await $.command.run({ command: 'radio-fm', args: 'forget driftwood', ...RUN })
  pump()
  await clock.advance(1000)
  expect(recentIds(store)).toEqual([])
})

test('Clear empties Recent, saved, and the music plays on; /radio-fm forget all does the same', async ($, on) => {
  const { clock, store, spawned } = world(on, { isStreaming: true, output: PLAYS })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const id of ['driftwood', 'nightline']) {
    await $.command.run({ command: 'radio-fm', args: id, ...RUN })
    await clock.advance(1000)
  }
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  expect(await findKey(ui.drawn(), 'forget-all')).toMatchObject({ props: { plain: true, label: 'Clear' } })
  expect(await findKey(ui.drawn(), 'forget-all')).not.toMatchObject({ props: { hotkey: expect.anything() } })

  await ui.press({ key: 'forget-all' })
  expect(store.recent).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'Recent' })).toBeUndefined()
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  expect(spawned).toHaveLength(2)

  const run = async (args: string) => (await $.command.run({ command: 'radio-fm', args, ...RUN })).text
  expect(await run('forget all')).toBe('Recent is already empty.')
  await run('driftwood')
  await clock.advance(1000)
  expect(await run('forget all')).toBe('Cleared Recent (1).')
  expect(store.recent).toEqual([])
})

test('a station list opens on its row and closes on a pick, on its row, on Close, and when the other opens', async ($, on) => {
  const { clock, spawned } = world(on, { isStreaming: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  const isOpen = async (source: string) => (await ui.find({ key: `close-${source}` })) !== undefined

  expect(await isOpen('lounge')).toBe(false)
  await ui.press({ key: 'station-lounge' })
  expect(await isOpen('lounge')).toBe(true)
  expect(await findKey(ui.drawn(), 'station-lounge')).toMatchObject({ props: { label: 'Lounge ▴ Pick a station…' } })

  await ui.press({ key: 'station-lounge' })
  expect(await isOpen('lounge')).toBe(false)

  await ui.press({ key: 'station-lounge' })
  await ui.press({ key: 'close-lounge' })
  expect(await isOpen('lounge')).toBe(false)

  await ui.press({ key: 'station-lounge' })
  await ui.press({ key: 'station-greek' })
  expect(await isOpen('lounge')).toBe(false)
  expect(await isOpen('greek')).toBe(true)

  await ui.press({ key: 'pick-zeppelin-106-7' })
  expect(await isOpen('greek')).toBe(false)
  await clock.advance(1000)
  expect(spawned.at(-1)?.at(-1)).toBe('https://radio.example.gr/zeppelin')
})

test('Esc, which takes the keyboard from the pane, hides an open list at once and it stays closed', async ($, on) => {
  const { clock } = world(on, { isStreaming: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })

  await ui.press({ key: 'station-lounge' })
  expect(await ui.find({ key: 'pick-driftwood' })).toBeDefined()

  await ui.redraw({ ...PANE_PROPS, isFocused: false })
  expect(await ui.find({ key: 'pick-driftwood' })).toBeUndefined()

  await clock.advance(1000)
  await ui.redraw({ ...PANE_PROPS, isFocused: true })
  expect(await ui.find({ key: 'pick-driftwood' })).toBeUndefined()
  expect(await findKey(ui.drawn(), 'station-lounge')).toMatchObject({ props: { label: 'Lounge ▾ Pick a station…' } })
})


// ── Resume on start ──────────────────────────────────────────────────────────

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

test('a new session resumes the station that was playing when the last one ended', async ($, on) => {
  const { clock, spawned } = world(on, { isStreaming: true, stored: { lastStation: 'driftwood' } })
  await $.session.start(START)
  await clock.advance(1000)

  expect(spawned.map(argv => argv.at(-1))).toEqual(['https://radio.example.com/driftwood'])
})

test('with Resume on start off, a new session stays quiet', { options: { resumeOnStart: false } }, async ($, on) => {
  const { clock, spawned } = world(on, { isStreaming: true, stored: { lastStation: 'driftwood' } })
  await $.session.start(START)
  await clock.advance(3000)

  expect(spawned).toEqual([])
})

const END = { reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } } as const

test('what plays when the session ends is saved; nothing is, after a stop', async ($, on) => {
  const { clock, store } = world(on, { isStreaming: true, output: PLAYS })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: 'nightline', ...RUN })
  await clock.advance(1000)
  // Not while it plays: another session opened now must find nothing to resume.
  expect(store.lastStation).toBeUndefined()

  await $.session.end(END)
  expect(store.lastStation).toBe('nightline')
})

test('a station stopped before the session ends is not resumed', async ($, on) => {
  const { clock, store } = world(on, { isStreaming: true, output: PLAYS })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: 'nightline', ...RUN })
  await clock.advance(1000)
  await $.command.run({ command: 'radio-fm', args: 'stop', ...RUN })
  await clock.advance(1000)

  await $.session.end(END)
  expect(store.lastStation).toBeUndefined()
})

test('a new session claims the saved station, so one opened beside it finds nothing', async ($, on) => {
  const { store } = world(on, { stored: { lastStation: 'driftwood' } })
  await $.session.start(START)

  expect(store.lastStation).toBeUndefined()
})

test('/clear saves nothing: its process goes on playing', async ($, on) => {
  const { clock, store } = world(on, { isStreaming: true, output: PLAYS })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: 'nightline', ...RUN })
  await clock.advance(1000)

  await $.session.end({ ...END, reason: 'clear' })
  expect(store.lastStation).toBeUndefined()
})

test('a headless run never plays, and hands the claimed station back at its end', async ($, on) => {
  const { clock, spawned, store } = world(on, { isStreaming: true, surfaces: [], stored: { lastStation: 'driftwood' } })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await clock.advance(3000)
  expect(spawned).toEqual([])

  await $.session.end(END)
  expect(store.lastStation).toBe('driftwood')
})

test('a resume that could not play (both lists unreachable) is handed back for next time', async ($, on) => {
  const { clock, spawned, store, toasts } = world(on, {
    isStreaming: true, loungeFetchesOk: 0, isGreekDown: true, stored: { lastStation: 'driftwood' },
  })
  await $.session.start(START)
  await clock.advance(2000)
  expect(spawned).toEqual([])
  expect(toasts.at(-1)).toMatch(/^radio: /)

  await $.session.end(END)
  expect(store.lastStation).toBe('driftwood')
})

test('a resumed station that played and was then stopped is not resumed again', async ($, on) => {
  const { clock, store } = world(on, { isStreaming: true, output: PLAYS, stored: { lastStation: 'driftwood' } })
  await $.session.start(START)
  await clock.advance(1000)
  await $.command.run({ command: 'radio-fm', args: 'stop', ...RUN })
  await clock.advance(1000)

  await $.session.end(END)
  expect(store.lastStation).toBeUndefined()
})

test('a saved station that is in neither list says so once, instead of retrying every second', async ($, on) => {
  const { clock, spawned, toasts } = world(on, { isStreaming: true, stored: { lastStation: 'long-gone' } })
  await $.session.start(START)
  await clock.advance(5000)

  expect(spawned).toEqual([])
  expect(toasts).toEqual(['radio: "long-gone" is in neither station list right now'])
})

test('a hot reload never resumes, even with a station saved', async ($, on) => {
  const { clock, spawned, store } = world(on, { isStreaming: true })
  await $.session.start(START)
  await clock.advance(1000)
  store.lastStation = 'driftwood'

  // session.start again: the module reloading mid-session.
  await $.session.start(START)
  await clock.advance(3000)
  expect(spawned).toEqual([])
})

// ── Search ───────────────────────────────────────────────────────────────────

const resultKeys = async (ui: { drawn: () => Promise<unknown> }) =>
  keysOf(await ui.drawn()).filter(key => key.startsWith('result-'))

test('search finds stations by every word of name or genre, case and accents aside; the pickers step aside', async ($, on) => {
  world(on)
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  const type = (text: string) => ui.input({ key: 'search', text, kind: 'change' })

  await type('NIGHT')
  expect(await resultKeys(ui)).toEqual(['result-nightline', 'result-nightline-greek'])
  expect(await ui.find({ key: 'station-lounge' })).toBeUndefined()

  await type('ρυθμος')
  expect(await resultKeys(ui)).toEqual(['result-ρυθμος-89-2'])
  await type('classical')
  expect(await resultKeys(ui)).toEqual(['result-kanali-3'])
  await type('greek pop')
  expect(await resultKeys(ui)).toEqual(['result-ρυθμος-89-2', 'result-sfera'])

  await type('polka')
  expect(await resultKeys(ui)).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'No station matches “polka”.' })).toBeDefined()

  await ui.press({ key: 'search-clear' })
  expect(await ui.find({ key: 'station-lounge' })).toBeDefined()
  expect(await ui.find({ key: 'search-clear' })).toBeUndefined()
})

test('Enter plays the first match and a result plays when pressed; either clears the search', async ($, on) => {
  const { clock, spawned } = world(on, { isStreaming: true })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })

  await ui.input({ key: 'search', text: 'zeppelin' })
  await clock.advance(1000)
  expect(spawned.at(-1)?.at(-1)).toBe('https://radio.example.gr/zeppelin')
  expect(await ui.find({ key: 'station-lounge' })).toBeDefined()

  await ui.input({ key: 'search', text: 'night', kind: 'change' })
  await ui.press({ key: 'result-nightline' })
  await clock.advance(1000)
  expect(spawned.at(-1)?.at(-1)).toBe('https://radio.example.com/nightline')
  expect(await resultKeys(ui)).toEqual([])

  // Enter with nothing matching plays nothing.
  await ui.input({ key: 'search', text: 'polka' })
  await clock.advance(1000)
  expect(spawned).toHaveLength(2)
})

test('search shows twelve results and says how many more there are', async ($, on) => {
  const many = Array.from({ length: 80 }, (_, i) => ({ name: `Channel ${i}`, tags: '', url_resolved: `https://radio.example.com/ch${i}` }))
  world(on, { lounge: many })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })

  await ui.input({ key: 'search', text: 'channel', kind: 'change' })
  expect(await resultKeys(ui)).toHaveLength(12)
  expect(await ui.find({ type: 'Text', text: '68 more: type more of the name.' })).toBeDefined()
})

// ── Mini-player above the prompt ─────────────────────────────────────────────

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 3,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 3 },
  view: {},
} as const

test('the mini-player shows while a station plays and the pane is closed, and its controls work', async ($, on) => {
  const { clock, pump } = world(on, {
    isStreaming: true,
    output: [['main input debug: Buffering 50%\n'], ['main input debug: Stream buffering done (1 ms in 1 ms)\n']],
  })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)
  const band = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })

  expect(await band.find({ type: 'Text', text: '♪ Driftwood' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '◌ 50%' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '· buffering ▰▰▰▱▱' })).toBeDefined()
  pump()
  await clock.advance(1000)
  expect(await band.find({ type: 'Text', text: '● LIVE' })).toBeDefined()
  expect(await band.find({ key: 'band-equalizer' })).toBeDefined()
  for (const [key, hotkey] of [['band-mute', 'm'], ['band-stop', 's'], ['band-open', 'o']] as const) {
    expect(await findKey(band.drawn(), key)).toMatchObject({ props: { plain: true, hotkey } })
  }

  await band.press({ key: 'band-mute' })
  expect(await band.find({ type: 'Text', text: '● MUTED' })).toBeDefined()
  expect(await findKey(band.drawn(), 'band-mute')).toMatchObject({ props: { label: 'Unmute' } })

  await band.press({ key: 'band-stop' })
  await clock.advance(1000)
  expect(await band.find({ key: 'band-stop' })).toBeUndefined()
})

test('the mini-player steps aside with nothing playing, while the pane is open, and for a survey', async ($, on) => {
  const { clock, panes } = world(on, { isStreaming: true })
  await $.session.start(START)
  const isShown = async (props: { hasSurvey?: boolean } = {}) => {
    const band = await $.ui.mount({
      plugin: 'radio', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, ...props },
    })
    const shown = (await band.find({ key: 'band-stop' })) !== undefined
    if (!shown) expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await band.unmount()

    return shown
  }

  expect(await isShown()).toBe(false)

  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)
  expect(await isShown()).toBe(true)
  expect(await isShown({ hasSurvey: true })).toBe(false)

  // /radio-fm opens the pane: the band yields at once.
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  expect(await isShown()).toBe(false)
  // The person closes it: within a tick the band is back.
  panes.delete('radio')
  await clock.advance(1000)
  expect(await isShown()).toBe(true)
})

test('Open on the mini-player opens the pane, and the band yields to it', async ($, on) => {
  const { clock } = world(on, { isStreaming: true })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)
  const band = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })

  await band.press({ key: 'band-open' })
  await clock.advance(1000)
  expect(await band.find({ key: 'band-stop' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined()
})

test('a narrow mini-player keeps its controls and drops the bars; every surface draws it', async ($, on) => {
  const { clock } = world(on, { isStreaming: true, output: PLAYS })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    for (const bodyColumns of [40, 79, 80, 160]) {
      const band = await $.ui.mount({
        plugin: 'radio', surface, component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns },
      })
      await band.drawn()
      const isWide = bodyColumns >= 80
      expect(await band.find({ key: 'band-stop' })).toBeDefined()
      const bars = surface === 'vscode' ? await band.find({ type: 'Text', text: '▃▅▇▅▂▆▄' }) : await band.find({ key: 'band-equalizer' })
      expect(bars !== undefined).toBe(isWide)
      await band.unmount()
    }
  }
})

test('Enter on an empty or blank Search plays nothing', async ($, on) => {
  const { clock, spawned } = world(on, { isStreaming: true })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })

  await ui.input({ key: 'search', text: '' })
  await ui.input({ key: 'search', text: '   ' })
  await clock.advance(1000)
  expect(spawned).toEqual([])
})

test('a control character typed into Search never costs the pane', async ($, on) => {
  world(on)
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })

  await ui.input({ key: 'search', text: '\u0007night', kind: 'change' })
  await ui.drawn()
  expect(await resultKeys(ui)).toEqual(['result-nightline', 'result-nightline-greek'])
})

test('search folds a final sigma, finds stations only Recent keeps, and closes an open list on a pick', async ($, on) => {
  const gone = {
    id: 'old-favourite', title: 'Old Favourite 99.9', genre: 'Greek · laika', listeners: null,
    nowPlaying: '', url: 'https://radio.example.gr/old', source: 'greek',
  }
  const { clock } = world(on, { isStreaming: true, stored: { recent: [gone] } })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  const type = (text: string) => ui.input({ key: 'search', text, kind: 'change' })

  await type('ρυθμοσ')
  expect(await resultKeys(ui)).toEqual(['result-ρυθμος-89-2'])
  await type('ΡΥΘΜΟΣ')
  expect(await resultKeys(ui)).toEqual(['result-ρυθμος-89-2'])
  await type('laika')
  expect(await resultKeys(ui)).toEqual(['result-old-favourite'])

  await type('')
  await ui.press({ key: 'station-lounge' })
  await type('zeppelin')
  await ui.press({ key: 'result-zeppelin-106-7' })
  await clock.advance(1000)
  expect(await ui.find({ key: 'close-lounge' })).toBeUndefined()
})

test('the mini-player says starting, not LIVE, until this module plays the station', async ($, on) => {
  const { clock } = world(on, { isStreaming: true, output: PLAYS })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  const band = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })

  expect(await band.find({ type: 'Text', text: '◌ 0%' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '● LIVE' })).toBeUndefined()
  await clock.advance(1000)
  expect(await band.find({ type: 'Text', text: '● LIVE' })).toBeDefined()
})

const favoriteIds = (store: Record<string, unknown>) => (store.favorites as { id: string }[] | undefined)?.map(c => c.id)

test('Star (f) stars the playing station, saved, and Unstar takes it back; no Star with nothing playing', async ($, on) => {
  const { clock, store } = world(on, { isStreaming: true, output: PLAYS })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  expect(await ui.find({ key: 'favorite' })).toBeUndefined()

  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)
  expect(await findKey(ui.drawn(), 'favorite')).toMatchObject({ props: { plain: true, hotkey: 'f', label: '☆ Star' } })

  await ui.press({ key: 'favorite' })
  expect(favoriteIds(store)).toEqual(['driftwood'])
  expect(await findKey(ui.drawn(), 'favorite')).toMatchObject({ props: { label: '★ Unstar' } })

  // Starred in the order starred, not moved by playing.
  await $.command.run({ command: 'radio-fm', args: 'nightline', ...RUN })
  await clock.advance(1000)
  await ui.press({ key: 'favorite' })
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)
  expect(favoriteIds(store)).toEqual(['driftwood', 'nightline'])

  await ui.press({ key: 'favorite' })
  expect(favoriteIds(store)).toEqual(['nightline'])
  expect(await findKey(ui.drawn(), 'favorite')).toMatchObject({ props: { label: '☆ Star' } })
})

test('Favorites sit above Recent and the pickers, mark what plays, replay on a press, and ✕ unstars', async ($, on) => {
  const { clock, spawned, store } = world(on, { isStreaming: true, output: PLAYS })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  for (const id of ['driftwood', 'nightline']) {
    await $.command.run({ command: 'radio-fm', args: id, ...RUN })
    await clock.advance(1000)
    await ui.press({ key: 'favorite' })
  }

  expect(await ui.find({ type: 'Text', text: 'Favorites' })).toBeDefined()
  expect(await findKey(ui.drawn(), 'favorite-driftwood')).toMatchObject({
    props: { plain: true, dimColor: false, label: 'Driftwood (Lounge)' },
  })
  expect(await findKey(ui.drawn(), 'favorite-nightline')).toMatchObject({
    props: { dimColor: true, label: '♪ Nightline (Lounge)' },
  })
  const order = keysOf(await ui.drawn())
  expect(order.indexOf('favorite-driftwood')).toBeLessThan(order.indexOf('recent-1'))
  expect(order.indexOf('recent-1')).toBeLessThan(order.indexOf('station-lounge'))

  await ui.press({ key: 'favorite-driftwood' })
  await clock.advance(1000)
  expect(spawned.at(-1)?.at(-1)).toBe('https://radio.example.com/driftwood')

  // Unstarring the playing station leaves it playing.
  await ui.press({ key: 'unstar-driftwood' })
  await clock.advance(1000)
  expect(favoriteIds(store)).toEqual(['nightline'])
  expect(await ui.find({ key: 'favorite-driftwood' })).toBeUndefined()
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  expect(spawned).toHaveLength(3)

  await ui.press({ key: 'unstar-nightline' })
  expect(favoriteIds(store)).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'Favorites' })).toBeUndefined()
})

test('Favorites come back in a new session, play a station their source dropped, and search finds it once', async ($, on) => {
  const gone = {
    id: 'old-favourite', title: 'Old Favourite 99.9', genre: 'Greek · laika', listeners: null,
    nowPlaying: '', url: 'https://radio.example.gr/old', source: 'greek',
  }
  // In both saved lists: still one row in search.
  const { clock, spawned } = world(on, { isStreaming: true, stored: { favorites: [gone], recent: [gone] } })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  expect(await findKey(ui.drawn(), 'favorite-old-favourite')).toMatchObject({ props: { label: 'Old Favourite 99.9 (Greek · laika)' } })

  await ui.input({ key: 'search', text: 'laika', kind: 'change' })
  expect(await resultKeys(ui)).toEqual(['result-old-favourite'])
  await ui.input({ key: 'search', text: '', kind: 'change' })

  expect((await $.command.run({ command: 'radio-fm', args: 'old-favourite', ...RUN })).text).toBe('Tuning to Old Favourite 99.9.')
  await clock.advance(1000)
  expect(spawned.at(-1)?.at(-1)).toBe('https://radio.example.gr/old')
  expect(await findKey(ui.drawn(), 'favorite')).toMatchObject({ props: { label: '★ Unstar' } })
})

test('a favorite its source dropped plays from Favorites alone, and the mini-player shows it', async ($, on) => {
  const gone = {
    id: 'old-favourite', title: 'Old Favourite 99.9', genre: 'Greek · laika', listeners: null,
    nowPlaying: '', url: 'https://radio.example.gr/old', source: 'greek',
  }
  const { clock, spawned, toasts } = world(on, { isStreaming: true, stored: { favorites: [gone] } })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: 'old-favourite', ...RUN })
  await clock.advance(1000)
  expect(spawned.at(-1)?.at(-1)).toBe('https://radio.example.gr/old')
  expect(toasts).toEqual([])

  const band = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await band.find({ type: 'Text', text: /Old Favourite 99\.9/ })).toBeDefined()

  const ui = await $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: '♪ Old Favourite 99.9' })).toBeDefined()
  expect(await findKey(ui.drawn(), 'favorite')).toMatchObject({ props: { label: '★ Unstar' } })
})

test('a narrow pane cuts a favorite to the columns beside its ✕, with no genre', async ($, on) => {
  const longName = 'The Very Long Name Of A Station That Never Ends'
  const lounge = { name: 'Lounge', stations: [
    { id: 'driftwood', title: longName, url: LOUNGE[0]!.url_resolved },
    { id: 'nightline', title: 'Nightline', url: LOUNGE[1]!.url_resolved },
  ] }
  const { clock } = world(on, { isStreaming: true, output: PLAYS, files: { 'feeds.json': JSON.stringify({ feeds: [lounge, DEFAULT_FEEDS.feeds[1]] }) } })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  const ui = await $.ui.mount({
    plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: { ...PANE_PROPS, bodyColumns: 30 },
  })
  await ui.press({ key: 'favorite' })

  const label = ((await findKey(ui.drawn(), 'favorite-driftwood')) as { props: { label: string } }).props.label
  expect(label).toBe(`♪ ${longName}`.slice(0, 27) + '…')
})

test('a station whose stream is not http(s) never reaches cvlc, so it cannot pass VLC an option', async ($, on) => {
  const evil = {
    id: 'evil', title: 'Evil FM', genre: 'Greek', listeners: null,
    nowPlaying: '', url: '--sout=file/ts:/tmp/owned', source: 'greek',
  }
  const { clock, spawned, toasts } = world(on, { isStreaming: true, stored: { favorites: [evil] } })
  await $.session.start(START)

  expect((await $.command.run({ command: 'radio-fm', args: 'evil', ...RUN })).text).toBe('Tuning to Evil FM.')
  await clock.advance(3000)
  expect(spawned).toEqual([])
  // Said once, then off: the tick does not retry it every second.
  expect(toasts).toEqual(['radio: Evil FM has no http(s) stream; not playing it'])

  // An http(s) station still plays.
  await $.command.run({ command: 'radio-fm', args: 'driftwood', ...RUN })
  await clock.advance(1000)
  expect(spawned.at(-1)?.at(-1)).toBe('https://radio.example.com/driftwood')
})


const JAZZ = {
  name: 'Jazz',
  stations: [
    { title: 'Jazz24', url: 'https://jazz.example.com/jazz24.mp3' },
    { title: 'KCSM', url: 'http://jazz.example.com/kcsm' },
  ],
}
const [LOUNGE_FEED, GREEK_FEED] = DEFAULT_FEEDS.feeds as [unknown, Record<string, unknown>]
const feedsJson = (...feeds: unknown[]) => JSON.stringify({ feeds })
const dropdownKeys = async (ui: { drawn: () => Promise<unknown> }) =>
  keysOf(await ui.drawn()).filter(key => key.startsWith('station-'))
const mountPane = ($: Engine) =>
  $.ui.mount({ plugin: 'radio', surface: 'terminal', component: 'Pane', requestId: 'radio', props: PANE_PROPS })

test('without feeds.json the dropdowns come from feeds.default.json in the mod\'s own folder, nothing said', async ($, on) => {
  const { toasts, fsPaths, fetched } = world(on)
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  const ui = await mountPane($)
  expect(await dropdownKeys(ui)).toEqual(['station-lounge', 'station-greek'])
  expect(toasts).toEqual([])
  expect(fsPaths.length).toBeGreaterThan(0)
  for (const path of fsPaths) expect(path).toMatch(/^\/.+\/feeds(\.default)?\.json$/)
  // Every address comes from the file.
  expect(fetched).toEqual([
    (LOUNGE_FEED as { url: string }).url,
    GREEK_FEED.url,
  ])
})

test('feeds.json sets the dropdowns, their order and names; a source it leaves out is never fetched', async ($, on) => {
  const { clock, spawned, fetched } = world(on, {
    isStreaming: true,
    files: { 'feeds.json': feedsJson(JAZZ, { ...GREEK_FEED, name: 'Greek radio' }, { name: 'Talk Radio', stations: [{ title: 'Talk One', url: 'https://talk.example.com/one' }] }) },
  })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  const ui = await mountPane($)

  expect(await dropdownKeys(ui)).toEqual(['station-jazz', 'station-greek-radio', 'station-talk-radio'])
  expect(fetched.some(url => url.includes('lounge'))).toBe(false)
  // "Greek radio" is the longest label: every ▾ sits one column after it.
  const label = async (key: string) => ((await findKey(ui.drawn(), key)) as { props: { label: string } }).props.label
  expect(await label('station-greek-radio')).toBe('Greek radio ▾ Pick a station…')
  expect(await label('station-jazz')).toBe('Jazz        ▾ Pick a station…')

  await ui.press({ key: 'station-jazz' })
  expect(await findKey(ui.drawn(), 'pick-jazz24')).toMatchObject({ props: { label: 'Jazz24 (Jazz)' } })
  await ui.press({ key: 'pick-kcsm' })
  await clock.advance(1000)
  expect(spawned.at(-1)?.at(-1)).toBe('http://jazz.example.com/kcsm')
  expect(await label('station-jazz')).toBe('Jazz        ▾ KCSM (Jazz)')

  // By id from the command, and by the feed's name from search.
  expect((await $.command.run({ command: 'radio-fm', args: 'talk-one', ...RUN })).text).toBe('Tuning to Talk One.')
  await ui.input({ key: 'search', text: 'jazz', kind: 'change' })
  expect(await resultKeys(ui)).toEqual(['result-jazz24', 'result-kcsm'])
})

test('a feed\'s url, source and own stations are all the file\'s: a second radio-browser query is a second dropdown', async ($, on) => {
  const italy = {
    name: 'Italy',
    source: 'radio-browser',
    url: 'https://dir.example.com/json/stations/search?countrycode=IT',
    stations: [{ id: 'Rai 1', title: 'Rai Radio 1', genre: 'news', url: 'https://rai.example.com/r1' }],
  }
  const { fetched } = world(on, { files: { 'feeds.json': feedsJson(GREEK_FEED, italy) } })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  expect(fetched).toEqual([GREEK_FEED.url, italy.url])

  const ui = await mountPane($)
  expect(await dropdownKeys(ui)).toEqual(['station-greek', 'station-italy'])
  await ui.press({ key: 'station-italy' })
  // Own stations first, an "id" slugged, a "genre" after the feed's name; the
  // directory's answer (the test's Greek one) follows, named for this feed.
  expect(await findKey(ui.drawn(), 'pick-rai-1')).toMatchObject({ props: { label: 'Rai Radio 1 (Italy · news)' } })
  expect(await findKey(ui.drawn(), 'pick-zeppelin-106-7-italy')).toMatchObject({
    props: { label: 'Zeppelin 106.7 (Italy · alternative rock, classic rock)' },
  })
})

test('ids go in feeds.json order: the first to slug to one keeps it, a later one takes its feed\'s key after it', async ($, on) => {
  const chill = {
    name: 'Chill',
    stations: [
      { title: 'Driftwood', url: 'https://chill.example.com/a' },
      { title: 'Mirror', url: 'https://chill.example.com/m1' },
      { title: 'Mirror', url: 'https://chill.example.com/m2' },
      { title: 'Mirror', url: 'https://chill.example.com/m3' },
    ],
  }
  const { clock, spawned } = world(on, { isStreaming: true, files: { 'feeds.json': feedsJson(chill, GREEK_FEED, LOUNGE_FEED) } })
  await $.session.start(START)

  const playsFrom = async (id: string) => {
    await $.command.run({ command: 'radio-fm', args: id, ...RUN })
    await clock.advance(1000)

    return spawned.at(-1)?.at(-1)
  }
  expect(await playsFrom('driftwood')).toBe('https://chill.example.com/a')
  expect(await playsFrom('driftwood-lounge')).toBe('https://radio.example.com/driftwood')
  expect(await playsFrom('nightline')).toBe('https://radio.example.gr/nightline')
  expect(await playsFrom('nightline-lounge')).toBe('https://radio.example.com/nightline')
  expect(await playsFrom('mirror')).toBe('https://chill.example.com/m1')
  expect(await playsFrom('mirror-chill')).toBe('https://chill.example.com/m2')
  expect(await playsFrom('mirror-chill-2')).toBe('https://chill.example.com/m3')
})

test('a broken feeds.json says why once, not on every load, falls back to the defaults, and an edit is read on the next /radio-fm', async ($, on) => {
  const { toasts, files } = world(on, { files: { 'feeds.json': '{ "feeds": [' } })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(/^radio: \/.+\/feeds\.json: /)
  const before = await mountPane($)
  expect(await dropdownKeys(before)).toEqual(['station-lounge', 'station-greek'])
  await before.unmount()

  files['feeds.json'] = JSON.stringify({ stations: [] })
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  expect(toasts.at(-1)).toMatch(/feeds\.json: it needs a "feeds" list$/)

  files['feeds.json'] = feedsJson(LOUNGE_FEED, JAZZ)
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  expect(toasts).toHaveLength(2)
  expect(await dropdownKeys(await mountPane($))).toEqual(['station-lounge', 'station-jazz'])
})

test('with neither feeds file there are no dropdowns, and a toast says where to add one', async ($, on) => {
  const { toasts, files } = world(on)
  delete files['feeds.default.json']
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  expect(toasts).toEqual([expect.stringMatching(/^radio: no stations: add \/.+\/feeds\.json$/)])
  expect(await dropdownKeys(await mountPane($))).toEqual([])
})

test('bad entries are skipped and counted: no name, an unknown source, a source without an http(s) url, nothing to play, a bad station', async ($, on) => {
  const feeds = feedsJson(
    { source: 'radio-browser', url: LOUNGE_URL },
    LOUNGE_FEED,
    { name: 'Spotify', source: 'spotify', url: 'https://spotify.example.com' },
    { name: 'No url', source: 'radio-browser' },
    { name: 'Option url', source: 'radio-browser', url: '--sout=file/ts:/tmp/owned' },
    { name: 'No stations' },
    { name: 'Empty', stations: [] },
    null,
    {
      name: 'Mixed',
      stations: [
        { title: 'Good', url: 'https://good.example.com' },
        { title: 'Option', url: '--sout=file/ts:/tmp/owned' },
        { title: 'Ftp', url: 'ftp://files.example.com/x' },
        { url: 'https://untitled.example.com' },
        'not a station',
      ],
    },
  )
  const { toasts, fetched } = world(on, { files: { 'feeds.json': feeds } })
  await $.session.start(START)
  await $.command.run({ command: 'radio-fm', args: '', ...RUN })
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(/feeds\.json: skipped 11 \(/)
  expect(fetched).toEqual([(LOUNGE_FEED as { url: string }).url])

  const ui = await mountPane($)
  expect(await dropdownKeys(ui)).toEqual(['station-lounge', 'station-mixed'])
  await ui.press({ key: 'station-mixed' })
  expect(keysOf(await ui.drawn()).filter(key => key.startsWith('pick-'))).toEqual(['pick-good'])
})

test('offline, a feed\'s own stations still open the pane and play', async ($, on) => {
  const { clock, spawned } = world(on, {
    isStreaming: true, loungeFetchesOk: 0, isGreekDown: true,
    files: { 'feeds.json': feedsJson(LOUNGE_FEED, JAZZ) },
  })
  await $.session.start(START)
  expect((await $.command.run({ command: 'radio-fm', args: '', ...RUN })).text).toMatch(/^Radio pane opened/)
  expect((await $.command.run({ command: 'radio-fm', args: 'jazz24', ...RUN })).text).toBe('Tuning to Jazz24.')
  await clock.advance(1000)
  expect(spawned.at(-1)?.at(-1)).toBe('https://jazz.example.com/jazz24.mp3')
})

test('with only fetched feeds and none of their own stations, all unreachable, /radio-fm says the lists could not load', async ($, on) => {
  world(on, { loungeFetchesOk: 0, isGreekDown: true, files: { 'feeds.json': feedsJson(LOUNGE_FEED) } })
  await $.session.start(START)
  expect((await $.command.run({ command: 'radio-fm', args: '', ...RUN })).text).toMatch(/^radio: could not load the station lists \(/)
})
