# Photo geolocator

This entry loads task-specific instructions from MAKEFUN_PROMPT_FILE, retrieves the pending photos, and asks Claude to estimate where each image was taken. It submits the resulting coordinates together, in the same order as the photos, rounded to six decimal places.

The location estimate is based on visible evidence such as terrain, buildings, vegetation, roads, signs, and language. If the model's first response does not contain a valid coordinate object, the entry makes one short text-only request to restate its conclusion in the required format.

Up to four photos are processed at once. Temporary service failures receive a small fixed retry schedule; invalid requests and other client errors are reported as failures. Run with Node 22 using node /bot/main.ts after setting the environment URL, Anthropic endpoint and key, and prompt file.
