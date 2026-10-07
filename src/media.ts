import type { MediaSource } from "./types";

function signature(bytes: Uint8Array, mime: string): boolean {
  const b = Buffer.from(bytes);
  switch (mime) {
    case "image/png": return b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/jpeg": return b[0] === 255 && b[1] === 216 && b[2] === 255;
    case "image/gif": return /^GIF8[79]a/.test(b.toString("ascii"));
    case "image/webp": return b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP";
    case "audio/wav": return b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE";
    case "audio/ogg": return b.toString("ascii", 0, 4) === "OggS";
    case "audio/mp4": return b.toString("ascii", 4, 8) === "ftyp";
    case "audio/mpeg": return b.toString("ascii", 0, 3) === "ID3" || (b[0] === 255 && (b[1] & 224) === 224);
    default: return false;
  }
}

export async function mediaResponse(asset: MediaSource, headers: Record<string, string>): Promise<Response> {
  try {
    const body = asset.data ? Buffer.from(asset.data, "base64") : Bun.file(asset.path!);
    const size = body instanceof Uint8Array ? body.length : body.size;
    if (size > 64 * 1024 * 1024) return new Response("Media exceeds 64 MiB", { status: 413, headers });
    const first = body instanceof Uint8Array ? body.subarray(0, 16) : new Uint8Array(await body.slice(0, 16).arrayBuffer());
    if (!signature(first, asset.mime)) return new Response("Unsupported media", { status: 415, headers });
    return new Response(body, { headers: { ...headers, "Content-Type": asset.mime } });
  } catch {
    return new Response("Attachment unavailable", { status: 404, headers });
  }
}
