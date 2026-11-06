# The project's own verify folder

Read this when a repository has no `.selfbuilding/verify/` folder, or when what you learned booting
the app belongs in one.

The boot command, environment, session and selectors differ per repository and change with the
app, so they live in the app's repository: the change that renames a cookie fixes the note in the
same diff. A copy kept in this skill would age where no app change ever touches it.

## The contract

```
<repo>/.selfbuilding/verify/
  README.md        always read first: boot, env, auth, database, macros, probes
  selectors.md     the app's own widgets and routes, when README grows past a screen
  setup/           SETUP macros: scripts that write state through app internals (mint a user,
                   sign in as admin, flip a flag, add credits, send a test webhook, reset)
  check/           CHECK probes: scripts that read a surface without the UI (a database row, the
                   mailbox, a queue, a webhook log, console errors)
```

- **`setup/` is for setup, `check/` for the checker, never either for the verifier.** A
  state-writing script in the verifier's hands produces a pass that looks exactly like a real one.
- `README.md` is the only required file and the only one this skill promises to read.
- **Absent is not an error.** Discover the facts, verify, then write a draft of the folder into your
  evidence directory (`/selfbuilding/out/files/verify/proposed-verify-folder/`) so a human can add
  it. This is a read-only run: never write it into the repository yourself.

## The template

```markdown
# Verifying this app

app dir            apps/web                          (pnpm, never npm here)
dev command        pnpm dev
readiness          curl -sf http://127.0.0.1:3000/api/health   (setup waits at most 300 s)
fresh database     DATABASE_PATH=/tmp/verify-<slug>.db pnpm db:reset && pnpm db:seed
db probe           sqlite3 "$DATABASE_PATH" 'select id, title from notes order by id desc limit 5'

## Environment
DATABASE_URL            the fresh database setup created
<AUTH_SECRET>           32+ characters or the auth library refuses
<VENDOR_KEY>            no key: the client is null and the flow dies on "<the message>"
<A_FAKE_ONE_IS_FINE>    logs an error and the flow continues; that line is noise

## Signing in
The seed script creates <user> in <org>. Session cookie name: <name>.

## Selectors and routes
one-time code      input[data-input-otp]
after sign-in      /org/resolve is a spinner: wait for /dashboard, not for "not /sign-up"

## Database
snake_case columns whatever the models say; "user" is reserved, quote it.

## Setup macros (SETUP only)
setup/mint-user.mjs --tier free|pro        makes an account and a session, prints both
setup/set-flag.mjs <flag> on|off           flips a feature flag for the seeded org

## Check probes (CHECKER only)
check/db.sh <table> [where]                the rows
check/mailbox.sh <to>                      messages to one address, from the mailbox shim
```

Keep it to a screen or two: every line should be something you would otherwise learn by booting the
app and failing once.
