/**
 * One height for every bar across the top of the app shell.
 *
 * WHY THIS IS A CONSTANT AND NOT A NUMBER TYPED THREE TIMES
 *
 * The shell has three bars that must end on the same horizontal line: the
 * sidebar's brand block, the desktop top bar, and the mobile header. Each one
 * was sized by its own padding around its own content, so each ended up a
 * different height:
 *
 *   sidebar brand   py-4 (32) + h-8 icon (32)        = 64px
 *   desktop top bar py-2 (16) + bell p-2 + w-5 (36)  = 52px
 *   mobile header   py-3 (24) + bell p-2 + w-5 (36)  = 60px
 *
 * So the border under the sidebar sat 12px below the border under the top bar,
 * which is visible as a step where the two meet. Nothing was wrong with any
 * individual rule; the heights were simply never expressed as the same thing.
 *
 * Padding cannot hold three bars level when their contents differ, because the
 * result depends on the tallest child in each. An explicit height can, so the
 * bars declare a height and centre whatever they hold inside it.
 *
 * Changing this value moves all three together, which is the point.
 */
export const APP_SHELL_BAR_HEIGHT = "h-16";
