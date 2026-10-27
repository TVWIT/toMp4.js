# svod / invintus-otfp service — custom VCL with failover to the tomp4 packager.
#
# Same behaviour as the current service while Fastly's On-the-Fly Packager (OTFP)
# is healthy. Adds:
#   1. Packager failover. When the OTFP backend is unhealthy (2026-10-26:
#      "503 No healthy backends") or fails without a packaging error, HLS
#      playlists are served by the tomp4 packager (packager/, same request URLs).
#      Its variant and segment names end in -tm, and -tm URLs always route to
#      it, so a playback session never mixes the two packagers.
#   2. A simulation switch: X-Simulate-Otfp-Down: <packager_cfg.simulate_token>
#      takes the failover path on demand, without caching the result.
#   3. 5xx responses are no longer kept as stale objects (they were cached with
#      stale_if_error 5m, so the edge kept serving an old 503).
#
# Needs (Fastly UI, see README.md in this directory):
#   - Backend "tomp4_packager" (F_tomp4_packager): TLS, override host, shield
#     iad-va-us, health check on /healthz, request condition
#     `req.http.X-Packager-Route == "1"`.
#   - Edge dictionary "packager_cfg": failover ("on"/"off"), simulate_token.
#   - The Fastly-managed "otfp" snippet (unchanged; defines
#     get_backend_otfp_vpop_mnz_https() and is_backend_otfp()).
#
# Storage keys belong in a write-only dictionary, never in this file.

sub vcl_recv {
  unset req.http.Cookie;

  if (req.request != "GET" && req.request != "HEAD" && req.request != "FASTLYPURGE") {
    error 405;
  }

  # Internal routing headers are trusted only between our own POPs (edge → shield).
  if (fastly.ff.visits_this_service == 0 && req.restarts == 0) {
    unset req.http.X-Packager-Route;
    unset req.http.X-Packager-Simulated;
    unset req.http.X-Packager-Base-Url;
  }

  # Simulated OTFP outage (testing): only with the configured token, at the edge.
  declare local var.token STRING;
  set var.token = table.lookup(packager_cfg, "simulate_token", "");
  if (fastly.ff.visits_this_service == 0 && var.token != "" && req.http.X-Simulate-Otfp-Down == var.token) {
    set req.http.X-Packager-Simulated = "1";
  }
  unset req.http.X-Simulate-Otfp-Down;

  # Route to the tomp4 packager (picked up by the backend's request condition in
  # #FASTLY recv, which also applies shielding):
  #  - its own names (-tm.m3u8 variants, -tm{n}.ts segments), always;
  #  - a failover restart (X-failover: tm);
  #  - playlists during a simulated outage.
  if (req.url.path ~ "-tm(\d+)?\.(m3u8|ts)$"
      || req.http.X-failover == "tm"
      || (req.http.X-Packager-Simulated && req.url.ext == "m3u8")) {
    set req.http.X-Packager-Route = "1";
  }
  if (req.http.X-Packager-Simulated && !req.http.X-Packager-Route) {
    # OTFP-named segments: behave as if OTFP were down.
    error 503 "Simulated OTFP outage";
  }

#FASTLY recv

  # No wonky paths.
  if (req.url.path ~ "/(/|\.(/|\./))") {
    error 400;
  }

  if (req.url ~ "^/crossdomain.xml") {
    error 900;
  }

  if (req.url != req.url.path) {
    declare local var.start INTEGER;
    declare local var.end INTEGER;
    declare local var.iframe BOOL;
    declare local var.subtitles STRING;

    if (   req.url.ext ~ "^(?:ts|m3u8)$"
        && req.url.path !~ "/master.m3u8$"
        && req.url.qs ~ "(^|&)iframe(&|$)"
    ) {
      set var.iframe = true;
      # ?iframe versions of HLS media manifests and segments.
    } elsif (  req.url.path ~ "/master.m3u8$"
             && req.url.qs ~ "(?:^|&)subtitles=([^&]+)"
    ) {
      set var.subtitles = urldecode(re.group.1);
      # ?subtitles= qs may be applied to HLS master manifests only.
    }

    if (req.url.ext ~ "^(?:mpd|m3u8)" && req.url.path !~ "\.webvtt\.m3u8$") {
      if (req.url.qs ~ "(?:^|&)start=(\d+)(?:$|&)") {
        set var.start = std.atoi(re.group.1);
        if (var.start < 0) {
          error 400;
        }
      }
      if (req.url.qs ~ "(?:^|&)end=(\d+)(?:$|&)") {
        set var.end = std.atoi(re.group.1);
        if (var.end <= var.start) {
          error 400;
        }
      }
    }

    # drop all qs
    set req.url = req.url.path;

    # The normalized form of the URL will be "start=N&end=M", if present, If
    # "end" is specified without "start", that will be normalized to
    # "start=0&end=N". "start=0" alone will just be dropped, while "start=N" may
    # be specified without an "end".
    if (var.end > 0) {
      set req.url = querystring.add(req.url, "start", var.start);
      set req.url = querystring.add(req.url, "end", var.end);
    } elsif (var.start > 0) {
      set req.url = querystring.add(req.url, "start", var.start);
    }

    if (var.subtitles && var.subtitles != "") {
      set req.url = querystring.add(req.url, "subtitles", var.subtitles);
    } elsif (var.iframe) {
      set req.url = if(req.url.qs == "",req.url.path "?iframe", req.url "&iframe");
    }
  }

  /* unset state tracking header to avoid end-client sending it */
  if (req.restarts == 0) {
    unset req.http.X-failover;
  }

  /* failover logic: storage (aws|imw|ics) and packager (tm) */
  if (req.http.X-failover ~ "aws|imw|ics|tm") {
    /* stach the original host header for later if needed */
    set req.http.X-Orig-Host = req.http.Host;
    /* enable rqeuest clustering and force miss after restart */
    set req.http.Fastly-Force-Shield = "1";
    set req.hash_always_miss = true;
  }

  # Simulated responses must never land in the cache under normal keys.
  if (req.http.X-Packager-Simulated) {
    return(pass);
  }
  return(lookup);
}

