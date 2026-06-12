import type { AttachmentRef } from "../types";

export interface MediaDeps {
  tg: { getFilePath(fileId: string): Promise<string>; downloadFile(path: string): Promise<ArrayBuffer> };
  gcs: { uploadAndSign(name: string, body: ArrayBuffer, ct: string): Promise<string> };
  transcribeAudio: (audio: ArrayBuffer, mime: string) => Promise<string>;
}

export interface MediaError {
  kind: AttachmentRef["kind"];
  stage: "download" | "upload" | "transcribe";
  message: string;
}

export interface MediaResult {
  attachments: AttachmentRef[];
  errors: MediaError[];
}

function mimeFor(kind: AttachmentRef["kind"]): string {
  switch (kind) {
    case "voice": return "audio/ogg";
    case "photo": return "image/jpeg";
    case "video": return "video/mp4";
    case "document": return "application/octet-stream";
  }
}

function extFor(kind: AttachmentRef["kind"]): string {
  switch (kind) {
    case "voice": return "ogg";
    case "photo": return "jpg";
    case "video": return "mp4";
    case "document": return "bin";
  }
}

export async function processAttachments(
  refs: AttachmentRef[],
  deps: MediaDeps
): Promise<MediaResult> {
  const out: AttachmentRef[] = [];
  const errors: MediaError[] = [];

  for (const ref of refs) {
    let body: ArrayBuffer;
    try {
      const path = await deps.tg.getFilePath(ref.telegram_file_id);
      body = await deps.tg.downloadFile(path);
    } catch (e) {
      errors.push({ kind: ref.kind, stage: "download", message: (e as Error).message });
      out.push(ref);
      continue;
    }

    const objectName = `${ref.kind}/${Date.now()}-${ref.telegram_file_id}.${extFor(ref.kind)}`;
    let signed_url: string | undefined;
    try {
      signed_url = await deps.gcs.uploadAndSign(objectName, body, mimeFor(ref.kind));
    } catch (e) {
      errors.push({ kind: ref.kind, stage: "upload", message: (e as Error).message });
    }

    let transcription: string | undefined;
    if (ref.kind === "voice") {
      try {
        transcription = await deps.transcribeAudio(body, "audio/ogg");
      } catch (e) {
        errors.push({ kind: ref.kind, stage: "transcribe", message: (e as Error).message });
      }
    }

    out.push({
      ...ref,
      ...(signed_url ? { signed_url } : {}),
      ...(transcription ? { transcription } : {}),
    });
  }

  return { attachments: out, errors };
}
