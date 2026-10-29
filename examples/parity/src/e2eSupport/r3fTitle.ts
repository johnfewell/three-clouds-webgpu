// The r3f smoke's check that the r3f dev server serves examples/r3f (p4 test
// 9), here so vitest collects its tests. On a cold Vite dep cache the server
// reloads once after first load, and a title read inside that reload
// is ''. The origin is a PARAMETER: the config probes a free port
// per run, so the 5200 these messages used to name is rarely the port answered
/** The page methods the check uses. Playwright's Page satisfies it */
export interface TitleSource {
  title(): Promise<string>
  waitForTimeout(ms: number): Promise<void>
}

/** examples/r3f's `<title>` contains this (examples/r3f/index.html) */
export const R3F_TITLE = 'r3f example'

/** Polls until the title is non-empty, and returns '' at the deadline */
export async function settledTitle(
  page: TitleSource,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    // title() throws while the execution context is being replaced
    const title = await page.title().catch(() => '')
    if (title !== '' || Date.now() >= deadline) return title
    await page.waitForTimeout(250)
  }
}

/**
 * null when the title is examples/r3f's, otherwise the failure to report
 *
 * @param origin the URL the smoke navigated to, named in the message
 */
export function titleProblem(
  title: string,
  timeoutMs: number,
  origin: string
): string | null {
  if (title.includes(R3F_TITLE)) return null
  if (title === '') {
    return (
      `${origin} served an empty title for ${timeoutMs / 1000} s: the page ` +
      `never settled (a Vite dependency-optimize reload that did not finish, ` +
      `or an empty response). That is not evidence of a foreign server.`
    )
  }
  return (
    `${origin} answered with "${title}" — that is not examples/r3f. Something ` +
    `else is bound to this port; the smoke below would have graded it.`
  )
}