sub vcl_miss {
#FASTLY miss

  # tomp4 packager (routed in vcl_recv): plain origin fetch, no OTFP headers or
  # URL rewrites. At the edge req.backend is the shield; at the shield it is
  # F_tomp4_packager (request condition).
  if (req.http.X-Packager-Route) {
    set bereq.http.X-Packager-Base-Url = if(req.is_ssl, "https://", "http://") req.http.host;
    return (fetch);
  }

  # Version 50 OTFP hardware update
  # Set req.backend to OTFP.
  # Subroutine is defined within OTFP managed snippet.
  set req.backend = get_backend_otfp_vpop_mnz_https();
  if (!is_backend_otfp()) {
    # Go to shield.
    return (fetch);
  }

  # At the packager location with the OTFP backend down: playlists go to the
  # tomp4 packager. OTFP-named segments can't (their cut points are OTFP's);
  # the player errors, reloads the playlist and lands on the packager.
  # (vcl_miss can't restart, so the backend is switched here directly.)
  if (!req.backend.healthy && table.lookup(packager_cfg, "failover", "on") == "on") {
    if (req.url.ext == "m3u8") {
      set req.http.X-Packager-Route = "1";
      set req.backend = F_tomp4_packager;
      set bereq.http.X-Packager-Base-Url = if(req.is_ssl, "https://", "http://") req.http.host;
      set bereq.http.X-Packager-Failover = "otfp-unhealthy";
      return (fetch);
    }
    error 503 "OTFP unavailable";
  }

  set bereq.http.X-Fastly-Ignore-Missing = "true";

  # Set defaults here and override special cases later
  set bereq.http.X-Fastly-Origin = "https://s3.us-east-005.backblazeb2.com/invintus-client-media/";

  # Keep all OTFP headers in Whitelist
  set bereq.http.X-Fastly-Whitelist = "Ignore-Missing Origin ";

  #
  # time slicing
  #
  if (req.url.ext ~ "^(m3u8|mpd)$" && req.url.qs ~ "(start=(\d+)(?:&end=(\d+))?)") {
    set bereq.http.X-Fastly-Segment-Condition = "slice=" re.group.2 "-" if(re.group.3, re.group.3, "");
    set bereq.http.X-Fastly-Whitelist = bereq.http.X-Fastly-Whitelist " Segment-Condition";
    if (std.suffixof(req.url.path, "/master.m3u8")) {
      set bereq.http.X-Fastly-Query-Param = re.group.1;
      set bereq.http.X-Fastly-Whitelist = bereq.http.X-Fastly-Whitelist " Query-Param";
    }
  }

  # failover logic
  if (req.http.X-failover == "ics") {
    set bereq.http.X-Fastly-Origin = "https://s3-external-1.amazonaws.com/elsclientstore/";
  } else if (req.http.X-failover == "imw") {
    set bereq.http.X-Fastly-Origin = "https://s3-us-west-2.amazonaws.com/invintus-mediaworkflow/";
    set bereq.http.X-Fastly-Whitelist = "Ignore-Missing Origin Hls-Fragmented-Mp4";
    set bereq.http.X-Fastly-Hls-Fragmented-Mp4 = "true";
  } else if (req.http.X-failover == "aws") {
    set bereq.http.X-Fastly-Origin = "https://s3-external-1.amazonaws.com/invintus-client-media/";
  }

  # Trim query parameters if present.
  set bereq.url = bereq.url.path;

  # Parse and handle ABR manifest requests.
  # Example: /9375922947/bf27bda395e9146272d2bd7a3dda56b1fc666214,bf27bda395e9146272d2bd7a3dda56b1fc666214_480p_30fps,bf27bda395e9146272d2bd7a3dda56b1fc666214_360p_30fps,/master.m3u8
  if (bereq.url ~ "^(.*/)([^/]+)/master\.(m3u8|mpd)$") {
    declare local var.base STRING;
    declare local var.parts STRING;
    declare local var.ext STRING;

    set var.base = re.group.1;     # base: /a/b/c/
    set var.parts = re.group.2;    # parts: lo,mid,hi
    set var.ext = re.group.3;    # extention: mpd, m3u8, f4m

    # parts is at least 1, up to 10, file names, separated by commas.
    if (var.parts !~ "^[^,]+(,[^,]+){0,9}$") {
      error 400 "Invalid request";
    }

    # If the req has the subtitles query parameter, we build our X-Fastly-Hls-Subtitles
    # header.
    declare local var.subtitles STRING;
    set var.subtitles = subfield(req.url.qs, "subtitles", "&");

    # temporarily override bereq.url (it'll be reset later - see bellow)
    # to sanitize the subtitles parameter
    set bereq.url = var.subtitles;
    set var.subtitles = bereq.url.basename;

    # URI and NAME are required, FORCED, DEFAULT, AUTOSELECT, LANGUAGE, and
    # CHARACTERISTICS are optional. We throw in LANGUAGE.
    if (var.subtitles != "") {  // hopefully checked and filtered in vcl_recv
      set bereq.http.X-Fastly-Hls-Subtitles = "NAME=English LANGUAGE=en URI=" var.subtitles ".webvtt.m3u8";
      set bereq.http.X-Fastly-Whitelist = bereq.http.X-Fastly-Whitelist " Hls-Subtitles";
    }

    set bereq.url = var.base "basic_multi." var.ext;
    set bereq.http.X-Fastly-Basic-Multi = regsuball(var.parts, ",", " ");

    # see vcl_hash
    set bereq.http.X-Fastly-Base-Url = if(req.is_ssl, "https://", "http://") req.http.host var.base;

    set bereq.http.X-Fastly-Whitelist = bereq.http.X-Fastly-Whitelist " Basic-Multi Base-Url ";

    if (var.ext == "m3u8") {
      set bereq.http.X-Fastly-Iframe-Param = "iframe";
      set bereq.http.X-Fastly-Whitelist = bereq.http.X-Fastly-Whitelist " Iframe-Param";
    }
  } else {
    if (req.url.qs ~ "iframe") {
      set bereq.http.X-Fastly-Iframe-Param = "iframe";
      set bereq.http.X-Fastly-Whitelist = bereq.http.X-Fastly-Whitelist " Iframe-Param";
    }
  }

  # /a/b/c/lo,mid,hi/master.m3u8 must have the same ID as /a/b/c/lo.m3u8, etc.
  if (req.url.path ~ "(^/[^,\-_.]+)") {
    set client.identity = re.group.1;
  } else {
    set client.identity = regsub(req.url.path, "[^/]+$", "");
  }

  return (fetch);
}

