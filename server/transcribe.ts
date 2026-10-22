import { config } from './config';
import { fetchRecording } from './twilio';

/**
 * Voicemail transcription with OpenAI speech-to-text (gpt-4o-transcribe by default), which handles
 * names, phone numbers and accents far better than Twilio's built-in transcription. Used when
 * OPENAI_API_KEY is set; otherwise voicemails fall back to Twilio's transcription.
 */

const TIMEOUT_MS = 60_000;
// Overridable so tests can point at a fake OpenAI.
const apiBase = () => (process.env.OPENAI_API_BASE || 'https://api.openai.com').replace(/\/$/, '');

export const transcriptionConfigured = () => Boolean(config('OPENAI_API_KEY'));

async function downloadRecording(recordingSid: string) {
  // Twilio can take a moment to make a just-finished recording downloadable.
  for (let attempt = 0; ; attempt++) {
    const res = await fetchRecording(recordingSid);
    if (res.ok) return res.arrayBuffer();
    if (res.status !== 404 || attempt >= 2) throw new Error(`Twilio returned ${res.status} for the recording`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

/** Downloads the voicemail from Twilio and returns its transcript (empty if nothing was said). */
export async function transcribeVoicemail(recordingSid: string, businessName: string) {
  const audio = await downloadRecording(recordingSid);
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/mpeg' }), `${recordingSid}.mp3`);
  form.append('model', config('OPENAI_TRANSCRIBE_MODEL') || 'gpt-4o-transcribe');
  // OpenAI takes a plain language code; the prompt carries the Australian context.
  form.append('language', 'en');
  form.append(
    'prompt',
    `${businessName} voicemail in Australian English. Names, Australian phone numbers, phone repair terms (iPhone, Samsung, screen, battery).`,
  );
  form.append('response_format', 'json');

  const res = await fetch(`${apiBase()}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config('OPENAI_API_KEY')}` },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(detail?.error?.message || `OpenAI returned ${res.status}`);
  }
  const { text } = (await res.json()) as { text?: string };
  return (text ?? '').trim();
}
