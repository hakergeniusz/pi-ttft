# pi-ttft

Time-to-first-token and decode throughput in [pi](https://github.com/earendil-works/pi)'s
footer, next to the token stats that are already there.

```
↑200 ↓125 R1.8k CH90.0% T800ms 38t/s 1.0%/100k (auto)
                        ^^^^^^  ^^^^
                        TTFT    throughput
```

`T800ms` is the average time to the first token over this chat. `38t/s` is the average
output-token rate after that first token. Both are hidden until the first assistant
response completes.

## Commands

| Command | What it does |
|---|---|
| `/ttft` | Report the current averages plus a per-model breakdown |
| `/ttft avg` | Footer shows the average over the chat (default) |
| `/ttft last` | Footer shows only the newest response |
| `/ttft reset` | Drop the samples collected so far |
| `/ttft off` | Restore the built-in footer |
| `/ttft on` | Reinstall the footer with the speed segments |

Environment overrides: `PI_TTFT_DISPLAY=last` to start in last-response mode,
`PI_TTFT_FOOTER=0` to leave the built-in footer alone.

## Colours

The segments change colour when the model is slow, using pi's theme tokens:

| Segment | Yellow | Red |
|---|---|---|
| `T` (TTFT) | over 15 s | over 45 s |
| `t/s` (throughput) | under 25 t/s | under 10 t/s |

Both thresholds are configurable: `PI_TTFT_WARN_TTFT_MS`, `PI_TTFT_SLOW_TTFT_MS`,
`PI_TTFT_WARN_TPS`, `PI_TTFT_SLOW_TPS`.

## How it is measured

Per assistant response:

| Point | Event | Meaning |
|---|---|---|
| `t0` | `before_provider_headers` | Headers assembled, HTTP call next — the honest start of the request |
| `t1` | first `*_delta` / `*_start` on `message_update` | First token, thinking deltas included |
| `t2` | `message_end` | Stream finished |

```
TTFT       = t1 - t0
throughput = output tokens / (t2 - t1)
```

`t0` is taken from `before_provider_headers` rather than `message_start` on purpose:
`message_start` fires only once response headers are back, which would hide connection
setup, TLS, and provider queueing — exactly the latency people mean by TTFT.

Throughput uses `usage.output`, which includes reasoning tokens when the model reports
them, divided by the generation window. That matches how throughput is normally quoted,
and it means a long thinking phase lowers the rate. Providers that report no usage fall
back to a character estimate of 4 characters per token.

Samples reset on `session_start`, so the average covers the chat you are in. They are not
written to the session file.

## Why the footer is replaced

pi exposes `ctx.ui.setFooter()` but no hook to extend the built-in stats line, so
`MetricsFooter` reproduces the layout of pi 1.1.0's `FooterComponent.render()` and adds
two segments. Consequences worth knowing:

- The route arrow for virtual models (`model → routed-model`) is dropped; it comes from
  `AgentSession.routedModel`, which extensions cannot read. The `omniroute` extension
  keeps working, only that suffix is missing.
- Auto-compaction (`(auto)`) is read from `settings.compaction.enabled` with a 1 s cache
  instead of the live `AgentSession` flag, so a mid-session toggle shows up within a
  second.
- Only one extension can own the footer. If another extension calls `setFooter()` after
  this one, it wins; `/reload` restores the order.

Everything else — token totals, cache hit rate, cost and `(sub)`, context percentage and
its colouring, git branch, session name, provider prefix, thinking level, truncation at
narrow widths, and the `ctx.ui.setStatus()` line — is unchanged.

## Development

```
bun test.ts   # smoke test: fake pi, fake ctx, stubbed clock, no network
```