sub vcl_fetch {

  ################################################################################
  ### Added by Fastly staff. Reduces number of copies of an object stored per POP.
  ### For customers with large working sets, increases cache hit ratio.
  ### Do not remove!
  set beresp.reduced_redundancy = true;
  ################################################################################

  /* enable Streaming Miss to optimize first pull performance */
  set beresp.do_stream = true;

  # Packager failover: an OTFP playlist fetch failed without a packaging error
  # (infrastructure, not the file) → retry it on the tomp4 packager. Responses
  # that already came from the packager (X-Packager) are never retried.
  if (beresp.status >= 500 && beresp.status < 600
      && req.url.ext == "m3u8"
      && !req.http.X-Packager-Route
      && !beresp.http.X-Packager
      && !beresp.http.X-Fastly-Package-Error
      && req.restarts < 3
      && table.lookup(packager_cfg, "failover", "on") == "on") {
    set req.http.X-failover = "tm";
    restart;
  }

  /* do not cache any 400 or 404 videos from s3 */
  # UPDATE FOR LOOP ERROR, support ticket 67126
  if (beresp.status == 404 || beresp.status == 400){
    set beresp.cacheable = false;
  }

  if (beresp.status >= 500 && beresp.status < 600 ) {
    /* deliver stale if a good copy is available */
    if (stale.exists) {
      return(deliver_stale);
    }
    # Collapse a burst of requests onto one origin fetch, but never keep the
    # error itself as stale content (stale_if_error on a 5xx made the edge
    # serve a 5-minute-old 503).
    set beresp.cacheable = true;
    set beresp.ttl = 2s;
    set beresp.stale_if_error = 0s;
  } else {
    set beresp.ttl = 6h; # 6 hours
    set beresp.stale_if_error = 1d;
  }

  # Playlists the packager serves on OTFP URLs during a failover: short TTL, so
  # the service returns to OTFP soon after it recovers. Its -tm URLs keep 6 h.
  if (req.http.X-Packager-Route && req.url.ext == "m3u8" && req.url.path !~ "-tm\.m3u8$") {
    set beresp.ttl = 60s;
  }

#FASTLY fetch

  return(deliver);
}

