# Evidence for a flow with no UI

Read this when the thing you are proving has nothing to show: a webhook, a cron job, a sweep, an API
procedure, a queue drain, an MCP server. It still needs ONE file: request, response and database
rows, in the order they ran.

```bash
F=/selfbuilding/out/files/verify/bounce-webhook   # the flow's slug directory (SKILL.md §2)
mkdir -p "$F"
{
  echo '== request =='
  curl -sS -X POST http://localhost:3000/api/webhooks/bounce \
    -H 'content-type: application/json' -d '{"event":"bounce","email":"a@example.test"}'
  echo
  echo '== db =='
  psql "$DATABASE_URL" -c "select id, status from tickets order by id desc limit 5"
} 2>&1 | tee "$F/evidence.md"
```

- **Never build a browser recording for a flow like this.** A recording of a page the flow never
  touches looks like proof and is worth less than the text.
- The response is what the app said; the rows are what happened. Quote both. The four outcomes apply
  unchanged.
- **Seeding:** run the app's own seed script if it has one. If not, drive the app's own API, and say
  whether you seeded. A pass against an empty database proves little.

## A callback from outside the sandbox

An OAuth redirect or a third-party webhook comes from the internet, not from the sandbox. Do not
fake one with a hand-written request and call it verified. Drive it through the vendor's local mock
or test mode if one exists; otherwise the flow is `could_not_boot`, with the missing inbound route
named in `detail`.

## An MCP server

`curl` is the wrong driver: every call needs an `initialize` handshake, Streamable HTTP carries a
session id, and stdio has no URL. Use a scriptable MCP client (the MCP Inspector's CLI mode, pinned
to an exact version), one method per call, raw JSON out:

1. `initialize` proves the server speaks MCP;
2. `tools/list` proves the tool and its `inputSchema`;
3. `tools/call` is the flow;
4. the rows are what happened.

Put all four in the one evidence file. The checker lowers a claim to `broken` when the result has
`isError: true`, empty `content`, or the row is missing. A handshake that never completes is
`could_not_boot`.
