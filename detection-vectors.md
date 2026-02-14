## Detection vectors

When monitoring network activity, look for the following strings within Fetch/XHR items to determine when an advertisement is playing within the video.

### URL, Header, and POST Body patterns (Fetch/XHR/ping)

- `ad_break`
- `pagead`
- `pubads`
- `googleads`
- `doubleclick`
- `googleadservices`
- `googlesyndication`
- `c3.ad.system`
- `advertiserCategory`
- `advertiserId`
- `media.adStart`
- `advertisingDetails`
- `media.adBreakStart`
- `ads?ver`
- `adview`

### URL path segment matching (regex)

- `/ad/`, `/ad?`, `/ads/`, `/ads?` — matches `ad` or `ads` as a distinct path segment to avoid false positives from words like "download", "add", "loading"

### Image tracking pixel detection

- Request URLs of `img/gif` content types containing any of the above patterns
- P3P response headers on image requests containing `googleadservices`

Look for these strings in the Headers and the Payloads of Fetch/XHR network including the URLs of the network items. Most of these items are of the `POST` type so look in those first.