sub vcl_pass {
#FASTLY pass

  # Simulated requests are passed (no vcl_miss), so set the base URL here too.
  if (req.http.X-Packager-Route) {
    set bereq.http.X-Packager-Base-Url = if(req.is_ssl, "https://", "http://") req.http.host;
  }
}

sub vcl_deliver {

  /* restart when backend is responding with invalid response */
  if (req.restarts == 0 && (resp.http.X-Fastly-Package-Error ~ "Origin 404" || resp.http.X-Fastly-Package-Error ~ "Invalid response from origin")) {
    set req.http.X-failover = "aws";
    restart;
  }
  if (req.restarts == 1 && (resp.http.X-Fastly-Package-Error ~ "Origin 404" || resp.http.X-Fastly-Package-Error ~ "Invalid response from origin")) {
    set req.http.X-failover = "imw";
    restart;
  }
  if (req.restarts == 2 && (resp.http.X-Fastly-Package-Error ~ "Origin 404" || resp.http.X-Fastly-Package-Error ~ "Invalid response from origin")) {
    set req.http.X-failover = "ics";
    restart;
  }

  /* enable CORS */
  if (!resp.http.Access-Control-Allow-Origin) {
    set resp.http.Access-Control-Allow-Origin = "*";
  }

  /* for logging */
  if (req.url.ext ~ "m3u8|ts|aac|webvtt") {
    set resp.http.Otfp-Format = "HLS";
  } else if (req.url.ext ~ "mpd|m4s") {
    set resp.http.Otfp-Format = "DASH";
  } else {
    set resp.http.Otfp-Format = "OTHER";
  }

  # Extract name-value pairs Otfp Info herder
  if (resp.http.X-Fastly-Otfp-Info) {
    set resp.http.Otfp-SS = regsub(resp.http.X-Fastly-Otfp-Info, ".*ss=(\S+).*", "\1");
    set resp.http.Otfp-SL = regsub(resp.http.X-Fastly-Otfp-Info, ".*sl=(\S+).*", "\1");
    set resp.http.Otfp-VL = regsub(resp.http.X-Fastly-Otfp-Info, ".*vl=(\S+).*", "\1");

    # Resolution (rs name-value) not available for audio-only segments
    if (resp.http.X-Fastly-Otfp-Info ~ ".*rs=(\S+).*") {
      set resp.http.Otfp-RS = re.group.1;
    } else {
      set resp.http.Otfp-RS = "-";
    }
  }

  #for api auth purge requests
  if (req.request == "FASTLYPURGE") {
    set req.http.Fastly-Purge-Requires-Auth = "1";
  }

#FASTLY deliver

  return(deliver);
}

sub vcl_error {
  # Packager failover for synthetic errors (OTFP backend unreachable, first-byte
  # timeout, ...) on playlists. Not for our own refusals below or for responses
  # that already came from the tomp4 packager.
  if (obj.status == 503
      && req.url.ext == "m3u8"
      && !req.http.X-Packager-Route
      && obj.response != "Simulated OTFP outage"
      && req.restarts < 3
      && table.lookup(packager_cfg, "failover", "on") == "on") {
    set req.http.X-failover = "tm";
    restart;
  }

#FASTLY error

  if (obj.status == 900) {
    set obj.status = 200;
    set obj.response = "OK";
    set obj.http.Content-Type = "text/xml";
    synthetic {"<cross-domain-policy>
        <site-control permitted-cross-domain-policies="master-only"/>
        <allow-access-from domain="*" secure="false"/>
        <allow-http-request-headers-from domain="*" headers="*"/>
        </cross-domain-policy>"};
    return(deliver);
  }
}

sub vcl_hash {
#FASTLY hash

  # The embedded "base url" in each ABR manifest is fully qualified, including
  # the original request scheme.
  if (req.url.path ~ "/master\.(m3u8|f4m|mpd)$") {
    set req.hash += if(req.is_ssl, "1", "0");
  }
}

sub vcl_hit {
#FASTLY hit
  return(deliver);
}

sub vcl_log {
#FASTLY log
}
