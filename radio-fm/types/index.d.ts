export type Picker = { source: string; label: string }

export type Channel = {
  id: string
  title: string
  genre: string
  url: string
  // the key of the feeds.json dropdown it came from: its name, slugged
  source: string
}

declare module 'claude-code' {
  interface PluginState {
    radio: {
      station: string | null
      channels: Channel[]
      buffering: number | null
      volume: number
      isMuted: boolean
      recent: Channel[]
      favorites: Channel[]
      // the open dropdown's source
      openPicker: string | null
      // the dropdowns, in feeds.json's order
      pickers: Picker[]
      isPaneOpen: boolean
      query: string
      started: boolean
    }
  }
}
