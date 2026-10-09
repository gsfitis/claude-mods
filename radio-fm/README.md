# radio

Internet radio inside Claude Code: radio-browser.info directories and your own stations in a pane, with search,
favorites, recent stations and a one-line mini-player above the prompt.

## Requirements

- VLC's `cvlc` on your `PATH`: it plays the streams
- Linux with a systemd user session bus (`busctl`): volume, mute and the stall watchdog talk to VLC
  over MPRIS (without it the radio still plays, at VLC's own volume)
- Network access to the `url` of each fetched feed in your feeds file (by default
  `all.api.radio-browser.info`) and to each station's own stream server

## Install

To listen with the default dropdowns:

```
/plugin install radio --marketplace gsfitis/claude-mods
```

That runs a copy in Claude Code's plugin cache, which an update replaces. To keep dropdowns of your
own (`feeds.json`, below), install from a clone instead, so the mod runs from your folder:

```
git clone https://github.com/gsfitis/claude-mods
claude plugin marketplace add ./claude-mods
claude plugin install radio@claude-mods --scope user
```

An edit in the clone takes effect after `/reload-plugins`, except `feeds.json`, which is read live.

## Use

`/radio-fm` opens the pane. (Claude Code's built-in `/radio` is a different thing.)

| Command | Does |
| --- | --- |
| `/radio-fm` | open the pane |
| `/radio-fm <station>` | tune by id or name, e.g. `/radio-fm my-jazz-station` |
| `/radio-fm stop` | turn it off |
| `/radio-fm vol 0-100` | set the volume (`/radio-fm vol` says the level) |
| `/radio-fm mute` / `unmute` | mute keeps the level |
| `/radio-fm forget <station>` / `forget all` | remove from Recent |

### Pane keys (once the pane has focus: click it, or `ctrl+x tab`)

| Key | Does |
| --- | --- |
| `9` / `0` | volume down / up |
| `m` | mute / unmute |
| `s` | stop |
| `f` | star / unstar the playing station |
| `1`–`5` | play a Recent station |

Search: Tab into the field first, then type any words of a name or genre (case and accents
ignored); until the field has the keys, letters press the keys above. With the field empty, the
dropdown rows open each feed's full list.

Favorites (starred, uncapped; `✕` unstars) and Recent (the last 5 that actually played; `✕`
removes, Clear empties) are saved across sessions, and keep a station playable even after its
source stops listing it. The volume is saved too; mute lasts for the session.

### Mini-player

While a station plays and the pane is closed, one row above the prompt shows it. Once that row has
focus (click it, or `ctrl+x tab`): `m` (mute), `s` (stop) and `o` (open the pane).

## Dropdowns (feeds.json)

Every dropdown, and every address the mod fetches or plays, comes from a feeds file in the mod's
folder (`radio-fm/` in your clone; see Install): your own `feeds.json` (untracked, in
`.gitignore`), or `feeds.default.json` (tracked: a radio-browser search for Greek stations) while
you have none. Start yours by copying the default:

```
cd radio-fm && cp feeds.default.json feeds.json
```

Each feed is a dropdown, in the order written:

```json
{
  "feeds": [
    {
      "name": "Italy",
      "source": "radio-browser",
      "url": "https://all.api.radio-browser.info/json/stations/search?countrycode=IT&hidebroken=true&order=clickcount&reverse=true&limit=40",
      "stations": [{ "id": "my-news", "title": "My News Station", "genre": "news", "url": "https://stream.example.com/news" }]
    },
    {
      "name": "Jazz",
      "stations": [{ "title": "My Jazz Station", "url": "https://stream.example.com/jazz.mp3" }]
    }
  ]
}
```

- `"source": "radio-browser"` means the feed's `url` is a radio-browser.info station search (any
  query its API takes: a country, a tag, a language), asked once per load of the mod. An answer
  that fails, or lists nothing, is asked again on the next load, the feed keeping its last
  stations meanwhile. Leave `source` out for a feed of your own stations only; a `url` without a
  `source` is never fetched.
- `stations` are listed first in their dropdown, ahead of anything fetched (which skips a station
  with the same id or stream). A station needs a `title` and an http(s) `url` (a stream, or a
  `.pls`/`.m3u` playlist VLC plays); `id` and `genre` are optional.
- A station's id (for `/radio-fm <station>`) is its `id`, slugged (`"Rai 1"` is `rai-1`), else its
  title slugged (`My Jazz Station` is `my-jazz-station`). The station playing keeps its id until it
  stops, whatever is edited or answers meanwhile; then an `id` you give is kept; the rest are handed
  out in the file's order, and one already taken gets its feed's key (the feed name, slugged) after
  it, `my-jazz-station-jazz`, then a number. A station keeps its id while the mod stays loaded,
  even when a feed listed before it starts answering. Between sessions, a feed that was down when
  the first one started, or feeds reordered or renamed, can still move an id, and with it a
  Favorite or Recent entry that names it; an `id` of your own moves only for the station playing
  under it, until it stops.

The file is read each time the station lists load, so an edit shows on the next `/radio-fm`.
Entries missing a name, a title or an http(s) url, naming an unknown source, or giving a `url`
without a `source`, and feeds left with nothing to fetch or play, are skipped, and a toast names
them (`feed 2 "Jazz"`, `"Jazz" station 3`); a `feeds.json` that cannot be read falls back to
`feeds.default.json`, and a toast says why. A feed's own stations work everywhere the others do
(search by title or feed name, Favorites, Recent, `/radio-fm <station>`), and still play when every
fetched feed is unreachable, as do your Favorites and Recent stations (`/radio-fm` still opens
the pane on them). A feed name longer than 15
characters is cut in its dropdown.

## Options

`resumeOnStart` (default on): a new session plays the station that was playing when the last one
ended.

## Development

```
claude plugin validate radio-fm
claude plugin test radio-fm
```
