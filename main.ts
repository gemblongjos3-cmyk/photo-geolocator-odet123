/*
 * Photo geolocation runner.
 * Work through the service's listing in order and submit the coordinates that
 * can be supported by the model's visual evidence.
 */
const MODEL = 'claude-sonnet-5-5';
const ANALYSIS_TOKENS = 3072;
const RESCUE_TOKENS = 256;
const TRANSIENT_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000];

const ANALYST_INSTRUCTIONS = [
  'Act as a careful visual geolocation analyst. Base the estimate on evidence visible in the image, not on a guessed landmark.',
  'Describe clues before drawing conclusions: readable language, scripts, business names, signs and URL formats; driving side, road markings, signs, vehicle styles and plate shapes; architecture, materials, street furniture, poles and wiring; vegetation, climate, terrain and likely season.',
  'Treat sun and shadow direction as weak evidence. Note flags, emblems, and distinctive public features when visible.',
  'Separate direct observations from hypotheses and consider plausible alternatives. Narrow from country to region to city, then give the most specific defensible location. Do not claim unsupported precision; give one best point estimate even when evidence supports only a broad region.',
  'Think through the evidence, then finish with exactly one JSON object containing numeric decimal-degree coordinates, in this form: {"lat": 0.0, "lon": 0.0}. Put no text after that object.'
].join(' ');

interface Photo {
  id: string;
  url: string;
  answered: boolean;
}

interface CoordinateAnswer {
  id: string;
  lat: number;
  lon: number;
}

interface Coordinates {
  lat: number;
  lon: number;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is not set');
  return value;
}

function inLatitudeRange(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

function inLongitudeRange(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

function roundCoordinate(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function coordinatesFrom(value: Record<string, unknown>): Coordinates | null {
  const latitude = value.lat ?? value.latitude ?? value.Lat ?? value.Latitude;
  const longitude = value.lon ?? value.lng ?? value.longitude ?? value.Lon ?? value.Lng ?? value.Longitude;
  if (!inLatitudeRange(latitude) || !inLongitudeRange(longitude)) return null;
  return { lat: roundCoordinate(latitude), lon: roundCoordinate(longitude) };
}

function parseCoordinates(reply: string): Coordinates | null {
  const found: Coordinates[] = [];
  for (const part of reply.matchAll(/\{[^{}]*\}/gs)) {
    try {
      const value: unknown = JSON.parse(part[0]);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const coordinates = coordinatesFrom(value as Record<string, unknown>);
        if (coordinates) found.push(coordinates);
      }
    } catch {
      // An explanatory brace group need not be JSON; keep looking for a verdict.
    }
  }
  if (found.length > 0) return found[found.length - 1];

  // Also accept a plain key/value coordinate pair embedded in prose.
  const latitude = reply.match(/"?\b(?:lat|latitude)\b"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  const longitude = reply.match(/"?\b(?:lon|lng|longitude)\b"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  if (latitude && longitude) {
    const coordinates = coordinatesFrom({
      lat: Number(latitude[1]),
      lon: Number(longitude[1])
    });
    if (coordinates) return coordinates;
  }

  // Last resort: inspect adjacent numeric pairs from the end of the response.
  const numbers = Array.from(reply.matchAll(/-?\d+(?:\.\d+)?/g), (match) => Number(match[0]));
  for (let index = numbers.length - 2; index >= 0; index--) {
    const lat = numbers[index];
    const lon = numbers[index + 1];
    if (inLatitudeRange(lat) && inLongitudeRange(lon)) {
      return { lat: roundCoordinate(lat), lon: roundCoordinate(lon) };
    }
  }
  return null;
}

async function getOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('HTTP ' + response.status + ' from ' + url);
  return response;
}

function isTransient(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

async function requestText(body: string, gateway: string, apiKey: string): Promise<string | null> {
  for (let retry = 0; ; retry++) {
    let response: Response;
    try {
      response = await fetch(gateway + '/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body
      });
    } catch (error) {
      process.stderr.write('model request failed: ' + String(error).slice(0, 160) + '\n');
      return null;
    }

    if (response.ok) {
      try {
        const payload = await response.json() as { content?: unknown };
        if (!Array.isArray(payload.content)) return null;
        return payload.content
          .filter((block): block is { type: string; text?: string } =>
            !!block && typeof block === 'object' && 'type' in block && typeof block.type === 'string')
          .filter((block) => block.type === 'text')
          .map((block) => typeof block.text === 'string' ? block.text : '')
          .join('\n');
      } catch {
        return null;
      }
    }

    const detail = (await response.text()).slice(0, 180).replace(/\s+/g, ' ');
    if (isTransient(response.status) && retry < TRANSIENT_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[retry]));
      continue;
    }
    process.stderr.write('model call HTTP ' + response.status + ': ' + detail + '\n');
    return null;
  }
}

function modelBody(imageBase64: string, tokenLimit: number): string {
  return JSON.stringify({
    model: MODEL,
    max_tokens: tokenLimit,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: ANALYST_INSTRUCTIONS }
      ]
    }]
  });
}

