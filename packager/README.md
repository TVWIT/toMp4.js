# OTFP-compatible HLS packager

> **Parked (2026-10-27):** not deployed. Fastly OTFP was fixed, so this is kept for reference only.
> See `docs/plans/2026-10-26-otfp-compatible-packager.md`.

Packages progressive MP4s from object storage (Backblaze B2) as HLS (MPEG-TS) on request, using
`RemoteMp4` from this repo. It accepts the request URLs Invintus sends Fastly's On-the-Fly Packager,
so Fastly can fail over to it. Design and rationale:
`docs/plans/2026-10-26-otfp-compatible-packager.md`.

## Run

```bash
npm run packager                      # PORT=8080, B2 origin by default
PORT=8090 ORIGIN_BASE=https://s3.us-east-005.backblazeb2.com/invintus-client-media/ npm run packager

docker build -f packager/Dockerfile -t tomp4-packager .   # from the repo root
docker run --rm -p 8080:8080 tomp4-packager
```

| Env | Default | Notes |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | |
| `ORIGIN_BASE` | `https://s3.us-east-005.backblazeb2.com/invintus-client-media/` | Must allow anonymous Range GETs (the B2 bucket does) |
| `PUBLIC_BASE_URL` | — | Base for absolute variant URLs when the request has no `X-Packager-Base-Url` |
| `SEGMENT_DURATION` | `6` | Seconds; segments end at the first keyframe at or after this |
| `ORIGIN_TIMEOUT_MS` | `15000` | Per origin request (OTFP uses 15 s) |
| `CACHE_MAX_MB` | `512` | Parsed sources (~4–5 MB per 42-min rendition) |
| `CACHE_TTL_S` | `21600` | Re-read sources after 6 h |
| `MAX_CONCURRENT_SEGMENTS` | `32` | Segment builds in flight |

## Routes

| Request | Response |
|---|---|
| `GET /{dir}/{a},{b},…/master.m3u8` | Master, variants in URL order, absolute `{base}/{dir}/{x}-tm.m3u8` (base from `X-Packager-Base-Url`, else `PUBLIC_BASE_URL`, else the request host) |
| `GET /{dir}/{name}.m3u8`, `/{dir}/{name}-tm.m3u8` | Media playlist of `{ORIGIN_BASE}{dir}/{name}.mp4`, relative `{name}-tm{n}.ts` |
| `GET /{dir}/{name}-tm{n}.ts` | MPEG-TS segment n (1-based) |
| `?start=&end=` on playlists | Segment-level slice; on a master, carried to the variant URLs |
| `GET /healthz` | `200 {"ok":true,…}`: point the Fastly health check here |

OTFP-named segments (`{name}-{n}.ts`) get 404 `Foreign segment name`: a session must not mix
packagers. `?subtitles=`, `?iframe` and DASH aren't supported (our player doesn't use them).

## Responses

- Playlists: `application/vnd.apple.mpegurl`, `Cache-Control: public, max-age=3600`.
- Segments: `video/mp2t`, `Cache-Control: public, max-age=604800, immutable` (asset names are content hashes).
- `ETag` on everything (`If-None-Match` → 304), `Access-Control-Allow-Origin: *`, HEAD supported.
- Errors set `X-Packager-Error`, mirroring OTFP's `X-Fastly-Package-Error`: `Origin 404` (404),
  `Invalid response from origin` / `Failed to reach origin` / `Invalid Content-Range from origin`
  (502), `Origin timeout` (504), `Incompatible or corrupt origin media`, `Flapping origin entity`
  (500). 404s are cacheable for 60 s; 5xx are `no-store`.
- One JSON log line per request: `{t, method, path, status, ms, bytes, err?}`.

## Measured (event 2147483647/2026101011, 42:12, 5 renditions, from B2)

- Cold master (5 sources read and parsed in parallel): 2.6 s; warm: ~1 ms.
- 6 s segment: 0.3–1.2 s to build (~10× real time).
- hosted-player (`?src=` direct source) plays from 0:00 and after a seek to 21:06; hls.js started on
  the 1080p variant.
