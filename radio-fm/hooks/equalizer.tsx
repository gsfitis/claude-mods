import type { ClientModule } from 'claude-code'

type Props = { isPlaying: boolean }
type State = { frame: number }

const BARS = '▁▂▃▄▅▆▇█'
const COUNT = 7
const FRAME_MS = 120

// Decorative: neither VLC nor MPRIS exposes audio levels, so the bars are two
// sine waves per column, out of phase, moving only while audio flows.
const bars = (frame: number): string =>
  Array.from({ length: COUNT }, (_, column) => {
    const wave = Math.sin(frame * 0.55 + column * 1.3) + Math.sin(frame * 0.31 * (1 + column / 3) + column * 2.1)
    const level = Math.round(((wave + 2) / 4) * (BARS.length - 1))

    return BARS[Math.min(BARS.length - 1, Math.max(0, level))]
  }).join('')

// Runs on the drawing surface with its own frame clock: animating costs the
// hooks module nothing. ponytail: it ticks while idle too (a 7-glyph redraw);
// stop the timer on !isPlaying if a profile ever says it matters.
const Equalizer: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  if (surface.state === undefined) {
    surface.setState({ frame: 0 })
    surface.every(FRAME_MS, () => surface.setState({ frame: (surface.state?.frame ?? 0) + 1 }))
  }

  return props.isPlaying ? (
    <Text color="claude">{bars(surface.state?.frame ?? 0)}</Text>
  ) : (
    <Text dimColor>{BARS[0]!.repeat(COUNT)}</Text>
  )
}

export default Equalizer
