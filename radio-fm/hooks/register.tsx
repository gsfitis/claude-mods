import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  HookStream,
  ProcessSpawnChunk,
  ProcessSpawnResult,
  Register,
} from 'claude-code'

import type { Channel, Picker } from '../types'

const PANE = 'radio'
// radio-browser.info asks callers to name themselves.
const USER_AGENT = 'claude-code-radio-mod/0.1'
const REFRESH_MS = 30_000
// What a feed's `url` answers in: a radio-browser.info station search. A feed
// without a source lists only its own stations.
const FORMATS = ['radio-browser'] as const
// The dropdowns, in feeds.json's order, as the station lists last read them. In
// $.state so a hot reload keeps drawing them before the lists load again.
const pickers = atom({ plugin: 'radio', key: 'pickers' } as const, [])
// Said once per distinct problem, not on every refresh.
let feedProblem = ''

const station = atom({ plugin: 'radio', key: 'station' } as const, null)
const channels = atom({ plugin: 'radio', key: 'channels' } as const, [])
// VLC's buffer fill while a station starts (or stalls); null once audio plays.
const buffering = atom({ plugin: 'radio', key: 'buffering' } as const, null)
// 0-100; VLC's own volume (MPRIS), set live so a change never restarts the stream.
const volume = atom({ plugin: 'radio', key: 'volume' } as const, 100)
const VOLUME_STEP = 10
// $.store outlives the session; $.state does not.
const VOLUME_KEY = 'volume'
// Session-only on purpose: a new session never starts silent for no visible reason.
const isMuted = atom({ plugin: 'radio', key: 'isMuted' } as const, false)
// The last stations that actually played, newest first, kept whole so one that
// leaves its source (a directory's top 40) still plays from here.
const recent = atom({ plugin: 'radio', key: 'recent' } as const, [])
const RECENT_KEY = 'recent'
const RECENT_MAX = 5
// Starred stations, in the order starred, kept whole as Recent keeps them; no cap.
const favorites = atom({ plugin: 'radio', key: 'favorites' } as const, [])
const FAVORITES_KEY = 'favorites'
// Which station list is open. Not the engine's Select: its terminal list has no
// close the person can reach (Esc only hands the keys back), so the pane owns
// this one and closes it on a pick, on its row, on Close, and on losing the keys.
const openPicker = atom({ plugin: 'radio', key: 'openPicker' } as const, null)
// The render hook's last word on whether the pane holds the keyboard; the tick
// reads it to close a list Esc left open.
let isPaneFocused = false
// Whether the radio pane is up; the mini-player above the prompt shows only
// while it is not. The ui.open / ui.close hooks keep it at once; the tick checks
// it against the engine's own record, since not every open reaches those hooks
// (one from a mini-player press does not) and a missed close would hide the
// mini-player for good.
const isPaneOpen = atom({ plugin: 'radio', key: 'isPaneOpen' } as const, false)
// The search field's text; '' shows the station pickers.
const query = atom({ plugin: 'radio', key: 'query' } as const, '')
const RESULTS_MAX = 12
// Resume on start. $.store is one file for all the person's sessions, so a new
// session claims the saved station (deletes it: a session opened beside a
// playing one finds nothing) and a session saves its station only as it ends.
// `started` tells a new session (never written) from a hot reload (written).
const LAST_STATION_KEY = 'lastStation'
const started = atom({ plugin: 'radio', key: 'started' } as const, false)
// Claimed but not set yet: it waits for a drawn surface (a `claude -p` run has
// none and never plays).
let pendingResume: string | undefined
// Claimed and not yet played or replaced by a pick: handed back at the end, so a
// resume that never got to play (offline, headless) is tried again next session.
let unusedResume: string | undefined
let hasStarted = false

// Case and accent blind: "ρυθμος" finds "Ρυθμός 89.2".
// Final sigma folds too: "ρυθμοσ" and "ΚΟΣ" find what "ρυθμός" and "Κόσμος" do.
const fold = (text: string): string => text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/ς/g, 'σ')

// Every word of the query in the title or genre.
const search = (list: Channel[], text: string): Channel[] => {
  const words = fold(text).split(/\s+/).filter(Boolean)
  // No words match nothing: Enter on an empty field must not play the first station.
  if (words.length === 0) return []

  return list.filter(c => words.every(word => fold(`${c.title} ${c.genre}`).includes(word)))
}

// Theme keys, so pane and band follow the person's Claude Code theme.
const badgeOf = (tuned: Channel | undefined, percent: number | null, muted: boolean) =>
  tuned === undefined
    ? { text: '○ OFF', color: 'inactive' }
    : percent !== null
      ? { text: `◌ ${percent}%`, color: 'warning' }
      : muted
        ? { text: '● MUTED', color: 'warning' }
        : { text: '● LIVE', color: 'success' }

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Radio', focus: true })

// `id` undefined forgets them all.
const forget = async ($: EngineInterface, id?: string): Promise<void> => {
  await update($, recent, list => (id === undefined ? [] : list.filter(c => c.id !== id)))
  await $.store.set(RECENT_KEY, await read($, recent))
}

const remember = async ($: EngineInterface, channel: Channel): Promise<void> => {
  await update($, recent, list => [channel, ...list.filter(c => c.id !== channel.id)].slice(0, RECENT_MAX))
  await $.store.set(RECENT_KEY, await read($, recent))
}

const toggleFavorite = async ($: EngineInterface, channel: Channel): Promise<void> => {
  await update($, favorites, list =>
    list.some(c => c.id === channel.id) ? list.filter(c => c.id !== channel.id) : [...list, channel],
  )
  await $.store.set(FAVORITES_KEY, await read($, favorites))
}

// The stations kept whole: one its source dropped still plays from here.
const savedStations = async ($: EngineInterface): Promise<Channel[]> => [...(await read($, favorites)), ...(await read($, recent))]

