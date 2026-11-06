# Driving a flow in the browser

Everything between "the app is booted" (SKILL.md §3a) and "the evidence exists". Each trap here
costs a whole re-run the first time. One app's own facts live in its `.selfbuilding/verify/README.md`,
never here.

## The tools

The verifier has the `browser` MCP server: headless Chromium, a fresh profile per session, files
written under `/selfbuilding/out/files/verify/`. These are the tools a person's hands map to:

| Tool | A person would |
|---|---|
| `browser_navigate`, `browser_navigate_back` | type a URL, press Back |
| `browser_snapshot` | look at the page (an accessibility tree with element refs; read it before every click) |
| `browser_click`, `browser_hover`, `browser_drag` | click, hover, drag |
| `browser_type`, `browser_fill_form`, `browser_press_key`, `browser_select_option` | type, fill a form, press a key, pick an option |
| `browser_file_upload`, `browser_handle_dialog` | upload a file, answer a dialog |
| `browser_wait_for` | wait for text to appear or disappear |
| `browser_take_screenshot` | take a screenshot |
| `browser_resize`, `browser_tabs` | resize the window, switch tabs |
| `browser_console_messages`, `browser_network_requests` | open the developer tools to watch, never to act |

**Never use** `browser_evaluate`, `browser_run_code`, or any tool that runs script in the page,
mocks a route or sets a cookie: a person cannot do that, and a pass that needs it is not a pass.

## Screenshots

Take one per step with `browser_take_screenshot` and `filename` set to
`<slug>/screenshots/NN-<step>.png`, numbered from `01` in the order they happened. The tool replies
with the path it wrote. If that is not the path you asked for (some versions flatten the name),
move the file there with `mv`: filing your own screenshot is bookkeeping, not an app action. Take a
full-page screenshot when the end state is below the fold.

## Selectors and waiting

- **Click what the snapshot names**, by its ref. When the facts file lists `data-testid` selectors,
  use them to find the right element in the snapshot, not to script around the page.
- **Wait for the destination, not for "not the origin".** After a submit, wait for the text or
  element the flow's end state names (a flash, the new row in the list). A redirect that has not
  finished leaves the evidence on a blank page.
- **Reload to prove persistence.** When the end state must survive a reload, navigate to the same
  URL again and screenshot it.
- Text often matches a heading, a toast and a live region at once; prefer the element whose role
  matches what the user sees.

## Skipping sign-in with the seeded session

When the flow is *downstream* of sign-in, start from the session setup seeded and named in
`setup.json`. Say in the evidence that you did, and why: it is right only when sign-in is not what
the flow proves.

## A phone or a tablet

The default is a desktop window. For a layout change at a breakpoint, `browser_resize` to the width
the CSS reads. A change that needs a real mobile context (touch, `<meta name="viewport">`) cannot be
proved by resizing: say so in `detail` instead of calling a resized desktop a phone.

## A flow that needs a mailbox

Point the app's mail settings at the mailbox shim setup started (SETUP does that, before the boot),
and read the message in the shim's web UI with the browser, newest first. Use a fresh address per
run, so a retry cannot read a stale message. Codes usually expire in minutes; if you burn one, send
a new one rather than typing a dead code and reporting a false defect.

## Proving a remount instead of blaming your own typing

Missing keystrokes tempt "the driver typed too fast". Test it: type one character, snapshot, and
check whether the same field still has focus and kept the earlier characters. The cause is almost
always a component declared inside another, so its identity changes every render and a person gets
one character in, then loses focus. Record it as an observation with the frame.

If a defect blocks the rest of the flow, work around it the way a person would (click the field
again and keep typing), caption both the defect and the workaround, and keep going: the remaining
steps still get verified and the evidence shows the bug.