function rescueBody(previousReply: string): string {
  const limit = 6000;
  const context = previousReply.length <= limit ? previousReply : previousReply.slice(0, 3000) + '\n[...middle of reply omitted...]\n' + previousReply.slice(-3000);
  return JSON.stringify({
    model: MODEL,
    max_tokens: RESCUE_TOKENS,
    messages: [{
      role: 'user',
      content: 'Restate the conclusion from the reply below as exactly one JSON object with numeric decimal-degree coordinates: {"lat": ..., "lon": ...}. Use only the prior conclusion; do not invent another location.\n\n' + context
    }]
  });
}

async function locate(photo: Photo, envUrl: string, gateway: string, apiKey: string): Promise<CoordinateAnswer | null> {
  try {
    const imageResponse = await getOk(envUrl + photo.url);
    const imageData = Buffer.from(await imageResponse.arrayBuffer()).toString('base64');
    const initialReply = await requestText(modelBody(imageData, ANALYSIS_TOKENS), gateway, apiKey);
    if (initialReply === null) return null;

    let coordinates = parseCoordinates(initialReply);
    if (coordinates === null) {
      // One deterministic rescue asks for formatting of the existing conclusion.
      const rescueReply = await requestText(rescueBody(initialReply), gateway, apiKey);
      coordinates = rescueReply === null ? null : parseCoordinates(rescueReply);
    }

    if (coordinates === null) {
      process.stderr.write('no coordinates parsed for ' + photo.id + '\n');
      return null;
    }
    return { id: photo.id, ...coordinates };
  } catch (error) {
    process.stderr.write('photo ' + photo.id + ' failed: ' + String(error).slice(0, 160) + '\n');
    return null;
  }
}

async function run(): Promise<number> {
  const envUrl = env('MAKEFUN_ENV_URL').replace(/\/+$/, '');
  const promptFile = env('MAKEFUN_PROMPT_FILE');
  const gateway = env('ANTHROPIC_BASE_URL').replace(/\/+$/, '');
  const apiKey = env('ANTHROPIC_API_KEY');

  // Read the supplied brief as required by the trial contract.
  await (await import('node:fs/promises')).readFile(promptFile, 'utf8');

  const listing = await (await getOk(envUrl + '/photos')).json() as { photos?: Photo[] };
  if (!listing || !Array.isArray(listing.photos)) throw new Error('invalid /photos response');
  const unanswered = listing.photos.filter((photo) =>
    photo && typeof photo.id === 'string' && typeof photo.url === 'string' && !photo.answered);

  const answers: CoordinateAnswer[] = [];
  let failedModelCalls = 0;
  for (const photo of unanswered) {
    const answer = await locate(photo, envUrl, gateway, apiKey);
    if (answer) answers.push(answer);
    // A missing answer can be a photo problem or an exhausted/refused model call.
    else failedModelCalls++;
  }

  if (answers.length === 0) return failedModelCalls > 0 ? 1 : 0;
  const submission = await fetch(envUrl + '/answers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers })
  });
  if (!submission.ok) {
    process.stderr.write('answer submission HTTP ' + submission.status + ': ' +
      (await submission.text()).slice(0, 180) + '\n');
    return 1;
  }
  return 0;
}

try {
  process.exitCode = await run();
} catch (error) {
  process.stderr.write('photo geolocator: ' + String(error).slice(0, 300) + '\n');
  process.exitCode = 1;
}