// Any volume change unmutes, as most players do.
const changeVolume = async ($: EngineInterface, next: (level: number) => number): Promise<number> => {
  await update($, isMuted, () => false)
  await update($, volume, level => Math.min(100, Math.max(0, next(level))))
  const level = await read($, volume)
  await $.store.set(VOLUME_KEY, level)

  return level
}

type DirectoryStation = { name: string; tags: string; url_resolved: string }

// A dropdown as feeds.json describes it; `key` names it in the pane and in each
// of its stations' `source`.
type Feed = {
  key: string
  name: string
  format?: (typeof FORMATS)[number]
  url?: string
  stations: { id?: string; title: string; genre?: string; url: string }[]
}

// The engine refuses a whole tree over one control character, and every source is outside data.
const printable = (text: string): string => text.replace(/\p{Cc}/gu, '')

// `/radio-fm` takes it: "Ρυθμός 89.2" is `ρυθμος-89-2`.
const slug = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')

const sameStream = (a: string, b: string): boolean =>
  a.replace(/^https?:\/\//, '') === b.replace(/^https?:\/\//, '')

const isStream = (url: unknown): url is string => typeof url === 'string' && /^https?:\/\//i.test(url)

// `base`, or `base-suffix` once taken, then a number: every id `/radio-fm` and
// the pane's keys name stays unique.
const claim = (taken: Set<string>, base: string, suffix?: string): string => {
  const first = suffix !== undefined && taken.has(base) ? `${base}-${suffix}` : base
  let id = first
  for (let n = 2; taken.has(id); n += 1) id = `${first}-${n}`
  taken.add(id)

  return id
}

// A directory changes slowly, so each is asked once per module load.
const directories = new Map<string, Channel[]>()

const loadDirectory = async ($: EngineInterface, feed: Feed, url: string): Promise<Channel[]> => {
  const cached = directories.get(`${feed.key} ${url}`)
  if (cached !== undefined) return cached

  const { ok, status, text } = await $.http.fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!ok) throw new Error(`${feed.name} answered ${status}`)

  const stations: unknown = JSON.parse(text)
  if (!Array.isArray(stations)) throw new Error(`${feed.name} answered no station list`)
  const list: Channel[] = []
  for (const s of stations as (Partial<DirectoryStation> | null)[]) {
    // Outside data: an entry without a name or an http(s) stream is left out.
    if (typeof s?.name !== 'string' || !isStream(s.url_resolved)) continue
    const tags = (typeof s.tags === 'string' ? printable(s.tags) : '')
      .split(',')
      .map(t => t.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(', ')
    const channel: Channel = {
      id: slug(s.name),
      title: printable(s.name).trim(),
      genre: tags === '' ? feed.name : `${feed.name} · ${tags}`,
      url: s.url_resolved,
      source: feed.key,
    }
    // The directory lists one stream under several names (and over http and
    // https); the most played wins.
    const isListed = list.some(c => c.id === channel.id || sameStream(c.url, channel.url))
    if (channel.id === '' || isListed) continue
    list.push(channel)
  }
  // Nothing to list counts as a failure: asked again next time, the feed keeping
  // its last stations meanwhile.
  if (list.length === 0) throw new Error(`${feed.name} listed no stations`)
  directories.set(`${feed.key} ${url}`, list)

  return list
}

const fetchFeed = ($: EngineInterface, feed: Feed): Promise<Channel[]> =>
  feed.url === undefined ? Promise.resolve([]) : loadDirectory($, feed, feed.url)

// `{ "feeds": [{ "name", "source"?: "radio-browser", "url"?, "stations"?:
// [{ "id"?, "title", "genre"?, "url" }] }] }` as dropdowns; throws without a "feeds" list.
// `skipped` names each entry left out (`feed 2 "Jazz"`, `"Jazz" station 3`), so a
// different mistake is a different toast.
const parseFeeds = (config: any): { feeds: Feed[]; skipped: string[] } => {
  if (!Array.isArray(config?.feeds)) throw new Error('it needs a "feeds" list')

  const feeds: Feed[] = []
  const keys = new Set<string>()
  const skipped: string[] = []
  for (const [index, feed] of config.feeds.entries()) {
    const name = typeof feed?.name === 'string' ? printable(feed.name).trim() : ''
    const where = name === '' ? `feed ${index + 1}` : `feed ${index + 1} "${name}"`
    const format = FORMATS.find(f => f === feed?.source)
    const isFetched = feed?.source !== undefined
    if (name === '' || (isFetched && (format === undefined || !isStream(feed.url)))) {
      skipped.push(where)
      continue
    }
    // A url is only fetched with a source; without one it would be dropped unsaid.
    if (!isFetched && feed.url !== undefined) skipped.push(`${where} "url" (no "source")`)
    const stations: Feed['stations'] = []
    for (const [n, s] of (Array.isArray(feed.stations) ? feed.stations : []).entries()) {
      const title = typeof s?.title === 'string' ? printable(s.title).trim() : ''
      if (title === '' || !isStream(s.url)) {
        skipped.push(`"${name}" station ${n + 1}`)
        continue
      }
      stations.push({
        title,
        url: s.url,
        ...(typeof s.id === 'string' && slug(s.id) !== '' ? { id: slug(s.id) } : {}),
        ...(typeof s.genre === 'string' && printable(s.genre).trim() !== '' ? { genre: printable(s.genre).trim() } : {}),
      })
    }
    // A feed with nothing to fetch or play would leave no dropdown; it counts as skipped.
    if (!isFetched && stations.length === 0) {
      skipped.push(where)
      continue
    }
    feeds.push({ key: claim(keys, slug(name) || 'feed'), name, ...(isFetched ? { format, url: feed.url } : {}), stations })
  }

  return { feeds, skipped }
}

// The dropdowns, in order, from feeds.json beside the mod (yours, untracked),
// else feeds.default.json; read on every load of the lists, so an edit shows on
// the next /radio-fm. A feeds.json that cannot be read falls back to the default.
const SKIPS_SHOWN = 5

const readFeeds = async ($: EngineInterface): Promise<Feed[]> => {
  const problems: string[] = []
  let feeds: Feed[] = []
  let used: string | undefined
  for (const file of ['feeds.json', 'feeds.default.json']) {
    const path = `${$.plugin.root}/${file}`
    try {
      if (!(await $.fs.exists(path))) continue
      const { feeds: parsed, skipped } = parseFeeds(JSON.parse(await $.fs.read(path)))
      if (skipped.length > 0) {
        const more = skipped.length > SKIPS_SHOWN ? ` and ${skipped.length - SKIPS_SHOWN} more` : ''
        problems.push(
          `${path}: skipped ${skipped.length}: ${skipped.slice(0, SKIPS_SHOWN).join(', ')}${more} (a feed needs a "name", and a "source" of radio-browser with an http(s) "url", or "stations"; a station, a "title" and an http(s) "url")`,
        )
      }
      feeds = parsed
      used = path
      break
    } catch (error) {
      problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (feeds.length === 0 && problems.length === 0) {
    problems.push(used === undefined ? `no stations: add ${$.plugin.root}/feeds.json` : `${used}: lists no feeds`)
  }
  const problem = problems.join('; ')
  if (problem !== '' && problem !== feedProblem) $.ui.toast(`radio: ${problem}`)
  feedProblem = problem

  return feeds
}

const loadChannels = async ($: EngineInterface): Promise<Channel[]> => {
  const last = await read($, channels)
  const feeds = await readFeeds($)
  const fetched = await Promise.allSettled(feeds.map(feed => fetchFeed($, feed)))
  // Offline, a feed's own stations still play; with none, say why nothing loaded.
  const failed = fetched.flatMap(r => (r.status === 'rejected' ? [r.reason] : []))
  const isFetching = feeds.some(f => f.url !== undefined)
  const hasOwn = feeds.some(f => f.stations.length > 0)
  if (isFetching && !hasOwn && failed.length === feeds.filter(f => f.url !== undefined).length) throw failed[0]

  const explicit = new Map<Channel, string>()
  const groups = feeds.map((feed, index) => {
    const own = feed.stations.map(s => {
      const c: Channel = {
        id: s.id ?? (slug(s.title) || 'station'),
        title: s.title,
        genre: s.genre === undefined ? feed.name : `${feed.name} · ${s.genre}`,
        url: s.url,
        source: feed.key,
      }
      if (s.id !== undefined) explicit.set(c, s.id)

      return c
    })
    const result = fetched[index]
    // A feed that failed keeps the stations it gave last time.
    const remote = (result?.status === 'fulfilled' ? result.value : last.filter(c => c.source === feed.key)).filter(
      c => !own.some(o => o.id === c.id || sameStream(o.url, c.url)),
    )

    return { feed, stations: [...own, ...remote] }
  })
  const all = groups.flatMap(g => g.stations)
  const sameAs = (a: Channel, b: Channel): boolean => a.source === b.source && sameStream(a.url, b.url)
  // Ids in four rounds, so no edit or late answer moves one a station holds: the
  // station playing keeps its id until it stops, listed or not; then an own
  // station's "id"; then the id the last load gave the same stream in the same
  // feed (and title, for one stream listed twice); then, in feeds.json's order,
  // the slug, with the feed's key after it once taken, then a number.
  const taken = new Set<string>()
  const ids = new Map<Channel, string>()
  const reserve = (c: Channel, id: string | undefined): void => {
    if (id === undefined || ids.has(c) || taken.has(id)) return
    taken.add(id)
    ids.set(c, id)
  }
  const onAir = current
  const playingHere = onAir && (all.find(c => sameAs(c, onAir) && c.id === onAir.id) ?? all.find(c => sameAs(c, onAir)))
  // Listed or not (a refreshed top 40, a feed edited away, a saved station): the
  // pane, the band and the tick name it by `current` when no list does.
  if (playingHere !== undefined && onAir !== undefined) reserve(playingHere, onAir.id)
  else if (onAir !== undefined) taken.add(onAir.id)
  all.forEach(c => reserve(c, explicit.get(c)))
  all.forEach(c => reserve(c, (last.find(p => sameAs(p, c) && p.title === c.title) ?? last.find(p => sameAs(p, c)))?.id))
  for (const { feed, stations } of groups) for (const c of stations) if (!ids.has(c)) ids.set(c, claim(taken, c.id, feed.key))
  const list = all.map(c => ({ ...c, id: ids.get(c) ?? c.id }))
  await update($, pickers, () => feeds.map(feed => ({ source: feed.key, label: feed.name })))
  await update($, channels, () => list)

  return list
}

const statusOf = (channel: Channel | undefined, percent: number | null, muted: boolean): string | undefined =>
  channel &&
  [`♪ ${channel.title}`, percent === null ? '' : `buffering ${percent}%`, muted ? 'muted' : '']
    .filter(Boolean)
    .join(' · ')

const ignore = (): void => undefined

const meter = (percent: number, cells = 10): string => {
  const filled = Math.min(cells, Math.max(0, Math.round((percent / 100) * cells)))

  return '▰'.repeat(filled) + '▱'.repeat(cells - filled)
}

// A Button's label has no truncation of its own.
const clip = (text: string, room: number): string =>
  text.length > room ? `${text.slice(0, Math.max(1, room - 1))}…` : text

// Narrower than this (a sidebar docked beside the transcript), the pane goes compact.
const COMPACT_BELOW = 48
// A dropdown's name is cut to this, so one long name never pads the others' station out of view.
const LABEL_MAX = 15

// The child dies with the module, so these only mirror what is playing now;
// `station` in $.state is the truth, and a reload resumes from it.
let playing: string | null = null
// What plays, whole: the one handle on it no reload of the lists can move. It
// outlives /clear, as the cvlc does.
let current: Channel | undefined
// The station `id` names: as listed, else saved whole, else the one playing.
const playingAs = (id: string | null): Channel | undefined => (id !== null && current?.id === id ? current : undefined)
let player: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined
let fetchedAt = 0
// When the tick last asked for the lists because it had none.
let emptyTriedAt: number | undefined
let isBusy = false
// The playing VLC's pid (its shell wrapper prints it), its MPRIS bus name once
// found, and the volume it last took.
let childPid: string | undefined
let childBus: string | undefined
let appliedVolume: number | null = null
let isSyncingVolume = false

// By pid: another VLC (a window of yours) may hold the plain MPRIS name.
const busOf = async ($: EngineInterface): Promise<string | undefined> => {
  const pid = childPid
  if (pid === undefined) return undefined
  if (childBus !== undefined) return childBus

  const { stdout } = await $.process.run(['busctl', '--user', 'list', '--no-legend'])
  const name = stdout
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .find(([bus, owner]) => bus?.startsWith('org.mpris.MediaPlayer2.vlc') && owner === pid)?.[0]
  if (pid === childPid) childBus = name

  return name
}

// The watchdog. A stalled stream (a socket that hangs after suspend, a server
// that stops sending) leaves VLC alive, silent and saying "Playing"; only its
// MPRIS Position stops moving. Checked every WATCH_MS; no move for STALL_MS
// reconnects, and STALL_RETRIES reconnects with no progress between stop it.
const WATCH_MS = 5_000
const STALL_MS = 20_000
const STALL_RETRIES = 3
let watchedAt = 0
let progressAt = 0
let lastPosition: number | undefined
let stallRetries = 0

// Microseconds played, or undefined when it cannot be read (VLC not on the bus
// yet, no busctl): the watchdog never judges what it cannot read.
const positionOf = async ($: EngineInterface): Promise<number | undefined> => {
  try {
    const name = await busOf($)
    if (name === undefined) return undefined

    const { exitCode, stdout } = await $.process.run([
      'busctl', '--user', 'get-property', name, '/org/mpris/MediaPlayer2',
      'org.mpris.MediaPlayer2.Player', 'Position',
    ])
    const micros = /^x (\d+)$/.exec(stdout.trim())?.[1]

    return exitCode === 0 && micros !== undefined ? Number(micros) : undefined
  } catch {
    return undefined
  }
}

const watchdog = async ($: EngineInterface, channel: Channel, now: number): Promise<void> => {
  if (now - watchedAt < WATCH_MS) return
  watchedAt = now
  if (progressAt === 0) progressAt = now

  const pid = childPid
  const position = await positionOf($)
  if (position === undefined || pid !== childPid) return
  if (position !== lastPosition) {
    // Anything past the start counts as progress; a fresh child sits at 0.
    if (lastPosition !== undefined || position > 0) progressAt = now
    if (lastPosition !== undefined && position > 0) stallRetries = 0
    lastPosition = position

    return
  }
  if (now - progressAt < STALL_MS) return

  if (stallRetries >= STALL_RETRIES) {
    await update($, station, () => null)
    $.ui.toast(`radio: ${channel.title} keeps stalling; stopped it`)

    return
  }
  stallRetries += 1
  $.ui.toast(`radio: ${channel.title} stalled; reconnecting`)
  tune($, channel)
}
// What the tick last saw, for putting back after a wipe.
let mirror: { station: string | null; isMuted: boolean } = { station: null, isMuted: false }

// /clear and /resume wipe $.state, and no session.start follows; the module and
// its cvlc live on. A never-written volume or recent list takes the saved one (a
// new session too); a wiped station puts back the station and mute this module
// played with.
const restoreAfterWipe = async ($: EngineInterface): Promise<void> => {
  if ((await $.state.get({ plugin: 'radio', key: 'volume' })).version === 0) {
    const saved = await $.store.get(VOLUME_KEY)
    if (typeof saved === 'number') await update($, volume, () => saved)
  }
  if ((await $.state.get({ plugin: 'radio', key: 'recent' })).version === 0) {
    const saved = await $.store.get(RECENT_KEY)
    if (Array.isArray(saved)) await update($, recent, () => saved as Channel[])
  }
  if ((await $.state.get({ plugin: 'radio', key: 'favorites' })).version === 0) {
    const saved = await $.store.get(FAVORITES_KEY)
    if (Array.isArray(saved)) await update($, favorites, () => saved as Channel[])
  }
  // Else the first hot reload after a /clear would count as a new session.
  if (hasStarted && (await $.state.get({ plugin: 'radio', key: 'started' })).version === 0) {
    await update($, started, () => true)
  }
  const was = mirror
  if (was.station !== null && (await $.state.get({ plugin: 'radio', key: 'station' })).version === 0) {
    await update($, station, () => was.station)
    await update($, isMuted, () => was.isMuted)
  }
}

const syncVolume = async ($: EngineInterface): Promise<void> => {
  const wanted = (await read($, isMuted)) ? 0 : await read($, volume)
  const pid = childPid
  if (pid === undefined || wanted === appliedVolume || isSyncingVolume) return

  isSyncingVolume = true
  try {
    const name = await busOf($)
    if (name === undefined) return // not on the bus yet; the next tick retries

    const set = await $.process.run([
      'busctl', '--user', 'set-property', name, '/org/mpris/MediaPlayer2',
      'org.mpris.MediaPlayer2.Player', 'Volume', 'd', String(wanted / 100),
    ])
    if (set.exitCode !== 0) throw new Error(set.stderr.trim() || `busctl exited ${set.exitCode}`)
    if (pid === childPid) appliedVolume = wanted
  } catch (error) {
    // A failure on a VLC already replaced says nothing about the new one.
    if (pid !== childPid) return
    // Give this value up rather than retry it every second; the next change tries again.
    appliedVolume = wanted
    $.ui.toast(`radio: could not set the volume (${String(error)})`)
  } finally {
    isSyncingVolume = false
  }
}

const tune = ($: EngineInterface, channel: Channel | undefined): void => {
  player?.return({ code: null, signal: 'SIGTERM' }).catch(ignore)
  player = undefined
  playing = channel?.id ?? null
  current = channel
  childPid = undefined
  childBus = undefined
  appliedVolume = null
  watchedAt = 0
  progressAt = 0
  lastPosition = undefined
  const percent = channel === undefined ? null : 0
  // Work left running past an unload finds $ refused; it ends quietly (`ignore`).
  update($, buffering, () => percent).catch(ignore)
  read($, isMuted).then(muted => $.ui.status(statusOf(channel, percent, muted))).catch(ignore)
  if (channel === undefined) return
  // The URL is cvlc's last argument and comes from outside data (a community
  // directory, a saved list): one starting with "-" would be read as an option.
  if (!/^https?:\/\//i.test(channel.url)) {
    update($, station, () => null).catch(ignore)
    $.ui.toast(`radio: ${channel.title} has no http(s) stream; not playing it`)

    return
  }

  // -vv: VLC reports "Buffering N%" and "Stream buffering done" only in debug.
  // The shell prints its pid, then becomes cvlc (exec keeps the pid); the URL
  // rides as $0, never parsed by the shell.
  const child = $.process.spawn({
    // --play-and-exit: a dead or dropped stream ends cvlc, so the end path below
    // runs; without it VLC idles silently forever.
    argv: ['sh', '-c', 'echo "pid $$"; exec cvlc -vv --no-video --play-and-exit "$0"', channel.url],
  })
  player = child
  void (async () => {
    let reason = 'the stream ended'
    const partial = { stdout: '', stderr: '' }
    let hasPlayed = false
    try {
      // Keep pulling for the child's whole life: unread output blocks it.
      for await (const chunk of child) {
        const lines = (partial[chunk.stream] + chunk.text).split('\n')
        partial[chunk.stream] = lines.pop() ?? ''
        for (const line of lines) {
          const error = / error: (.+)/.exec(line)?.[1]
          if (error !== undefined) reason = error.trim().slice(0, 200)
          // "sh: 1: exec: cvlc: not found": the shell's own word on why nothing started.
          if (line.startsWith('sh: ')) reason = line.slice(0, 200)
          if (player !== child) continue

          const pid = /^pid (\d+)$/.exec(line)?.[1]
          const filled = /Buffering (\d+)%/.exec(line)?.[1]
          if (pid !== undefined) childPid = pid
          else if (filled !== undefined) {
            // VLC is up and on the bus: set the volume before any audio plays
            // (a no-op once it took).
            syncVolume($).catch(ignore)
            await update($, buffering, () => Number(filled))
          }
          else if (line.includes('Stream buffering done')) {
            await update($, buffering, () => null)
            // Recent means it played, not merely that it was picked; once per
            // start, so a rebuffer never undoes a removal mid-play.
            if (!hasPlayed) remember($, channel).catch(ignore)
            if (channel.id === unusedResume) unusedResume = undefined
            hasPlayed = true
          }
        }
      }
    } catch (error) {
      reason = `cvlc did not start (${String(error)})`
    }
    if (player !== child) return

    // Forget the dead child at once, so picking the same station again replays it.
    player = undefined
    playing = null
    current = undefined
    childPid = undefined
    childBus = undefined
    appliedVolume = null
    $.ui.status(undefined)
    await update($, buffering, () => null)
    await update($, station, () => null)
    $.ui.toast(`radio: ${reason}`)
  })().catch(ignore)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    // ponytail: 1s poll of $.state, a state.set hook if the lag ever matters
    $.clock.every(1000, async () => {
      if (isBusy) return
      isBusy = true
      try {
        await restoreAfterWipe($)
        if (!isPaneFocused && (await read($, openPicker)) !== null) await update($, openPicker, () => null)
        // Bookkeeping for the mini-player: a failure here never stops the music.
        const panes = await $.ui.panes().catch(() => undefined)
        const isUp = panes?.some(pane => pane.id === PANE)
        if (isUp !== undefined && isUp !== (await read($, isPaneOpen))) await update($, isPaneOpen, () => isUp)
        if (pendingResume !== undefined && (await $.session.surfaces().catch(() => [])).length > 0) {
          const id = pendingResume
          pendingResume = undefined
          await update($, station, () => id)
        }
        const wanted = await read($, station)
        mirror = { station: wanted, isMuted: await read($, isMuted) }
        // A station the person picked instead: the claimed one is spent.
        if (wanted !== null && wanted !== unusedResume) unusedResume = undefined
        const now = await $.clock.now()
        let list = await read($, channels)
        // What plays without the lists: a station saved whole, or the one playing.
        const known = (await savedStations($)).find(c => c.id === wanted) ?? playingAs(wanted)
        // An empty list may be all there is (no feeds, every one down): asked again
        // once per REFRESH_MS, not every second; in the background when something
        // can play already, so a slow network never holds Stop, mute or volume.
        const isEmptyDue = emptyTriedAt === undefined || now - emptyTriedAt >= REFRESH_MS
        const isEmptyTried = wanted !== null && list.length === 0 && isEmptyDue
        if (isEmptyTried) {
          emptyTriedAt = now
          if (known !== undefined) loadChannels($).catch(ignore)
          else list = await loadChannels($)
        }
        // A list in hand: the next empty one (after /clear) is asked for at once.
        if (list.length > 0) emptyTriedAt = undefined
        if (playing !== null && now - fetchedAt > REFRESH_MS) {
          fetchedAt = now
          // In the background: a slow station list must never hold Stop, mute or volume.
          // A failed refresh keeps the last list; the next tick reads a new one.
          loadChannels($).catch(ignore)
        }
        const channel = list.find(c => c.id === wanted) ?? known
        if (wanted !== null && channel === undefined && (list.length > 0 || isEmptyTried)) {
          await update($, station, () => null)
          $.ui.toast(`radio: "${wanted}" is in neither station list right now`)
        } else if (wanted !== playing) {
          // A station the person picked starts with a clean reconnect count.
          stallRetries = 0
          tune($, channel)
        } else $.ui.status(statusOf(channel, await read($, buffering), await read($, isMuted)))
        await syncVolume($)
        if (channel !== undefined && playing === channel.id) await watchdog($, channel, now)
      } catch (error) {
        await update($, station, () => null).catch(ignore)
        $.ui.toast(`radio: ${String(error)}`)
      } finally {
        isBusy = false
      }
    })

    // Only a new session resumes: a hot reload finds `started` written. Its own
    // try: a failure here must never cost the timer above, which plays the radio.
    try {
      // A new session takes the saved volume; a hot reload keeps the one it has.
      await restoreAfterWipe($)
      const isNewSession = (await $.state.get({ plugin: 'radio', key: 'started' })).version === 0
      await update($, started, () => true)
      hasStarted = true
      if (isNewSession && options.resumeOnStart === true) {
        const last = await $.store.get(LAST_STATION_KEY)
        if (typeof last === 'string') {
          await $.store.delete(LAST_STATION_KEY)
          pendingResume = last
          unusedResume = last
        }
      }
    } catch (error) {
      $.ui.toast(`radio: could not restore the last session (${String(error)})`)
    }


    // After the timer: a refused registration must not stop playback. Not
    // `radio`: Claude Code ships a built-in /radio and refuses that name.
    await $.command.register({
      name: 'radio-fm',
      description: 'Radio: open the station picker, tune to a station, or stop',
      argumentHint: '[station|stop|vol 0-100|mute|unmute|forget station|forget all]',
    })

    return next(e)
  })

  on('command.run', { command: 'radio-fm' }, async ($, e) => {
    const wanted = e.args.trim().toLowerCase()
    const level = /^vol(?:ume)?(?:\s+(\d{1,3}))?$/.exec(wanted)
    if (level !== null) {
      if (level[1] === undefined) return { text: `Volume ${await read($, volume)}%. Set it with /radio-fm vol 0-100.` }

      const percent = await changeVolume($, () => Number(level[1]))

      return { text: `Volume ${percent}%.` }
    }
    const forgetting = /^forget(?:\s+(.+))?$/.exec(wanted)
    if (forgetting !== null) {
      const name = forgetting[1]?.trim()
      const played = await read($, recent)
      if (name === 'all') {
        await forget($)

        return { text: played.length === 0 ? 'Recent is already empty.' : `Cleared Recent (${played.length}).` }
      }
      const found = played.find(c => c.id === name || c.title.toLowerCase() === name)
      if (found === undefined) {
        const ids = played.map(c => c.id).join(', ') || 'nothing yet'
        return {
          text:
            name === undefined
              ? `Forget which? Recent: ${ids}. Or /radio-fm forget all.`
              : `"${name}" isn't in Recent (${ids}).`,
        }
      }
      await forget($, found.id)

      return { text: `Removed ${found.title} from Recent.` }
    }
    if (wanted === 'mute' || wanted === 'unmute') {
      await update($, isMuted, () => wanted === 'mute')

      return { text: wanted === 'mute' ? 'Muted.' : `Unmuted, at ${await read($, volume)}%.` }
    }
    if (wanted === 'stop' || wanted === 'off') {
      await update($, station, () => null)

      return { text: 'Radio off.' }
    }

    let list: Channel[]
    try {
      list = await loadChannels($)
    } catch (error) {
      // Offline, a station saved whole in Favorites or Recent still plays, and the
      // pane still opens on them.
      const saved = await savedStations($)
      const isPlayable = wanted === '' ? saved.length > 0 : saved.some(c => c.id === wanted || c.title.toLowerCase() === wanted)
      if (!isPlayable) return { text: `radio: could not load the station lists (${String(error)})` }
      list = []
    }

    if (wanted === '') {
      await openPane($)

      return { text: 'Radio pane opened: pick a station there (nothing plays until you do), or run /radio-fm <station>.' }
    }

    // An id before a title, so a feed station titled like another's id never takes it.
    const saved = await savedStations($)
    const match =
      [...list, ...saved].find(c => c.id === wanted) ?? [...list, ...saved].find(c => c.title.toLowerCase() === wanted)
    if (match === undefined) {
      return { text: `No station "${wanted}". Stations: ${list.map(c => c.id).join(', ')}` }
    }
    await update($, station, () => match.id)

    return { text: `Tuning to ${match.title}.` }
  }).catch(() => ({ text: 'radio: the command failed; claude --debug says why.' }))

  // Resume's save, as the session ends (not /clear, whose process goes on).
  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') {
      const keep = (await read($, station).catch(() => null)) ?? unusedResume
      if (keep !== undefined) await $.store.set(LAST_STATION_KEY, keep).catch(ignore)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // These two only keep track; whatever they hit, the pane opens and closes.
  on('ui.open', { id: PANE }, async ($, e, next) => {
    const opened = await next(e)
    await update($, isPaneOpen, () => true)

    return opened
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, isPaneOpen, () => false)

    return closed
  }).catch(($, e, next) => next(e))

  // The mini-player: one row above the prompt while a station plays and the
  // pane is closed. Its keys work once the band has focus (a click, ctrl+x tab).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.surface === 'mobile') return next(e)

    const wanted = await read($, station)
    if (wanted === null || (await read($, isPaneOpen))) return next(e)

    const tuned =
      (await read($, channels)).find(c => c.id === wanted) ??
      (await savedStations($)).find(c => c.id === wanted) ??
      playingAs(wanted)
    if (tuned === undefined) return next(e)

    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Client = e.surface !== 'vscode' && 'Client' in elements ? elements.Client : undefined
    // Until this module's cvlc plays it (a resume, the second before a tick), it is
    // starting. Read either way: the read is what redraws this when tune() writes it.
    const buffered = await read($, buffering)
    const percent = playing === wanted ? buffered : 0
    const muted = await read($, isMuted)
    const isFlowing = percent === null && !muted
    const badge = badgeOf(tuned, percent, muted)
    // Narrow: the controls keep their room, the buffering meter and the bars give theirs up.
    const isWide = e.props.bodyColumns >= 80
    const track = percent === null ? '' : `buffering ${meter(percent, 5)}`

    return (
      <Box columnGap={2}>
        <Box flexShrink={1} columnGap={1}>
          <Text bold wrap="truncate-end">
            ♪ {tuned.title}
          </Text>
          {isWide && track !== '' && (
            <Text dimColor wrap="truncate-end">
              · {track}
            </Text>
          )}
        </Box>
        <Box flexShrink={0} columnGap={2}>
          {isWide &&
            (Client !== undefined ? (
              <Client key="band-equalizer" module="./equalizer.tsx" props={{ isPlaying: isFlowing }} width={7} />
            ) : (
              <Text color={isFlowing ? 'claude' : 'inactive'}>{isFlowing ? '▃▅▇▅▂▆▄' : '▁▁▁▁▁▁▁'}</Text>
            ))}
          <Text bold color={badge.color}>
            {badge.text}
          </Text>
          <Button key="band-mute" plain hotkey="m" label={muted ? 'Unmute' : 'Mute'} onPress={() => update($, isMuted, m => !m)} />
          <Button key="band-stop" plain hotkey="s" label="Stop" onPress={() => update($, station, () => null)} />
          <Button key="band-open" plain hotkey="o" label="Open" onPress={() => openPane($)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)

      return <Text dimColor>The radio picker needs a terminal or the desktop app.</Text>
    }

    const elements = $.ui.resolve(e)
    const { Box, Button, Input, Text } = elements
    isPaneFocused = e.props.isFocused
    // VS Code panes draw no Client (its table still answers one, drawing an empty
    // box), so it gets the bars standing still.
    const Client = e.surface !== 'vscode' && 'Client' in elements ? elements.Client : undefined
    const list = await read($, channels)
    const wanted = await read($, station)
    // Starting until this module's cvlc plays it; read either way, so tune() redraws this.
    const buffered = await read($, buffering)
    const percent = wanted !== null && playing !== wanted ? 0 : buffered
    const loudness = await read($, volume)
    const muted = await read($, isMuted)
    const played = await read($, recent)
    const starred = await read($, favorites)
    const opened = await read($, openPicker)
    const tuned =
      list.find(c => c.id === wanted) ??
      starred.find(c => c.id === wanted) ??
      played.find(c => c.id === wanted) ??
      playingAs(wanted)
    const isStarred = starred.some(c => c.id === tuned?.id)
    const isLive = tuned !== undefined && percent === null
    const isCompact = e.props.bodyColumns < COMPACT_BELOW
    const named = (c: Channel) => (isCompact ? c.title : `${c.title} (${c.genre})`)
    const badge = badgeOf(tuned, percent, muted)
    // Cleaned on read too: a control character stored before would refuse the pane.
    const text = printable(await read($, query))
    // Favorites and Recent keep stations their source dropped; search finds them
    // there too, each once.
    const searchable = [...list, ...starred, ...played].filter((c, index, all) => all.findIndex(o => o.id === c.id) === index)
    const results = search(searchable, text)
    const dropdowns = await read($, pickers)
    // One column for the labels, so every dropdown's ▾ lines up.
    const labelWidth = Math.min(LABEL_MAX, Math.max(0, ...dropdowns.map(p => p.label.length))) + 1
    const play = async (id: string) => {
      await update($, station, () => id)
      await update($, query, () => '')
      await update($, openPicker, () => null)
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box
          key="card"
          flexDirection="column"
          // Compact drops the border: its 4 columns are worth more to the text.
          {...(isCompact ? {} : { borderStyle: 'round', borderColor: isLive && !muted ? 'claude' : 'subtle', paddingX: 1 })}
        >
          <Box
            key="title-row"
            flexDirection={isCompact ? 'column' : 'row'}
            justifyContent={isCompact ? 'flex-start' : 'space-between'}
            columnGap={2}
          >
            <Box flexShrink={1}>
              <Text bold wrap="truncate-end">
                {tuned === undefined ? 'Radio off' : `♪ ${tuned.title}`}
              </Text>
            </Box>
            <Box flexShrink={0} columnGap={1}>
              {tuned !== undefined &&
                (Client !== undefined ? (
                  <Client key="equalizer" module="./equalizer.tsx" props={{ isPlaying: isLive && !muted }} width={7} />
                ) : (
                  <Text color={isLive && !muted ? 'claude' : 'inactive'}>{isLive && !muted ? '▃▅▇▅▂▆▄' : '▁▁▁▁▁▁▁'}</Text>
                ))}
              <Text bold color={badge.color}>
                {badge.text}
              </Text>
            </Box>
          </Box>
          {tuned === undefined ? (
            <Text dimColor wrap="truncate-end">
              {isCompact ? 'Pick a station below.' : 'Pick a station below, or run /radio-fm with its name.'}
            </Text>
          ) : (
            percent !== null && (
              <Text dimColor>
                Buffering {meter(percent)} {percent}%
              </Text>
            )
          )}
          {tuned !== undefined && (
            <Text dimColor wrap="truncate-end">
              {tuned.genre}
            </Text>
          )}
        </Box>
        <Box flexDirection="column">
          <Box columnGap={isCompact ? 1 : 3} flexWrap="wrap">
            <Text>
              Vol {meter(muted ? 0 : loudness, isCompact ? 5 : 10)}{' '}
              {muted ? `muted (${loudness}%)` : `${String(loudness).padStart(3)}%`}
            </Text>
            <Box columnGap={isCompact ? 1 : 2}>
              <Button key="quieter" plain label="−" hotkey="9" onPress={() => changeVolume($, v => v - VOLUME_STEP)} />
              <Button key="louder" plain label="+" hotkey="0" onPress={() => changeVolume($, v => v + VOLUME_STEP)} />
              <Button
                key="mute"
                plain
                label={muted ? 'Unmute' : 'Mute'}
                hotkey="m"
                onPress={() => update($, isMuted, m => !m)}
              />
              {tuned !== undefined && (
                <Button key="stop" plain label="Stop" hotkey="s" onPress={() => update($, station, () => null)} />
              )}
              {tuned !== undefined && (
                <Button
                  key="favorite"
                  plain
                  label={isStarred ? '★ Unstar' : '☆ Star'}
                  hotkey="f"
                  onPress={() => toggleFavorite($, tuned)}
                />
              )}
            </Box>
          </Box>
          {!e.props.isFocused && (
            <Text dimColor wrap="truncate-end">
              {isCompact ? 'Focus the pane for the keys.' : 'The keys work once the pane has focus: click it, or ctrl+x tab.'}
            </Text>
          )}
        </Box>
        <Box flexDirection="column">
          {starred.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold dimColor>
                Favorites
              </Text>
              {starred.map(c => (
                <Box key={`favorite-row-${c.id}`} columnGap={1}>
                  <Button
                    key={`favorite-${c.id}`}
                    plain
                    dimColor={c.id === tuned?.id}
                    // " ✕" after it takes 2 of the columns.
                    label={clip(`${c.id === tuned?.id ? '♪ ' : ''}${named(c)}`, e.props.bodyColumns - 2)}
                    onPress={() => update($, station, () => c.id)}
                  />
                  <Button key={`unstar-${c.id}`} plain dimColor label="✕" onPress={() => toggleFavorite($, c)} />
                </Box>
              ))}
            </Box>
          )}
          {played.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <Box justifyContent="space-between">
                <Text bold dimColor>
                  Recent
                </Text>
                {/* No hotkey: one stray key should not wipe the list. */}
                <Button key="forget-all" plain dimColor label="Clear" onPress={() => forget($)} />
              </Box>
              {played.map((c, index) => (
                <Box key={`recent-row-${index + 1}`} columnGap={1}>
                  <Button
                    key={`recent-${index + 1}`}
                    plain
                    hotkey={String(index + 1)}
                    dimColor={c.id === tuned?.id}
                    // "1: " before it and " ✕" after it take 5 of the columns.
                    label={clip(`${c.id === tuned?.id ? '♪ ' : ''}${named(c)}`, e.props.bodyColumns - 5)}
                    onPress={() => update($, station, () => c.id)}
                  />
                  <Button key={`forget-${index + 1}`} plain dimColor label="✕" onPress={() => forget($, c.id)} />
                </Box>
              ))}
            </Box>
          )}
          <Text bold dimColor>
            Stations
          </Text>
          {list.length === 0 && <Text dimColor>No stations loaded. Run /radio-fm again.</Text>}
          <Box columnGap={1}>
            <Input
              key="search"
              label="Search "
              // Until the field has the keys, typing presses the pane's hotkeys (s stops).
              placeholder={isCompact ? 'Tab here, then type' : 'Tab here, then type a name or genre'}
              value={text}
              submitLabel="play first"
              onInput={value => update($, query, () => printable(value))}
              onSubmit={value => {
                const first = search(searchable, printable(value))[0]

                return first === undefined ? undefined : play(first.id)
              }}
            />
            {text !== '' && <Button key="search-clear" plain dimColor label="✕" onPress={() => update($, query, () => '')} />}
          </Box>
          {text.trim() !== '' && results.length === 0 && <Text dimColor>No station matches “{text.trim()}”.</Text>}
          {results.slice(0, RESULTS_MAX).map(c => (
            <Button
              key={`result-${c.id}`}
              plain
              dimColor={c.id === tuned?.id}
              label={clip(`${c.id === tuned?.id ? '♪ ' : ''}${named(c)}`, e.props.bodyColumns)}
              onPress={() => play(c.id)}
            />
          ))}
          {results.length > RESULTS_MAX && (
            <Text dimColor>{results.length - RESULTS_MAX} more: type more of the name.</Text>
          )}
          {text.trim() === '' && dropdowns.map(({ source, label }) => {
            const group = list.filter(c => c.source === source)
            if (group.length === 0) return false

            const isTunedHere = group.some(c => c.id === tuned?.id)
            // Drawn only while the pane holds the keys, so Esc hides it at once.
            const isOpen = opened === source && e.props.isFocused
            const current = isTunedHere && tuned !== undefined ? named(tuned) : 'Pick a station…'
            const close = async () => {
              await update($, openPicker, () => null)
              await $.ui.focus({ requestId: PANE, key: `station-${source}` }).catch(ignore)
            }

            return (
              <Box key={`picker-${source}`} flexDirection="column">
                <Button
                  key={`station-${source}`}
                  plain
                  label={clip(`${clip(label, LABEL_MAX).padEnd(labelWidth)}${isOpen ? '▴' : '▾'} ${current}`, e.props.bodyColumns)}
                  // Opening leaves the keyboard on this row: a ring moved into the list
                  // stays lit on its station while the pointer lights another, so
                  // two stations look picked. Tab steps into the list.
                  onPress={() => (isOpen ? close() : update($, openPicker, () => source))}
                />
                {isOpen && (
                  <Box flexDirection="column" paddingLeft={2}>
                    {group.map(c => (
                      <Button
                        key={`pick-${c.id}`}
                        plain
                        dimColor={c.id === tuned?.id}
                        label={clip(`${c.id === tuned?.id ? '♪ ' : ''}${named(c)}`, e.props.bodyColumns - 2)}
                        onPress={async () => {
                          await update($, station, () => c.id)
                          await close()
                        }}
                      />
                    ))}
                    <Button key={`close-${source}`} plain dimColor label="Close" onPress={close} />
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })
}
