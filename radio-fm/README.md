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

```
/plugin install radio --marketplace gsfitis/claude-mods
```

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
folder: your own `feeds.json` (untracked, in `.gitignore`), or `feeds.default.json` (tracked: a
radio-browser search for Greek stations) while you have none. Start yours by copying the default:

```
cp feeds.default.json feeds.json
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
  query its API takes: a country, a tag, a language), asked once per load of the mod. Leave
  `source` out for a feed of your own stations only.
- `stations` are listed first in their dropdown, ahead of anything fetched (which skips a station
  with the same id or stream). A station needs a `title` and an http(s) `url` (a stream, or a
  `.pls`/`.m3u` playlist VLC plays); `id` and `genre` are optional.
- A station's id (for `/radio-fm <station>`) is its `id`, else its title slugged (`My Jazz Station`
  is `my-jazz-station`). Ids are handed out in the file's order: one already taken gets its feed's
  key (the feed name, slugged) after it, `my-jazz-station-jazz`, then a number. Reordering or
  renaming feeds can move an id, and with it a Favorite or Recent entry that names it.

The file is read each time the station lists load, so an edit shows on the next `/radio-fm`.
Entries missing a name, a title or an http(s) url, or naming an unknown source, and feeds left with
nothing to fetch or play, are skipped, and a toast says how many; a `feeds.json` that cannot be
read falls back to `feeds.default.json`, and a toast says why. A feed's own stations work everywhere
the others do (search by title or feed name, Favorites, Recent, `/radio-fm <station>`), and still
play when every fetched feed is unreachable.

## Options

`resumeOnStart` (default on): a new session plays the station that was playing when the last one
ended.

## Development

```
claude plugin validate radio-fm
claude plugin test radio-fm
```
