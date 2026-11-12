import { readFile } from "node:fs/promises";

type Photo = {
  id?: string | number;
  photo_id?: string | number;
  url?: string;
  image_url?: string;
  jpeg_url?: string;
  answered?: boolean;
  answer?: unknown;
  lat?: number;
  lon?: number;
  [key: string]: unknown;
};

type Coordinate = { lat: number; lon: number };
type Result = { id: string | number; lat: number; lon: number };

const retryDelays = [250, 750, 1500];
const promptPath = process.env.MAKEFUN_PROMPT_FILE;
const envUrl = process.env.MAKEFUN_ENV_URL;
const apiRoot = process.env.ANTHROPIC_BASE_URL;
const apiKey = process.env.ANTHROPIC_API_KEY;

if (!promptPath || !envUrl || !apiRoot || !apiKey) {
  console.error("Required environment is missing.");
  process.exit(1);
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (!response.ok && (response.status === 408 || response.status === 429 || response.status >= 500) && attempt < retryDelays.length) {
        await wait(retryDelays[attempt]);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= retryDelays.length) throw error;
      await wait(retryDelays[attempt]);
    }
  }
  throw lastError;
}

function responsePhotos(value: unknown): Photo[] {
  if (Array.isArray(value)) return value as Photo[];
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (Array.isArray(row.photos)) return row.photos as Photo[];
    if (Array.isArray(row.data)) return row.data as Photo[];
  }
  throw new Error("Photo endpoint returned no photo list.");
}

function isAnswered(photo: Photo): boolean {
  return photo.answered === true || photo.answer != null ||
    (typeof photo.lat === "number" && typeof photo.lon === "number");
}

function photoId(photo: Photo): string | number {
  const id = photo.photo_id ?? photo.id;
  if (typeof id !== "string" && typeof id !== "number") throw new Error("Photo has no identifier.");
  return id;
}

function imageUrl(photo: Photo): string {
  const value = photo.jpeg_url ?? photo.image_url ?? photo.url;
  if (typeof value !== "string") throw new Error("Photo has no JPEG URL.");
  return value;
}

function parseCoordinates(text: string): Coordinate | null {
  const candidates = [...text.matchAll(/\{[^{}]*\}/g)];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const object = JSON.parse(candidates[index][0]) as Record<string, unknown>;
      const latitude = object.lat ?? object.latitude ?? object.lat_deg;
      const longitude = object.lon ?? object.lng ?? object.longitude ?? object.lon_deg;
      if (typeof latitude !== "number" || typeof longitude !== "number") continue;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
          latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;
      return { lat: latitude, lon: longitude };
    } catch {
      continue;
    }
  }
  return null;
}

function assistantText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const content = (value as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "text")
    .map((part) => String((part as Record<string, unknown>).text ?? "")).join("\n");
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const side = Math.floor((limit - 32) / 2);
  return text.slice(0, side) + "\n[... middle omitted ...]\n" + text.slice(-side);
}

async function anthropic(body: Record<string, unknown>, token: number): Promise<string> {
  const response = await request(new URL("/v1/messages", apiRoot).toString(), {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: token, ...body }),
  });
  if (!response.ok) throw new Error("Anthropic request failed with HTTP " + response.status);
  return assistantText(await response.json());
}

async function locate(photo: Photo, taskPrompt: string): Promise<Result> {
  const imageResponse = await request(new URL(imageUrl(photo), envUrl).toString());
  if (!imageResponse.ok) throw new Error("Photo download failed with HTTP " + imageResponse.status);
  const bytes = new Uint8Array(await imageResponse.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  const encoded = btoa(binary);
  const instruction = taskPrompt + "\n\nEstimate the most likely camera location from visible geographic evidence. Compare landforms, vegetation, architecture, road markings, signs, coastline, shadows, and any readable language. Separate direct observations from inference, consider plausible alternatives, and narrow the estimate using the strongest independent clues. Give a concise rationale, then make your final line exactly one JSON object with numeric latitude and longitude, for example {\"lat\": 12.345678, \"lon\": -98.765432}. Keep coordinates within valid latitude and longitude ranges.";
  const first = await anthropic({
    messages: [{ role: "user", content: [
      { type: "text", text: instruction },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: encoded } },
    ] }],
  }, 3072);
  let coordinate = parseCoordinates(first);
  if (!coordinate) {
    const followUp = await anthropic({
      messages: [{ role: "user", content: "Restate your conclusion from this previous reply as exactly one JSON object with numeric lat and lon, no other text:\n\n" + clip(first, 6000) }],
    }, 256);
    coordinate = parseCoordinates(followUp);
  }
  if (!coordinate) throw new Error("Model did not return valid coordinates for photo " + String(photoId(photo)));
  return { id: photoId(photo), lat: coordinate.lat, lon: coordinate.lon };
}

async function main(): Promise<void> {
  const taskPrompt = await readFile(promptPath as string, "utf8");
  const photoResponse = await request(new URL("/photos", envUrl).toString());
  if (!photoResponse.ok) throw new Error("Photo endpoint failed with HTTP " + photoResponse.status);
  const photos = responsePhotos(await photoResponse.json()).filter((photo) => !isAnswered(photo));
  const results: (Result | null)[] = new Array(photos.length).fill(null);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= photos.length) return;
      results[index] = await locate(photos[index], taskPrompt);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, photos.length) }, () => worker()));
  const answers = results.map((result) => {
    if (!result) throw new Error("A photo result is missing.");
    return { photo_id: result.id, lat: Number(result.lat.toFixed(6)), lon: Number(result.lon.toFixed(6)) };
  });
  const posted = await request(new URL("/answers", envUrl).toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  if (!posted.ok) throw new Error("Answer submission failed with HTTP " + posted.status);
}

main().then(() => {
  process.exit(0);
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

// Keep this entry directly runnable by the Node 22 TypeScript runtime.
