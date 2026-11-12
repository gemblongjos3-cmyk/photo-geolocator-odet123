# Photo geolocator

This entry reads the supplied trial brief and the environment service's photo list, then sends each unanswered JPEG to Claude Sonnet 5.5 through the Anthropic Messages gateway. The visual-analysis prompt asks the model to describe visible clues, weigh alternatives, and narrow its estimate from country to the most specific defensible location.

Photos are handled sequentially in listing order. Valid coordinates are range-checked and rounded to six decimal places, then submitted together in one ordered batch. If the first response has no parseable coordinate, the runner makes one text-only rescue request based on that response. The rescue includes at most 6,000 characters, retaining both its beginning and conclusion when the reply is longer.

Only transient HTTP statuses (408, 429, and 5xx) are retried, with a fixed backoff. Connection errors, refusals, other HTTP failures, and unparseable responses do not trigger repeated model calls. Each call allows up to four attempts; each photo uses at most one analysis call and one rescue call, keeping the 25-photo run within the 200-request cap.
