// Photo geolocation entry. Requests are fixed by the listed photo order; results are
// stored by index so parallel completion cannot change the final answer order.
const MODEL = 'claude-sonnet-5-5';
// The detailed visual reasoning needs enough room to reach its final JSON verdict.
const MAX_TOKENS = 3072;
const RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];
const PROMPT = `Act as a careful visual geolocation analyst. Inspect the image and reason from visible evidence, not a guessed landmark. Work through these clues: transcribe any readable language, script, shop names, signs, phone numbers and URL formats; infer driving side, road markings, traffic signs, vehicle types and plate shape; compare architecture, building materials, street furniture, utility poles and wiring; assess vegetation, climate, terrain and likely season; use sun/shadow direction only as weak evidence; note flags, emblems and distinctive public features. Separate direct observations from hypotheses, and consider plausible alternatives. Narrow in order from country to region to city, then identify the most specific defensible location or street-level area. Do not claim unsupported precision. Still provide your best single point estimate even if only a broad region is supported. Think through the evidence before the verdict. Your final line must be exactly one JSON object with numeric decimal-degree coordinates: {"lat": 0.0, "lon": 0.0}. No text after that line.`;

interface Photo { id: string; url: string; answered: boolean }
interface Guess { id: string; lat: number; lon: number }
interface Geo { lat: number; lon: number }

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
function validLat(x: unknown): x is number { return typeof x === 'number' && Number.isFinite(x) && x >= -90 && x <= 90; }
function validLon(x: unknown): x is number { return typeof x === 'number' && Number.isFinite(x) && x >= -180 && x <= 180; }
function rounded(x: number): number { return Math.round(x * 1e6) / 1e6; }

function fromObject(value: Record<string, unknown>): Geo | null {
  const lat = value.lat ?? value.latitude ?? value.Lat ?? value.Latitude;
  const lon = value.lon ?? value.lng ?? value.longitude ?? value.Lon ?? value.Lng ?? value.Longitude;
  return validLat(lat) && validLon(lon) ? { lat: rounded(lat), lon: rounded(lon) } : null;
}
/** Prefer the last valid JSON object, as the final verdict follows the reasoning. */
function parseCoordinates(text: string): Geo | null {
  const candidates: Geo[] = [];
  for (const match of text.matchAll(/\{[^{}]*\}/gs)) {
    try {
      const parsed: unknown = JSON.parse(match[0]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const geo = fromObject(parsed as Record<string, unknown>);
        if (geo) candidates.push(geo);
      }
    } catch { /* Continue through the answer; later JSON may be the verdict. */ }
  }
  if (candidates.length) return candidates[candidates.length - 1]!;

  // Support common key spellings even when the surrounding reply is not valid JSON.
  const latMatch = text.match(/(?:"?(?:lat|latitude)"?)\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  const lonMatch = text.match(/(?:"?(?:lon|lng|longitude)"?)\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  if (latMatch && lonMatch) {
    const geo = fromObject({ lat: Number(latMatch[1]), lon: Number(lonMatch[1]) });
    if (geo) return geo;
  }
  // Last resort: take the final adjacent, in-range numeric pair in the reply.
  const numbers = [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  for (let i = numbers.length - 2; i >= 0; i--) {
    const lat = numbers[i], lon = numbers[i + 1];
    if (validLat(lat) && validLon(lon)) return { lat: rounded(lat), lon: rounded(lon) };
  }
  return null;
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  return response;
}

async function ask(body: string, gateway: string, apiKey: string): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${gateway}/v1/messages`, { method: 'POST', headers: {
        'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
      }, body });
    } catch (error) {
      process.stderr.write(`model request failed: ${String(error).slice(0, 160)}\n`);
      return null;
    }
    if (response.ok) {
      try {
        const payload = await response.json() as { content?: unknown };
        if (!Array.isArray(payload.content)) return null;
        return payload.content.filter((block): block is { type: string; text?: string } =>
          !!block && typeof block === 'object' && 'type' in block && typeof block.type === 'string')
          .filter((block) => block.type === 'text').map((block) => typeof block.text === 'string' ? block.text : '').join('\n');
      } catch { return null; }
    }
    const detail = (await response.text()).slice(0, 180).replace(/\s+/g, ' ');
    if ((response.status === 408 || response.status === 429 || (response.status >= 500 && response.status <= 599)) && attempt < RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt]!));
      continue;
    }
    process.stderr.write(`model call HTTP ${response.status}: ${detail}\n`);
    return null;
  }
}

async function main(): Promise<number> {
  const envUrl = required('MAKEFUN_ENV_URL').replace(/\/+$/, '');
  const promptPath = required('MAKEFUN_PROMPT_FILE');
  const gateway = required('ANTHROPIC_BASE_URL').replace(/\/+$/, '');
  const apiKey = required('ANTHROPIC_API_KEY');
  // The trial brief can supply useful task context; always read it as required by the contract.
  const brief = await (await import('node:fs/promises')).readFile(promptPath, 'utf8');
  void brief;

  const listing = await (await fetchOk(`${envUrl}/photos`)).json() as { photos: Photo[] };
  if (!listing || !Array.isArray(listing.photos)) throw new Error('invalid /photos response');
  const photos = listing.photos.filter((photo) => photo && typeof photo.id === 'string' && typeof photo.url === 'string' && !photo.answered);
  const guesses: Guess[] = [];
  let refused = 0;
  // Sequential processing fixes the gateway request order as well as answer order.
  for (const photo of photos) {
    try {
      const jpeg = Buffer.from(await (await fetchOk(`${envUrl}${photo.url}`)).arrayBuffer());
      const body = JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
        { type: 'text', text: PROMPT },
      ] }] });
      const answer = await ask(body, gateway, apiKey);
      if (answer === null) { refused++; continue; }
      let geo = parseCoordinates(answer);
      if (!geo) {
        // Rescue is a deterministic function of the recorded first reply; never call a third time.
        const rescueBody = JSON.stringify({ model: MODEL, max_tokens: 256, messages: [{ role: 'user', content:
          `Restate your conclusion as exactly one JSON object {"lat": ..., "lon": ...} with numeric decimal-degree coordinates.\n\nPrevious reply:\n${answer}` }] });
        const rescue = await ask(rescueBody, gateway, apiKey);
        geo = rescue === null ? null : parseCoordinates(rescue);
      }
      if (geo) guesses.push({ id: photo.id, ...geo });
      else process.stderr.write(`no coordinates parsed for ${photo.id}\n`);
    } catch (error) {
      process.stderr.write(`photo ${photo.id} failed: ${String(error).slice(0, 160)}\n`);
    }
  }
  const answers = guesses;
  if (!answers.length) return refused > 0 ? 1 : 0;
  const response = await fetch(`${envUrl}/answers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers }) });
  if (!response.ok) {
    process.stderr.write(`answer submission HTTP ${response.status}: ${(await response.text()).slice(0, 180)}\n`);
    return 1;
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`photo geolocator: ${String(error).slice(0, 300)}\n`);
  process.exitCode = 1;
}
